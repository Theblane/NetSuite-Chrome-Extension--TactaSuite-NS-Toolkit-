/**
 * TactaSuite bridge companion check (not a Playwright test).
 *
 * Spawns companion/tacta-bridge.mjs, connects a fake "extension" over the
 * loopback WebSocket (Node 24 global WebSocket client), then drives the MCP
 * stdio side (initialize, tools/list, tools/call) and verifies a round trip.
 *
 * Scenario 2 covers the 1.1.0 multi-instance behaviour: a second copy on the
 * same port must attach to the primary as a relay, a copy with the wrong token
 * must be rejected, and when the primary exits the secondary must take over
 * the port and serve calls directly.
 *
 * Run with Node 24+:  node tests/bridge.check.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = path.resolve(process.cwd());
const COMPANION = path.join(ROOT, 'companion', 'tacta-bridge.mjs');
const TOKEN = 'test-token-123';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function ok(msg) { console.log('ok:', msg); }
async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Spawn one companion instance and expose its MCP stdio + stderr log. */
function startCompanion(label, { token = TOKEN, port }) {
  const child = spawn(process.execPath, [COMPANION], {
    env: { ...process.env, TACTA_BRIDGE_TOKEN: token, TACTA_BRIDGE_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const logs = [];
  const logWaiters = [];
  child.stderr.on('data', (d) => {
    const text = String(d);
    process.stderr.write('[' + label + '] ' + text);
    logs.push(text);
    for (const w of logWaiters.splice(0)) {
      if (logs.some(w.test)) w.resolve(true); else logWaiters.push(w);
    }
  });

  const replies = new Map(); // id -> resolve
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch { return; }
    if (msg.id !== undefined && replies.has(msg.id)) {
      replies.get(msg.id)(msg);
      replies.delete(msg.id);
    }
  });

  function mcp(method, params) {
    const id = Math.floor(Math.random() * 1e9);
    return new Promise((resolve) => {
      replies.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** Resolve true when a stderr line matching `re` has been seen, false on timeout. */
  function waitForLog(re, timeoutMs = 4000) {
    const test = (l) => re.test(l);
    if (logs.some(test)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      logWaiters.push({ test, resolve: (v) => { clearTimeout(timer); resolve(v); } });
    });
  }

  return { child, mcp, waitForLog, logs, kill: () => child.kill() };
}

/**
 * Connect a fake extension to the companion on `port`: hello handshake with
 * the pairing token, answers pings, and returns canned tool results.
 */
async function connectExtension(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port, {
    headers: { Origin: 'chrome-extension://' + EXT_ID }
  });
  let welcomed = false;
  let calls = 0;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'welcome') { welcomed = true; return; }
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: msg.t })); return; }
    if (msg.type === 'call') {
      calls++;
      let data;
      if (msg.tool === 'netsuite_run_suiteql') data = { columns: ['id'], rows: [{ id: 1 }, { id: 2 }], count: 2 };
      else if (msg.tool === 'netsuite_list_tabs') data = { tabs: [{ id: 5, url: 'https://x.netsuite.com/app', title: 'NS' }] };
      else data = { echoed: msg.args };
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data }));
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', () => { ws.send(JSON.stringify({ type: 'hello', token: TOKEN, extId: EXT_ID })); res(); });
    ws.addEventListener('error', rej);
    setTimeout(() => rej(new Error('ws open timeout')), 4000);
  });
  await wait(300);
  return { ws, get welcomed() { return welcomed; }, get calls() { return calls; } };
}

function callText(reply) { return reply?.result?.content?.[0]?.text || ''; }

// ---------------------------------------------------------------------------
// Scenario 1: single instance, MCP handshake, round trips, large frames
// ---------------------------------------------------------------------------

async function scenarioSingle() {
  console.log('\n--- scenario 1: single instance ---');
  const PORT = 8799;
  const a = startCompanion('A', { port: PORT });
  (await a.waitForLog(/listening on 127\.0\.0\.1:8799 \(primary/)) ? ok('A is primary') : fail('A never listened');

  const ext = await connectExtension(PORT);
  ext.welcomed ? ok('extension paired (welcome received)') : fail('no welcome after hello');

  const init = await a.mcp('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  init?.result?.serverInfo?.name ? ok('initialize: ' + init.result.serverInfo.name) : fail('initialize bad: ' + JSON.stringify(init));

  const list = await a.mcp('tools/list', {});
  const names = (list?.result?.tools || []).map((t) => t.name);
  // The bridge exposes the full NetSuite tool set; assert the core read tool is
  // present rather than a fixed count, so adding tools does not break the check.
  names.includes('netsuite_run_suiteql') ? ok('tools/list (' + names.length + '): ' + names.join(', ')) : fail('tools/list missing netsuite_run_suiteql, got ' + JSON.stringify(names));

  const call = await a.mcp('tools/call', { name: 'netsuite_run_suiteql', arguments: { query: 'SELECT id FROM transaction' } });
  callText(call).includes('"count": 2') ? ok('tools/call round trip returned rows') : fail('bad tools/call result: ' + JSON.stringify(call));

  // >65535 bytes forces extended length framing on the WS 'call' frame.
  const bigArgs = { query: 'SELECT ' + 'x'.repeat(70000) + ' FROM dual' };
  const bigCall = await a.mcp('tools/call', { name: 'netsuite_run_suiteql', arguments: bigArgs });
  callText(bigCall).includes('"count": 2') ? ok('large-frame round trip ok') : fail('large-frame round trip failed');

  ext.ws.close();
  await wait(200);
  a.kill();
}

// ---------------------------------------------------------------------------
// Scenario 2: multi-instance relay, token rejection, primary failover
// ---------------------------------------------------------------------------

async function scenarioMultiInstance() {
  console.log('\n--- scenario 2: multi-instance relay + failover ---');
  const PORT = 8798;

  const a = startCompanion('A', { port: PORT });
  (await a.waitForLog(/listening on 127\.0\.0\.1:8798 \(primary/)) ? ok('A is primary') : fail('A never listened');
  let ext = await connectExtension(PORT);
  ext.welcomed ? ok('extension paired with A') : fail('extension not paired with A');

  // Second copy on the same port must attach as a secondary, not exit.
  const b = startCompanion('B', { port: PORT });
  (await b.waitForLog(/relaying tool calls through it \(secondary\)/)) ? ok('B attached to A as secondary') : fail('B did not become secondary');
  (await a.waitForLog(/secondary instance attached \(1 attached\)/)) ? ok('A sees 1 secondary') : fail('A did not log the secondary');
  b.child.exitCode === null ? ok('B stayed alive') : fail('B exited with ' + b.child.exitCode);

  // B's MCP side must work end to end through A and the extension.
  const bInit = await b.mcp('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  bInit?.result?.serverInfo?.name ? ok('B initialize ok') : fail('B initialize bad');
  const before = ext.calls;
  const viaRelay = await b.mcp('tools/call', { name: 'netsuite_run_suiteql', arguments: { query: 'SELECT id FROM transaction' } });
  callText(viaRelay).includes('"count": 2') ? ok('B tools/call relayed through A') : fail('relay call failed: ' + JSON.stringify(viaRelay));
  ext.calls === before + 1 ? ok('extension received exactly one relayed call') : fail('extension call count ' + ext.calls + ', expected ' + (before + 1));

  // Large payload across the relay link (newline JSON) and on to the WS frame.
  const bigArgs = { query: 'SELECT ' + 'y'.repeat(70000) + ' FROM dual' };
  const bigRelay = await b.mcp('tools/call', { name: 'netsuite_run_suiteql', arguments: bigArgs });
  callText(bigRelay).includes('"count": 2') ? ok('large payload relayed ok') : fail('large relay payload failed');

  // Unknown tool is rejected by the secondary before it reaches the relay.
  const badTool = await b.mcp('tools/call', { name: 'netsuite_nope', arguments: {} });
  (badTool?.error || badTool?.result?.isError) ? ok('B rejects unknown tool') : fail('unknown tool was not rejected: ' + JSON.stringify(badTool));

  // Wrong pairing token: primary must refuse the relay and never attach it.
  const c = startCompanion('C', { token: 'wrong-token', port: PORT });
  (await c.waitForLog(/primary rejected relay/)) ? ok('C (wrong token) rejected by A') : fail('C was not rejected');
  (await a.waitForLog(/rejected relay connection: bad or missing token/)) ? ok('A logged the token rejection') : fail('A did not log rejection');
  a.logs.some((l) => /secondary instance attached \(2 attached\)/.test(l)) ? fail('A attached the wrong-token instance') : ok('A never attached C');
  c.kill();

  // Failover: kill the primary, the secondary must take over the port.
  a.kill();
  (await b.waitForLog(/lost connection to primary; attempting to take over/)) ? ok('B noticed primary loss') : fail('B did not notice primary loss');
  (await b.waitForLog(/listening on 127\.0\.0\.1:8798 \(primary/, 6000)) ? ok('B took over the port as primary') : fail('B did not take over the port');

  // The real extension reconnects on its retry cycle; simulate that here.
  try { ext.ws.close(); } catch (_) {}
  await wait(200);
  ext = await connectExtension(PORT);
  ext.welcomed ? ok('extension re-paired with B') : fail('extension could not pair with B');
  const direct = await b.mcp('tools/call', { name: 'netsuite_list_tabs', arguments: {} });
  callText(direct).includes('netsuite.com') ? ok('B serves tools/call directly after failover') : fail('post-failover call failed: ' + JSON.stringify(direct));

  ext.ws.close();
  await wait(200);
  b.kill();
}

// ---------------------------------------------------------------------------

async function run() {
  await scenarioSingle();
  await scenarioMultiInstance();
  console.log('\nbridge check complete' + (process.exitCode ? ' WITH FAILURES.' : '.'));
}

run().catch((e) => { fail(e.stack || e.message); process.exit(1); });

/**
 * NetSuite TactaSuite - Local bridge client (service worker side)
 *
 * @author Blane Maher
 *
 * Connects the extension OUT to the local companion's loopback WebSocket
 * server (see companion/tacta-bridge.mjs). The companion is launched by the
 * user's desktop MCP client (e.g. Claude Desktop) and forwards MCP tool calls
 * here; this module runs them against the live NetSuite tab using the existing
 * service-worker primitives and returns the result.
 *
 * Why a WebSocket the extension dials OUT: an open WebSocket keeps the MV3
 * service worker alive (Chrome 116+), and the extension cannot itself run a
 * server. The companion owns the loopback port; we connect to it.
 *
 * Security: loopback only, shared pairing token in the hello handshake,
 * read-only by default. No NetSuite-side setup, no OAuth - everything runs in
 * the user's already-signed-in session.
 *
 * Capabilities are injected by the service worker (deps) so this module does
 * not duplicate the page-execution logic:
 *   deps.executeSuiteQL(tabId, query, params)
 *   deps.getPageInfo(tabId)
 *   deps.getRecordFields(tabId)
 *   deps.findNetSuiteTab()        -> { id, url, title } | null
 *   deps.listNetSuiteTabs()       -> [{ id, url, title, active }]
 */

const BRIDGE_SETTINGS_KEY = 'tacta_bridge_settings';
const DEFAULT_PORT = 8787;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;

// Account lock: the bridge acts only on tabs of lockedAccountId (persisted;
// survives tab close). multiAccount=true lets it use any NetSuite tab but forces
// writes off. allowWrites permits create/update, and only on the locked account.
const DEFAULT_SETTINGS = { enabled: false, token: '', port: DEFAULT_PORT, lockedAccountId: null, lockedAccountLabel: '', multiAccount: false, allowWrites: false };

const SANDBOX_HOST_RE = /^https:\/\/[^/]*(-sb\d+\.|sandbox|-rp\.)/i;
const NS_ACCOUNT_HOST_RE = /\.(netsuite|oracle)\.com$/i;
const NON_ACCOUNT_LABELS = new Set(['system', 'www', 'docs', 'login', 'rest', 'webservices']);

/** True when a NetSuite tab URL is a sandbox or release-preview account. */
export function isSandboxUrl(url) {
  return SANDBOX_HOST_RE.test(String(url || ''));
}

/**
 * Account key for a NetSuite tab URL: the leftmost hostname label (e.g.
 * "1234567" for production, "1234567-sb1" for a sandbox). Null for non-account
 * hosts (login/system/docs) or non-NetSuite URLs. This is what the account lock
 * matches on, so production and its sandbox are distinct lockable instances.
 */
export function accountKeyFromUrl(url) {
  try {
    const host = new URL(String(url)).hostname;
    if (!NS_ACCOUNT_HOST_RE.test(host)) return null;
    const label = host.split('.')[0].toLowerCase();
    if (!label || NON_ACCOUNT_LABELS.has(label)) return null;
    return label;
  } catch (_) {
    return null;
  }
}

/** Human-friendly environment + display label for an account key. */
export function accountInfoFromKey(key) {
  const k = String(key || '');
  let base = k, env = 'Production', m;
  if ((m = /^(.*)-sb(\d+)$/i.exec(k))) { base = m[1]; env = 'Sandbox ' + m[2]; }
  else if (/-rp$/i.test(k)) { base = k.replace(/-rp$/i, ''); env = 'Release Preview'; }
  return { key: k, base: base, env: env, label: k + ' - ' + env };
}

// In-memory connection state (per service-worker lifetime).
let ws = null;
let deps = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
let desiredEnabled = false;
let status = { state: 'stopped', since: Date.now(), lastError: null, port: DEFAULT_PORT };

function setStatus(state, extra) {
  status = { ...status, state, since: Date.now(), ...(extra || {}) };
}

export async function getBridgeSettings() {
  const stored = await chrome.storage.local.get(BRIDGE_SETTINGS_KEY);
  const raw = stored[BRIDGE_SETTINGS_KEY] || {};
  const settings = { ...DEFAULT_SETTINGS, ...raw };
  // Drop superseded keys from older versions: the sandbox-only toggle and the
  // environment-based write flags are replaced by the per-account lock. Writes
  // never auto-enable across a settings-model change: the user must re-opt-in.
  delete settings.sandboxOnly;
  delete settings.allowSandboxWrites;
  delete settings.allowProductionWrites;
  // Older builds persisted the label with a different separator; rebuild it
  // from the key on every read so stored text is normalised.
  if (settings.lockedAccountId) {
    settings.lockedAccountLabel = accountInfoFromKey(settings.lockedAccountId).label;
  }
  return settings;
}

export async function setBridgeSettings(patch) {
  const current = await getBridgeSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [BRIDGE_SETTINGS_KEY]: next });
  return next;
}

/** Generate a fresh random pairing token (URL-safe). */
export function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getBridgeStatus() {
  return { ...status, connected: !!ws && status.state === 'connected' };
}

/**
 * Start (or restart) the bridge using the given capability deps. Reads the
 * stored settings; connects only when enabled. Safe to call repeatedly
 * (onStartup, onInstalled, alarm, settings change).
 */
export async function startBridge(injectedDeps) {
  if (injectedDeps) deps = injectedDeps;
  const settings = await getBridgeSettings();
  desiredEnabled = !!settings.enabled;

  if (!desiredEnabled) {
    stopBridge();
    return getBridgeStatus();
  }
  if (!settings.token) {
    setStatus('error', { lastError: 'No pairing token set.', port: settings.port });
    return getBridgeStatus();
  }
  // Already connected, connecting, or still closing: leave it. A closing
  // socket fires 'close' shortly and that handler schedules the reconnect.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.CLOSING)) {
    return getBridgeStatus();
  }
  // A reconnect is already queued: take it over rather than letting the alarm
  // or a settings change open a second socket alongside it.
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connect(settings);
  return getBridgeStatus();
}

export function stopBridge() {
  desiredEnabled = false;
  reconnectDelay = RECONNECT_MIN_MS;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  setStatus('stopped', { lastError: null });
}

function scheduleReconnect(settings) {
  if (!desiredEnabled) return;
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  setStatus('reconnecting', { port: settings.port, retryInMs: delay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    getBridgeSettings().then((s) => { if (desiredEnabled) connect(s); });
  }, delay);
}

function connect(settings) {
  const port = Number(settings.port) || DEFAULT_PORT;
  let socket;
  try {
    socket = new WebSocket('ws://127.0.0.1:' + port);
  } catch (e) {
    setStatus('error', { lastError: String(e && e.message || e), port });
    scheduleReconnect(settings);
    return;
  }
  ws = socket;
  setStatus('connecting', { port, lastError: null });

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      v: 1,
      type: 'hello',
      token: settings.token,
      extId: chrome.runtime.id,
      capabilities: { readOnly: !(settings.allowWrites && !settings.multiAccount && !!settings.lockedAccountId) }
    }));
  });

  socket.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : ''); } catch (_) { return; }

    if (msg.type === 'welcome') {
      reconnectDelay = RECONNECT_MIN_MS;
      setStatus('connected', { port, server: msg.version, lastError: null });
      return;
    }
    if (msg.type === 'error') {
      setStatus('error', { lastError: msg.message || 'Bridge rejected the connection.', port });
      return;
    }
    if (msg.type === 'ping') {
      try { socket.send(JSON.stringify({ type: 'pong', t: msg.t })); } catch (_) {}
      return;
    }
    if (msg.type === 'call' && msg.id) {
      const settingsNow = await getBridgeSettings();
      try {
        const data = await dispatchTool(msg.tool, msg.args || {}, settingsNow);
        safeSend(socket, { type: 'result', id: msg.id, ok: true, data });
      } catch (e) {
        safeSend(socket, { type: 'result', id: msg.id, ok: false, error: String(e && e.message || e) });
      }
    }
  });

  socket.addEventListener('close', (ev) => {
    // A superseded socket (stopBridge or a newer connect replaced it) must
    // never schedule a reconnect: that is how two sockets end up leapfrogging
    // each other every couple of seconds.
    if (ws !== socket) return;
    ws = null;
    if (ev.code === 4001) {
      // Companion: pairing token rejected. Retrying with the same token only
      // spams its log; the minute alarm still re-runs startBridge.
      setStatus('error', {
        lastError: 'Pairing token rejected by the companion. Regenerate the token in these settings and paste it into your MCP client config.',
        port
      });
      return;
    }
    if (ev.code === 4002) {
      // Companion: replaced by a newer connection from this extension. Back
      // off fully so this instance does not fight the one that replaced it.
      reconnectDelay = RECONNECT_MAX_MS;
    }
    if (desiredEnabled) scheduleReconnect(settings);
    else setStatus('stopped');
  });

  socket.addEventListener('error', () => {
    // 'close' fires after 'error'; record the reason for the status card, but
    // keep a token-rejection message in place so it is not masked.
    if (status.state === 'error' && /token/i.test(status.lastError || '')) return;
    setStatus('error', {
      lastError: 'No companion is listening on 127.0.0.1:' + port + '. Open Claude Desktop or start a Claude Code session to launch it; the bridge reconnects on its own.',
      port
    });
  });
}

function safeSend(socket, obj) {
  try { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj)); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Tool dispatch - maps MCP tool names to the live-session primitives.
// ---------------------------------------------------------------------------

const READONLY_PREFIX = /^\s*(select|with)\b/i;
const FORBIDDEN = /\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke)\b/i;

/**
 * Tabs the bridge may act on. Multi-account mode allows any NetSuite tab;
 * otherwise only tabs belonging to the locked account, and none when no
 * account is locked.
 */
async function allowedTabs(settings) {
  const tabs = await deps.listNetSuiteTabs();
  if (settings && settings.multiAccount) return tabs;
  const locked = settings && settings.lockedAccountId;
  if (!locked) return [];
  return tabs.filter((t) => accountKeyFromUrl(t.url) === locked);
}

/** The tab to act on: the one being viewed, else the most recently used. */
async function requireTab(settings) {
  const tabs = await allowedTabs(settings);
  if (!tabs.length) {
    if (settings && !settings.multiAccount && !settings.lockedAccountId) {
      throw new Error('No NetSuite account selected. Open the TactaSuite bridge settings and either lock onto an account or turn on "Keep tool active across multiple accounts".');
    }
    if (settings && !settings.multiAccount && settings.lockedAccountId) {
      throw new Error('The locked NetSuite account (' + (settings.lockedAccountLabel || settings.lockedAccountId) + ') has no open tab. Open a tab for that account, or pick a different account in the bridge settings.');
    }
    throw new Error('No open NetSuite tab found. Open your NetSuite instance in a browser tab and try again.');
  }
  const active = tabs.find((t) => t.active);
  if (active) return active;
  // listNetSuiteTabs does not expose lastAccessed; fall back to the service
  // worker's own pick when it is allowed, else the first allowed tab.
  const preferred = await deps.findNetSuiteTab();
  if (preferred && tabs.some((t) => t.id === preferred.id)) return preferred;
  return tabs[0];
}

/**
 * Whether write actions are permitted for this tab. Writes require: NOT in
 * multi-account mode, a locked account, allowWrites enabled for it, and the tab
 * actually belonging to that locked account.
 */
function writesAllowed(settings, tab) {
  if (!settings || settings.multiAccount || !settings.lockedAccountId || !settings.allowWrites) return false;
  return accountKeyFromUrl(tab && tab.url) === settings.lockedAccountId;
}

/** Throw a clear, specific error if writes are not permitted for this tab. */
function assertWritesAllowed(settings, tab) {
  if (settings && settings.multiAccount) {
    throw new Error('Writes are disabled while "Keep tool active across multiple accounts" is on. Turn multi-account mode off and lock onto a single account to enable writes.');
  }
  if (!settings || !settings.lockedAccountId) {
    throw new Error('Writes require locking onto a specific account. Select an account in the TactaSuite bridge settings first.');
  }
  if (!settings.allowWrites) {
    throw new Error('Writes are disabled for the locked account (' + (settings.lockedAccountLabel || settings.lockedAccountId) + '). Enable "Allow writes" for it in the bridge settings.');
  }
  const key = accountKeyFromUrl(tab && tab.url);
  if (key !== settings.lockedAccountId) {
    throw new Error('This tab (' + (key || 'unknown') + ') does not belong to the locked account (' + (settings.lockedAccountLabel || settings.lockedAccountId) + ').');
  }
}

async function dispatchTool(tool, args, settings) {
  if (!deps) throw new Error('Bridge not initialised.');

  switch (tool) {
    case 'netsuite_run_suiteql': {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('A SuiteQL query is required.');
      const tab = await requireTab(settings);
      // SuiteQL runs through N/query (SELECT/WITH only) so it cannot perform DML
      // regardless; this guard stays defensive. Relax it only when writes are
      // allowed for this tab (locked account with allowWrites on, not
      // multi-account mode).
      if (!writesAllowed(settings, tab)) {
        if (!READONLY_PREFIX.test(query) || FORBIDDEN.test(query)) {
          throw new Error('Read-only: only SELECT / WITH SuiteQL queries are allowed. Lock onto an account and enable "Allow writes" to run other statements.');
        }
      }
      return deps.executeSuiteQL(tab.id, query, Array.isArray(args.params) ? args.params : null);
    }

    case 'netsuite_run_saved_search': {
      // Accept searchId (preferred) or id as an alias.
      const searchId = String(args.searchId || args.id || '').trim();
      if (!searchId) {
        throw new Error('A saved search id is required (scriptid like "customsearch_my_search" or an internal numeric id).');
      }
      // Running a saved search is inherently read-only; no write gate needed.
      const limit = Number.isFinite(args.limit) ? Number(args.limit) : null;
      const tab = await requireTab(settings);
      return deps.executeSavedSearch(tab.id, searchId, limit);
    }

    case 'netsuite_read_file': {
      const fileId = args.fileId != null && String(args.fileId).trim() ? String(args.fileId).trim() : '';
      const name = (args.path || args.name) ? String(args.path || args.name).trim() : '';
      if (!fileId && !name) {
        throw new Error('Provide fileId (internal id) or path/name of a File Cabinet file.');
      }
      const limit = Number.isFinite(args.limit) ? Number(args.limit) : null;
      const tab = await requireTab(settings);

      let whereSql, params;
      if (fileId) {
        whereSql = 'id = ?';
        params = [fileId];
      } else {
        const base = name.split('/').pop();   // match on filename or exact given string
        whereSql = 'name = ? OR name = ?';
        params = [name, base];
      }
      const meta = await deps.executeSuiteQL(
        tab.id,
        'SELECT id, name, url, filetype, documentsize FROM file WHERE ' + whereSql,
        params
      );
      const row = (meta.rows || [])[0];
      if (!row) throw new Error('No File Cabinet file found for "' + (fileId || name) + '".');
      const body = await deps.fetchFileContents(tab.id, row.url, limit);
      return {
        id: row.id,
        name: row.name,
        url: row.url,
        filetype: row.filetype,
        size: Number(row.documentsize || 0),
        matched: (meta.rows || []).length,
        content: body.content,
        length: body.length,
        truncated: body.truncated
      };
    }

    case 'netsuite_read_script': {
      const raw = String(args.scriptId || args.id || args.name || '').trim();
      if (!raw) {
        throw new Error('Provide scriptId (e.g. "customscript_foo"), internal numeric id, or exact name of a script.');
      }
      const limit = Number.isFinite(args.limit) ? Number(args.limit) : null;
      const tab = await requireTab(settings);

      const isNumeric = /^\d+$/.test(raw);
      const scriptSql = isNumeric
        ? 'SELECT id, scriptid, name, scripttype, scriptfile FROM script WHERE id = ?'
        : 'SELECT id, scriptid, name, scripttype, scriptfile FROM script WHERE UPPER(scriptid) = UPPER(?) OR UPPER(name) = UPPER(?)';
      const scriptParams = isNumeric ? [raw] : [raw, raw];

      const scriptRes = await deps.executeSuiteQL(tab.id, scriptSql, scriptParams);
      const script = (scriptRes.rows || [])[0];
      if (!script) throw new Error('No script found matching "' + raw + '".');
      if (!script.scriptfile) {
        throw new Error('Script "' + (script.scriptid || raw) + '" has no associated script file id.');
      }
      const fileRes = await deps.executeSuiteQL(
        tab.id,
        'SELECT id, name, url, filetype, documentsize FROM file WHERE id = ?',
        [script.scriptfile]
      );
      const file = (fileRes.rows || [])[0];
      if (!file) throw new Error('Script file (file id ' + script.scriptfile + ') not found in the File Cabinet.');
      const body = await deps.fetchFileContents(tab.id, file.url, limit);
      return {
        script: {
          id: script.id,
          scriptId: script.scriptid,
          name: script.name,
          scriptType: script.scripttype
        },
        file: {
          id: file.id,
          name: file.name,
          url: file.url,
          size: Number(file.documentsize || 0)
        },
        content: body.content,
        length: body.length,
        truncated: body.truncated
      };
    }

    case 'netsuite_list_scripts': {
      const tab = await requireTab(settings);
      const clauses = [];
      const params = [];
      if (args.type && String(args.type).trim()) {
        clauses.push('UPPER(scripttype) = UPPER(?)');
        params.push(String(args.type).trim());
      }
      if (args.nameLike && String(args.nameLike).trim()) {
        const like = '%' + String(args.nameLike).trim() + '%';
        clauses.push('(UPPER(name) LIKE UPPER(?) OR UPPER(scriptid) LIKE UPPER(?))');
        params.push(like, like);
      }
      if (!args.includeInactive) {
        clauses.push("isinactive = 'F'");
      }
      const where = clauses.length ? (' WHERE ' + clauses.join(' AND ')) : '';
      const limit = (Number.isFinite(args.limit) && args.limit > 0) ? Math.floor(args.limit) : 500;
      const sql =
        'SELECT * FROM (' +
          'SELECT id, scriptid, name, scripttype, apiversion, isinactive, scriptfile ' +
          'FROM script' + where + ' ORDER BY scripttype, name' +
        ') WHERE ROWNUM <= ' + limit;
      return deps.executeSuiteQL(tab.id, sql, params.length ? params : null);
    }

    case 'netsuite_create_record': {
      const type = String(args.type || '').trim();
      if (!type) throw new Error('A record type is required (e.g. "customer", "salesorder").');
      const values = (args.values && typeof args.values === 'object' && !Array.isArray(args.values)) ? args.values : null;
      if (!values || Object.keys(values).length === 0) {
        throw new Error('A non-empty "values" object (fieldId -> value) is required.');
      }
      const tab = await requireTab(settings);
      assertWritesAllowed(settings, tab);
      return deps.mutateRecord(tab.id, {
        mode: 'create',
        type,
        values,
        defaultValues: (args.defaultValues && typeof args.defaultValues === 'object') ? args.defaultValues : null,
        options: (args.options && typeof args.options === 'object') ? args.options : {}
      });
    }

    case 'netsuite_update_record': {
      const type = String(args.type || '').trim();
      if (!type) throw new Error('A record type is required.');
      const id = (args.id !== undefined && args.id !== null) ? String(args.id).trim() : '';
      if (!id) throw new Error('A record id is required.');
      const values = (args.values && typeof args.values === 'object' && !Array.isArray(args.values)) ? args.values : null;
      if (!values || Object.keys(values).length === 0) {
        throw new Error('A non-empty "values" object (fieldId -> value) is required.');
      }
      const tab = await requireTab(settings);
      assertWritesAllowed(settings, tab);
      return deps.mutateRecord(tab.id, {
        mode: 'update',
        type,
        id,
        values,
        submitFields: !!args.submitFields,
        options: (args.options && typeof args.options === 'object') ? args.options : {}
      });
    }

    case 'netsuite_get_current_page': {
      const tab = await requireTab(settings);
      const info = await deps.getPageInfo(tab.id);
      return { tabUrl: tab.url, tabTitle: tab.title, page: info };
    }

    case 'netsuite_get_current_record_fields': {
      const tab = await requireTab(settings);
      return deps.getRecordFields(tab.id);
    }

    case 'netsuite_list_tabs': {
      const tabs = await allowedTabs(settings);
      return {
        tabs,
        lockedAccountId: settings.lockedAccountId || null,
        lockedAccountLabel: settings.lockedAccountLabel || '',
        multiAccount: !!settings.multiAccount
      };
    }

    default:
      throw new Error('Unknown tool: ' + tool);
  }
}

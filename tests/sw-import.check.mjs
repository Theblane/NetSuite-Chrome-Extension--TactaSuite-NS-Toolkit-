/**
 * NetSuite TactaSuite - service worker import check
 *
 * @author Blane Maher
 *
 * Boots the unpacked extension in headless Chromium and asks the service
 * worker to dynamically import each background module, reporting the first
 * module that fails to evaluate. Also checks whether message handling works.
 * Run: node tests/sw-import.check.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(process.cwd());
const userData = path.join(ROOT, 'test-results', 'sw-profile-' + Date.now());
fs.mkdirSync(userData, { recursive: true });
const swLogs = [];
const context = await chromium.launchPersistentContext(userData, {
  channel: 'chromium', headless: true,
  args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT]
});
context.on('serviceworker', (w) => w.on('console', (m) => swLogs.push(m.type() + ': ' + m.text())));
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
sw.on('console', (m) => swLogs.push(m.type() + ': ' + m.text()));
await new Promise((r) => setTimeout(r, 1000));

const report = await sw.evaluate(async () => {
  const out = { onInstalledListeners: chrome.runtime.onInstalled.hasListeners(), onMessageListeners: chrome.runtime.onMessage.hasListeners(), imports: {} };
  for (const m of ['feature-registry.js', 'storage-manager.js', 'context-menu-manager.js', 'screenshot.js', 'bridge-client.js']) {
    try {
      const mod = await import(chrome.runtime.getURL('background/modules/' + m));
      out.imports[m] = 'ok: ' + Object.keys(mod).join(',');
    } catch (e) {
      out.imports[m] = 'FAIL: ' + (e && e.message) + (e && e.stack ? ' | ' + String(e.stack).split('\n').slice(0, 2).join(' / ') : '');
    }
  }
  try {
    const mod = await import(chrome.runtime.getURL('background/service-worker.js'));
    out.serviceWorkerImport = 'ok';
  } catch (e) {
    out.serviceWorkerImport = 'FAIL: ' + (e && e.message);
  }
  out.storage = await chrome.storage.local.get(null);
  out.storageKeys = Object.keys(out.storage);
  delete out.storage;
  return out;
});
console.log(JSON.stringify(report, null, 1));

// Message round-trip from an extension page
const page = await context.newPage();
await page.goto('chrome-extension://' + new URL(sw.url()).host + '/popup/popup.html');
const rt = await page.evaluate(() => new Promise((res) => {
  const t = setTimeout(() => res('TIMEOUT (no response)'), 4000);
  chrome.runtime.sendMessage({ action: 'getFeatures' }, (r) => { clearTimeout(t); res(chrome.runtime.lastError ? 'lastError: ' + chrome.runtime.lastError.message : (Array.isArray(r) ? 'ok: ' + r.length + ' features' : JSON.stringify(r))); });
}));
console.log('getFeatures round trip:', rt);
console.log('sw console:', swLogs.length ? swLogs : 'none');
await context.close();

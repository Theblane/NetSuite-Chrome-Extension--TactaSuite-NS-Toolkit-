/**
 * NetSuite TactaSuite - Background Service Worker
 *
 * @author Blane Maher
 *
 * No persistent in-memory state - all state in chrome.storage (MV3 best practice).
 *
 * Central coordinator for the extension. Manages feature states, handles
 * messages from popup/content scripts, sets up context menus, and controls
 * the declarativeContent rules that govern when the action icon is visible.
 */

import { FEATURES } from './modules/feature-registry.js';
import { initDefaults, getFeatureStates, setFeatureState, setFeatureStates, getMeetingMode, setMeetingMode } from './modules/storage-manager.js';
import { setupContextMenus } from './modules/context-menu-manager.js';
import { handleScreenshotMessage } from './modules/screenshot.js';
import { startBridge, stopBridge, getBridgeStatus, getBridgeSettings, setBridgeSettings, generateToken, accountKeyFromUrl, accountInfoFromKey } from './modules/bridge-client.js';
// Classic script that attaches globalThis.TactaUserTypes (shared with the
// popup, settings page and walkthrough so every preset is computed one way).
import '../shared/user-types.js';

const ONBOARDING_URL = 'onboarding/onboarding.html';
const OPTIONS_URL = 'options/options.html';

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  // First install: seed the User preset and record the choice, so the popup's
  // default selection ("User") is true the first time it opens. Nothing else
  // happens on install: no tab is opened, the walkthrough is opt-in from the
  // popup gear panel or the settings page.
  if (details.reason === 'install') {
    const UT = globalThis.TactaUserTypes;
    await chrome.storage.local.set({
      featureStates: UT.presetFor(FEATURES, UT.DEFAULT_TYPE),
      [UT.STORAGE_KEY]: UT.DEFAULT_TYPE
    });
  }

  if (details.reason === 'install' || details.reason === 'update') {
    // Persist default feature toggles for any feature not yet in storage
    // (after an update adds new features). Existing user preferences are kept.
    await initDefaults(FEATURES);
  }

  // Updated: let the popup offer the walkthrough once so new features land.
  if (details.reason === 'update') {
    const current = chrome.runtime.getManifest().version;
    if (details.previousVersion && details.previousVersion !== current) {
      await chrome.storage.local.set({ tacta_update_notice: { from: details.previousVersion, to: current } });
    }
  }

  // Context menus
  setupContextMenus();

  // DeclarativeContent - show the action icon only on *.netsuite.com pages
  setupDeclarativeContent();

  // Local bridge: reconnect if the user has it enabled.
  kickBridge();
});

// ---------------------------------------------------------------------------
// Local bridge (optional) - connect out to the desktop companion so an MCP
// client can query the live NetSuite session through the extension.
// ---------------------------------------------------------------------------

const BRIDGE_ALARM = 'tacta-bridge-reconnect';

/** Capabilities handed to the bridge client so it can run against the live tab. */
const bridgeDeps = {
  executeSuiteQL: (tabId, query, params) => executeSuiteQL(tabId, query, params),
  executeSavedSearch: (tabId, searchId, limit) => executeSavedSearch(tabId, searchId, limit),
  fetchFileContents: (tabId, url, maxChars) => fetchFileContents(tabId, url, maxChars),
  mutateRecord: (tabId, payload) => mutateRecord(tabId, payload),
  getPageInfo: (tabId) => getPageInfo(tabId),
  getRecordFields: (tabId) => nsRunInPage(tabId, feGetRecordFieldsFn, []),
  findNetSuiteTab: () => findNetSuiteTab(),
  listNetSuiteTabs: () => listNetSuiteTabs()
};

function kickBridge() {
  startBridge(bridgeDeps).catch((e) => console.warn('[TactaSuite] bridge start failed:', e));
}

// Host permissions for *.netsuite.com / *.oracle.com let us read url/title of
// those tabs without the broad "tabs" permission; query all and filter here.
const NS_TAB_RE = /^https:\/\/[^/]*\.(netsuite|oracle)\.com\//i;

async function getNetSuiteTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.url && NS_TAB_RE.test(t.url));
}

/** Find the best NetSuite tab to act on: the active one, else most recent. */
async function findNetSuiteTab() {
  const tabs = await getNetSuiteTabs();
  if (!tabs.length) return null;
  const active = tabs.find((t) => t.active);
  const chosen = active || tabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  return { id: chosen.id, url: chosen.url, title: chosen.title };
}

async function listNetSuiteTabs() {
  const tabs = await getNetSuiteTabs();
  return tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: !!t.active }));
}

/** Distinct NetSuite accounts (instances) across the currently open tabs. */
async function listNetSuiteAccounts() {
  const tabs = await getNetSuiteTabs();
  const map = new Map();
  for (const t of tabs) {
    const key = accountKeyFromUrl(t.url);
    if (!key) continue;
    if (!map.has(key)) {
      const info = accountInfoFromKey(key);
      map.set(key, { key: key, label: info.label, env: info.env, tabs: 0 });
    }
    map.get(key).tabs += 1;
  }
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

// Reconnect the bridge when the browser starts and on a periodic alarm (so a
// companion started after the service worker went idle is picked up).
chrome.runtime.onStartup.addListener(() => kickBridge());

chrome.alarms.create(BRIDGE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BRIDGE_ALARM) kickBridge();
});

// Reconnect immediately if the user toggles bridge settings in another context.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.tacta_bridge_settings) kickBridge();
});

// Cold service-worker start (any wake): attempt to reconnect if enabled.
kickBridge();

// ---------------------------------------------------------------------------
// DeclarativeContent rules
// ---------------------------------------------------------------------------

function setupDeclarativeContent() {
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: [
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostSuffix: '.netsuite.com' }
          }),
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostSuffix: '.oracle.com' }
          })
        ],
        actions: [new chrome.declarativeContent.ShowAction()]
      }
    ]);
  });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));

  // Return true to indicate an async sendResponse
  return true;
});

/**
 * Route an incoming message to the appropriate handler.
 *
 * @param {Object} message - The message payload; must include an `action` key.
 * @param {Object} sender  - Chrome message sender info (includes tab).
 * @returns {Promise<*>} Resolved value is sent back to the caller.
 */
async function handleMessage(message, sender) {
  switch (message.action) {
    // -- Feature registry -----------------------------------------------------
    case 'getFeatures':
      return FEATURES;

    // -- Feature toggles ----------------------------------------------------
    case 'getFeatureStates':
      return getFeatureStates();

    case 'setFeatureState':
      await setFeatureState(message.featureId, message.enabled);
      return { success: true };

    case 'setFeatureStates':
      await setFeatureStates(message.states);
      return { success: true };

    // -- Inject specific files for a feature (from router) ------------------
    case 'injectFeatureFiles': {
      const tabId = message.tabId || sender?.tab?.id;
      if (!tabId) throw new Error('No tab ID available');
      if (message.featureId) {
        await assertFeatureCanRun(message.featureId);
      }
      if (message.css?.length) {
        await chrome.scripting.insertCSS({ target: { tabId }, files: message.css }).catch(e => console.warn('CSS injection failed:', e));
      }
      if (message.injectScripts?.length) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['shared/ns-bridge.js'],
          world: 'MAIN'
        }).catch(() => {});
        await chrome.scripting.executeScript({
          target: { tabId },
          files: message.injectScripts,
          world: 'MAIN'
        });
      }
      if (message.js?.length) {
        await chrome.scripting.executeScript({ target: { tabId }, files: message.js });
      }
      return { success: true };
    }

    // -- On-demand feature injection ----------------------------------------
    case 'executeFeature': {
      const feature = FEATURES.find((f) => f.id === message.featureId);
      if (!feature) {
        throw new Error(`Unknown feature: ${message.featureId}`);
      }
      await assertFeatureCanRun(feature.id);
      const targetTabId = message.tabId || sender?.tab?.id;
      if (!targetTabId) throw new Error('No tab ID available');
      return executeFeatureScripts(feature, targetTabId);
    }

    // -- Meeting mode -------------------------------------------------------
    case 'getMeetingMode':
      return getMeetingMode();

    case 'setMeetingMode':
      await setMeetingMode(message.enabled);
      return { success: true };

    // -- Page info ----------------------------------------------------------
    case 'getPageInfo':
      return getPageInfo(message.tabId);

    // -- SuiteQL execution (used by script-analyzer, transaction-tree, script-explorer)
    case 'executeSuiteQL': {
      const sqlTabId = message.tabId || sender?.tab?.id;
      if (!sqlTabId) throw new Error('No tab ID available');
      return executeSuiteQL(sqlTabId, message.query, message.params);
    }

    // -- Saved search execution --------------------------------------------
    case 'executeSavedSearch': {
      const ssTabId = message.tabId || sender?.tab?.id;
      if (!ssTabId) throw new Error('No tab ID available');
      return executeSavedSearch(ssTabId, message.searchId, message.limit);
    }

    // -- File Cabinet file contents ----------------------------------------
    case 'fetchFileContents': {
      const ffTabId = message.tabId || sender?.tab?.id;
      if (!ffTabId) throw new Error('No tab ID available');
      return fetchFileContents(ffTabId, message.url, message.maxChars);
    }

    // -- Record create / update --------------------------------------------
    case 'mutateRecord': {
      const mrTabId = message.tabId || sender?.tab?.id;
      if (!mrTabId) throw new Error('No tab ID available');
      return mutateRecord(mrTabId, message.payload);
    }

    // -- Field Explorer operations (direct page-world injection) ------------
    case 'getRecordFields': {
      const feTabId = message.tabId || sender?.tab?.id;
      if (!feTabId) throw new Error('No tab ID available');
      return nsRunInPage(feTabId, feGetRecordFieldsFn, []);
    }

    case 'getSelectOptions': {
      const soTabId = message.tabId || sender?.tab?.id;
      if (!soTabId) throw new Error('No tab ID available');
      return nsRunInPage(soTabId, feGetSelectOptionsFn, [message.fieldId, message.sublistId, message.line]);
    }

    case 'setFieldValue': {
      const sfTabId = message.tabId || sender?.tab?.id;
      if (!sfTabId) throw new Error('No tab ID available');
      return nsRunInPage(sfTabId, feSetFieldValueFn, [message.fieldId, message.value, message.sublistId, message.line]);
    }

    case 'setFieldAttribute': {
      const saTabId = message.tabId || sender?.tab?.id;
      if (!saTabId) throw new Error('No tab ID available');
      return nsRunInPage(saTabId, feSetFieldAttributeFn, [message.fieldId, message.attr, message.value]);
    }

    // -- Preview Saved Search (run without saving) --------------------------
    case 'previewSavedSearch': {
      const psTabId = message.tabId || sender?.tab?.id;
      if (!psTabId) throw new Error('No tab ID available');
      return nsRunInPage(psTabId, previewSavedSearchFn, [message.searchDef]);
    }

    // -- Create Saved Search ------------------------------------------------
    case 'createSavedSearch': {
      const csTabId = message.tabId || sender?.tab?.id;
      if (!csTabId) throw new Error('No tab ID available');
      return nsRunInPage(csTabId, createSavedSearchFn, [message.searchDef, message.title]);
    }

    // -- Custom field metadata (formula, source list, definition link) -----
    case 'getCustomFieldMeta': {
      const cfTabId = message.tabId || sender?.tab?.id;
      if (!cfTabId) throw new Error('No tab ID available');
      return nsRunInPage(cfTabId, getCustomFieldMetaFn, [message.fieldId]);
    }

    // -- Source record link for select/list fields -------------------------
    case 'getFieldSourceLink': {
      const slTabId = message.tabId || sender?.tab?.id;
      if (!slTabId) throw new Error('No tab ID available');
      return nsRunInPage(slTabId, getFieldSourceLinkFn, [message.fieldId]);
    }

    // -- Extension pages ----------------------------------------------------
    case 'openOptions': {
      const hash = message.hash ? '#' + String(message.hash).replace(/^#/, '') : '';
      await chrome.tabs.create({ url: chrome.runtime.getURL(OPTIONS_URL + hash) });
      return { success: true };
    }

    case 'openOnboarding': {
      const step = message.step ? '?step=' + encodeURIComponent(message.step) : '';
      await chrome.tabs.create({ url: chrome.runtime.getURL(ONBOARDING_URL + step) });
      return { success: true };
    }

    // Send feedback form: open the composed mailto: / GitHub issue URL from
    // here rather than from the popup, because the popup closes as soon as a
    // new tab takes focus and any cleanup timer it set would die with it. A
    // mailto: tab hands off to the mail program and is left blank, so we
    // remove it shortly after.
    case 'openFeedbackTarget': {
      const url = String(message.url || '');
      if (!/^(mailto:|https:\/\/github\.com\/)/i.test(url)) return { success: false, error: 'Unsupported URL.' };
      const tab = await chrome.tabs.create({ url });
      if (/^mailto:/i.test(url) && tab && tab.id != null) {
        setTimeout(async () => {
          try {
            const fresh = await chrome.tabs.get(tab.id);
            const u = (fresh && (fresh.url || fresh.pendingUrl)) || '';
            if (!u || u === 'about:blank' || /^mailto:/i.test(u)) await chrome.tabs.remove(tab.id);
          } catch (_) { /* already closed */ }
        }, 1500);
      }
      return { success: true };
    }

    // -- Local bridge -------------------------------------------------------
    case 'getBridgeSettings': {
      const settings = await getBridgeSettings();
      const accounts = await listNetSuiteAccounts();
      return { settings, status: getBridgeStatus(), extensionId: chrome.runtime.id, accounts };
    }

    case 'setBridgeSettings': {
      const settings = await setBridgeSettings(message.settings || {});
      await startBridge(bridgeDeps);
      return { settings, status: getBridgeStatus() };
    }

    case 'getBridgeStatus':
      return getBridgeStatus();

    case 'generateBridgeToken':
      return { token: generateToken() };

    case 'restartBridge':
      await startBridge(bridgeDeps);
      return { status: getBridgeStatus() };

    case 'stopBridge':
      stopBridge();
      return { status: getBridgeStatus() };

    default: {
      // Delegated handler (Screenshot Studio). Returns undefined when the
      // action is not one of its own.
      const shotResult = await handleScreenshotMessage(message, sender);
      if (shotResult !== undefined) return shotResult;
      throw new Error(`Unrecognised action: ${message.action}`);
    }
  }
}

async function assertFeatureCanRun(featureId) {
  const feature = FEATURES.find((f) => f.id === featureId);
  if (!feature) {
    throw new Error(`Unknown feature: ${featureId}`);
  }

  if (await getMeetingMode()) {
    throw new Error('Meeting mode is enabled.');
  }

  const states = await getFeatureStates();
  const enabled = featureId in states ? states[featureId] === true : feature.defaultEnabled === true;
  if (!enabled) {
    throw new Error(`Feature is disabled: ${featureId}`);
  }
}

// ---------------------------------------------------------------------------
// SuiteQL execution (used by script-analyzer, transaction-tree, script-explorer)
// ---------------------------------------------------------------------------

async function executeSuiteQL(tabId, query, params) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('No query provided.');
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [query.trim(), params || null],
    func: (queryString, queryParams) => {
      return new Promise((resolve) => {
        if (typeof require !== 'function') {
          resolve({ error: 'NetSuite require() is not available on this page.' });
          return;
        }
        try {
          require(['N/query'], (queryModule) => {
            try {
              const startTime = performance.now();
              const PAGE_SIZE = 5000;
              const MAX_ROWS = 200000;

              const firstOpts = { query: queryString };
              if (queryParams && Array.isArray(queryParams) && queryParams.length > 0) {
                firstOpts.params = queryParams;
              }
              const firstResultSet = queryModule.runSuiteQL(firstOpts);

              let columns = [];
              if (firstResultSet.columns && firstResultSet.columns.length > 0) {
                for (let c = 0; c < firstResultSet.columns.length; c++) {
                  const col = firstResultSet.columns[c];
                  columns.push(col.label || col.alias || ('column_' + c));
                }
              }

              let allRows = firstResultSet.asMappedResults();

              if (columns.length === 0 && allRows.length > 0) {
                columns = Object.keys(allRows[0]);
              }

              if (allRows.length >= PAGE_SIZE) {
                let currentBegin = PAGE_SIZE + 1;
                let moreRecords = true;
                while (moreRecords && allRows.length < MAX_ROWS) {
                  const rowEnd = currentBegin + PAGE_SIZE - 1;
                  const pagedSql =
                    'SELECT * FROM ( SELECT ROWNUM AS rownumber__, t__.* FROM ( ' +
                    queryString +
                    ' ) t__ ) WHERE rownumber__ BETWEEN ' + currentBegin + ' AND ' + rowEnd;
                  const pageOpts = { query: pagedSql };
                  if (queryParams && Array.isArray(queryParams) && queryParams.length > 0) {
                    pageOpts.params = queryParams;
                  }
                  const pageResult = queryModule.runSuiteQL(pageOpts);
                  const pageRows = pageResult.asMappedResults();
                  for (let r = 0; r < pageRows.length; r++) {
                    delete pageRows[r].rownumber__;
                    allRows.push(pageRows[r]);
                  }
                  if (pageRows.length < PAGE_SIZE) moreRecords = false;
                  currentBegin += PAGE_SIZE;
                }
              }

              columns = columns.filter(c => c !== 'rownumber__');
              const truncated = allRows.length >= MAX_ROWS;
              const rows = truncated ? allRows.slice(0, MAX_ROWS) : allRows;
              const executionTime = Math.round(performance.now() - startTime);

              resolve({ columns, rows, count: rows.length, executionTime, truncated });
            } catch (e) {
              resolve({ error: e.message || String(e) });
            }
          }, (err) => {
            resolve({ error: 'Failed to load N/query: ' + (err?.message || String(err)) });
          });
        } catch (e) {
          resolve({ error: 'require() failed: ' + (e.message || String(e)) });
        }
      });
    }
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error('No result returned from page execution.');
  if (result.error) throw new Error(result.error);
  return result;
}

// ---------------------------------------------------------------------------
// Saved-search execution (mirror of executeSuiteQL, using N/search)
// ---------------------------------------------------------------------------

/**
 * Load an existing saved search by id/scriptid, run it in the live NetSuite
 * tab, and return { columns, rows, count, executionTime, truncated }. Read-only
 * by nature: loading and running a saved search never modifies data.
 *
 * @param {number} tabId    - Target NetSuite tab.
 * @param {string} searchId - Saved search scriptid or internal numeric id.
 * @param {number|null} limit - Optional max rows (capped at 200000).
 */
async function executeSavedSearch(tabId, searchId, limit) {
  const id = String(searchId || '').trim();
  if (!id) throw new Error('No saved search id provided.');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [id, (typeof limit === 'number' && limit > 0) ? limit : null],
    func: (searchIdArg, maxRowsArg) => {
      return new Promise((resolve) => {
        if (typeof require !== 'function') {
          resolve({ error: 'NetSuite require() is not available on this page.' });
          return;
        }
        try {
          require(['N/search'], (search) => {
            try {
              const startTime = performance.now();
              const MAX_ROWS = 200000;
              const cap = maxRowsArg ? Math.min(maxRowsArg, MAX_ROWS) : MAX_ROWS;

              const s = search.load({ id: searchIdArg });
              const searchColumns = s.columns || [];

              // Build stable, unique, human-readable column keys.
              const seen = {};
              const colKeys = searchColumns.map((c, i) => {
                if (typeof c === 'string') return c;
                let base = (c.label && String(c.label).trim())
                  || [c.name, c.join].filter(Boolean).join('.')
                  || ('column_' + i);
                if (c.summary) base += ' (' + c.summary + ')';
                let key = base;
                let n = 2;
                while (Object.prototype.hasOwnProperty.call(seen, key)) key = base + ' #' + (n++);
                seen[key] = true;
                return key;
              });

              const rows = [];
              let truncated = false;
              const paged = s.runPaged({ pageSize: 1000 });

              for (let p = 0; p < paged.pageRanges.length && !truncated; p++) {
                const page = paged.fetch({ index: paged.pageRanges[p].index });
                const data = page.data || [];
                for (let r = 0; r < data.length; r++) {
                  const rowResult = data[r];
                  const obj = {};
                  for (let ci = 0; ci < searchColumns.length; ci++) {
                    const col = searchColumns[ci];
                    let text = null, value = null;
                    try { text = rowResult.getText(col); } catch (_) {}
                    try { value = rowResult.getValue(col); } catch (_) {}
                    obj[colKeys[ci]] = (text !== null && text !== '') ? text : value;
                  }
                  rows.push(obj);
                  if (rows.length >= cap) { truncated = true; break; }
                }
              }

              const executionTime = Math.round(performance.now() - startTime);
              resolve({
                searchId: searchIdArg,
                searchType: s.searchType,
                columns: colKeys,
                rows,
                count: rows.length,
                executionTime,
                truncated
              });
            } catch (e) {
              resolve({ error: e.message || String(e) });
            }
          }, (err) => {
            resolve({ error: 'Failed to load N/search: ' + (err?.message || String(err)) });
          });
        } catch (e) {
          resolve({ error: 'require() failed: ' + (e.message || String(e)) });
        }
      });
    }
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error('No result returned from page execution.');
  if (result.error) throw new Error(result.error);
  return result;
}

// ---------------------------------------------------------------------------
// File Cabinet file contents (used to read SuiteScript source, etc.)
// ---------------------------------------------------------------------------

/**
 * Fetch a File Cabinet file's text contents from the live NetSuite session.
 * The file url comes from a SuiteQL query on the `file` table; we fetch it in
 * the page world with same-origin credentials (same approach the
 * script-content-search feature uses). Read-only.
 *
 * @param {number} tabId      - Target NetSuite tab.
 * @param {string} fileUrl    - The file's url (absolute or site-relative).
 * @param {number} [maxChars] - Optional cap on returned characters (default 1,000,000).
 * @returns {Promise<{content:string,length:number,truncated:boolean}>}
 */
async function fetchFileContents(tabId, fileUrl, maxChars) {
  const url = String(fileUrl || '').trim();
  if (!url) throw new Error('No file URL provided.');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [url, (typeof maxChars === 'number' && maxChars > 0) ? maxChars : 1000000],
    func: (fileUrlArg, cap) => {
      return new Promise((resolve) => {
        try {
          const abs = fileUrlArg.charAt(0) === '/' ? location.origin + fileUrlArg : fileUrlArg;
          fetch(abs, { credentials: 'same-origin' })
            .then((response) => {
              if (!response.ok) { resolve({ error: 'HTTP ' + response.status + ' fetching file.' }); return null; }
              return response.text();
            })
            .then((text) => {
              if (text === null || text === undefined) return;
              const truncated = text.length > cap;
              resolve({ content: truncated ? text.slice(0, cap) : text, length: text.length, truncated });
            })
            .catch((e) => resolve({ error: 'Fetch failed: ' + ((e && e.message) || String(e)) }));
        } catch (e) {
          resolve({ error: (e && e.message) || String(e) });
        }
      });
    }
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error('No result returned from page execution.');
  if (result.error) throw new Error(result.error);
  return result;
}

// ---------------------------------------------------------------------------
// Record create / update (write actions; gated in bridge-client by the account
// lock + allowWrites settings).
// ---------------------------------------------------------------------------

/**
 * Create or update a record in the live NetSuite session using N/record.
 *
 * @param {number} tabId - Target NetSuite tab.
 * @param {Object} payload
 *   payload.mode          'create' | 'update'
 *   payload.type          Record type id (e.g. 'customer', 'salesorder').
 *   payload.id            Internal id (required for update).
 *   payload.values        { fieldId: value, ... } body fields (sublists not yet supported).
 *   payload.submitFields  update only: use record.submitFields (field-only, lighter).
 *   payload.defaultValues create only: defaultValues passed to record.create.
 *   payload.options       { enableSourcing?:bool (default true), ignoreMandatoryFields?:bool }
 * @returns {Promise<{id:(number|string),type:string,mode:string,method:string}>}
 */
async function mutateRecord(tabId, payload) {
  const p = payload || {};
  if (!p.type) throw new Error('A record type is required.');
  if (p.mode === 'update' && (p.id === undefined || p.id === null || p.id === '')) {
    throw new Error('A record id is required for update.');
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [p],
    func: (payloadArg) => {
      return new Promise((resolve) => {
        if (typeof require !== 'function') {
          resolve({ error: 'NetSuite require() is not available on this page.' });
          return;
        }
        try {
          require(['N/record'], (record) => {
            try {
              const values = payloadArg.values || {};
              const opts = payloadArg.options || {};
              const saveOpts = {
                enableSourcing: opts.enableSourcing !== false,
                ignoreMandatoryFields: !!opts.ignoreMandatoryFields
              };

              // Lightweight field-only update path.
              if (payloadArg.mode === 'update' && payloadArg.submitFields) {
                const submittedId = record.submitFields({
                  type: payloadArg.type,
                  id: payloadArg.id,
                  values: values,
                  options: saveOpts
                });
                resolve({ id: submittedId || payloadArg.id, type: payloadArg.type, mode: 'update', method: 'submitFields' });
                return;
              }

              let rec;
              if (payloadArg.mode === 'create') {
                rec = record.create({ type: payloadArg.type, isDynamic: false, defaultValues: payloadArg.defaultValues || undefined });
              } else {
                rec = record.load({ type: payloadArg.type, id: payloadArg.id, isDynamic: false });
              }

              Object.keys(values).forEach((fieldId) => {
                const v = values[fieldId];
                try {
                  rec.setValue({ fieldId: fieldId, value: v });
                } catch (e1) {
                  // Fall back to setText for fields that expect display text.
                  rec.setText({ fieldId: fieldId, text: String(v) });
                }
              });

              const savedId = rec.save(saveOpts);
              resolve({ id: savedId, type: payloadArg.type, mode: payloadArg.mode, method: 'load/save' });
            } catch (e) {
              resolve({ error: (e && e.message) || String(e) });
            }
          }, (err) => {
            resolve({ error: 'Failed to load N/record: ' + ((err && err.message) || String(err)) });
          });
        } catch (e) {
          resolve({ error: 'require() failed: ' + ((e && e.message) || String(e)) });
        }
      });
    }
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error('No result returned from page execution.');
  if (result.error) throw new Error(result.error);
  return result;
}

// ---------------------------------------------------------------------------
// Generic page-world execution helper
// ---------------------------------------------------------------------------

async function nsRunInPage(tabId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args
  });
  const result = results?.[0]?.result;
  if (result === undefined) throw new Error('No result from page.');
  if (result && result.error) throw new Error(result.error);
  return result;
}

// ---------------------------------------------------------------------------
// Feature injection
// ---------------------------------------------------------------------------

/**
 * Inject a feature's content scripts into the given tab using
 * chrome.scripting.executeScript.
 *
 * @param {Object} feature - A feature descriptor from the registry.
 * @param {number} tabId   - The target tab.
 */
async function executeFeatureScripts(feature, tabId) {
  // Ensure shared dependencies are available (they may already be loaded via
  // manifest content_scripts, but executeScript is idempotent for IIFEs that
  // guard against re-initialisation).
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['shared/ns-utils.js', 'shared/storage-utils.js', 'shared/dom-utils.js']
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['shared/theme-vars.css', 'shared/tactasuite-ui.css']
  });

  // Inject feature stylesheets (ignore errors for missing files).
  if (feature.contentStyles?.length) {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: feature.contentStyles
    }).catch(() => {});
  }

  // Inject page-world scripts first (so bridge handlers are ready before
  // content scripts try to communicate with them).
  if (feature.injectScripts?.length) {
    // Inject the bridge first
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['shared/ns-bridge.js'],
      world: 'MAIN'
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: feature.injectScripts,
      world: 'MAIN'
    });
  }

  // Inject content scripts (extension world).
  if (feature.contentScripts?.length) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: feature.contentScripts
    });
  }

  // Send activation signal so the feature knows to show its UI.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (featureId) => {
      window.dispatchEvent(new CustomEvent('tacta:featureActivated', {
        detail: { featureId }
      }));
    },
    args: [feature.id]
  });

  return { success: true };
}

// ---------------------------------------------------------------------------
// Page info
// ---------------------------------------------------------------------------

/**
 * Execute the page detector inside the given tab and return the result.
 *
 * @param {number} tabId - The target tab.
 * @returns {Promise<Object>} Parsed page info.
 */
async function getPageInfo(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (typeof window.TactaPageDetector !== 'undefined') {
        return window.TactaPageDetector.detect();
      }
      return null;
    }
  });

  return results?.[0]?.result ?? null;
}

// ---------------------------------------------------------------------------
// Field Explorer page-world functions
//
// Each function below is serialised with Function.toString() and executed
// inside the NetSuite page (world: 'MAIN'), so it must be fully
// self-contained: no references to anything else in this file.
//
// Field metadata is resolved in priority order:
//   1. SuiteScript 2.x N/currentRecord. NetSuite's require() is asynchronous,
//      so the record is loaded through a Promise and the function returns a
//      Promise (chrome.scripting.executeScript awaits it).
//   2. NetSuite's own form markup: .uir-field-wrapper[data-field-type] with a
//      <fieldId>_fs_lbl label. Present in both view and edit mode.
//   3. SuiteScript 1.0 globals (nlapiGetField etc.) as a last resort. SS1
//      reports 'text' for anything it cannot classify, so its type is only
//      trusted when it also knows the field's label or the field is rendered.
// ---------------------------------------------------------------------------

function feGetRecordFieldsFn() {
  const SS2_LOAD_TIMEOUT_MS = 2500;

  function ser(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(ser);
    if (typeof v === 'object') { try { return JSON.parse(JSON.stringify(v)); } catch (_) { return String(v); } }
    return v;
  }
  function normType(t) {
    if (!t) return 'Unknown';
    const m = {
      text: 'Free-Form Text', textarea: 'Text Area', richtext: 'Rich Text', longtext: 'Long Text', clobtext: 'Long Text',
      email: 'Email', url: 'URL', phone: 'Phone', identifier: 'Identifier', identifieranycase: 'Identifier', password: 'Password',
      integer: 'Integer', posinteger: 'Integer', float: 'Decimal', posfloat: 'Decimal', nonnegfloat: 'Decimal',
      currency: 'Currency', poscurrency: 'Currency', nonnegcurrency: 'Currency', currency2: 'Currency',
      percent: 'Percent', rate: 'Rate', ratehighprecision: 'Rate', quantity: 'Quantity', posquantity: 'Quantity',
      date: 'Date', datetime: 'Date/Time', datetimetz: 'Date/Time', timeofday: 'Time of Day', duration: 'Duration',
      checkbox: 'Check Box', select: 'List/Record', multiselect: 'Multi-Select', radio: 'Radio',
      inlinehtml: 'Inline HTML', image: 'Image', file: 'Document', document: 'Document', label: 'Label', help: 'Help',
      summary: 'Summary', ccnumber: 'Credit Card Number', ccexpdate: 'Credit Card Expiration',
      ccvalidfrom: 'Credit Card Valid From', cctype: 'Credit Card Type', hidden: 'Hidden', unknown: 'Unknown'
    };
    return m[String(t).toLowerCase()] || String(t);
  }
  function cleanLabel(text) {
    return String(text || '').replace(/\s+/g, ' ').replace(/[*:]\s*$/g, '').trim();
  }
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }
  function normalizeBodyFieldId(id) {
    if (!id) return '';
    let fid = String(id);
    if (fid.indexOf('inpt_') === 0) fid = fid.substring(5);
    if (fid.indexOf('hddn_') === 0) fid = fid.substring(5);
    ['_fs_lbl_uir_label', '_lbl_uir_label', '_display', '_fs_lbl', '_label', '_lbl', '_help', '_err',
      '_popup_link', '_popup', '_arrow', '_val', '_fs', '_hdn', '_formattedValue'].some((suffix) => {
      if (fid.length > suffix.length && fid.slice(-suffix.length) === suffix) {
        fid = fid.slice(0, -suffix.length);
        return true;
      }
      return false;
    });
    if (!fid || /^(sys_|__|submitter|wfSR|nsapiPI|nsapiFC|nsapiLC|nsapiPS|nsapiVF|nsapiRC|nlapiPI|nlapiFC|nlapiLC|nlapiPS|nlapiVF|nlapiRC|hddn|uir-|tacta)/.test(fid)) return '';
    if (/row\d+$/.test(fid)) return '';
    return fid;
  }

  // -- SS2 record -----------------------------------------------------------
  function loadCurrentRecord() {
    return new Promise(function (resolve) {
      let settled = false;
      function finish(rec) { if (!settled) { settled = true; resolve(rec || null); } }
      try {
        if (typeof require !== 'function') { finish(null); return; }
        require(['N/currentRecord'], function (mod) {
          try { finish(mod && typeof mod.get === 'function' ? mod.get() : null); } catch (_) { finish(null); }
        }, function () { finish(null); });
      } catch (_) { finish(null); }
      setTimeout(function () { finish(null); }, SS2_LOAD_TIMEOUT_MS);
    });
  }

  // -- DOM helpers ----------------------------------------------------------
  function ownHidden(el) {
    if (!el) return false;
    try {
      const s = window.getComputedStyle(el);
      return s.display === 'none' || s.visibility === 'hidden';
    } catch (_) { return false; }
  }
  // Only the element and its immediate field containers are checked. Inactive
  // subtabs hide a distant ancestor, and fields on them are not "hidden".
  function isRenderedHidden(el) {
    if (!el) return false;
    if (ownHidden(el)) return true;
    const wrapper = el.closest('.uir-field-wrapper');
    if (wrapper && wrapper !== el && ownHidden(wrapper)) return true;
    const cell = el.closest('td');
    if (cell && ownHidden(cell)) return true;
    const row = el.closest('tr');
    if (row && ownHidden(row)) return true;
    return false;
  }
  // One pass over every element with an id (or form control name), bucketed by
  // the field id it belongs to. A field usually has several: label span,
  // wrapper anchor, display input, hidden value input, help link...
  function buildDomIndex() {
    const index = {};
    function put(fid, el) {
      if (!fid) return;
      if (!index[fid]) index[fid] = [];
      if (index[fid].indexOf(el) < 0) index[fid].push(el);
    }
    const withId = document.querySelectorAll('[id]');
    for (let i = 0; i < withId.length; i++) {
      const el = withId[i];
      if (el.closest('.uir-machine-table-container, .uir-sublist')) continue;
      put(normalizeBodyFieldId(el.id), el);
    }
    const named = document.querySelectorAll('#main_form input[name], #main_form select[name], #main_form textarea[name]');
    for (let n = 0; n < named.length; n++) {
      const el = named[n];
      if (el.closest('.uir-machine-table-container, .uir-sublist')) continue;
      put(normalizeBodyFieldId(el.getAttribute('name')), el);
    }
    return index;
  }
  function isControl(el) {
    const tag = String(el && el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'select' || tag === 'textarea';
  }
  function isHiddenInput(el) {
    return isControl(el) && String(el.type || '').toLowerCase() === 'hidden';
  }
  // A field is visibly rendered if ANY of its elements is shown. A hidden
  // value input (display:none by the browser) sitting next to a visible label
  // must not make the field "hidden".
  function anyRendered(candidates) {
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (isHiddenInput(el)) continue;
      if (!isRenderedHidden(el)) return true;
    }
    return false;
  }
  function wrapperFieldId(w) {
    // NetSuite stamps the field id on the wrapper itself in view mode.
    const stamped = normalizeBodyFieldId(w.getAttribute('data-field-name') || '');
    if (stamped) {
      const stampedLbl = w.querySelector('[id$="_fs_lbl"], [id$="_lbl"]');
      return { fid: stamped, lblEl: stampedLbl || null };
    }
    const selectors = ['[id$="_fs_lbl"]', '[id$="_lbl"]', '[id$="_uir_label"]'];
    for (let i = 0; i < selectors.length; i++) {
      const lblEl = w.querySelector(selectors[i]);
      if (lblEl && lblEl.id) {
        const fid = normalizeBodyFieldId(lblEl.id);
        if (fid) return { fid: fid, lblEl: lblEl };
      }
    }
    const ctrl = w.querySelector('input[id], select[id], textarea[id], [id$="_fs"], [id$="_val"]');
    if (ctrl) {
      const fid = normalizeBodyFieldId(ctrl.id);
      if (fid) return { fid: fid, lblEl: null };
    }
    return null;
  }
  // NetSuite renders every body field inside .uir-field-wrapper and stamps the
  // field type on it. This is the most reliable non-API source of type + label.
  function collectDomFields() {
    const map = {};
    const wrappers = document.querySelectorAll('.uir-field-wrapper');
    for (let i = 0; i < wrappers.length; i++) {
      const w = wrappers[i];
      if (w.closest('.uir-machine-table-container, .uir-sublist')) continue;
      const found = wrapperFieldId(w);
      if (!found) continue;
      const type = w.getAttribute('data-field-type') || '';
      let label = found.lblEl ? cleanLabel(found.lblEl.textContent) : '';
      if (!label) label = cleanLabel(w.getAttribute('data-nsps-label') || '');
      if (!label) {
        const lblFallback = w.querySelector('.smalltextnolink, .uir-label span, .uir-label, label');
        if (lblFallback) label = cleanLabel(lblFallback.textContent);
      }
      // What NetSuite rendered as the value: in view mode a .uir-field-input
      // span (list/record fields hold a link to the source record), in edit
      // mode the readonly inpt_<id> display input of a dropdown.
      let displayText = '';
      let sourceHref = '';
      let hrefId = '';
      const valueSpan = w.querySelector('.uir-field-input, .uir-field');
      if (valueSpan && !valueSpan.querySelector('input:not([type="hidden"]), select, textarea')) {
        const link = valueSpan.querySelector('a[href^="/app/"], a[href^="https://"]');
        if (link) {
          sourceHref = link.getAttribute('href') || '';
          const m = sourceHref.match(/[?&]id=(\d+)/);
          if (m) hrefId = m[1];
        }
        displayText = cleanLabel(valueSpan.textContent);
      }
      if (!displayText) {
        const inpt = w.querySelector('input[id^="inpt_"]');
        if (inpt && inpt.value) displayText = cleanLabel(inpt.value);
      }
      if (!map[found.fid]) {
        map[found.fid] = { type: type, label: label, el: w, displayText: displayText, sourceHref: sourceHref, hrefId: hrefId };
      } else {
        if (!map[found.fid].type && type) map[found.fid].type = type;
        if (!map[found.fid].label && label) map[found.fid].label = label;
        if (!map[found.fid].displayText && displayText) map[found.fid].displayText = displayText;
        if (!map[found.fid].sourceHref && sourceHref) { map[found.fid].sourceHref = sourceHref; map[found.fid].hrefId = hrefId; }
      }
    }
    return map;
  }
  // Only NetSuite's own label elements count as proof that an id is a field.
  // (label[for] is what widgets embedded in inline-HTML fields tend to use.)
  function nsLabelFor(fid) {
    const ids = [fid + '_fs_lbl', fid + '_lbl', fid + '_fs_lbl_uir_label'];
    for (let i = 0; i < ids.length; i++) {
      const el = document.getElementById(ids[i]);
      if (el) { const l = cleanLabel(el.textContent); if (l) return l; }
    }
    return '';
  }
  function domLabelFallback(fid) {
    const ids = [fid + '_fs_lbl', fid + '_lbl', fid + '_fs_lbl_uir_label'];
    for (let i = 0; i < ids.length; i++) {
      const el = document.getElementById(ids[i]);
      if (el) { const l = cleanLabel(el.textContent); if (l) return l; }
    }
    try {
      const forLbl = document.querySelector('label[for="' + cssEscape(fid) + '"], label[for="' + cssEscape(fid) + '_display"], label[for="inpt_' + cssEscape(fid) + '"]');
      if (forLbl) { const l = cleanLabel(forLbl.textContent); if (l) return l; }
    } catch (_) {}
    return '';
  }

  // -- SS1 helpers ----------------------------------------------------------
  function ss1Field(fid) {
    try { return typeof nlapiGetField === 'function' ? nlapiGetField(fid) : null; } catch (_) { return null; }
  }
  function ss1Label(f1) {
    try { return cleanLabel(f1.getLabel ? f1.getLabel() : (f1.label || '')); } catch (_) { return ''; }
  }
  function ss1Type(f1) {
    try { return String(f1.type || (f1.getType ? f1.getType() : '') || ''); } catch (_) { return ''; }
  }
  function ss1Value(fid) {
    try {
      if (typeof nlapiGetFieldValues === 'function') {
        const multi = nlapiGetFieldValues(fid);
        if (Array.isArray(multi) && multi.length > 1) return multi.join(', ');
        if (Array.isArray(multi) && multi.length === 1) return multi[0];
      }
    } catch (_) {}
    try { if (typeof nlapiGetFieldValue === 'function') return nlapiGetFieldValue(fid); } catch (_) {}
    return null;
  }
  function ss1Text(fid) {
    try {
      if (typeof nlapiGetFieldTexts === 'function') {
        const multi = nlapiGetFieldTexts(fid);
        if (Array.isArray(multi) && multi.length > 0) return multi.join(', ');
      }
    } catch (_) {}
    try { if (typeof nlapiGetFieldText === 'function') return nlapiGetFieldText(fid); } catch (_) {}
    return null;
  }
  function textOrNull(t) {
    if (t === null || t === undefined) return null;
    if (Array.isArray(t)) return t.length ? t.join(', ') : null;
    const s = String(t);
    return s === '' ? null : s;
  }

  // -- Body fields ----------------------------------------------------------
  function buildBodyFields(rec, domFields) {
    const ids = [];
    const seen = {};
    function add(id) { if (id && !seen[id]) { seen[id] = true; ids.push(id); } }

    let ss2Ids = [];
    if (rec) { try { ss2Ids = rec.getFields() || []; } catch (_) { ss2Ids = []; } }
    const ss2Usable = !!rec && ss2Ids.length > 0;

    // 1. Everything the record knows about (includes fields not on the form).
    for (let i = 0; i < ss2Ids.length; i++) add(String(ss2Ids[i]));

    // 2. Everything NetSuite rendered as a field wrapper.
    Object.keys(domFields).forEach(add);

    // 3. Raw controls without a wrapper of their own. These need positive
    //    evidence of being a field: a NetSuite label element, or API metadata
    //    with a label / non-default type. "The API returned an object" is NOT
    //    evidence: on a view-mode record both N/currentRecord.getField and
    //    nlapiGetField hand back the same stub (type 'text', empty label) for
    //    ANY id, including ids that do not exist. This keeps form plumbing
    //    (whence / nlloc / entryformquerystring), the quick-find box and the
    //    controls inside inline-HTML widgets (Sticky Notes) out of the list.
    const formHeader = document.querySelector('#main_form .uir-form-header');
    const controls = document.querySelectorAll('#main_form input[id], #main_form select[id], #main_form textarea[id]');
    for (let c = 0; c < controls.length; c++) {
      const el = controls[c];
      if (el.closest('.uir-machine-table-container, .uir-sublist')) continue;
      if (formHeader && formHeader.contains(el)) continue;
      const ctlType = String(el.type || '').toLowerCase();
      if (ctlType === 'button' || ctlType === 'submit' || ctlType === 'reset' || ctlType === 'image') continue;
      const id = normalizeBodyFieldId(el.id);
      if (!id || seen[id]) continue;
      // A control nested in another field's wrapper belongs to that field's
      // widget markup, not to the record.
      const owner = el.closest('.uir-field-wrapper');
      if (owner) {
        const ownerField = wrapperFieldId(owner);
        if (!ownerField || ownerField.fid !== id) continue;
      }
      let label = nsLabelFor(id);
      let type = '';
      if (rec) {
        try {
          const f = rec.getField({ fieldId: id });
          if (f) { if (!label) label = cleanLabel(f.label || ''); type = String(f.type || ''); }
        } catch (_) {}
      }
      if (!label && (!type || type.toLowerCase() === 'text')) {
        const f1 = ss1Field(id);
        if (f1) { label = ss1Label(f1); if (!type) type = ss1Type(f1); }
      }
      const confirmed = !!label || (!!type && type.toLowerCase() !== 'text');
      if (!confirmed) continue;
      if (ctlType === 'hidden' && !label) continue;
      add(id);
    }

    const domIndex = buildDomIndex();

    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const fid = ids[i];
      const dom = domFields[fid] || null;
      let label = '', type = '', value = null, text = null;
      let isMandatory = false, isDisabled = false, isHidden = false;
      let ss2SaysHidden = false, flagsKnown = false, hiddenBy = '';

      // SS2 field object (form-bound: null for fields not on the form)
      let f2 = null;
      if (rec) { try { f2 = rec.getField({ fieldId: fid }); } catch (_) { f2 = null; } }
      // Metadata from the stub a view-mode record returns is meaningless (type
      // 'text', empty label, isDisplay false for every id); use it only when
      // getFields() works. Values via rec.getValue/getText are fine either way.
      if (f2 && ss2Usable) {
        try { type = String(f2.type || ''); } catch (_) {}
        try { label = cleanLabel(f2.label || ''); } catch (_) {}
        try { isMandatory = !!f2.isMandatory; isDisabled = !!f2.isDisabled; flagsKnown = true; } catch (_) {}
        // View-mode stubs report isDisplay:false for everything; only trust the
        // flags when the record is really usable (getFields() works).
        try { ss2SaysHidden = ss2Usable && (f2.isDisplay === false || f2.isVisible === false); } catch (_) {}
      }

      // NetSuite markup
      if (!type && dom && dom.type) type = dom.type;
      if (!label && dom && dom.label) label = dom.label;

      // Every element that belongs to this field
      const candidates = (domIndex[fid] || []).slice();
      if (dom && dom.el && candidates.indexOf(dom.el) < 0) candidates.unshift(dom.el);
      const domEl = candidates.length ? candidates[0] : null;

      // SS1 (last resort). Its 'text' default is only trusted with corroboration.
      const f1 = ss1Field(fid);
      if (f1) {
        const l1 = ss1Label(f1);
        if (!label && l1) label = l1;
        if (!type) {
          const t1 = ss1Type(f1);
          if (t1 && (t1.toLowerCase() !== 'text' || l1 || domEl)) type = t1;
        }
        if (!flagsKnown) {
          try { isMandatory = f1.isMandatory ? !!f1.isMandatory() : !!f1.required; } catch (_) {}
          try { isDisabled = f1.isDisabled ? !!f1.isDisabled() : !!f1.disabled; } catch (_) {}
          flagsKnown = true;
        }
      }
      if (!label) label = domLabelFallback(fid);

      // Hidden. The rendered page is the deciding vote:
      //   - anything belonging to the field is visibly rendered  => not hidden
      //   - the field has elements but all are collapsed         => hidden (DOM)
      //   - nothing in the DOM, SS2 has a form-bound field object => trust SS2 flags
      //   - nothing in the DOM and SS2 has no field object        => not on this form
      if (candidates.length > 0) {
        if (anyRendered(candidates)) {
          isHidden = false;
        } else {
          isHidden = true;
          hiddenBy = 'dom';
        }
      } else if (f2 && ss2Usable) {
        isHidden = ss2SaysHidden;
        if (isHidden) hiddenBy = 'ss2';
      } else {
        isHidden = true;
        hiddenBy = 'not-on-form';
      }
      // Disabled from DOM only for real, visible controls. Readonly is NOT
      // disabled: NetSuite dropdowns render as readonly text inputs.
      if (!isDisabled) {
        for (let c = 0; c < candidates.length; c++) {
          if (isControl(candidates[c]) && !isHiddenInput(candidates[c]) && candidates[c].disabled) { isDisabled = true; break; }
        }
      }

      // Values: SS2 first, SS1 fallback
      if (rec) {
        try { value = ser(rec.getValue({ fieldId: fid })); } catch (_) { value = null; }
        try { text = textOrNull(rec.getText({ fieldId: fid })); } catch (_) { text = null; }
      }
      if (value === null) value = ss1Value(fid);
      if (text === null) text = textOrNull(ss1Text(fid));
      // View mode: the APIs return nothing, but NetSuite rendered the display
      // text (and, for list/record fields, a link whose id= is the value).
      if (dom) {
        if ((value === null || value === undefined || value === '') && dom.hrefId) value = dom.hrefId;
        if ((text === null || text === '') && dom.displayText) text = dom.displayText;
      }
      if (Array.isArray(value)) value = value.join(', ');
      if (value !== null && typeof value === 'object') { try { value = JSON.stringify(value); } catch (_) { value = String(value); } }
      if (text !== null && value !== null && String(text) === String(value)) text = null;

      out.push({
        id: fid,
        label: label,
        type: normType(type),
        value: value === undefined ? null : value,
        text: text,
        isMandatory: isMandatory,
        isDisabled: isDisabled,
        isHidden: isHidden,
        hiddenBy: isHidden ? hiddenBy : null,
        sourceUrl: dom && dom.sourceHref ? dom.sourceHref : null
      });
    }
    return out;
  }

  // -- Sublists -------------------------------------------------------------
  function lineCountOf(rec, name) {
    if (rec) {
      try { const c = rec.getLineCount({ sublistId: name }); if (typeof c === 'number' && c >= 0) return c; } catch (_) {}
    }
    try {
      if (typeof nlapiGetLineItemCount === 'function') {
        const c = nlapiGetLineItemCount(name);
        if (typeof c === 'number' && c >= 0) return c;
      }
    } catch (_) {}
    return -1;
  }
  function discoverSublists(rec) {
    const ids = [];
    const seen = {};
    function add(name, requireLines) {
      if (!name || seen[name]) return;
      const c = lineCountOf(rec, name);
      if (c < 0 || (requireLines && c === 0)) return;
      seen[name] = true;
      ids.push(name);
    }

    // Authoritative list from the record itself
    if (rec) {
      try { (rec.getSublists() || []).forEach((s) => add(String(s), false)); } catch (_) {}
      if (ids.length > 0) return ids;
    }

    // DOM strategies (verified against the APIs)
    document.querySelectorAll('.uir-machine-table-container[id]').forEach((el) => {
      const m = el.id.match(/^(.+?)_splits$/);
      if (m && m[1]) add(m[1], false);
    });
    document.querySelectorAll('[id$="_subtab"], [id$="subtab"]').forEach((el) => {
      const m = el.id.match(/^(.+?)_?subtab$/);
      if (m && m[1]) add(m[1], false);
    });
    document.querySelectorAll('div[id^="div__body"]').forEach((el) => {
      const name = el.id.replace(/^div__body/, '').replace(/tab$/, '');
      if (name) add(name, false);
    });
    document.querySelectorAll('.uir-machine-headerrow').forEach((el) => {
      const table = el.closest('table[id]');
      if (table) {
        const m = table.id.match(/^(.+?)(?:_splits|_layer|header)$/);
        if (m && m[1]) add(m[1], false);
      }
    });
    // Guesses: only kept when they actually have lines
    ['item', 'line', 'expense', 'apply', 'deposit', 'partners', 'salesteam', 'addressbook', 'links',
      'mediaitem', 'payment', 'contacts', 'inventoryassignment', 'billingschedule', 'installment'
    ].forEach((n) => add(n, true));
    return ids;
  }
  function headerLabels(slId) {
    const labels = {};
    const container = document.getElementById(slId + '_splits') || document.getElementById(slId + '_layer');
    if (!container) return labels;
    container.querySelectorAll('.uir-machine-headerrow td, .uir-list-headerrow td').forEach((td) => {
      let hid = td.getAttribute('data-nsps-id') || td.getAttribute('data-field') || '';
      if (!hid) return;
      hid = hid.replace(/^columnsheader_/, '');
      if (hid.indexOf(slId + '_') === 0) hid = hid.substring(slId.length + 1);
      if (!hid) return;
      const lbl = cleanLabel(td.getAttribute('data-nsps-label') || td.textContent);
      if (!labels[hid]) labels[hid] = lbl;
    });
    return labels;
  }
  function buildSublists(rec) {
    const sublists = {};
    discoverSublists(rec).forEach((slId) => {
      const lc = Math.max(0, lineCountOf(rec, slId));
      const labels = headerLabels(slId);
      const ids = [];
      const seen = {};
      function add(id) { if (id && !seen[id]) { seen[id] = true; ids.push(id); } }

      if (rec) { try { (rec.getSublistFields({ sublistId: slId }) || []).forEach((f) => add(String(f))); } catch (_) {} }
      Object.keys(labels).forEach(add);
      if (ids.length === 0) {
        const firstRow = document.querySelector('#' + slId + '_splits .uir-machine-row-odd, #' + slId + '_splits .uir-machine-row-even, #' + slId + 'row0');
        if (firstRow) {
          firstRow.querySelectorAll('input[id], select[id], textarea[id], span[id]').forEach((inp) => {
            const fName = inp.id.replace(new RegExp('^' + slId + '_'), '').replace(/_\d+$/, '').replace(/_display$/, '').replace(/_formattedValue$/, '');
            if (fName && fName !== slId) add(fName);
          });
        }
      }

      const hasHeaderInfo = Object.keys(labels).length > 0;
      const fields = ids.map((f) => {
        const meta = { id: f, label: labels[f] || '', type: 'Unknown', value: null, text: null, isMandatory: false, isDisabled: false, isHidden: false, hiddenBy: null };
        let sf = null;
        if (rec) {
          if (lc > 0) { try { sf = rec.getSublistField({ sublistId: slId, fieldId: f, line: 0 }); } catch (_) { sf = null; } }
          if (!sf && typeof rec.getCurrentSublistField === 'function') {
            try { sf = rec.getCurrentSublistField({ sublistId: slId, fieldId: f }); } catch (_) { sf = null; }
          }
        }
        if (sf) {
          try { if (sf.type) meta.type = normType(sf.type); } catch (_) {}
          try { if (sf.label) meta.label = cleanLabel(sf.label); } catch (_) {}
          try { meta.isMandatory = !!sf.isMandatory; meta.isDisabled = !!sf.isDisabled; } catch (_) {}
        }
        // Hidden column: a rendered header cell is the deciding vote. Only when
        // NetSuite drew no header cells at all do the SS2 flags get a say.
        if (hasHeaderInfo) {
          if (!labels.hasOwnProperty(f)) { meta.isHidden = true; meta.hiddenBy = 'dom'; }
        } else if (sf) {
          try { if (sf.isDisplay === false || sf.isVisible === false) { meta.isHidden = true; meta.hiddenBy = 'ss2'; } } catch (_) {}
        }
        if (!sf && lc > 0) {
          try {
            if (typeof nlapiGetLineItemField === 'function') {
              const lf = nlapiGetLineItemField(slId, f, 1);
              if (lf) {
                const t1 = ss1Type(lf);
                const l1 = ss1Label(lf);
                if (!meta.label && l1) meta.label = l1;
                if (t1 && (t1.toLowerCase() !== 'text' || l1 || meta.label)) meta.type = normType(t1);
              }
            }
          } catch (_) {}
        }
        if (lc > 0) {
          if (rec) {
            try { meta.value = ser(rec.getSublistValue({ sublistId: slId, fieldId: f, line: 0 })); } catch (_) {}
            try { meta.text = textOrNull(rec.getSublistText({ sublistId: slId, fieldId: f, line: 0 })); } catch (_) {}
          }
          if (meta.value === null) { try { if (typeof nlapiGetLineItemValue === 'function') meta.value = nlapiGetLineItemValue(slId, f, 1); } catch (_) {} }
          if (meta.text === null) { try { if (typeof nlapiGetLineItemText === 'function') meta.text = textOrNull(nlapiGetLineItemText(slId, f, 1)); } catch (_) {} }
          if (Array.isArray(meta.value)) meta.value = meta.value.join(', ');
          if (meta.text !== null && meta.value !== null && String(meta.text) === String(meta.value)) meta.text = null;
        }
        return meta;
      });

      sublists[slId] = { fields: fields, lineCount: lc };
    });
    return sublists;
  }

  // -- Main -----------------------------------------------------------------
  return loadCurrentRecord().then(function (rec) {
    const result = { bodyFields: [], sublists: {}, meta: { ss2: !!rec, recordType: null, recordId: null } };
    try { if (rec) { result.meta.recordType = rec.type || null; result.meta.recordId = rec.id || null; } } catch (_) {}
    if (!result.meta.recordType) {
      try { if (typeof nlapiGetRecordType === 'function') result.meta.recordType = nlapiGetRecordType() || null; } catch (_) {}
      try { if (typeof nlapiGetRecordId === 'function') result.meta.recordId = nlapiGetRecordId() || null; } catch (_) {}
    }
    try {
      const domFields = collectDomFields();
      result.bodyFields = buildBodyFields(rec, domFields);
    } catch (e) {
      result.meta.bodyError = e && e.message ? e.message : String(e);
    }
    try {
      result.sublists = buildSublists(rec);
    } catch (e) {
      result.meta.sublistError = e && e.message ? e.message : String(e);
    }
    return result;
  }).catch(function (e) {
    return { error: 'Field scan failed: ' + (e && e.message ? e.message : String(e)) };
  });
}

function feGetSelectOptionsFn(fieldId, sublistId, line) {
  if (!fieldId) return { fieldId: fieldId, options: [] };
  const lineIdx = (line !== null && line !== undefined) ? Number(line) : 0;

  function push(list, v, t) {
    if (v === null || v === undefined || v === '') return;
    list.push({ value: String(v), text: (t !== null && t !== undefined && t !== '') ? String(t) : String(v) });
  }
  function fromDom() {
    const options = [];
    if (sublistId) return options;
    try {
      const dropdown = document.querySelector('.ns-dropdown[data-name="' + fieldId + '"]');
      const dataOpts = dropdown ? dropdown.getAttribute('data-options') : null;
      if (dataOpts) {
        const parsed = JSON.parse(dataOpts);
        for (let i = 0; i < parsed.length; i++) push(options, parsed[i].value, parsed[i].text);
      }
    } catch (_) {}
    if (options.length === 0) {
      try {
        const inpt = document.getElementsByName('inpt_' + fieldId)[0];
        if (inpt && typeof getDropdown === 'function') {
          const dd = getDropdown(inpt);
          if (dd && dd.valueArray) {
            for (let i = 0; i < dd.valueArray.length; i++) push(options, dd.valueArray[i], dd.textArray ? dd.textArray[i] : null);
          }
        }
      } catch (_) {}
    }
    return options;
  }
  function fromSS1() {
    const options = [];
    try {
      let f = null;
      if (sublistId && typeof nlapiGetLineItemField === 'function') f = nlapiGetLineItemField(sublistId, fieldId, lineIdx + 1);
      else if (!sublistId && typeof nlapiGetField === 'function') f = nlapiGetField(fieldId);
      if (f && typeof f.getSelectOptions === 'function') {
        const raw = f.getSelectOptions() || [];
        for (let i = 0; i < raw.length; i++) push(options, raw[i].getId(), raw[i].getText());
      }
    } catch (_) {}
    return options;
  }
  function fromSS2() {
    return new Promise(function (resolve) {
      let settled = false;
      function finish(list) { if (!settled) { settled = true; resolve(list || []); } }
      try {
        if (typeof require !== 'function') { finish([]); return; }
        require(['N/currentRecord'], function (mod) {
          const options = [];
          try {
            const rec = mod.get();
            let field = null;
            if (sublistId) {
              try { field = rec.getSublistField({ sublistId: sublistId, fieldId: fieldId, line: lineIdx }); } catch (_) { field = null; }
              if (!field && typeof rec.getCurrentSublistField === 'function') {
                try { field = rec.getCurrentSublistField({ sublistId: sublistId, fieldId: fieldId }); } catch (_) { field = null; }
              }
            } else {
              field = rec.getField({ fieldId: fieldId });
            }
            if (field && typeof field.getSelectOptions === 'function') {
              let raw = null;
              try { raw = field.getSelectOptions({}); } catch (_) { raw = field.getSelectOptions(); }
              for (let i = 0; i < (raw || []).length; i++) push(options, raw[i].value, raw[i].text);
            }
          } catch (_) {}
          finish(options);
        }, function () { finish([]); });
      } catch (_) { finish([]); }
      setTimeout(function () { finish([]); }, 8000);
    });
  }

  const domOptions = fromDom();
  if (domOptions.length > 0) return { fieldId: fieldId, options: domOptions };
  return fromSS2().then(function (ss2Options) {
    if (ss2Options.length > 0) return { fieldId: fieldId, options: ss2Options };
    return { fieldId: fieldId, options: fromSS1() };
  });
}

function feSetFieldValueFn(fieldId, value, sublistId, line) {
  if (!fieldId) return { error: 'fieldId required' };

  function ser(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return String(v); } }
    return v;
  }
  // The UI sends strings; SS2 setValue wants typed values.
  function coerce(fieldType, raw) {
    const t = String(fieldType || '').toLowerCase();
    const s = raw === null || raw === undefined ? '' : String(raw);
    if (t === 'checkbox') return /^(t|true|1|yes|y)$/i.test(s.trim());
    if (t === 'multiselect') return s.trim() === '' ? [] : s.split(',').map((x) => x.trim()).filter(Boolean);
    if (/^(integer|posinteger|float|posfloat|nonnegfloat|currency|poscurrency|nonnegcurrency|currency2|percent|rate|ratehighprecision|quantity|posquantity)$/.test(t)) {
      const n = Number(s.replace(/[,\s]/g, ''));
      return isNaN(n) ? s : n;
    }
    if (/^(date|datetime|datetimetz)$/.test(t)) {
      const d = new Date(s);
      return isNaN(d.getTime()) ? s : d;
    }
    return s;
  }
  function viaSS1() {
    try {
      if (sublistId && line !== null && line !== undefined && typeof nlapiSetLineItemValue === 'function') {
        nlapiSetLineItemValue(sublistId, fieldId, Number(line) + 1, value);
        const newValue = typeof nlapiGetLineItemValue === 'function' ? nlapiGetLineItemValue(sublistId, fieldId, Number(line) + 1) : value;
        const newText = typeof nlapiGetLineItemText === 'function' ? nlapiGetLineItemText(sublistId, fieldId, Number(line) + 1) : null;
        return { success: true, fieldId: fieldId, newValue: newValue, newText: newText };
      }
      if (!sublistId && typeof nlapiSetFieldValue === 'function') {
        let v = value;
        if (typeof v === 'boolean') v = v ? 'T' : 'F';
        else if (/^(true|false)$/i.test(String(v || ''))) v = /^true$/i.test(String(v)) ? 'T' : 'F';
        nlapiSetFieldValue(fieldId, v, true, false);
        const newValue = typeof nlapiGetFieldValue === 'function' ? nlapiGetFieldValue(fieldId) : v;
        const newText = typeof nlapiGetFieldText === 'function' ? nlapiGetFieldText(fieldId) : null;
        return { success: true, fieldId: fieldId, newValue: newValue, newText: newText };
      }
    } catch (e) { return { error: e.message || String(e) }; }
    return { error: 'No NetSuite API available to set field value' };
  }

  // Sublist lines: SS1 is simpler and does not disturb the current line.
  if (sublistId) return viaSS1();

  return new Promise(function (resolve) {
    let settled = false;
    function finish(r) { if (!settled) { settled = true; resolve(r); } }
    try {
      if (typeof require !== 'function') { finish(viaSS1()); return; }
      require(['N/currentRecord'], function (mod) {
        try {
          const rec = mod.get();
          let field = null;
          try { field = rec.getField({ fieldId: fieldId }); } catch (_) { field = null; }
          if (!field) { finish(viaSS1()); return; }
          rec.setValue({ fieldId: fieldId, value: coerce(field.type, value), ignoreFieldChange: false });
          let newText = null;
          try { newText = rec.getText({ fieldId: fieldId }); } catch (_) {}
          finish({ success: true, fieldId: fieldId, newValue: ser(rec.getValue({ fieldId: fieldId })), newText: ser(newText) });
        } catch (e) {
          finish({ error: e.message || String(e) });
        }
      }, function () { finish(viaSS1()); });
    } catch (_) { finish(viaSS1()); }
    setTimeout(function () { finish(viaSS1()); }, 4000);
  });
}

function feSetFieldAttributeFn(fieldId, attr, value) {
  if (!fieldId || !attr) return { error: 'fieldId and attr required' };
  try {
    if (attr === 'mandatory') {
      if (typeof nlapiSetFieldMandatory === 'function') {
        nlapiSetFieldMandatory(fieldId, !!value);
        return { success: true, fieldId, attr, value: !!value };
      }
    } else if (attr === 'disabled') {
      if (typeof nlapiSetFieldDisabled === 'function') {
        nlapiSetFieldDisabled(fieldId, !!value);
        return { success: true, fieldId, attr, value: !!value };
      }
    }
  } catch(e) { return { error: e.message }; }
  return { error: 'API not available for ' + attr };
}

// ---------------------------------------------------------------------------
// Saved Search preview (page-world function for nsRunInPage)
// ---------------------------------------------------------------------------

function previewSavedSearchFn(searchDef) {
    return new Promise((resolve) => {
        if (typeof require !== 'function') {
            resolve({ error: 'NetSuite require() is not available on this page.' });
            return;
        }
        try {
            require(['N/search'], (searchModule) => {
                try {
                    const searchObj = searchModule.create({
                        type: searchDef.type,
                        filters: searchDef.filters || [],
                        columns: (searchDef.columns || []).map(col => {
                            const colDef = { name: col.name };
                            if (col.join) colDef.join = col.join;
                            if (col.summary) colDef.summary = searchModule.Summary[col.summary];
                            if (col.formula) colDef.formula = col.formula;
                            if (col.formulatype) colDef.formulaType = col.formulatype;
                            if (col.sort) colDef.sort = searchModule.Sort[col.sort];
                            if (col.label) colDef.label = col.label;
                            return searchModule.createColumn(colDef);
                        })
                    });

                    const results = [];
                    const columns = [];
                    let colsBuilt = false;
                    const MAX_PREVIEW = 500;

                    const pagedData = searchObj.runPaged({ pageSize: 1000 });

                    if (pagedData.count === 0) {
                        // Build columns from definition
                        for (const col of searchDef.columns || []) {
                            columns.push(col.label || col.name);
                        }
                        resolve({ columns, rows: [], count: 0 });
                        return;
                    }

                    pagedData.pageRanges.forEach(function(pageRange) {
                        if (results.length >= MAX_PREVIEW) return;
                        const page = pagedData.fetch({ index: pageRange.index });
                        page.data.forEach(function(result) {
                            if (results.length >= MAX_PREVIEW) return;
                            const row = {};
                            searchObj.columns.forEach(function(col, idx) {
                                const key = col.label || col.name;
                                if (!colsBuilt) columns.push(key);
                                const val = result.getValue(col);
                                const txt = result.getText(col);
                                row[key] = txt || val;
                            });
                            colsBuilt = true;
                            results.push(row);
                        });
                    });

                    resolve({ columns, rows: results, count: pagedData.count, truncated: pagedData.count > MAX_PREVIEW });
                } catch (e) {
                    resolve({ error: e.message || String(e) });
                }
            }, (err) => {
                resolve({ error: 'Failed to load N/search: ' + (err?.message || String(err)) });
            });
        } catch (e) {
            resolve({ error: 'require() failed: ' + (e.message || String(e)) });
        }
    });
}

// ---------------------------------------------------------------------------
// Saved Search creation (page-world function for nsRunInPage)
// ---------------------------------------------------------------------------

function createSavedSearchFn(searchDef, title) {
    return new Promise((resolve) => {
        if (typeof require !== 'function') {
            resolve({ error: 'NetSuite require() is not available on this page.' });
            return;
        }
        try {
            require(['N/search'], (searchModule) => {
                try {
                    const searchObj = searchModule.create({
                        type: searchDef.type,
                        title: title,
                        filters: searchDef.filters || [],
                        columns: (searchDef.columns || []).map(col => {
                            const colDef = { name: col.name };
                            if (col.join) colDef.join = col.join;
                            if (col.summary) colDef.summary = searchModule.Summary[col.summary];
                            if (col.formula) colDef.formula = col.formula;
                            if (col.formulatype) colDef.formulaType = col.formulatype;
                            if (col.sort) colDef.sort = searchModule.Sort[col.sort];
                            if (col.label) colDef.label = col.label;
                            return searchModule.createColumn(colDef);
                        })
                    });

                    const savedId = searchObj.save();
                    resolve({ id: savedId, success: true });
                } catch (e) {
                    resolve({ error: e.message || String(e) });
                }
            }, (err) => {
                resolve({ error: 'Failed to load N/search: ' + (err?.message || String(err)) });
            });
        } catch (e) {
            resolve({ error: 'require() failed: ' + (e.message || String(e)) });
        }
    });
}

// ---------------------------------------------------------------------------
// Custom field metadata (formula, source list, definition link)
// ---------------------------------------------------------------------------

function getCustomFieldMetaFn(fieldId) {
  if (!fieldId) return { error: 'fieldId required' };

  // Determine custom field type by prefix
  var defPage = null;
  if (fieldId.substring(0, 8) === 'custbody') {
    defPage = 'bodycustfields';
  } else if (fieldId.substring(0, 10) === 'custentity') {
    defPage = 'entitycustfields';
  } else if (fieldId.substring(0, 8) === 'custitem') {
    defPage = 'itemcustfields';
  } else if (fieldId.substring(0, 8) === 'custevent') {
    defPage = 'eventcustfields';
  } else if (fieldId.substring(0, 7) === 'custcol') {
    defPage = 'columncustfields';
  } else if (fieldId.substring(0, 10) === 'custrecord') {
    // Custom record fields - need the record type context
    return Promise.resolve({ fieldId: fieldId, isCustom: true, customType: 'customrecord', defPage: null });
  } else {
    return Promise.resolve({ fieldId: fieldId, isCustom: false });
  }

  return new Promise(function(resolve) {
    var xhr = new XMLHttpRequest();
    xhr.onload = function() {
      var result = { fieldId: fieldId, isCustom: true, customType: defPage };
      try {
        var html = xhr.responseText;
        if (!html) { resolve(result); return; }

        // Find the field in the list page HTML
        var fieldIndex = html.indexOf('>' + fieldId + '<');
        if (fieldIndex <= 0) { resolve(result); return; }

        // Extract the link to the field definition (3 <td> cells back from the field ID)
        var tdIndex = html.lastIndexOf('<td', fieldIndex);
        tdIndex = html.lastIndexOf('<td', tdIndex - 1);
        tdIndex = html.lastIndexOf('<td', tdIndex - 1);
        var linkEnd = html.indexOf('<', tdIndex + 4);
        var linkHtml = html.substring(tdIndex, linkEnd + 4);

        // Extract href from the link
        var hrefMatch = linkHtml.match(/href="([^"]+)"/);
        if (hrefMatch && hrefMatch[1]) {
          result.definitionUrl = hrefMatch[1];
          // Extract field label from the link text
          var labelMatch = linkHtml.match(/>([^<]+)</);
          if (labelMatch) result.definitionLabel = labelMatch[1].trim();
        }

        // Extract field type (2 <td> cells after the field ID)
        var afterFieldId = html.indexOf('<td', fieldIndex + 1);
        afterFieldId = html.indexOf('<td', afterFieldId + 1);
        if (afterFieldId > 0) {
          var typeStart = html.indexOf('>', afterFieldId) + 1;
          var typeEnd = html.indexOf('</td>', typeStart);
          if (typeEnd > typeStart) {
            result.customFieldType = html.substring(typeStart, typeEnd).replace(/<[^>]+>/g, '').trim();
          }
        }

        // If we have a definition URL, fetch the XML to get formula and source list info
        if (result.definitionUrl) {
          var xmlXhr = new XMLHttpRequest();
          xmlXhr.onload = function() {
            try {
              var xmlText = xmlXhr.responseText;
              if (xmlText) {
                var parser = new DOMParser();
                var xmlDoc = parser.parseFromString(xmlText, 'text/xml');
                if (xmlDoc) {
                  // Check if it's a formula field
                  var isFormulaEl = xmlDoc.getElementsByTagName('isformula')[0];
                  if (isFormulaEl && isFormulaEl.textContent === 'T') {
                    result.isFormula = true;
                    var defaultValEl = xmlDoc.getElementsByTagName('defaultvalue')[0];
                    if (defaultValEl) result.formula = defaultValEl.textContent;
                  }

                  // Check for static list (custom list)
                  var staticListEl = xmlDoc.getElementsByTagName('staticlistrecordtype')[0];
                  if (staticListEl && staticListEl.textContent && parseInt(staticListEl.textContent) > 0) {
                    result.sourceListId = staticListEl.textContent;
                    result.sourceListUrl = '/app/common/custom/custlist.nl?id=' + staticListEl.textContent + '&e=T&ord=T';
                  }

                  // Check for select record type (custom record)
                  var selectRecTypeEl = xmlDoc.getElementsByTagName('selectrecordtype')[0];
                  if (selectRecTypeEl && selectRecTypeEl.textContent && parseInt(selectRecTypeEl.textContent) > 0) {
                    result.sourceRecordTypeId = selectRecTypeEl.textContent;
                    result.sourceRecordUrl = '/app/common/custom/custrecordentrylist.nl?rectype=' + selectRecTypeEl.textContent;
                  }

                  // Check for help text / description
                  var helpEl = xmlDoc.getElementsByTagName('help')[0];
                  if (helpEl && helpEl.textContent) {
                    result.helpText = helpEl.textContent.trim();
                  }
                }
              }
            } catch(_) {}
            resolve(result);
          };
          xmlXhr.onerror = function() { resolve(result); };
          xmlXhr.open('GET', result.definitionUrl + '&xml=T');
          xmlXhr.send();
        } else {
          resolve(result);
        }
      } catch(_) {
        resolve(result);
      }
    };
    xhr.onerror = function() {
      resolve({ fieldId: fieldId, isCustom: true, customType: defPage });
    };
    xhr.open('GET', '/app/common/custom/' + defPage + '.nl?frame=B&segment=1%01000%01%021000');
    xhr.send();
  });
}

// ---------------------------------------------------------------------------
// Source record link for select/list fields
// ---------------------------------------------------------------------------

function getFieldSourceLinkFn(fieldId) {
  if (!fieldId) return { fieldId: fieldId, sourceUrl: null };

  var result = { fieldId: fieldId, sourceUrl: null, sourceLabel: null, direct: false };

  // Method 0: In view mode NetSuite renders list/record values as a link to
  // the source record. That link is complete (includes id=), so use it as is.
  try {
    var wrapper = document.querySelector('.uir-field-wrapper[data-field-name="' + fieldId + '"]');
    if (!wrapper) {
      var lblEl = document.getElementById(fieldId + '_fs_lbl');
      wrapper = lblEl ? lblEl.closest('.uir-field-wrapper') : null;
    }
    if (wrapper) {
      var valueLink = wrapper.querySelector('.uir-field-input a[href^="/app/"], .uir-field a[href^="/app/"]');
      if (valueLink) {
        result.sourceUrl = valueLink.getAttribute('href');
        result.sourceLabel = (valueLink.textContent || '').trim();
        result.direct = true;
        return result;
      }
    }
  } catch(_) {}

  // Method 1: Try the Sync function pattern (reference extension approach)
  try {
    var syncFn = window['Sync' + fieldId];
    if (syncFn) {
      var fnStr = syncFn.toString();
      var openIdx = fnStr.indexOf('nlOpenWindow(');
      if (openIdx > 0) {
        var quoteStart = fnStr.indexOf("'", openIdx + 13);
        var quoteEnd = fnStr.indexOf("'", quoteStart + 1);
        if (quoteStart > 0 && quoteEnd > quoteStart) {
          var url = fnStr.substring(quoteStart + 1, quoteEnd);
          result.sourceUrl = url.replace('target', 'target_');
        }
      }
    }
  } catch(_) {}

  // Method 2: Check for a visible link/icon next to the field
  if (!result.sourceUrl) {
    try {
      // NS often puts a popup link near select fields
      var el = document.getElementById(fieldId + '_popup_link') ||
               document.getElementById(fieldId + '_popup') ||
               document.querySelector('a[id*="' + fieldId + '"][onclick*="nlOpenWindow"]');
      if (el) {
        var onclick = el.getAttribute('onclick') || '';
        var urlMatch = onclick.match(/nlOpenWindow\('([^']+)'/);
        if (urlMatch) {
          result.sourceUrl = urlMatch[1].replace('target', 'target_');
        }
      }
    } catch(_) {}
  }

  // Method 3: For the current value, try to build a direct link
  if (!result.sourceUrl) {
    try {
      var currentVal = typeof nlapiGetFieldValue === 'function' ? nlapiGetFieldValue(fieldId) : null;
      var field = typeof nlapiGetField === 'function' ? nlapiGetField(fieldId) : null;
      if (currentVal && field) {
        // If the field is a record reference and we have an internal ID, we can build a link
        // but we'd need the record type which we don't reliably have
        result.currentValueId = currentVal;
      }
    } catch(_) {}
  }

  return result;
}

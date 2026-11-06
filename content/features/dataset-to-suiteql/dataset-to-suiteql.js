/**
 * dataset-to-suiteql.js
 * NetSuite TactaSuite - Dataset to SuiteQL (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Adds a "Get SuiteQL" toolbar button on Analytics dataset and workbook
 * pages. Clicking it asks the MAIN-world client
 * (dataset-to-suiteql-client.js) to run
 *   require(['N/query'], q => q.load({ id }).toSuiteQL())
 * and shows the resulting SQL in a toolkit panel with Copy and
 * "Open in SuiteQL Runner" actions.
 *
 * Dataset id resolution:
 *   - URL "scriptid=" or "id=" (dataset pages). Numeric ids are translated
 *     to a script id via SuiteQL (SELECT scriptid FROM dataset WHERE id = N);
 *     if that fails the numeric id is tried as-is.
 *   - Workbook pages: scan the page for a custdataset_* token. When none is
 *     found the panel explains how to open the dataset and offers a manual
 *     script id field.
 *
 * Messaging with the page world uses window.postMessage under the
 * TACTA_DS_SQL namespace (request/response with a correlation id).
 *
 * @fileoverview Dataset to SuiteQL content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaDatasetToSuiteQLLoaded) return;
    window.__tactaDatasetToSuiteQLLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} DOM ID of the toolbar button */
    var BUTTON_ID = 'tacta-ds-sql-btn';

    /** @type {string} CSS class scope */
    var SC = 'tacta-ds';

    /** @type {string} postMessage namespace shared with the client script */
    var NAMESPACE = 'TACTA_DS_SQL';

    /** @type {number} Timeout for page-world requests (ms) */
    var REQUEST_TIMEOUT = 20000;

    /** @type {string} Path of this feature's stylesheet (also injected into the shadow root for the panel) */
    var CSS_PATH = 'content/features/dataset-to-suiteql/dataset-to-suiteql.css';

    /** @type {Object<string, {resolve: Function, reject: Function, timer: number}>} */
    var _pending = {};

    /** @type {number} */
    var _reqCounter = 0;

    /** @type {Object|null} Panel instance */
    var _panel = null;

    // ────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────

    function sendMessage(payload) {
        return new Promise(function (resolve, reject) {
            try {
                chrome.runtime.sendMessage(payload, function (response) {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else if (response && response.error) {
                        reject(new Error(response.error));
                    } else {
                        resolve(response);
                    }
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    function pageKind() {
        var href = window.location.href;
        if (/\/app\/common\/dataset\//i.test(href)) return 'dataset';
        if (/\/app\/common\/workbook\//i.test(href)) return 'workbook';
        var info = window.__tactaPageInfo;
        if (info && (info.type === 'dataset' || info.type === 'workbook')) return info.type;
        return null;
    }

    function urlParam(name) {
        try {
            return new URL(window.location.href).searchParams.get(name);
        } catch (_) {
            return null;
        }
    }

    /**
     * Look for a custdataset_* token anywhere obvious on the page.
     * @returns {string|null}
     */
    function scanForDatasetScriptId() {
        var re = /\bcustdataset_[a-z0-9_]+/i;
        var inputs = document.querySelectorAll('input[name*="dataset" i], input[id*="dataset" i], [data-dataset-id], [data-datasetid]');
        for (var i = 0; i < inputs.length; i++) {
            var v = inputs[i].value || inputs[i].getAttribute('data-dataset-id') || inputs[i].getAttribute('data-datasetid') || '';
            var m = String(v).match(re);
            if (m) return m[0];
        }
        var m2 = (document.body ? document.body.innerHTML : '').match(re);
        return m2 ? m2[0] : null;
    }

    // ────────────────────────────────────────────────────────────────
    // Page-world messaging
    // ────────────────────────────────────────────────────────────────

    window.addEventListener('message', function (event) {
        if (event.source !== window || !event.data || event.data.namespace !== NAMESPACE) return;
        if (event.data.direction !== 'response') return;
        var p = _pending[event.data.requestId];
        if (!p) return;
        clearTimeout(p.timer);
        delete _pending[event.data.requestId];
        if (event.data.success) p.resolve(event.data.data);
        else p.reject(new Error(event.data.error || 'Page request failed'));
    });

    function pageRequest(action, data) {
        var requestId = NAMESPACE + '_' + (++_reqCounter) + '_' + Date.now().toString(36);
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                delete _pending[requestId];
                reject(new Error('Timed out waiting for the page. Reload and try again.'));
            }, REQUEST_TIMEOUT);
            _pending[requestId] = { resolve: resolve, reject: reject, timer: timer };
            window.postMessage({
                namespace: NAMESPACE,
                direction: 'request',
                requestId: requestId,
                action: action,
                data: data || null
            }, '*');
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Dataset id resolution
    // ────────────────────────────────────────────────────────────────

    /**
     * Resolve the dataset id to pass to N/query.load.
     * @returns {Promise<{ id: string|null, note: string|null }>}
     */
    function resolveDatasetId() {
        var kind = pageKind();
        var scriptId = urlParam('scriptid');
        var rawId = urlParam('id');

        if (scriptId && /^cust/i.test(scriptId)) {
            return Promise.resolve({ id: scriptId, note: null });
        }

        if (kind === 'dataset') {
            var candidate = scriptId || rawId;
            if (!candidate) {
                var scanned = scanForDatasetScriptId();
                return Promise.resolve({ id: scanned, note: scanned ? null : 'No dataset id in the URL.' });
            }
            if (/^cust/i.test(candidate)) return Promise.resolve({ id: candidate, note: null });
            if (/^\d+$/.test(candidate)) {
                var sql = 'SELECT scriptid FROM dataset WHERE id = ' + candidate;
                return sendMessage({ action: 'executeSuiteQL', query: sql })
                    .then(function (result) {
                        var rows = (result && result.rows) || [];
                        var sid = rows.length ? (rows[0].scriptid || rows[0].SCRIPTID) : null;
                        if (sid) return { id: sid, note: null };
                        var scanned2 = scanForDatasetScriptId();
                        return { id: scanned2 || candidate, note: scanned2 ? null : 'Could not translate internal id ' + candidate + ' to a script id; trying it directly.' };
                    })
                    .catch(function () {
                        var scanned3 = scanForDatasetScriptId();
                        return { id: scanned3 || candidate, note: scanned3 ? null : 'Could not translate internal id ' + candidate + ' to a script id; trying it directly.' };
                    });
            }
            return Promise.resolve({ id: candidate, note: null });
        }

        // Workbook: the SuiteQL comes from the underlying dataset
        var found = scanForDatasetScriptId();
        if (found) return Promise.resolve({ id: found, note: 'Using dataset ' + found + ' found on this workbook page.' });
        return Promise.resolve({
            id: null,
            note: 'Workbooks are built on a dataset. Open the dataset (Analytics > Datasets) and click Get SuiteQL there, or enter its script id below.'
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Panel
    // ────────────────────────────────────────────────────────────────

    function el(tag, attrs, children) {
        if (window.TactaDOM && window.TactaDOM.createElement) {
            return window.TactaDOM.createElement(tag, attrs, children);
        }
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            if (k === 'className') node.className = attrs[k];
            else if (k === 'textContent') node.textContent = attrs[k];
            else node.setAttribute(k, attrs[k]);
        });
        (children || []).forEach(function (c) {
            node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return node;
    }

    function toast(msg, type) {
        if (window.TactaDOM && window.TactaDOM.showToast) window.TactaDOM.showToast(msg, type || 'info', 2500);
    }

    function copy(text) {
        if (window.TactaDOM && window.TactaDOM.copyToClipboard) {
            return window.TactaDOM.copyToClipboard(text);
        }
        return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }

    function openPanel() {
        if (!window.TactaDOM) {
            console.error('[Tacta Dataset to SuiteQL] TactaDOM not available.');
            return;
        }
        if (_panel) {
            _panel.close();
            _panel = null;
        }

        try {
            window.TactaDOM.injectStylesheet(chrome.runtime.getURL(CSS_PATH)).catch(function () {});
        } catch (_) { /* ignore */ }

        _panel = window.TactaDOM.createPanel({
            title: 'Dataset SuiteQL',
            width: 640,
            height: 440,
            position: { top: '70px', right: '16px' },
            resizable: true,
            draggable: true,
            onClose: function () { _panel = null; }
        });
        _panel.panel.classList.add(SC);
        var body = _panel.body;

        body.appendChild(el('div', { className: SC + '-loading' }, [
            el('div', { className: 'tacta-spinner' }),
            el('span', { textContent: 'Resolving dataset and generating SuiteQL...' })
        ]));

        resolveDatasetId().then(function (res) {
            if (!res.id) {
                renderResult(body, { sql: null, id: null, note: res.note, error: null });
                return;
            }
            return fetchSql(res.id).then(function (out) {
                renderResult(body, { sql: out.sql, params: out.params, id: res.id, note: res.note, error: null });
            }).catch(function (err) {
                renderResult(body, { sql: null, id: res.id, note: res.note, error: err.message });
            });
        }).catch(function (err) {
            renderResult(body, { sql: null, id: null, note: null, error: err.message });
        });
    }

    function fetchSql(id) {
        return pageRequest('toSuiteQL', { id: id }).then(function (data) {
            if (!data || !data.sql) throw new Error('The page returned no SQL.');
            return data;
        });
    }

    /**
     * @param {HTMLElement} body
     * @param {{ sql: string|null, params?: Array, id: string|null, note: string|null, error: string|null }} state
     */
    function renderResult(body, state) {
        body.innerHTML = '';

        // Header line: which dataset
        var meta = el('div', { className: SC + '-meta' });
        meta.appendChild(el('span', { className: SC + '-meta-label', textContent: 'Dataset: ' }));
        meta.appendChild(el('code', { className: SC + '-meta-id', textContent: state.id || '(unknown)' }));
        body.appendChild(meta);

        if (state.note) {
            body.appendChild(el('div', { className: SC + '-note', textContent: state.note }));
        }
        if (state.error) {
            body.appendChild(el('div', { className: SC + '-error', textContent: 'Error: ' + state.error }));
        }

        if (state.sql) {
            var ta = el('textarea', {
                className: 'tacta-input ' + SC + '-sql',
                readonly: 'readonly',
                spellcheck: 'false'
            });
            ta.value = state.sql;
            body.appendChild(ta);

            if (state.params && state.params.length) {
                body.appendChild(el('div', {
                    className: SC + '-params',
                    textContent: 'Parameters (' + state.params.length + '): ' + state.params.map(function (p) { return JSON.stringify(p); }).join(', ')
                }));
            }

            var actions = el('div', { className: SC + '-actions' });

            var copyBtn = el('button', { className: 'tacta-btn ' + SC + '-btn', type: 'button', textContent: 'Copy' });
            copyBtn.addEventListener('click', function () {
                copy(ta.value).then(function (ok) {
                    toast(ok ? 'SuiteQL copied to clipboard' : 'Copy failed', ok ? 'success' : 'error');
                });
            });
            actions.appendChild(copyBtn);

            var runnerBtn = el('button', { className: 'tacta-btn ' + SC + '-btn', type: 'button', textContent: 'Open in SuiteQL Runner' });
            runnerBtn.title = 'Copies the SQL and asks the SuiteQL Runner to open. If the runner is not already loaded on this page, open it from the TactaSuite popup and paste.';
            runnerBtn.addEventListener('click', function () {
                copy(ta.value).then(function () {
                    // Content scripts cannot ask the background to executeFeature
                    // without a tabId, so dispatch the activation event directly.
                    // The runner only reacts if it has been injected on this page.
                    window.dispatchEvent(new CustomEvent('tacta:featureActivated', {
                        detail: { featureId: 'suiteql-runner', data: { query: ta.value } }
                    }));
                    toast('SQL copied. If the runner did not open, launch it from the popup and paste.', 'info');
                });
            });
            actions.appendChild(runnerBtn);

            body.appendChild(actions);
        }

        // Manual override / retry
        var manual = el('div', { className: SC + '-manual' });
        manual.appendChild(el('label', { className: SC + '-manual-label', textContent: 'Dataset script id' }));
        var input = el('input', {
            className: 'tacta-input ' + SC + '-manual-input',
            type: 'text',
            placeholder: 'custdataset_...'
        });
        input.value = state.id && /^cust/i.test(state.id) ? state.id : '';
        manual.appendChild(input);
        var loadBtn = el('button', { className: 'tacta-btn ' + SC + '-btn', type: 'button', textContent: 'Load' });
        loadBtn.addEventListener('click', function () {
            var id = input.value.trim();
            if (!id) return;
            body.innerHTML = '';
            body.appendChild(el('div', { className: SC + '-loading' }, [
                el('div', { className: 'tacta-spinner' }),
                el('span', { textContent: 'Generating SuiteQL for ' + id + '...' })
            ]));
            fetchSql(id).then(function (out) {
                renderResult(body, { sql: out.sql, params: out.params, id: id, note: null, error: null });
            }).catch(function (err) {
                renderResult(body, { sql: null, id: id, note: null, error: err.message });
            });
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') loadBtn.click();
        });
        manual.appendChild(loadBtn);
        body.appendChild(manual);
    }

    // ────────────────────────────────────────────────────────────────
    // Toolbar button
    // ────────────────────────────────────────────────────────────────

    function buildButton() {
        var btn = document.createElement('button');
        btn.id = BUTTON_ID;
        btn.type = 'button';
        btn.className = SC + '-toolbar-btn';
        btn.textContent = 'Get SuiteQL';
        btn.title = 'Generate the SuiteQL for this dataset (N/query toSuiteQL)';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            openPanel();
        });
        return btn;
    }

    /**
     * Try to place the button after the page title. Returns true on success.
     */
    function tryMountButton() {
        if (document.getElementById(BUTTON_ID)) return true;
        var target = document.querySelector('.uir-page-title-secondline')
            || document.querySelector('.uir-page-title')
            || document.getElementById('div__title')
            || document.querySelector('[class*="toolbar" i]')
            || document.querySelector('header');
        if (!target || !target.parentNode) return false;
        var btn = buildButton();
        btn.classList.add(SC + '-toolbar-btn--inline');
        target.parentNode.insertBefore(btn, target.nextSibling);
        return true;
    }

    function mountButton() {
        if (tryMountButton()) return;

        // Analytics pages render late; watch for the toolbar, then give up
        // on a fixed button after 20 seconds.
        var settled = false;
        var observer = new MutationObserver(function () {
            if (settled) return;
            if (tryMountButton()) {
                settled = true;
                observer.disconnect();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(function () {
            if (settled) return;
            settled = true;
            observer.disconnect();
            if (!document.getElementById(BUTTON_ID)) {
                var btn = buildButton();
                btn.classList.add(SC + '-toolbar-btn--fixed');
                document.body.appendChild(btn);
            }
        }, 20000);
    }

    // ────────────────────────────────────────────────────────────────
    // Init
    // ────────────────────────────────────────────────────────────────

    function init() {
        if (!pageKind()) return;
        mountButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();

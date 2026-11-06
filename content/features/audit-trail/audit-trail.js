/**
 * audit-trail.js
 * NetSuite TactaSuite - Audit Trail Panel (Content Script)
 *
 * @author Blane Maher
 *
 * Fetches the current record's system notes via SuiteQL and displays them
 * in a sortable, filterable, exportable table inside a floating panel.
 *
 * Activation: popup dispatches 'tacta:featureActivated' with featureId
 * 'audit-trail'. No MAIN-world injection needed — SuiteQL is handled by
 * the background service worker.
 */
(function () {
    'use strict';

    if (window.__tactaAuditTrailLoaded) return;
    window.__tactaAuditTrailLoaded = true;

    var FEATURE_ID = 'audit-trail';
    var SC = 'tacta-audit';

    var _panelInstance = null;

    // ── Helpers ──────────────────────────────────────────────────────

    function getRecordId() {
        var m = window.location.href.match(/[?&]id=(\d+)/);
        return m ? m[1] : null;
    }

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

    function formatDate(val) {
        if (!val) return '';
        try {
            // SuiteQL date strings are typically "MM/DD/YYYY HH:MM AM/PM"
            // or ISO format depending on the account locale
            var d = new Date(val);
            if (!isNaN(d.getTime())) {
                return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
        } catch (e) { /* fall through */ }
        return String(val);
    }

    // ── Open panel ───────────────────────────────────────────────────

    function openPanel() {
        if (!window.TactaDOM) {
            console.error('[Tacta Audit Trail] TactaDOM not available.');
            return;
        }

        var el = window.TactaDOM.createElement;
        var recordId = getRecordId();

        if (window.TactaDOM.injectStylesheet) {
            try {
                window.TactaDOM.injectStylesheet(
                    chrome.runtime.getURL('content/features/audit-trail/audit-trail.css')
                ).catch(function () {});
            } catch (e) { /* ignore */ }
        }

        _panelInstance = window.TactaDOM.createPanel({
            title: 'Audit Trail',
            width: 720,
            height: 480,
            position: { top: '60px', right: '16px' },
            resizable: true,
            draggable: true,
            onClose: function () { _panelInstance = null; }
        });

        _panelInstance.panel.classList.add(SC);
        var body = _panelInstance.body;

        if (!recordId) {
            body.appendChild(el('div', {
                className: SC + '-error',
                textContent: 'No record ID found in the URL. Open a saved record first.'
            }));
            return;
        }

        // Loading state
        var loadingEl = el('div', { className: SC + '-loading' }, [
            el('div', { className: 'tacta-spinner' }),
            el('span', { className: SC + '-loading-txt', textContent: 'Fetching system notes…' })
        ]);
        body.appendChild(loadingEl);

        var sql = [
            'SELECT sn.date, sn.type, sn.field, sn.oldvalue, sn.newvalue, sn.name',
            'FROM systemnote sn',
            'WHERE sn.record = ' + recordId,
            'ORDER BY sn.date DESC'
        ].join(' ');

        sendMessage({ action: 'executeSuiteQL', query: sql }).then(function (result) {
            body.innerHTML = '';

            var rows = (result && result.rows) ? result.rows : [];

            if (rows.length === 0) {
                body.appendChild(el('div', {
                    className: SC + '-empty',
                    textContent: 'No system notes found for record ' + recordId + '.'
                }));
                return;
            }

            // ── Summary bar ──────────────────────────────────────────
            body.appendChild(el('div', { className: SC + '-summary' }, [
                el('span', { className: SC + '-summary-count', textContent: rows.length + ' entries' }),
                el('span', { className: SC + '-summary-id', textContent: 'Record #' + recordId })
            ]));

            // ── Search input ─────────────────────────────────────────
            var searchInput = el('input', {
                className: 'tacta-input ' + SC + '-search',
                placeholder: 'Filter by field, user, value…',
                type: 'text'
            });
            body.appendChild(searchInput);

            // ── Table ────────────────────────────────────────────────
            var tableWrap = el('div', { className: SC + '-table-wrap' });
            body.appendChild(tableWrap);

            var headers = ['Date', 'Type', 'Field Changed', 'Old Value', 'New Value', 'Changed By'];

            var tableData = rows.map(function (r) {
                return [
                    formatDate(r.date),
                    r.type   || '',
                    r.field  || '',
                    r.oldvalue || '',
                    r.newvalue || '',
                    r.name   || ''
                ];
            });

            var tableResult = window.TactaDOM.createTable(headers, tableData, {
                sortable: true,
                exportable: true
            });
            tableWrap.appendChild(tableResult.wrapper);

            // ── Wire search filter ────────────────────────────────────
            var debounceTimer = 0;
            searchInput.addEventListener('input', function () {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(function () {
                    var term = searchInput.value.trim().toLowerCase();
                    if (!term) {
                        tableResult.refresh(tableData);
                        return;
                    }
                    var filtered = tableData.filter(function (row) {
                        return row.some(function (cell) {
                            return String(cell).toLowerCase().indexOf(term) >= 0;
                        });
                    });
                    tableResult.refresh(filtered);
                }, 200);
            });

        }).catch(function (err) {
            body.innerHTML = '';
            body.appendChild(el('div', {
                className: SC + '-error',
                textContent: 'SuiteQL error: ' + err.message
            }));
        });
    }

    function closePanel() {
        if (_panelInstance) {
            _panelInstance.close();
            _panelInstance = null;
        }
    }

    // ── Activation ───────────────────────────────────────────────────

    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === FEATURE_ID) {
            if (_panelInstance) closePanel();
            else openPanel();
        }
    });

})();

/**
 * console-snippets-client.js
 * NetSuite TactaSuite - Console Snippets (Page-World Script)
 *
 * @author Blane Maher
 *
 * Runs in the MAIN world where NetSuite's AMD loader lives, and answers one
 * bridge action: 'getSnippetContext'. Asking N/currentRecord is the only
 * reliable way to get the real SuiteScript record type - the URL stem gives
 * you 'salesord', not 'salesorder', and custom records give you nothing.
 *
 * Registers: TactaNSBridge handler 'getSnippetContext'
 */
(function () {
    'use strict';

    if (window.__tactaConsoleSnippetsClientLoaded) return;
    window.__tactaConsoleSnippetsClientLoaded = true;

    /**
     * Collects record and account context from the page world.
     * Always resolves - every lookup is optional and failures are expected on
     * list pages, dashboards and new (unsaved) records.
     * @returns {Promise<Object>}
     */
    function getSnippetContext() {
        return new Promise(function (resolve) {
            var out = {
                recordType: null,
                recordId: null,
                accountId: null,
                envType: null,
                available: false
            };

            if (typeof require !== 'function') {
                resolve(out);
                return;
            }

            var settled = false;
            function finish() {
                if (settled) return;
                settled = true;
                resolve(out);
            }

            // The AMD loader can hang on partially loaded pages.
            setTimeout(finish, 4000);

            try {
                require(['N/currentRecord', 'N/runtime'], function (currentRecord, runtime) {
                    try {
                        var rec = currentRecord.get();
                        if (rec) {
                            out.recordType = rec.type || null;
                            out.recordId = (rec.id || rec.id === 0) ? String(rec.id) : null;
                            out.available = true;
                        }
                    } catch (e) { /* not a record page */ }

                    try {
                        out.accountId = runtime.accountId || null;
                        out.envType = runtime.envType || null;
                    } catch (e) { /* runtime unavailable */ }

                    finish();
                }, finish);
            } catch (e) {
                finish();
            }
        });
    }

    if (window.TactaNSBridge && window.TactaNSBridge.registerHandler) {
        window.TactaNSBridge.registerHandler('getSnippetContext', getSnippetContext);
    } else {
        console.warn('[Tacta Console Snippets] TactaNSBridge not found - cannot register handler.');
    }
})();

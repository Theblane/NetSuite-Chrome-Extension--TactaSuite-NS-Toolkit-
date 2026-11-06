/**
 * dataset-to-suiteql-client.js
 * NetSuite TactaSuite - Dataset to SuiteQL Page-World Script
 *
 * @author Blane Maher
 *
 * Runs in the MAIN world (page context) where NetSuite's require() is
 * available. Answers TACTA_DS_SQL requests from dataset-to-suiteql.js by
 * loading the dataset with N/query and returning query.toSuiteQL().
 *
 * Message contract (window.postMessage, same window):
 *   request:  { namespace: 'TACTA_DS_SQL', direction: 'request', requestId, action: 'toSuiteQL', data: { id } }
 *   response: { namespace: 'TACTA_DS_SQL', direction: 'response', requestId, success, data: { sql, params, id }, error }
 *
 * Injected by the service worker via chrome.scripting.executeScript with
 * world: 'MAIN'.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaDatasetToSuiteQLClientLoaded) return;
    window.__tactaDatasetToSuiteQLClientLoaded = true;

    /** @type {string} postMessage namespace shared with the content script */
    var NAMESPACE = 'TACTA_DS_SQL';

    function respond(requestId, success, data, error) {
        window.postMessage({
            namespace: NAMESPACE,
            direction: 'response',
            requestId: requestId,
            success: success,
            data: success ? data : null,
            error: success ? null : (error || 'Unknown error')
        }, '*');
    }

    function errorMessage(err) {
        if (!err) return 'Unknown error';
        if (typeof err === 'string') return err;
        if (err.message) return err.name ? err.name + ': ' + err.message : err.message;
        try { return JSON.stringify(err); } catch (_) { return String(err); }
    }

    /**
     * Load the dataset and convert to SuiteQL.
     * @param {string} id  Dataset script id (custdataset_*) or internal id.
     * @returns {Promise<{ sql: string, params: Array, id: string }>}
     */
    function toSuiteQL(id) {
        return new Promise(function (resolve, reject) {
            if (typeof require !== 'function') {
                reject(new Error('NetSuite module loader (require) is not available on this page.'));
                return;
            }
            try {
                require(['N/query'], function (query) {
                    try {
                        var loaded = query.load({ id: id });
                        var result = loaded.toSuiteQL();
                        resolve({
                            sql: result && result.query ? result.query : String(result || ''),
                            params: result && Array.isArray(result.params) ? result.params : [],
                            id: id
                        });
                    } catch (e) {
                        reject(new Error(errorMessage(e)));
                    }
                }, function (e) {
                    reject(new Error('Could not load N/query: ' + errorMessage(e)));
                });
            } catch (e) {
                reject(new Error(errorMessage(e)));
            }
        });
    }

    window.addEventListener('message', function (event) {
        if (event.source !== window || !event.data) return;
        var msg = event.data;
        if (msg.namespace !== NAMESPACE || msg.direction !== 'request') return;

        if (msg.action === 'toSuiteQL') {
            var id = msg.data && msg.data.id ? String(msg.data.id) : '';
            if (!id) {
                respond(msg.requestId, false, null, 'No dataset id supplied.');
                return;
            }
            toSuiteQL(id).then(function (out) {
                respond(msg.requestId, true, out);
            }).catch(function (err) {
                respond(msg.requestId, false, null, errorMessage(err));
            });
            return;
        }

        respond(msg.requestId, false, null, 'Unknown action: ' + msg.action);
    });
})();

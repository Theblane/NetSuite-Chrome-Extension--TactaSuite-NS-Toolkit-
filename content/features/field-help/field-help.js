/**
 * field-help.js
 * NetSuite TactaSuite — Field Help (Content Script)
 *
 * @author Blane Maher
 *
 * Minimal content script that injects the page-world client script
 * (field-help-client.js) into the NetSuite page. The client script
 * hooks into NetSuite's native nlFieldHelp() function and enhances
 * the native field help popup with additional metadata — same approach
 * as the NetSuite Advanced Field Help reference extension.
 *
 * This content script does NOT intercept clicks or show its own tooltip.
 * The native NS help popup opens normally and the client script appends
 * enhanced data (field value, copy button, options table, etc.) into it.
 *
 * It also relays SuiteQL requests for the client's field-history link:
 * the page world cannot reach chrome.runtime, so it posts a
 * TACTA_FIELD_HELP message here and this script forwards the query to the
 * background executeSuiteQL handler and posts the result back.
 *
 * Auto-activates on all page types.
 *
 * @fileoverview Content script for the Field Help feature.
 */
(function () {
    'use strict';

    // Guard against double-init.
    if (window.__tactaFieldHelpLoaded) return;
    window.__tactaFieldHelpLoaded = true;

    /** @type {string} postMessage namespace shared with field-help-client.js */
    var RELAY_NAMESPACE = 'TACTA_FIELD_HELP';

    /**
     * Posts a relay response back to the page world.
     * @param {string} requestId
     * @param {Object|null} result
     * @param {string|null} error
     */
    function postRelayResponse(requestId, result, error) {
        window.postMessage({
            namespace: RELAY_NAMESPACE,
            direction: 'response',
            requestId: requestId,
            result: result || null,
            error: error || null
        }, '*');
    }

    /**
     * Handles SuiteQL relay requests from the page-world client. Only the
     * executeSuiteQL action is accepted; anything else is ignored.
     * @param {MessageEvent} event
     */
    function onRelayMessage(event) {
        if (event.source !== window) return;
        var msg = event.data;
        if (!msg || msg.namespace !== RELAY_NAMESPACE || msg.direction !== 'request') return;
        if (msg.action !== 'executeSuiteQL' || typeof msg.query !== 'string' || !msg.requestId) return;

        try {
            chrome.runtime.sendMessage({ action: 'executeSuiteQL', query: msg.query }, function (response) {
                if (chrome.runtime.lastError) {
                    var m = chrome.runtime.lastError.message || 'Relay failed';
                    if (m.indexOf('Extension context invalidated') >= 0) {
                        m = 'Extension was reloaded. Refresh this page (F5) to reconnect.';
                    }
                    postRelayResponse(msg.requestId, null, m);
                    return;
                }
                if (response && response.error) {
                    postRelayResponse(msg.requestId, null, response.error);
                } else {
                    postRelayResponse(msg.requestId, {
                        columns: response ? response.columns : [],
                        rows: response ? response.rows : []
                    }, null);
                }
            });
        } catch (e) {
            postRelayResponse(msg.requestId, null, (e && e.message) ? e.message : String(e));
        }
    }

    /**
     * Injects the field-help-client.js script into the page world
     * so it can access NetSuite's native JS APIs and hook nlFieldHelp.
     */
    function injectClientScript() {
        var scriptUrl = chrome.runtime.getURL('content/features/field-help/field-help-client.js');
        if (document.querySelector('script[src="' + scriptUrl + '"]')) return;

        var script = document.createElement('script');
        script.src = scriptUrl;
        (document.head || document.documentElement).appendChild(script);
    }

    /**
     * Sets up the Field Help feature: injects the page-world client script.
     */
    function init() {
        // Relay SuiteQL requests from the page-world client (field history).
        window.addEventListener('message', onRelayMessage);

        // Inject the page-world script for NS API access and nlFieldHelp hook.
        injectClientScript();

        // Also ensure the shared bridge is injected (for other features that may need it).
        var bridgeUrl = chrome.runtime.getURL('shared/ns-bridge.js');
        if (!document.querySelector('script[src="' + bridgeUrl + '"]')) {
            var bridgeScript = document.createElement('script');
            bridgeScript.src = bridgeUrl;
            (document.head || document.documentElement).appendChild(bridgeScript);
        }
    }

    // Run when DOM is ready.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();

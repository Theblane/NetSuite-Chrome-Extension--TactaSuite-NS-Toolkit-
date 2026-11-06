/**
 * ns-bridge.js
 * NetSuite TactaSuite - Content Script <-> Page World Messaging Bridge
 *
 * @author Blane Maher
 *
 * This file is designed to be injected into the PAGE context (not the
 * content script isolated world) via web_accessible_resources. It uses
 * window.postMessage with a 'TACTA_NS_BRIDGE' namespace to enable
 * bi-directional communication between the content script and the
 * page-world script that has access to NetSuite's JS globals.
 *
 * Architecture:
 *   Content Script                    Page World (this file)
 *   ──────────────                    ──────────────────────
 *   Bridge.request(action, data) ──>  window.addEventListener('message')
 *                                         ↓
 *                                     registered handler(data)
 *                                         ↓
 *                                     window.postMessage(response) ──> resolve Promise
 *
 * Usage from content script:
 *   const result = await TactaNSBridge.request('getFieldValue', { fieldId: 'entity' });
 *
 * Usage from page-world inject script:
 *   TactaNSBridge.registerHandler('getFieldValue', function(data) {
 *       return nlapiGetFieldValue(data.fieldId);
 *   });
 *
 * Exposes: window.TactaNSBridge
 *
 * @fileoverview Page-world messaging bridge for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} Namespace for all bridge messages */
    var NAMESPACE = 'TACTA_NS_BRIDGE';

    /** @type {string} Message direction: content script -> page world */
    var DIR_REQUEST = 'TACTA_REQUEST';

    /** @type {string} Message direction: page world -> content script */
    var DIR_RESPONSE = 'TACTA_RESPONSE';

    /** @type {number} Default timeout for requests in milliseconds */
    var DEFAULT_TIMEOUT = 10000;

    // ────────────────────────────────────────────────────────────────
    // Internal state
    // ────────────────────────────────────────────────────────────────

    /** Counter for unique message IDs */
    var _msgIdCounter = 0;

    /**
     * Registered action handlers (page-world side).
     * @type {Object<string, Function>}
     */
    var _handlers = {};

    /**
     * Pending request callbacks (content-script side).
     * Key: messageId, Value: { resolve, reject, timer }
     * @type {Object<string, {resolve: Function, reject: Function, timer: number}>}
     */
    var _pending = {};

    // ────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────

    /**
     * Generates a unique message ID.
     * @returns {string}
     */
    function _generateId() {
        _msgIdCounter++;
        return NAMESPACE + '_' + _msgIdCounter + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
    }

    /**
     * Validates that a message event belongs to our bridge.
     * @param {MessageEvent} event
     * @returns {boolean}
     */
    function _isBridgeMessage(event) {
        return event.source === window
            && event.data
            && event.data.namespace === NAMESPACE;
    }

    // ────────────────────────────────────────────────────────────────
    // Message listener (handles both directions)
    // ────────────────────────────────────────────────────────────────

    window.addEventListener('message', function (event) {
        if (!_isBridgeMessage(event)) return;

        var msg = event.data;

        // ── Handle incoming REQUEST (page-world side) ──────────────
        if (msg.direction === DIR_REQUEST) {
            var handler = _handlers[msg.action];
            if (!handler) {
                // No handler in this world - silently ignore. The message
                // may be handled by a listener in a different JS world
                // (e.g., suiteql-client.js running in MAIN world has its
                // own postMessage listener for executeSuiteQL, etc.).
                return;
            }

            // Execute handler (may be sync or async)
            try {
                var result = handler(msg.data);

                // Handle both sync returns and Promises
                if (result && typeof result.then === 'function') {
                    result.then(function (value) {
                        window.postMessage({
                            namespace: NAMESPACE,
                            direction: DIR_RESPONSE,
                            messageId: msg.messageId,
                            success: true,
                            data: value
                        }, '*');
                    }).catch(function (err) {
                        window.postMessage({
                            namespace: NAMESPACE,
                            direction: DIR_RESPONSE,
                            messageId: msg.messageId,
                            success: false,
                            error: err && err.message ? err.message : String(err)
                        }, '*');
                    });
                } else {
                    window.postMessage({
                        namespace: NAMESPACE,
                        direction: DIR_RESPONSE,
                        messageId: msg.messageId,
                        success: true,
                        data: result
                    }, '*');
                }
            } catch (err) {
                window.postMessage({
                    namespace: NAMESPACE,
                    direction: DIR_RESPONSE,
                    messageId: msg.messageId,
                    success: false,
                    error: err && err.message ? err.message : String(err)
                }, '*');
            }
            return;
        }

        // ── Handle incoming RESPONSE (content-script side) ─────────
        if (msg.direction === DIR_RESPONSE) {
            var pending = _pending[msg.messageId];
            if (!pending) return; // stale or duplicate response

            clearTimeout(pending.timer);
            delete _pending[msg.messageId];

            if (msg.success) {
                pending.resolve(msg.data);
            } else {
                pending.reject(new Error(msg.error || 'Bridge request failed'));
            }
        }
    });

    // ────────────────────────────────────────────────────────────────
    // Public API
    // ────────────────────────────────────────────────────────────────

    /**
     * Sends a request from the content script to the page-world bridge
     * and returns a Promise that resolves with the handler's response.
     *
     * Call this from the **content script** side.
     *
     * @param {string} action - The action name (must match a registered handler).
     * @param {*} [data] - Payload to send to the handler (must be JSON-serializable).
     * @param {Object} [options]
     * @param {number} [options.timeout=10000] - Request timeout in ms.
     * @returns {Promise<*>} Resolves with the handler's return value.
     * @throws {Error} If the request times out or the handler throws.
     *
     * @example
     * // Content script:
     * const value = await TactaNSBridge.request('getFieldValue', { fieldId: 'entity' });
     */
    function request(action, data, options) {
        var opts = options || {};
        var timeout = typeof opts.timeout === 'number' ? opts.timeout : DEFAULT_TIMEOUT;
        var messageId = _generateId();

        return new Promise(function (resolve, reject) {
            // Set up timeout
            var timer = setTimeout(function () {
                delete _pending[messageId];
                reject(new Error(
                    'TactaNSBridge: Request timed out after ' + timeout +
                    'ms for action "' + action + '"'
                ));
            }, timeout);

            // Store pending callback
            _pending[messageId] = {
                resolve: resolve,
                reject: reject,
                timer: timer
            };

            // Post request message
            window.postMessage({
                namespace: NAMESPACE,
                direction: DIR_REQUEST,
                messageId: messageId,
                action: action,
                data: data !== undefined ? data : null
            }, '*');
        });
    }

    /**
     * Registers a handler for a given action on the page-world side.
     * When a content script calls `Bridge.request(action, data)`, this
     * handler will be invoked with the data payload.
     *
     * The handler can return a value synchronously or return a Promise.
     *
     * Call this from the **page-world inject script** side.
     *
     * @param {string} action - The action name to handle.
     * @param {Function} handler - Function that receives the request data
     *   and returns a response (or a Promise resolving to one).
     *
     * @example
     * // Page-world inject script:
     * TactaNSBridge.registerHandler('getFieldValue', function(data) {
     *     return nlapiGetFieldValue(data.fieldId);
     * });
     *
     * TactaNSBridge.registerHandler('getRecord', async function(data) {
     *     const rec = await someAsyncCall(data.id);
     *     return rec;
     * });
     */
    function registerHandler(action, handler) {
        if (typeof handler !== 'function') {
            throw new TypeError('TactaNSBridge.registerHandler: handler must be a function');
        }
        _handlers[action] = handler;
    }

    /**
     * Removes a previously registered handler.
     *
     * @param {string} action - The action name to unregister.
     */
    function removeHandler(action) {
        delete _handlers[action];
    }

    /**
     * Returns an array of all registered handler action names.
     * Useful for debugging.
     *
     * @returns {string[]}
     */
    function getRegisteredActions() {
        return Object.keys(_handlers);
    }

    /**
     * Checks if a handler is registered for the given action.
     *
     * @param {string} action
     * @returns {boolean}
     */
    function hasHandler(action) {
        return typeof _handlers[action] === 'function';
    }

    /**
     * Returns the count of pending (in-flight) requests.
     * Useful for debugging or health checks.
     *
     * @returns {number}
     */
    function getPendingCount() {
        return Object.keys(_pending).length;
    }

    // ────────────────────────────────────────────────────────────────
    // Expose
    // ────────────────────────────────────────────────────────────────

    /** @namespace TactaNSBridge */
    var TactaNSBridge = {
        request: request,
        registerHandler: registerHandler,
        removeHandler: removeHandler,
        getRegisteredActions: getRegisteredActions,
        hasHandler: hasHandler,
        getPendingCount: getPendingCount,
        /** @type {string} Bridge namespace constant, for external reference */
        NAMESPACE: NAMESPACE
    };

    if (typeof window !== 'undefined') {
        window.TactaNSBridge = TactaNSBridge;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = TactaNSBridge;
    }
})();

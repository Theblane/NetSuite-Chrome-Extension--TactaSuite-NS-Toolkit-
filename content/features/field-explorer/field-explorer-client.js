/**
 * field-explorer-client.js
 * NetSuite TactaSuite - Field Explorer (Page World Script)
 *
 * @author Blane Maher
 *
 * Runs in the NetSuite page context (not the extension isolated world)
 * to access NetSuite's native JavaScript APIs. Communicates with the
 * content script via the TACTA_NS_BRIDGE postMessage namespace.
 *
 * Registered handlers:
 *   - getFieldValue: Returns detailed value for a specific field
 *
 * NOTE: Field enumeration (getRecordFields), select options (getSelectOptions),
 * and field mutation (setFieldValue) are handled by the service worker via
 * chrome.scripting.executeScript — those handlers have been removed from
 * this client script to eliminate redundancy.
 *
 * @fileoverview Page-world inject script for the Field Explorer feature.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaFieldExplorerClientLoaded) return;
    window.__tactaFieldExplorerClientLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Wait for bridge to be available
    // ────────────────────────────────────────────────────────────────

    /**
     * Polls for TactaNSBridge availability and registers handlers.
     * The bridge may load slightly after this script depending on injection order.
     * @param {number} [maxAttempts=50]
     * @param {number} [intervalMs=100]
     */
    function waitForBridge(maxAttempts, intervalMs) {
        maxAttempts = maxAttempts || 50;
        intervalMs = intervalMs || 100;
        var attempts = 0;

        var timer = setInterval(function () {
            attempts++;
            if (window.TactaNSBridge) {
                clearInterval(timer);
                registerHandlers();
                return;
            }
            if (attempts >= maxAttempts) {
                clearInterval(timer);
                console.warn('[Tacta FieldExplorer Client] TactaNSBridge not found after ' + maxAttempts + ' attempts');
            }
        }, intervalMs);
    }

    // ────────────────────────────────────────────────────────────────
    // Handler registration
    // ────────────────────────────────────────────────────────────────

    function registerHandlers() {
        window.TactaNSBridge.registerHandler('getFieldValue', handleGetFieldValue);
    }

    // ────────────────────────────────────────────────────────────────
    // getFieldValue handler
    // ────────────────────────────────────────────────────────────────

    /**
     * Returns detailed value for a specific field.
     * @param {Object} data - { fieldId: string, sublistId?: string, line?: number }
     * @returns {Object}
     */
    function handleGetFieldValue(data) {
        if (!data || !data.fieldId) {
            return { error: 'fieldId is required' };
        }

        var record = _getSS2CurrentRecord();

        if (data.sublistId && data.line !== null && data.line !== undefined) {
            // Sublist field
            if (record) {
                try {
                    return {
                        fieldId: data.fieldId,
                        sublistId: data.sublistId,
                        line: data.line,
                        value: _serializeValue(record.getSublistValue({
                            sublistId: data.sublistId,
                            fieldId: data.fieldId,
                            line: data.line
                        })),
                        text: record.getSublistText({
                            sublistId: data.sublistId,
                            fieldId: data.fieldId,
                            line: data.line
                        })
                    };
                } catch (e) {
                    return { error: e.message };
                }
            }
        }

        // Body field
        if (record) {
            try {
                return {
                    fieldId: data.fieldId,
                    value: _serializeValue(record.getValue({ fieldId: data.fieldId })),
                    text: record.getText({ fieldId: data.fieldId })
                };
            } catch (_) { /* fall through */ }
        }

        // SS1 fallback
        if (typeof nlapiGetFieldValue === 'function') {
            try {
                return {
                    fieldId: data.fieldId,
                    value: _serializeValue(nlapiGetFieldValue(data.fieldId)), // eslint-disable-line no-undef
                    text: typeof nlapiGetFieldText === 'function'
                        ? nlapiGetFieldText(data.fieldId) // eslint-disable-line no-undef
                        : null
                };
            } catch (e) {
                return { error: e.message };
            }
        }

        return { error: 'No NetSuite API available to read field value' };
    }

    // ────────────────────────────────────────────────────────────────
    // Shared utility functions
    // ────────────────────────────────────────────────────────────────

    /**
     * Attempts to get the current record via N/currentRecord (SS2.x).
     * @returns {Object|null} The current record object, or null
     */
    function _getSS2CurrentRecord() {
        try {
            // Method 1: require is available synchronously if N/currentRecord is already loaded
            if (typeof require === 'function') {
                var cr = null;
                require(['N/currentRecord'], function (mod) {
                    cr = mod.get();
                });
                // require may be async in some contexts; check if we got a sync result
                if (cr && typeof cr.getFields === 'function') {
                    return cr;
                }
            }
        } catch (_) { /* not available */ }

        try {
            // Method 2: Global currentRecord object (some NS pages expose this)
            if (window.currentRecord && typeof window.currentRecord.getFields === 'function') {
                return window.currentRecord;
            }
        } catch (_) { /* not available */ }

        return null;
    }

    /**
     * Safely serializes a value for postMessage transport.
     * Converts Dates to ISO strings, handles arrays/objects.
     * @param {*} value
     * @returns {*}
     */
    function _serializeValue(value) {
        if (value === null || value === undefined) return null;
        if (value instanceof Date) return value.toISOString();
        if (Array.isArray(value)) return value.map(_serializeValue);
        if (typeof value === 'object') {
            try {
                return JSON.parse(JSON.stringify(value));
            } catch (_) {
                return String(value);
            }
        }
        return value;
    }

    // ────────────────────────────────────────────────────────────────
    // Initialize
    // ────────────────────────────────────────────────────────────────

    if (window.TactaNSBridge) {
        registerHandlers();
    } else {
        waitForBridge();
    }

})();

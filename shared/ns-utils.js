/**
 * ns-utils.js
 * NetSuite TactaSuite - NetSuite Utility Functions
 *
 * @author Blane Maher
 *
 * Provides helper functions for extracting context from NetSuite pages
 * and URLs. Works in both content script and page-world contexts.
 *
 * Exposes: window.TactaNS
 *
 * @fileoverview NetSuite URL parsing, page detection, and environment utilities.
 */
(function () {
    'use strict';

    /**
     * Known sandbox URL patterns. A URL matching any of these is
     * considered non-production.
     * @type {RegExp[]}
     */
    const SANDBOX_PATTERNS = [
        /\.sandbox\./i,
        /-sb\d*\./i,
        /system\.sandbox/i,
        /\bsb\d+\b/i
    ];

    /**
     * Map of URL path segments / query patterns to human-readable page types.
     * Evaluated in order; first match wins.
     * @type {Array<{test: function(URL): boolean, type: string}>}
     */
    const PAGE_TYPE_RULES = [
        { test: (u) => u.pathname.includes('/app/common/search/search.nl') && u.searchParams.get('e') === 'T', type: 'search-edit' },
        { test: (u) => u.pathname.includes('/app/common/search/searchresults.nl'), type: 'search-results' },
        { test: (u) => u.pathname.includes('/app/common/search/search.nl'), type: 'search-results' },
        { test: (u) => u.pathname.includes('/app/common/scripting/script.nl'), type: 'script-record' },
        { test: (u) => u.searchParams.get('compid') !== null && u.pathname.includes('/app/site/hosting/scriptlet.nl'), type: 'suitelet' },
        { test: (u) => u.pathname.includes('/app/center/card.nl'), type: 'dashboard' },
        { test: (u) => u.pathname.includes('/app/setup/'), type: 'setup' },
        { test: (u) => u.pathname.includes('/app/common/entity/') || u.pathname.includes('/app/accounting/transactions/'), type: _detectRecordMode },
        { test: (u) => u.searchParams.has('id') && u.searchParams.get('e') === 'T', type: 'record-edit' },
        { test: (u) => u.searchParams.has('id') && !u.searchParams.has('l'), type: 'record-view' },
        { test: (u) => u.pathname.includes('/app/common/custom/custrecord'), type: _detectRecordMode },
        { test: (u) => u.searchParams.has('rectype') || u.searchParams.has('type'), type: 'list' }
    ];

    // ────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────

    /**
     * Safely parses a URL string into a URL object.
     * Falls back to current location when no argument is provided.
     * @param {string} [url]
     * @returns {URL|null}
     */
    function _safeUrl(url) {
        try {
            return new URL(url || window.location.href);
        } catch (_) {
            return null;
        }
    }

    /**
     * Returns 'record-edit' or 'record-view' based on the `e` parameter.
     * @param {URL} u
     * @returns {string}
     */
    function _detectRecordMode(u) {
        return u.searchParams.get('e') === 'T' ? 'record-edit' : 'record-view';
    }

    // ────────────────────────────────────────────────────────────────
    // Public API
    // ────────────────────────────────────────────────────────────────

    /**
     * Extracts the NetSuite account ID from the current page.
     * Tries multiple strategies in order:
     *   1. Global `nlapiGetContext().getCompany()` (page-world only)
     *   2. URL `compid` query parameter
     *   3. URL hostname segment (e.g. 1234567.app.netsuite.com)
     *   4. Cookie `compid`
     *
     * @param {string} [url] - Optional URL to parse. Defaults to current page.
     * @returns {string|null} Account ID or null if undetermined.
     */
    function getAccountId(url) {
        // Strategy 1: NS global API (only available in page world)
        if (!url) {
            try {
                // nlapiGetContext is available in SS1 page context
                if (typeof nlapiGetContext === 'function') {
                    var ctx = nlapiGetContext(); // eslint-disable-line no-undef
                    if (ctx && typeof ctx.getCompany === 'function') {
                        return ctx.getCompany();
                    }
                }
            } catch (_) { /* not in page world */ }
        }

        // Strategy 2: compid query param
        var u = _safeUrl(url);
        if (u) {
            var compid = u.searchParams.get('compid');
            if (compid) return compid;
        }

        // Strategy 3: hostname (e.g., 1234567.app.netsuite.com or 1234567-sb1.app.netsuite.com)
        if (u) {
            var hostMatch = u.hostname.match(/^(\d[\w-]*)\./);
            if (hostMatch) return hostMatch[1];
        }

        // Strategy 4: cookie
        if (!url) {
            var cookieMatch = document.cookie.match(/(?:^|;\s*)compid=([^;]+)/);
            if (cookieMatch) return decodeURIComponent(cookieMatch[1]);
        }

        return null;
    }

    /**
     * Extracts the record type from a NetSuite URL.
     * Checks `rectype`, then `recordtype`, then `type` query parameters,
     * and finally attempts to infer from the URL path.
     *
     * @param {string} [url] - Optional URL. Defaults to current page.
     * @returns {string|null} Record type identifier or null.
     */
    function getRecordType(url) {
        var u = _safeUrl(url);
        if (!u) return null;

        // Explicit params
        var rectype = u.searchParams.get('rectype')
            || u.searchParams.get('recordtype')
            || u.searchParams.get('type');
        if (rectype) return rectype;

        // Path-based inference (e.g., /app/accounting/transactions/salesord.nl)
        var pathMatch = u.pathname.match(/\/([a-z]+)\.nl$/i);
        if (pathMatch) return pathMatch[1];

        return null;
    }

    /**
     * Extracts the record internal ID from a NetSuite URL.
     *
     * @param {string} [url] - Optional URL. Defaults to current page.
     * @returns {string|null} Record ID or null.
     */
    function getRecordId(url) {
        var u = _safeUrl(url);
        if (!u) return null;

        return u.searchParams.get('id') || null;
    }

    /**
     * Determines the current NetSuite page type based on URL analysis.
     *
     * @param {string} [url] - Optional URL. Defaults to current page.
     * @returns {string} One of: 'record-view', 'record-edit', 'search-edit',
     *   'search-results', 'script-record', 'suitelet', 'dashboard',
     *   'list', 'setup', 'other'.
     */
    function getPageType(url) {
        var u = _safeUrl(url);
        if (!u) return 'other';

        for (var i = 0; i < PAGE_TYPE_RULES.length; i++) {
            var rule = PAGE_TYPE_RULES[i];
            if (rule.test(u)) {
                if (typeof rule.type === 'function') {
                    return rule.type(u);
                }
                return rule.type;
            }
        }

        return 'other';
    }

    /**
     * Checks whether the current environment is a production account.
     * Returns false if any sandbox indicator is detected.
     *
     * @param {string} [url] - Optional URL. Defaults to current page.
     * @returns {boolean} True if no sandbox indicators are found.
     */
    function isProductionAccount(url) {
        var href = url || window.location.href;
        for (var i = 0; i < SANDBOX_PATTERNS.length; i++) {
            if (SANDBOX_PATTERNS[i].test(href)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Returns a human-readable environment label.
     *
     * @param {string} [url] - Optional URL. Defaults to current page.
     * @returns {string} 'Production', 'Sandbox', 'Sandbox 2', etc.
     */
    function getEnvironmentLabel(url) {
        var href = url || window.location.href;

        if (isProductionAccount(href)) {
            return 'Production';
        }

        // Try to extract sandbox number (e.g., -sb2, sb3)
        var sbMatch = href.match(/[-.]sb(\d+)/i);
        if (sbMatch) {
            var num = parseInt(sbMatch[1], 10);
            if (num === 1) return 'Sandbox';
            return 'Sandbox ' + num;
        }

        return 'Sandbox';
    }

    /**
     * Builds a fully-qualified NetSuite URL from a relative path and parameters.
     *
     * @param {string} path - Relative path (e.g., '/app/common/search/searchresults.nl').
     * @param {Object} [params] - Key-value pairs to add as query parameters.
     * @returns {string} Complete URL string.
     */
    function buildNSUrl(path, params) {
        var base;
        try {
            base = new URL(path, window.location.origin);
        } catch (_) {
            base = new URL(window.location.origin + path);
        }

        if (params && typeof params === 'object') {
            var keys = Object.keys(params);
            for (var i = 0; i < keys.length; i++) {
                var val = params[keys[i]];
                if (val !== undefined && val !== null) {
                    base.searchParams.set(keys[i], String(val));
                }
            }
        }

        return base.toString();
    }

    /**
     * Parses a NetSuite URL and extracts structured information.
     *
     * @param {string} url - The URL to parse.
     * @returns {{ recordType: string|null, id: string|null, mode: string|null,
     *             compid: string|null, scriptId: string|null, deployId: string|null,
     *             pageType: string }} Parsed URL components.
     */
    function parseNSUrl(url) {
        var u = _safeUrl(url);
        if (!u) {
            return {
                recordType: null,
                id: null,
                mode: null,
                compid: null,
                scriptId: null,
                deployId: null,
                pageType: 'other'
            };
        }

        var editParam = u.searchParams.get('e');
        var mode = null;
        if (u.searchParams.has('id')) {
            mode = editParam === 'T' ? 'edit' : 'view';
        }

        return {
            recordType: getRecordType(url),
            id: u.searchParams.get('id') || null,
            mode: mode,
            compid: u.searchParams.get('compid') || null,
            scriptId: u.searchParams.get('script') || u.searchParams.get('scriptid') || null,
            deployId: u.searchParams.get('deploy') || u.searchParams.get('deploymentid') || null,
            pageType: getPageType(url)
        };
    }

    // ────────────────────────────────────────────────────────────────
    // Expose
    // ────────────────────────────────────────────────────────────────

    /** @namespace TactaNS */
    var TactaNS = {
        getAccountId: getAccountId,
        getRecordType: getRecordType,
        getRecordId: getRecordId,
        getPageType: getPageType,
        isProductionAccount: isProductionAccount,
        getEnvironmentLabel: getEnvironmentLabel,
        buildNSUrl: buildNSUrl,
        parseNSUrl: parseNSUrl
    };

    // Attach to window for both content scripts and page-world scripts
    if (typeof window !== 'undefined') {
        window.TactaNS = TactaNS;
    }

    // Also support module environments (e.g., testing)
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = TactaNS;
    }
})();

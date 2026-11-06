/**
 * quick-search-creation.js
 * NetSuite TactaSuite - Quick Search (Real-Time Global Record Search)
 *
 * @author Blane Maher
 *
 * Small circular icon next to NetSuite's search bar that expands into an
 * overlay search box. The user types text and sees matching records from
 * NetSuite in real time, with clickable links to open each record. Results
 * are grouped by record type (Transactions, Customers, Items, Vendors,
 * Employees, Cases).
 *
 * Secondary "Create new search" links are shown at the bottom of results
 * to preserve the original functionality.
 *
 * @fileoverview Quick Search content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaQuickSearchCreationLoaded) return;
    window.__tactaQuickSearchCreationLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} Wrapper element ID */
    var WRAPPER_ID = 'tacta-qsc-wrapper';

    /** @type {string} Chrome storage key for enabled search types */
    var TYPES_KEY = 'tacta_qsc_enabled_types';

    /** @type {string} Chrome storage key for include inactives setting */
    var INACTIVES_KEY = 'tacta_qsc_include_inactives';

    /** @type {number} Debounce delay in milliseconds */
    var DEBOUNCE_MS = 400;

    /** @type {number} Minimum query length to trigger search */
    var MIN_QUERY_LENGTH = 2;

    /** @type {number} How long to reuse identical search results on the current page */
    var CACHE_TTL_MS = 120000;

    /** @type {number} Maximum number of search result sets to keep on this page */
    var MAX_CACHE_ENTRIES = 30;

    /** SVG markup for the magnifying glass icon */
    var MAGNIFIER_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><line x1="15" y1="15" x2="21" y2="21"/></svg>';

    /** SVG markup for the small search icon inside the expanded input */
    var INNER_SEARCH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#76c043" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><line x1="15" y1="15" x2="21" y2="21"/></svg>';

    /**
     * Search type definitions used for the "Create new search" links at the
     * bottom of the results. These are the original search type launchers.
     */
    var ALL_SEARCH_TYPES = [
        { id: 'transaction',      label: 'Transaction',      type: 'Transaction',   group: 'Transactions', defaultEnabled: true },
        { id: 'salesorder',       label: 'Sales Order',      type: 'SalesOrd',      group: 'Transactions', defaultEnabled: true },
        { id: 'invoice',          label: 'Invoice',          type: 'CustInvc',      group: 'Transactions', defaultEnabled: true },
        { id: 'itemfulfillment',  label: 'Item Fulfillment', type: 'ItemShip',      group: 'Transactions', defaultEnabled: true },
        { id: 'purchaseorder',    label: 'Purchase Order',   type: 'PurchOrd',      group: 'Transactions', defaultEnabled: true },
        { id: 'vendorbill',       label: 'Vendor Bill',      type: 'VendBill',      group: 'Transactions', defaultEnabled: false },
        { id: 'returnauth',       label: 'Return Auth',      type: 'RtnAuth',       group: 'Transactions', defaultEnabled: false },
        { id: 'creditmemo',       label: 'Credit Memo',      type: 'CustCred',      group: 'Transactions', defaultEnabled: false },
        { id: 'transferorder',    label: 'Transfer Order',   type: 'TrnfrOrd',      group: 'Transactions', defaultEnabled: false },
        { id: 'inboundshipment',  label: 'Inbound Shipment', type: 'InboundShpmt',  group: 'Transactions', defaultEnabled: false },
        { id: 'journalentry',     label: 'Journal Entry',    type: 'Journal',       group: 'Transactions', defaultEnabled: false },
        { id: 'customer',         label: 'Customer',         type: 'Customer',      group: 'Entities',     defaultEnabled: true },
        { id: 'contact',          label: 'Contact',          type: 'Contact',       group: 'Entities',     defaultEnabled: true },
        { id: 'vendor',           label: 'Vendor',           type: 'Vendor',        group: 'Entities',     defaultEnabled: true },
        { id: 'partner',          label: 'Partner',          type: 'Partner',       group: 'Entities',     defaultEnabled: false },
        { id: 'employee',         label: 'Employee',         type: 'Employee',      group: 'Entities',     defaultEnabled: true },
        { id: 'item',             label: 'Item',             type: 'Item',          group: 'Items',        defaultEnabled: true },
        { id: 'task',             label: 'Task',             type: 'Task',          group: 'Activities',   defaultEnabled: false },
        { id: 'case',             label: 'Case',             type: 'SupportCase',   group: 'Activities',   defaultEnabled: false },
        { id: 'phonecall',        label: 'Phone Call',       type: 'PhoneCall',     group: 'Activities',   defaultEnabled: false },
        { id: 'event',            label: 'Event',            type: 'CalendarEvent', group: 'Activities',   defaultEnabled: false },
        { id: 'customrecord',     label: 'Custom Records',   type: 'CustomRecord',  group: 'Other',        defaultEnabled: false },
        { id: 'savedsearch',      label: 'Saved Searches',   type: 'SavedSearch',   group: 'Other',        defaultEnabled: false },
        { id: 'file',             label: 'File',             type: 'File',          group: 'Other',        defaultEnabled: false }
    ];

    // ────────────────────────────────────────────────────────────────
    // SuiteQL Query Definitions
    // ────────────────────────────────────────────────────────────────

    /**
     * Each query definition describes how to search a record type via SuiteQL.
     * @type {Array<{
     *   key: string,
     *   label: string,
     *   buildQuery: function(string): { sql: string, params: string[] },
     *   mapRow: function(Object): { id: string, name: string, detail: string, url: string }
     * }>}
     */
    var RECORD_QUERIES = [
        {
            key: 'transactions',
            label: 'Transactions',
            buildQuery: function (q) {
                return {
                    sql: 'SELECT t.id, t.tranid, t.type, t.trandate, ' +
                         'BUILTIN.DF(t.type) AS typename, ' +
                         'BUILTIN.DF(t.entity) AS entityname ' +
                         'FROM Transaction t ' +
                         'WHERE t.mainline = \'T\' ' +
                         'AND (t.tranid LIKE ? OR BUILTIN.DF(t.entity) LIKE ?) ' +
                         'ORDER BY t.trandate DESC ' +
                         'FETCH FIRST 8 ROWS ONLY',
                    params: ['%' + q + '%', '%' + q + '%']
                };
            },
            mapRow: function (row) {
                var name = row.tranid || ('ID: ' + row.id);
                var detail = (row.typename || row.type || '') +
                    (row.entityname ? ' - ' + row.entityname : '') +
                    (row.trandate ? ' (' + row.trandate + ')' : '');
                return {
                    id: row.id,
                    name: name,
                    detail: detail,
                    url: '/app/accounting/transactions/transaction.nl?id=' + row.id
                };
            }
        },
        {
            key: 'customers',
            label: 'Customers',
            buildQuery: function (q, includeInactives) {
                return {
                    sql: 'SELECT c.id, c.entityid, c.companyname, c.email ' +
                         'FROM Customer c ' +
                         'WHERE ' + (includeInactives ? '1 = 1 ' : 'c.isinactive = \'F\' ') +
                         'AND (c.entityid LIKE ? OR c.companyname LIKE ? OR c.email LIKE ?) ' +
                         'FETCH FIRST 5 ROWS ONLY',
                    params: ['%' + q + '%', '%' + q + '%', '%' + q + '%']
                };
            },
            mapRow: function (row) {
                var name = row.companyname || row.entityid || ('ID: ' + row.id);
                var detail = (row.entityid || '') + (row.email ? ' - ' + row.email : '');
                return {
                    id: row.id,
                    name: name,
                    detail: detail,
                    url: '/app/common/entity/custjob.nl?id=' + row.id
                };
            }
        },
        {
            key: 'items',
            label: 'Items',
            buildQuery: function (q, includeInactives) {
                return {
                    sql: 'SELECT i.id, i.itemid, i.displayname, BUILTIN.DF(i.type) AS typename ' +
                         'FROM Item i ' +
                         'WHERE ' + (includeInactives ? '1 = 1 ' : 'i.isinactive = \'F\' ') +
                         'AND (i.itemid LIKE ? OR i.displayname LIKE ?) ' +
                         'FETCH FIRST 5 ROWS ONLY',
                    params: ['%' + q + '%', '%' + q + '%']
                };
            },
            mapRow: function (row) {
                var name = row.itemid || ('ID: ' + row.id);
                var detail = (row.displayname || '') + (row.typename ? ' (' + row.typename + ')' : '');
                return {
                    id: row.id,
                    name: name,
                    detail: detail,
                    url: '/app/common/item/item.nl?id=' + row.id
                };
            }
        },
        {
            key: 'vendors',
            label: 'Vendors',
            buildQuery: function (q, includeInactives) {
                return {
                    sql: 'SELECT v.id, v.entityid, v.companyname ' +
                         'FROM Vendor v ' +
                         'WHERE ' + (includeInactives ? '1 = 1 ' : 'v.isinactive = \'F\' ') +
                         'AND (v.entityid LIKE ? OR v.companyname LIKE ?) ' +
                         'FETCH FIRST 5 ROWS ONLY',
                    params: ['%' + q + '%', '%' + q + '%']
                };
            },
            mapRow: function (row) {
                var name = row.companyname || row.entityid || ('ID: ' + row.id);
                var detail = row.entityid || '';
                return {
                    id: row.id,
                    name: name,
                    detail: detail,
                    url: '/app/common/entity/vendor.nl?id=' + row.id
                };
            }
        },
        {
            key: 'employees',
            label: 'Employees',
            buildQuery: function (q, includeInactives) {
                return {
                    sql: 'SELECT e.id, e.entityid, e.firstname, e.lastname ' +
                         'FROM Employee e ' +
                         'WHERE ' + (includeInactives ? '1 = 1 ' : 'e.isinactive = \'F\' ') +
                         'AND (e.entityid LIKE ? OR (e.firstname || \' \' || e.lastname) LIKE ?) ' +
                         'FETCH FIRST 5 ROWS ONLY',
                    params: ['%' + q + '%', '%' + q + '%']
                };
            },
            mapRow: function (row) {
                var fullName = ((row.firstname || '') + ' ' + (row.lastname || '')).trim();
                var name = fullName || row.entityid || ('ID: ' + row.id);
                var detail = row.entityid || '';
                return {
                    id: row.id,
                    name: name,
                    detail: detail,
                    url: '/app/common/entity/employee.nl?id=' + row.id
                };
            }
        },
        {
            key: 'cases',
            label: 'Cases',
            buildQuery: function (q) {
                return {
                    sql: 'SELECT sc.id, sc.casenumber, sc.title, BUILTIN.DF(sc.status) AS statustext ' +
                         'FROM SupportCase sc ' +
                         'WHERE sc.casenumber LIKE ? OR sc.title LIKE ? ' +
                         'FETCH FIRST 5 ROWS ONLY',
                    params: ['%' + q + '%', '%' + q + '%']
                };
            },
            mapRow: function (row) {
                var name = row.casenumber || ('ID: ' + row.id);
                var detail = (row.title || '') + (row.statustext ? ' [' + row.statustext + ']' : '');
                return {
                    id: row.id,
                    name: name,
                    detail: detail,
                    url: '/app/accounting/transactions/supportcase.nl?id=' + row.id
                };
            }
        }
    ];

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {boolean} Whether the search overlay is expanded */
    var _isOpen = false;

    /** @type {Object<string, boolean>} Map of search type id -> enabled */
    var _enabledTypes = {};

    /** @type {boolean} Whether to include inactive records in searches */
    var _includeInactives = false;

    /** @type {number} Currently selected index in results (-1 = none) */
    var _selectedIndex = -1;

    /**
     * Flat list of currently visible result items (record results + create-search links).
     * Each entry: { url: string, label: string }
     * @type {Array<{ url: string, label: string }>}
     */
    var _visibleResults = [];

    /** @type {number} Debounce timer ID */
    var _debounceTimer = 0;

    /** @type {number} Request counter to discard stale results */
    var _requestId = 0;

    /** @type {boolean} Whether a search is currently in progress */
    var _isLoading = false;

    /** @type {Map<string, { createdAt: number, groups: Array }>} In-page result cache */
    var _searchCache = new Map();

    /** @type {HTMLElement|null} Cached reference to the wrapper element */
    var _wrapperEl = null;

    /** @type {HTMLElement|null} Cached reference to the dropdown element */
    var _dropdownEl = null;

    /** @type {HTMLInputElement|null} Cached reference to the input element */
    var _inputEl = null;

    // ────────────────────────────────────────────────────────────────
    // Storage helpers
    // ────────────────────────────────────────────────────────────────

    /**
     * Loads state from chrome.storage.local.
     * @param {Function} callback - Called with no args once loading is complete.
     */
    function _loadState(callback) {
        try {
            chrome.storage.local.get([TYPES_KEY, INACTIVES_KEY], function (data) {
                _enabledTypes = data[TYPES_KEY] || {};
                _includeInactives = data[INACTIVES_KEY] === true;
                callback();
            });
        } catch (_) {
            _enabledTypes = {};
            _includeInactives = false;
            callback();
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Background messaging
    // ────────────────────────────────────────────────────────────────

    /**
     * Send a SuiteQL query to the background service worker.
     * @param {string} sql - The SuiteQL query string.
     * @param {string[]} params - Query parameters.
     * @returns {Promise<{ rows: Array<Object> }>}
     */
    function _executeSuiteQL(sql, params) {
        return new Promise(function (resolve, reject) {
            chrome.runtime.sendMessage(
                { action: 'executeSuiteQL', query: sql, params: params },
                function (response) {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else if (response && response.error) {
                        reject(new Error(response.error));
                    } else {
                        resolve(response);
                    }
                }
            );
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Search execution
    // ────────────────────────────────────────────────────────────────

    /**
     * Run all 6 SuiteQL queries in parallel and return grouped results.
     * @param {string} query - The user's search text.
     * @param {number} reqId - Request ID to detect stale responses.
     * @returns {Promise<Array<{ key: string, label: string, items: Array }>|null>}
     */
    function _runSearch(query, reqId) {
        var cacheKey = _getCacheKey(query);
        var cached = _getCachedSearch(cacheKey);
        if (cached) {
            return Promise.resolve(cached);
        }

        var promises = RECORD_QUERIES.map(function (rq) {
            var q = rq.buildQuery(query, _includeInactives);
            return _executeSuiteQL(q.sql, q.params)
                .then(function (result) {
                    var rows = (result && result.rows) ? result.rows : [];
                    return {
                        key: rq.key,
                        label: rq.label,
                        items: rows.map(rq.mapRow)
                    };
                })
                .catch(function () {
                    // Silently ignore individual query failures
                    return { key: rq.key, label: rq.label, items: [] };
                });
        });

        return Promise.allSettled(promises).then(function (settled) {
            // If this request is stale, return null to signal caller
            if (reqId !== _requestId) return null;

            var groups = [];
            for (var i = 0; i < settled.length; i++) {
                var result = settled[i].status === 'fulfilled' ? settled[i].value : null;
                if (result && result.items && result.items.length > 0) {
                    groups.push(result);
                }
            }
            _setCachedSearch(cacheKey, groups);
            return groups;
        });
    }

    function _getCacheKey(query) {
        return String(query || '').trim().toLowerCase() + '|' + (_includeInactives ? 'all' : 'active');
    }

    function _getCachedSearch(cacheKey) {
        var cached = _searchCache.get(cacheKey);
        if (!cached) return null;
        if ((Date.now() - cached.createdAt) > CACHE_TTL_MS) {
            _searchCache.delete(cacheKey);
            return null;
        }
        return cached.groups;
    }

    function _setCachedSearch(cacheKey, groups) {
        _searchCache.set(cacheKey, {
            createdAt: Date.now(),
            groups: groups
        });
        while (_searchCache.size > MAX_CACHE_ENTRIES) {
            var firstKey = _searchCache.keys().next().value;
            _searchCache.delete(firstKey);
        }
    }

    // ────────────────────────────────────────────────────────────────
    // "Create New Search" link helpers (preserved from original)
    // ────────────────────────────────────────────────────────────────

    /**
     * Returns the filtered list of search types based on user settings.
     * @returns {Array}
     */
    function _getEnabledSearchTypes() {
        var hasSettings = Object.keys(_enabledTypes).length > 0;
        return ALL_SEARCH_TYPES.filter(function (st) {
            if (hasSettings) {
                return _enabledTypes[st.id] === true;
            }
            return st.defaultEnabled;
        });
    }

    /**
     * Builds the URL for a given search type definition.
     * @param {{ type: string }} searchDef
     * @returns {string}
     */
    function _buildSearchUrl(searchDef) {
        if (searchDef.type === 'SavedSearch') {
            return '/app/common/search/savedsearchlist.nl';
        }
        if (searchDef.type === 'CustomRecord') {
            return '/app/common/custom/custrecordlist.nl';
        }
        var url = '/app/common/search/search.nl?searchtype=' + searchDef.type + '&e=T';
        if (!_includeInactives) {
            url += '&isinactive=F';
        }
        return url;
    }

    // ────────────────────────────────────────────────────────────────
    // HTML Helpers
    // ────────────────────────────────────────────────────────────────

    /**
     * Escapes HTML entities in a string.
     * @param {string} str
     * @returns {string}
     */
    function _escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str || ''));
        return div.innerHTML;
    }

    /**
     * Highlights matching substring in text, returning HTML.
     * @param {string} text
     * @param {string} query
     * @returns {string}
     */
    function _highlightMatch(text, query) {
        if (!text || !query) return _escapeHtml(text);
        var lower = text.toLowerCase();
        var qLower = query.toLowerCase();
        var idx = lower.indexOf(qLower);
        if (idx === -1) return _escapeHtml(text);

        var before = text.substring(0, idx);
        var match = text.substring(idx, idx + query.length);
        var after = text.substring(idx + query.length);
        return _escapeHtml(before) +
               '<span class="tacta-qsc-highlight">' + _escapeHtml(match) + '</span>' +
               _escapeHtml(after);
    }

    /**
     * Scrolls an element into view within a scrollable container if it's not visible.
     * @param {HTMLElement} el
     * @param {HTMLElement} container
     */
    function _scrollIntoViewIfNeeded(el, container) {
        var elRect = el.getBoundingClientRect();
        var containerRect = container.getBoundingClientRect();

        if (elRect.bottom > containerRect.bottom) {
            container.scrollTop += elRect.bottom - containerRect.bottom;
        } else if (elRect.top < containerRect.top) {
            container.scrollTop -= containerRect.top - elRect.top;
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Expand / Collapse
    // ────────────────────────────────────────────────────────────────

    /**
     * Expands the search overlay.
     */
    function _expand() {
        if (_isOpen) return;
        _isOpen = true;
        if (_wrapperEl) {
            _wrapperEl.classList.add('tacta-qsc-open');
            _positionFloatingWrapper();
        }
        if (_inputEl) {
            setTimeout(function () { _inputEl.focus(); }, 60);
        }
    }

    /**
     * Collapses the search overlay back to just the icon.
     */
    function _collapse() {
        if (!_isOpen) return;
        _isOpen = false;
        if (_wrapperEl) {
            _wrapperEl.classList.remove('tacta-qsc-open');
            _positionFloatingWrapper();
        }
        if (_dropdownEl) {
            _dropdownEl.classList.remove('tacta-qsc-dropdown-visible');
        }
        if (_inputEl) {
            _inputEl.blur();
        }
    }

    // ────────────────────────────────────────────────────────────────
    // NS Search Bar Detection
    // ────────────────────────────────────────────────────────────────

    /**
     * Finds NetSuite's header search bar container using multiple selectors.
     * @returns {HTMLElement|null}
     */
    function _findNsSearchBar() {
        var inputSelectors = [
            'input[type="search"]',
            '#_searchstring',
            'input[name="_searchstring"]',
            'input[id*="search" i]',
            'input[name*="search" i]',
            'input[placeholder*="search" i]',
            'input[aria-label*="search" i]',
            'input[title*="search" i]'
        ];

        for (var i = 0; i < inputSelectors.length; i++) {
            var matches = document.querySelectorAll(inputSelectors[i]);
            for (var j = 0; j < matches.length; j++) {
                var el = matches[j];
                if (el && el.tagName === 'INPUT' && _isVisibleSearchCandidate(el)) {
                    return el;
                }
            }
        }

        var containerSelectors = [
            '#ns-header-searcher-container',
            '#spn_cIS_d1',
            '.ns-role-header .ns-search'
        ];

        for (var k = 0; k < containerSelectors.length; k++) {
            var container = document.querySelector(containerSelectors[k]);
            if (!container) continue;
            var inputs = container.querySelectorAll('input');
            for (var n = 0; n < inputs.length; n++) {
                if (_isVisibleSearchCandidate(inputs[n])) return inputs[n];
            }
        }

        return null;
    }

    function _isVisibleSearchCandidate(el) {
        if (!el || el.id === 'tacta-qsc-input' || (el.closest && el.closest('#' + WRAPPER_ID))) return false;

        var searchText = [
            el.id,
            el.name,
            el.placeholder,
            el.getAttribute && el.getAttribute('aria-label'),
            el.title,
            el.className
        ].join(' ').toLowerCase();

        if (searchText.indexOf('search') === -1 && searchText.indexOf('_searchstring') === -1) return false;

        var rect = el.getBoundingClientRect();
        if (!rect || rect.width < 80 || rect.height < 12) return false;
        if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;

        var style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    /**
     * Finds a stable header-level container for NetSuite's native search so
     * the quick search icon sits to the left of the whole native search bar.
     * @param {HTMLElement} el
     * @returns {HTMLElement}
     */
    function _getSearchInsertTarget(el) {
        var current = el;
        var stop = document.body;

        while (current && current.parentElement && current.parentElement !== stop) {
            if (current.id === 'ns-header-searcher-container' ||
                current.id === 'spn_cIS_d1' ||
                _hasClass(current, 'ns-search')) {
                return current;
            }

            if (current.tagName === 'FORM') {
                return current;
            }

            if (current.parentElement && current.parentElement.querySelectorAll &&
                current.parentElement.querySelectorAll('input').length > 1) {
                return current;
            }

            current = current.parentElement;
        }

        return el.parentElement || el;
    }

    function _hasClass(el, className) {
        return !!(el && el.classList && el.classList.contains(className));
    }

    /**
     * Finds the header logo block so Quick Search can sit immediately after it.
     * @returns {HTMLElement|null}
     */
    function _findCompanyLogoAnchor() {
        var selectors = [
            '#ns-header-logo',
            '#nslogo',
            '.ns-header-logo',
            '.ns-logo',
            'a[href*="/app/center/card.nl"] img',
            'img[src*="logo"]'
        ];

        for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (!el) continue;
            return _getLogoInsertAnchor(el);
        }

        return null;
    }

    function _getLogoInsertAnchor(el) {
        var link = el.closest && el.closest('a');
        if (link && link.parentNode) return link;

        var cell = el.closest && el.closest('td, li');
        if (cell && cell.parentNode) return cell;

        var block = el.closest && el.closest('div');
        if (block && block.parentNode) return block;

        return el;
    }

    // ────────────────────────────────────────────────────────────────
    // UI Construction
    // ────────────────────────────────────────────────────────────────

    /**
     * Builds and inserts the quick search icon + expandable overlay into the page.
     */
    function _render() {
        // Don't double-render
        if (document.getElementById(WRAPPER_ID)) return;

        // ── Wrapper ──
        var wrapper = document.createElement('div');
        wrapper.id = WRAPPER_ID;
        wrapper.className = 'tacta-qsc-wrapper tacta-toolkit';

        // ── Icon button (always visible when collapsed) ──
        var iconBtn = document.createElement('button');
        iconBtn.className = 'tacta-qsc-icon';
        iconBtn.title = 'Quick Search (TactaSuite Toolkit)';
        iconBtn.type = 'button';
        iconBtn.innerHTML = MAGNIFIER_SVG;
        iconBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            _expand();
        });

        wrapper.appendChild(iconBtn);

        // ── Expandable container ──
        var expandBox = document.createElement('div');
        expandBox.className = 'tacta-qsc-expand';

        // Input area inside the expand box
        var inputArea = document.createElement('div');
        inputArea.className = 'tacta-qsc-input-area';

        // Small green search icon inside the input
        var innerIcon = document.createElement('span');
        innerIcon.className = 'tacta-qsc-search-icon-inner';
        innerIcon.innerHTML = INNER_SEARCH_SVG;
        innerIcon.setAttribute('aria-hidden', 'true');

        // Text input
        var input = document.createElement('input');
        input.type = 'text';
        input.id = 'tacta-qsc-input';
        input.className = 'tacta-qsc-input';
        input.placeholder = 'Search records by name, ID, or number...';
        input.autocomplete = 'off';
        input.spellcheck = false;

        // Loading spinner
        var spinner = document.createElement('span');
        spinner.className = 'tacta-qsc-spinner';
        spinner.id = 'tacta-qsc-spinner';

        inputArea.appendChild(innerIcon);
        inputArea.appendChild(input);
        inputArea.appendChild(spinner);

        // Close (X) button
        var closeBtn = document.createElement('button');
        closeBtn.className = 'tacta-qsc-close';
        closeBtn.type = 'button';
        closeBtn.title = 'Close search';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            _collapse();
        });

        expandBox.appendChild(inputArea);
        expandBox.appendChild(closeBtn);
        wrapper.appendChild(expandBox);

        // ── Results dropdown (positioned absolutely below the expand box) ──
        var dropdown = document.createElement('div');
        dropdown.className = 'tacta-qsc-dropdown';
        dropdown.id = 'tacta-qsc-dropdown';
        wrapper.appendChild(dropdown);

        // ── Cache references ──
        _wrapperEl = wrapper;
        _dropdownEl = dropdown;
        _inputEl = input;

        // ── Insert into the page ──
        _insertIntoPage(wrapper);

        // ── Event listeners ──
        input.addEventListener('input', function () {
            _onInputChange(input, dropdown);
        });

        input.addEventListener('keydown', function (e) {
            _handleKeyboard(e, dropdown, input);
        });

        // Re-show dropdown when input is focused (if there is content)
        input.addEventListener('focus', function () {
            if (input.value.trim().length >= MIN_QUERY_LENGTH) {
                dropdown.classList.add('tacta-qsc-dropdown-visible');
            }
        });

        // Close when clicking outside
        document.addEventListener('click', function (e) {
            var w = document.getElementById(WRAPPER_ID);
            if (w && !w.contains(e.target)) {
                _collapse();
            }
        });
    }

    /**
     * Inserts the wrapper as a floating body-level control. Positioning is
     * calculated from NetSuite's native search bar so we do not disturb the
     * header/menu layout.
     * @param {HTMLElement} wrapper
     */
    function _insertIntoPage(wrapper) {
        wrapper.classList.add('tacta-qsc-floating');
        document.body.appendChild(wrapper);
        _positionFloatingWrapper();
        window.addEventListener('resize', _positionFloatingWrapper);
        window.addEventListener('scroll', _positionFloatingWrapper, true);
    }

    function _positionFloatingWrapper() {
        if (!_wrapperEl) return;

        var anchor = _findNsSearchBar() || _findCompanyLogoAnchor();
        if (!anchor) {
            _wrapperEl.classList.add('tacta-qsc-unplaced');
            return;
        }

        var rect = anchor.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            _wrapperEl.classList.add('tacta-qsc-unplaced');
            return;
        }

        _wrapperEl.classList.remove('tacta-qsc-unplaced');

        var collapsedWidth = 30;
        var expandedWidth = Math.min(500, Math.max(320, window.innerWidth - 32));
        var width = _isOpen ? expandedWidth : collapsedWidth;
        var gap = 8;
        var left = Math.max(8, rect.left - width - gap);
        var top = Math.max(4, rect.top + (rect.height / 2) - 15);

        _wrapperEl.style.left = Math.round(left) + 'px';
        _wrapperEl.style.top = Math.round(top) + 'px';
    }

    // ────────────────────────────────────────────────────────────────
    // Search Input Handling
    // ────────────────────────────────────────────────────────────────

    /**
     * Handles input change with debouncing.
     * @param {HTMLInputElement} input
     * @param {HTMLElement} dropdown
     */
    function _onInputChange(input, dropdown) {
        _selectedIndex = -1;

        clearTimeout(_debounceTimer);

        var query = input.value.trim();

        if (query.length < MIN_QUERY_LENGTH) {
            dropdown.classList.remove('tacta-qsc-dropdown-visible');
            dropdown.innerHTML = '';
            _visibleResults = [];
            _setLoading(false);
            return;
        }

        _debounceTimer = setTimeout(function () {
            _performSearch(query, dropdown);
        }, DEBOUNCE_MS);
    }

    /**
     * Performs the actual search: shows loading, fires queries, renders results.
     * @param {string} query
     * @param {HTMLElement} dropdown
     */
    function _performSearch(query, dropdown) {
        _requestId++;
        var currentReqId = _requestId;

        _setLoading(true);

        // Show the dropdown immediately with loading state
        dropdown.innerHTML = '';
        var loadingEl = document.createElement('div');
        loadingEl.className = 'tacta-qsc-loading-msg';
        loadingEl.textContent = 'Searching...';
        dropdown.appendChild(loadingEl);
        dropdown.classList.add('tacta-qsc-dropdown-visible');

        _runSearch(query, currentReqId).then(function (groups) {
            // Stale request - discard
            if (groups === null) return;
            // Another search started - discard
            if (currentReqId !== _requestId) return;

            _setLoading(false);
            _renderSearchResults(dropdown, groups, query);
        }).catch(function () {
            if (currentReqId !== _requestId) return;
            _setLoading(false);
            _renderError(dropdown);
        });
    }

    /**
     * Renders search results into the dropdown.
     * @param {HTMLElement} dropdown
     * @param {Array<{ key: string, label: string, items: Array }>} groups
     * @param {string} query
     */
    function _renderSearchResults(dropdown, groups, query) {
        dropdown.innerHTML = '';
        _visibleResults = [];
        _selectedIndex = -1;

        var flatIndex = 0;
        var hasResults = false;

        // -- Record results grouped by type --
        for (var g = 0; g < groups.length; g++) {
            var group = groups[g];
            if (!group.items || group.items.length === 0) continue;
            hasResults = true;

            // Group header
            var groupHeader = document.createElement('div');
            groupHeader.className = 'tacta-qsc-group-header';
            groupHeader.textContent = group.label;
            dropdown.appendChild(groupHeader);

            for (var i = 0; i < group.items.length; i++) {
                var item = group.items[i];
                _visibleResults.push({ url: item.url, label: item.name });

                var row = document.createElement('a');
                row.className = 'tacta-qsc-result-item';
                row.href = item.url;
                row.target = '_blank';
                row.rel = 'noopener';
                row.setAttribute('data-index', flatIndex);
                row.title = 'Open ' + (item.name || 'record') + ' (ID: ' + item.id + ')';

                // Left side: name + detail
                var nameWrap = document.createElement('div');
                nameWrap.className = 'tacta-qsc-result-name-wrap';

                var nameEl = document.createElement('span');
                nameEl.className = 'tacta-qsc-result-name';
                nameEl.innerHTML = _highlightMatch(item.name, query);

                nameWrap.appendChild(nameEl);

                if (item.detail) {
                    var detailEl = document.createElement('span');
                    detailEl.className = 'tacta-qsc-result-detail';
                    detailEl.innerHTML = _highlightMatch(item.detail, query);
                    nameWrap.appendChild(detailEl);
                }

                // Right side: type badge
                var badge = document.createElement('span');
                badge.className = 'tacta-qsc-result-badge';
                badge.textContent = group.label;

                row.appendChild(nameWrap);
                row.appendChild(badge);
                dropdown.appendChild(row);

                // Hover sets selection
                (function (idx) {
                    row.addEventListener('mouseenter', function () {
                        _selectedIndex = idx;
                        _updateSelection(dropdown);
                    });
                })(flatIndex);

                flatIndex++;
            }
        }

        // -- No results message --
        if (!hasResults) {
            var empty = document.createElement('div');
            empty.className = 'tacta-qsc-empty';
            empty.textContent = 'No results for "' + query + '"';
            dropdown.appendChild(empty);
        }

        // -- "Create new search" section (secondary, always shown) --
        _renderCreateSearchLinks(dropdown, query, flatIndex);

        dropdown.classList.add('tacta-qsc-dropdown-visible');
    }

    /**
     * Renders the "Create new search" links at the bottom of the dropdown.
     * @param {HTMLElement} dropdown
     * @param {string} query
     * @param {number} startIndex - Starting flat index for keyboard nav
     */
    function _renderCreateSearchLinks(dropdown, query, startIndex) {
        var enabled = _getEnabledSearchTypes();
        if (enabled.length === 0) return;

        // Separator
        var sep = document.createElement('div');
        sep.className = 'tacta-qsc-create-separator';

        var sepLabel = document.createElement('span');
        sepLabel.className = 'tacta-qsc-create-sep-label';
        sepLabel.textContent = 'Create New Search';
        sep.appendChild(sepLabel);

        dropdown.appendChild(sep);

        var flatIndex = startIndex;

        for (var i = 0; i < enabled.length; i++) {
            var st = enabled[i];
            var url = _buildSearchUrl(st);
            _visibleResults.push({ url: url, label: 'New ' + st.label + ' Search' });

            var link = document.createElement('a');
            link.className = 'tacta-qsc-result-item tacta-qsc-create-link';
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener';
            link.setAttribute('data-index', flatIndex);
            link.title = 'Create new ' + st.label + ' search';

            var label = document.createElement('span');
            label.className = 'tacta-qsc-result-label';
            label.innerHTML = '+ ' + _highlightMatch(st.label, query);

            var badge = document.createElement('span');
            badge.className = 'tacta-qsc-result-badge tacta-qsc-badge-create';
            badge.textContent = st.group;

            link.appendChild(label);
            link.appendChild(badge);
            dropdown.appendChild(link);

            // Hover sets selection
            (function (idx) {
                link.addEventListener('mouseenter', function () {
                    _selectedIndex = idx;
                    _updateSelection(dropdown);
                });
            })(flatIndex);

            flatIndex++;
        }
    }

    /**
     * Renders an error message in the dropdown.
     * @param {HTMLElement} dropdown
     */
    function _renderError(dropdown) {
        dropdown.innerHTML = '';
        _visibleResults = [];
        _selectedIndex = -1;

        var errEl = document.createElement('div');
        errEl.className = 'tacta-qsc-empty tacta-qsc-error-msg';
        errEl.textContent = 'Search failed. Ensure you are on a NetSuite page with active session.';
        dropdown.appendChild(errEl);
        dropdown.classList.add('tacta-qsc-dropdown-visible');
    }

    /**
     * Shows or hides the loading spinner.
     * @param {boolean} show
     */
    function _setLoading(show) {
        _isLoading = show;
        var spinner = document.getElementById('tacta-qsc-spinner');
        if (spinner) {
            spinner.classList.toggle('tacta-qsc-spinner-visible', show);
        }
    }

    /**
     * Updates the visual selection state of result items.
     * @param {HTMLElement} dropdown
     */
    function _updateSelection(dropdown) {
        var items = dropdown.querySelectorAll('.tacta-qsc-result-item');
        for (var i = 0; i < items.length; i++) {
            var idx = parseInt(items[i].getAttribute('data-index'), 10);
            if (idx === _selectedIndex) {
                items[i].classList.add('tacta-qsc-result-selected');
                _scrollIntoViewIfNeeded(items[i], dropdown);
            } else {
                items[i].classList.remove('tacta-qsc-result-selected');
            }
        }
    }

    /**
     * Handles keyboard navigation within the search bar.
     * @param {KeyboardEvent} e
     * @param {HTMLElement} dropdown
     * @param {HTMLInputElement} input
     */
    function _handleKeyboard(e, dropdown, input) {
        var total = _visibleResults.length;

        switch (e.key) {
            case 'ArrowDown':
                if (total === 0) return;
                e.preventDefault();
                _selectedIndex = (_selectedIndex + 1) % total;
                _updateSelection(dropdown);
                break;

            case 'ArrowUp':
                if (total === 0) return;
                e.preventDefault();
                _selectedIndex = _selectedIndex <= 0 ? total - 1 : _selectedIndex - 1;
                _updateSelection(dropdown);
                break;

            case 'Enter':
                e.preventDefault();
                if (_selectedIndex >= 0 && _selectedIndex < total) {
                    window.open(_visibleResults[_selectedIndex].url, '_blank', 'noopener');
                } else if (total === 1) {
                    window.open(_visibleResults[0].url, '_blank', 'noopener');
                }
                break;

            case 'Escape':
                e.preventDefault();
                _collapse();
                break;
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Initialization
    // ────────────────────────────────────────────────────────────────

    /**
     * Main initialization -- loads state, renders UI.
     */
    function _init() {
        _loadState(function () {
            _render();
        });
    }

    /**
     * Initializes the feature when the DOM is ready.
     */
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', _init, { once: true });
        } else {
            _init();
        }
    }

    /**
     * Listen for feature activation events dispatched by the router.
     */
    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === 'quick-search-creation') {
            _init();
        }
    });

    // Listen for settings changes to refresh the UI dynamically
    try {
        chrome.storage.onChanged.addListener(function (changes) {
            var needsRefresh = false;
            if (changes[TYPES_KEY]) {
                _enabledTypes = changes[TYPES_KEY].newValue || {};
                needsRefresh = true;
            }
            if (changes[INACTIVES_KEY]) {
                _includeInactives = changes[INACTIVES_KEY].newValue === true;
                _searchCache.clear();
                needsRefresh = true;
            }
            if (needsRefresh) {
                var existing = document.getElementById(WRAPPER_ID);
                if (existing) {
                    existing.remove();
                }
                _wrapperEl = null;
                _dropdownEl = null;
                _inputEl = null;
                _isOpen = false;
                _render();
            }
        });
    } catch (_) { /* storage events not available */ }

    // Auto-initialize
    init();

})();

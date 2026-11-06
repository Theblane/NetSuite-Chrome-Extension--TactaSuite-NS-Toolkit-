/**
 * better-page-titles.js
 * NetSuite TactaSuite — Better Page Titles (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Rewrites the browser tab title on NetSuite pages to include the record
 * type and name/number, making it far easier to identify tabs when
 * multiple NetSuite pages are open.
 *
 * Title formats by page type:
 *   Record:  "{Record Type} - {Name/Number} | NetSuite"
 *   Search:  "Search: {Search Name} | NetSuite"
 *   List:    "List: {Page Title} | NetSuite"
 *   Setup:   "Setup: {Page Title} | NetSuite"
 *   Suitelet: "Suitelet: {Page Title} | NetSuite"
 *   Dashboard: "Dashboard | NetSuite"
 *   Other:   leaves title unchanged or lightly cleaned up
 *
 * Observes DOM mutations so the title stays correct when NetSuite
 * re-renders content (SPA-like navigation within the same tab).
 *
 * @fileoverview Content script for the Better Page Titles feature.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaBetterPageTitlesLoaded) return;
    window.__tactaBetterPageTitlesLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} Suffix appended to every rewritten title */
    var TITLE_SUFFIX = ' | NetSuite';

    /** @type {number} Debounce delay (ms) for MutationObserver callbacks */
    var DEBOUNCE_MS = 300;

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {string|null} The last title we wrote, to avoid loops */
    var _lastSetTitle = null;

    /** @type {MutationObserver|null} */
    var _headerObserver = null;

    /** @type {MutationObserver|null} */
    var _titleObserver = null;

    /** @type {number} Debounce timer handle */
    var _debounceTimer = 0;

    // ────────────────────────────────────────────────────────────────
    // DOM reading helpers
    // ────────────────────────────────────────────────────────────────

    /**
     * Returns the trimmed text content of the first element matching
     * any of the given selectors, or null if none match.
     * @param {string[]} selectors
     * @returns {string|null}
     */
    function _textFromSelectors(selectors) {
        for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el) {
                var text = _headerText(el);
                if (text) return text;
            }
        }
        return null;
    }

    /**
     * Text of a header element with NetSuite's inline menus and toolbars
     * removed. The record title line carries the "List / Search / Customize"
     * menu and the "New Body Field" shortcuts as children, and their text
     * must never end up in a tab title.
     * @param {Element} el
     * @returns {string}
     */
    function _headerText(el) {
        if (!el) return '';
        var clone = el.cloneNode(true);
        var junk = clone.querySelectorAll(
            'ul, ol, table, button, select, input, textarea, script, style, ' +
            '.uir-menu, .ns-menu, .uir-page-title-menu, .uir-toolbar, .uir-list-ta, ' +
            '[class*="menu"], [class*="Menu"], [role="menu"], [role="menubar"], .uir-help-link, .tacta-env-badge'
        );
        for (var i = 0; i < junk.length; i++) {
            if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
        }
        var text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        // Anything beyond a sane header length is menu residue, not a name.
        if (text.length > 120) text = text.slice(0, 120).trim();
        return text;
    }

    /**
     * Extracts the record type label from the page.
     * Looks at several well-known NetSuite DOM locations.
     * @returns {string|null}
     */
    function _getRecordType() {
        // NetSuite marks the type explicitly when it can; otherwise the first
        // title line holds "Sales Order", "Customer", etc. (the second line is
        // the record name and status). Older layouts had the two lines swapped,
        // so a short first line wins over the second.
        var type = _textFromSelectors(['.uir-record-type', '#_recordTypeName']);
        if (type) return type;
        var first = _textFromSelectors(['.uir-page-title-firstline']);
        var second = _textFromSelectors(['.uir-page-title-secondline']);
        if (first && second) {
            return first.length <= second.length ? first : second;
        }
        if (first) return first;
        if (second) return second;

        // Breadcrumb: the last breadcrumb text before the record name
        var breadcrumbs = document.querySelectorAll('.ns-breadcrumb-text, .uir-breadcrumb span');
        if (breadcrumbs.length > 0) {
            var last = (breadcrumbs[breadcrumbs.length - 1].textContent || '').trim();
            if (last) return last;
        }

        return null;
    }

    /**
     * Extracts the record name or number from the page header.
     * @returns {string|null}
     */
    function _getRecordName() {
        var first = _textFromSelectors(['.uir-page-title-firstline']);
        var second = _textFromSelectors(['.uir-page-title-secondline']);
        // Whichever title line is NOT the type is the name (see _getRecordType).
        if (first && second) {
            return first.length <= second.length ? second : first;
        }
        return first || second || _textFromSelectors(['#headertext', '.uir-page-title']);
    }

    /**
     * Extracts the search name from a search page.
     * @returns {string|null}
     */
    function _getSearchName() {
        // Search results page title
        var name = _textFromSelectors([
            '.uir-page-title-firstline',
            '.uir-page-title',
            '#headertext'
        ]);
        if (name) return name;

        // Fallback: the search title input on the edit page
        var titleInput = document.querySelector('input[name="title"], input[name="searchtitle"]');
        if (titleInput && titleInput.value) return titleInput.value.trim();

        return null;
    }

    /**
     * Extracts a generic page heading for list/setup/suitelet pages.
     * @returns {string|null}
     */
    function _getPageHeading() {
        return _textFromSelectors([
            '.uir-page-title-firstline',
            '.uir-page-title',
            '#headertext',
            '.ns-page-title',
            'h1'
        ]);
    }

    /**
     * Strips the " | NetSuite" or other common suffixes from the
     * existing document.title, so we can use it as a fallback.
     * @returns {string}
     */
    function _cleanExistingTitle() {
        var raw = document.title || '';
        return raw
            .replace(/\s*[|\u2013\u2014]\s*NetSuite\s*$/i, '')
            .replace(/\s*-\s*NetSuite\s*$/i, '')
            .trim();
    }

    // ────────────────────────────────────────────────────────────────
    // Page type detection
    // ────────────────────────────────────────────────────────────────

    /**
     * Determines the page category from the URL.
     * Uses the same URL heuristics as ns-page-detector.js but
     * simplified to the categories this feature cares about.
     * @returns {string} One of: record, search, list, setup, suitelet, dashboard, script, other
     */
    function _detectPageCategory() {
        var href = window.location.href;

        if (/\/app\/common\/search\/searchresults\.nl/i.test(href))    return 'search';
        if (/\/app\/common\/search\/search\.nl/i.test(href))           return 'search';
        if (/\/app\/common\/search\/searchlist\.nl/i.test(href))       return 'search-list';
        if (/\/app\/common\/search\//i.test(href))                     return 'search-list';
        if (/\/app\/common\/scripting\/script\.nl/i.test(href))        return 'record';
        if (/\/app\/common\/workflow\/setup\//i.test(href))            return 'other';
        if (/\/app\/site\/hosting\/scriptlet\.nl/i.test(href))         return 'suitelet';
        if (/\/app\/center\/card\.nl/i.test(href))                     return 'dashboard';
        if (/\/app\/setup\//i.test(href))                              return 'setup';
        if (/\/app\/accounting\/transactions\//i.test(href))           return 'record';
        if (/\/app\/common\/custom\/custrecordentry\.nl/i.test(href))  return 'record';
        if (/\/app\/common\/entity\//i.test(href))                     return 'record';
        if (/list\.nl/i.test(href))                                    return 'list';

        return 'other';
    }

    // ────────────────────────────────────────────────────────────────
    // Title composition
    // ────────────────────────────────────────────────────────────────

    /**
     * Builds the ideal title for the current page.
     * @returns {string|null} The new title, or null to leave as-is.
     */
    function _buildTitle() {
        var category = _detectPageCategory();

        switch (category) {
            case 'record': {
                var recType = _getRecordType();
                var recName = _getRecordName();

                if (recType && recName) {
                    // Avoid duplication if the name already contains the type
                    if (recName.toLowerCase().indexOf(recType.toLowerCase()) === 0) {
                        return recName + TITLE_SUFFIX;
                    }
                    return recType + ' - ' + recName + TITLE_SUFFIX;
                }
                if (recType) return recType + TITLE_SUFFIX;
                if (recName) return recName + TITLE_SUFFIX;

                // Fallback to cleaned existing title
                var cleaned = _cleanExistingTitle();
                return cleaned ? cleaned + TITLE_SUFFIX : null;
            }

            case 'search': {
                var searchName = _getSearchName();
                if (searchName) return 'Search: ' + searchName + TITLE_SUFFIX;
                var fallback = _cleanExistingTitle();
                return fallback ? 'Search: ' + fallback + TITLE_SUFFIX : null;
            }

            case 'search-list': {
                var heading = _getPageHeading();
                if (heading) return heading + TITLE_SUFFIX;
                return 'Saved Searches' + TITLE_SUFFIX;
            }

            case 'list': {
                var listHeading = _getPageHeading();
                if (listHeading) return 'List: ' + listHeading + TITLE_SUFFIX;
                var listFallback = _cleanExistingTitle();
                return listFallback ? 'List: ' + listFallback + TITLE_SUFFIX : null;
            }

            case 'setup': {
                var setupHeading = _getPageHeading();
                if (setupHeading) return 'Setup: ' + setupHeading + TITLE_SUFFIX;
                var setupFallback = _cleanExistingTitle();
                return setupFallback ? 'Setup: ' + setupFallback + TITLE_SUFFIX : null;
            }

            case 'suitelet': {
                var slHeading = _getPageHeading();
                if (slHeading) return 'Suitelet: ' + slHeading + TITLE_SUFFIX;
                var slFallback = _cleanExistingTitle();
                return slFallback ? 'Suitelet: ' + slFallback + TITLE_SUFFIX : null;
            }

            case 'dashboard':
                return 'Dashboard' + TITLE_SUFFIX;

            default:
                return null;
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Title application
    // ────────────────────────────────────────────────────────────────

    /**
     * Computes and applies the new page title if applicable.
     * Safe to call repeatedly — no-ops when nothing has changed.
     */
    function _applyTitle() {
        var newTitle = _buildTitle();

        // Nothing to set, or title unchanged
        if (!newTitle || newTitle === _lastSetTitle || newTitle === document.title) return;

        document.title = newTitle;
        _lastSetTitle = newTitle;
    }

    /**
     * Debounced version of _applyTitle to avoid rapid re-computation
     * when multiple DOM mutations fire in quick succession.
     */
    function _applyTitleDebounced() {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(_applyTitle, DEBOUNCE_MS);
    }

    // ────────────────────────────────────────────────────────────────
    // Observers
    // ────────────────────────────────────────────────────────────────

    /**
     * Watches for changes in the page header area so we can update
     * the title if NetSuite re-renders the record name or type
     * (e.g. after an inline edit save).
     *
     * Narrowed scope: prefer the title area elements over the entire
     * form to reduce observer overhead. characterData removed since
     * NetSuite title changes are structural (element replacement).
     */
    function _observeHeaderChanges() {
        // Prefer narrow targets: the page title container
        var target = document.querySelector('.uir-page-title-firstline')
                  || document.querySelector('.uir-page-title')
                  || document.getElementById('main_form')
                  || document.getElementById('div__body')
                  || document.body;

        if (_headerObserver) _headerObserver.disconnect();

        _headerObserver = new MutationObserver(_applyTitleDebounced);
        _headerObserver.observe(target, {
            childList: true,
            subtree: true
        });
    }

    /**
     * Watches document.title itself so we can re-assert our title
     * when NetSuite overwrites it (e.g. after SPA navigation).
     */
    function _observeTitleElement() {
        var titleEl = document.querySelector('title');
        if (!titleEl) return;

        if (_titleObserver) _titleObserver.disconnect();

        _titleObserver = new MutationObserver(function () {
            // Only reassert if NS overwrote our title with something different
            if (document.title !== _lastSetTitle) {
                _applyTitleDebounced();
            }
        });
        _titleObserver.observe(titleEl, {
            childList: true,
            characterData: true,
            subtree: true
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Initialization
    // ────────────────────────────────────────────────────────────────

    /**
     * Main init routine. Applies the title immediately, then sets up
     * observers for future changes.
     */
    function _render() {
        _applyTitle();
        _observeHeaderChanges();
        _observeTitleElement();
    }

    /**
     * Initializes the feature when the DOM is ready.
     */
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', _render, { once: true });
        } else {
            _render();
        }
    }

    /**
     * Listen for feature activation events dispatched by the router.
     */
    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === 'better-page-titles') {
            _render();
        }
    });

    // Auto-initialize
    init();

})();

/**
 * fixed-headers.js
 * NetSuite TactaSuite - Fixed Headers (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Pins sublist / machine header rows so they stay visible when scrolling
 * long line-item lists on NetSuite record pages.
 *
 * Approach:
 *   1. Scan for all `.uir-machine-table-container` and `table[id$="_splits"]`
 *      elements on the page.
 *   2. Inside each, locate `.uir-machine-headerrow` rows and apply a CSS
 *      class that makes them `position: sticky; top: 0`.
 *   3. A MutationObserver watches the DOM for dynamically loaded sublists
 *      (NetSuite lazy-loads some tabs) and applies the same treatment.
 *
 * Runs automatically on record-view, record-edit, search-results, and
 * list pages. No popup activation needed.
 *
 * @fileoverview Fixed Headers content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaFixedHeadersLoaded) return;
    window.__tactaFixedHeadersLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} CSS class applied to pinned header rows */
    var STICKY_CLASS = 'tacta-fh-sticky';

    /** @type {string} CSS class applied to scroll containers that have been processed */
    var PROCESSED_CLASS = 'tacta-fh-processed';

    /** @type {string} Selector for sublist scroll containers */
    var CONTAINER_SELECTOR = '.uir-machine-table-container, table[id$="_splits"]';

    /** @type {string} Selector for header rows inside sublist tables */
    var HEADER_ROW_SELECTOR = '.uir-machine-headerrow';

    /** @type {string} Selector matching NS list-page header rows (search results / lists) */
    var LIST_HEADER_SELECTOR = '.uir-list-headerrow';

    // ────────────────────────────────────────────────────────────────
    // Core logic
    // ────────────────────────────────────────────────────────────────

    /**
     * Processes a single sublist container: finds its header row(s) and
     * applies the sticky CSS class. Marks the container so it is not
     * processed again.
     *
     * @param {HTMLElement} container - A `.uir-machine-table-container` or
     *        `table[id$="_splits"]` element.
     */
    function _processContainer(container) {
        if (container.classList.contains(PROCESSED_CLASS)) return;
        container.classList.add(PROCESSED_CLASS);

        // The container itself is the scroll parent (overflow: auto).
        // For `table[id$="_splits"]` the table IS the container; we still
        // want to pin its header row, which works when an ancestor scrolls.
        var headers = container.querySelectorAll(HEADER_ROW_SELECTOR);
        for (var i = 0; i < headers.length; i++) {
            headers[i].classList.add(STICKY_CLASS);
        }
    }

    /**
     * Processes list-page header rows (search results, saved search lists).
     * These live inside `table.uir-list-table` and are not wrapped in a
     * `.uir-machine-table-container`.
     */
    function _processListHeaders() {
        var listHeaders = document.querySelectorAll(LIST_HEADER_SELECTOR);
        for (var i = 0; i < listHeaders.length; i++) {
            listHeaders[i].classList.add(STICKY_CLASS);
        }
    }

    /**
     * Scans the entire document for unprocessed sublist containers and
     * list headers, then applies sticky classes.
     */
    function _scanAndApply() {
        var containers = document.querySelectorAll(CONTAINER_SELECTOR);
        for (var i = 0; i < containers.length; i++) {
            _processContainer(containers[i]);
        }
        _processListHeaders();
    }

    // ────────────────────────────────────────────────────────────────
    // MutationObserver — catch lazy-loaded sublists
    // ────────────────────────────────────────────────────────────────

    /** @type {MutationObserver|null} */
    var _observer = null;

    /**
     * Starts a MutationObserver on `document.body` that watches for new
     * sublist containers being added to the DOM (e.g., when the user
     * switches to a sublist tab that was not yet rendered).
     */
    function _startObserver() {
        if (_observer) return;

        _observer = new MutationObserver(function (mutations) {
            var needsScan = false;

            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var node = added[j];
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;

                    // Check if the added node itself is a container
                    if (node.matches && node.matches(CONTAINER_SELECTOR)) {
                        _processContainer(node);
                        continue;
                    }

                    // Check if the added subtree contains containers or list headers
                    if (node.querySelector &&
                        (node.querySelector(CONTAINER_SELECTOR) ||
                         node.querySelector(HEADER_ROW_SELECTOR) ||
                         node.querySelector(LIST_HEADER_SELECTOR))) {
                        needsScan = true;
                        break;
                    }
                }
                if (needsScan) break;
            }

            if (needsScan) {
                _scanAndApply();
            }
        });

        _observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Initialization
    // ────────────────────────────────────────────────────────────────

    /**
     * Main render function — scans current DOM and starts the observer.
     */
    function _render() {
        _scanAndApply();
        _startObserver();
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
     * Although this is an auto-trigger feature, the router still dispatches
     * the activation event after injecting the script.
     */
    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === 'fixed-headers') {
            _render();
        }
    });

    // Auto-initialize
    init();

})();

/**
 * workflow-colors.js
 * NetSuite TactaSuite - Workflow Colors (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Color-codes workflow states and transitions on NetSuite workflow setup
 * pages for easier visual parsing.
 *
 * State classification (by name pattern):
 *   - Entry states:     green tint   (start, entry, begin, initial, new)
 *   - Exit/end states:  red tint     (exit, end, close, complete, finish, done)
 *   - Approval states:  blue tint    (approv, review, pending approval)
 *   - Rejection states: orange tint  (reject, denied, decline, return)
 *   - Default/other:    subtle gray
 *
 * Transition classification (by condition text):
 *   - Always:     green
 *   - Formula:    purple
 *   - Other:      muted blue
 *
 * Uses MutationObserver to handle dynamic rendering (workflow editor loads
 * states asynchronously).
 *
 * Runs automatically on workflow setup pages (/app/common/workflow/setup/*).
 *
 * @fileoverview Workflow Colors content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaWorkflowColorsLoaded) return;
    window.__tactaWorkflowColorsLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} CSS class prefix for this feature */
    var CLASS_PREFIX = 'tacta-wfc';

    /** @type {string} Marker class for processed elements */
    var PROCESSED_CLASS = 'tacta-wfc-processed';

    /**
     * State classification rules — tested in order; first match wins.
     * Each rule has a regex pattern and the CSS class suffix to apply.
     * @type {Array<{ pattern: RegExp, type: string }>}
     */
    var STATE_RULES = [
        { pattern: /\b(start|entry|begin|initial|new|init)\b/i,                         type: 'entry' },
        { pattern: /\b(exit|end|close|complet|finish|done|final|termin|cancel)\b/i,     type: 'exit' },
        { pattern: /\b(approv|review|pending\s+approv|authorize|authoris)\b/i,          type: 'approval' },
        { pattern: /\b(reject|denied|decline|return|refus|deny)\b/i,                    type: 'rejection' }
    ];

    /**
     * Transition classification rules.
     * @type {Array<{ pattern: RegExp, type: string }>}
     */
    var TRANSITION_RULES = [
        { pattern: /\balways\b/i,                   type: 'always' },
        { pattern: /\bformula\b/i,                  type: 'formula' },
        { pattern: /\bfield\s*(changed|=|equals)/i, type: 'field' },
        { pattern: /\bbutton\b/i,                   type: 'button' }
    ];

    /**
     * Selectors for workflow DOM elements.
     * NetSuite workflow editor uses a mix of class names and ID patterns.
     */
    var SELECTORS = {
        /** Workflow state containers (diagram view) */
        stateNode:       '.wfstate, [id^="state_"], .wf-state, .workflowstate, .uir-workflow-state',
        /** Workflow transition elements (diagram view) */
        transitionNode:  '.wftransition, .wf-transition, .workflowtransition, .uir-workflow-transition',
        /** State rows in list/table view */
        stateListRow:    'tr[id*="state"], .wfstaterow',
        /** Transition rows in list/table view */
        transitionListRow: 'tr[id*="transition"], .wftransitionrow',
        /** The overall workflow diagram container */
        diagramContainer: '#workflowdiagram, .wf-diagram, .workflow-diagram, #div__body',
        /** State labels within nodes */
        stateLabel:      '.wfstatelabel, .wf-state-label, .uir-workflow-state-name'
    };

    // ────────────────────────────────────────────────────────────────
    // State classification
    // ────────────────────────────────────────────────────────────────

    /**
     * Classifies a state by examining its text content against STATE_RULES.
     *
     * @param {string} text - The state name or label text.
     * @returns {string} The state type: 'entry', 'exit', 'approval', 'rejection', or 'default'.
     */
    function _classifyState(text) {
        if (!text) return 'default';
        for (var i = 0; i < STATE_RULES.length; i++) {
            if (STATE_RULES[i].pattern.test(text)) {
                return STATE_RULES[i].type;
            }
        }
        return 'default';
    }

    /**
     * Classifies a transition by examining its text/label against TRANSITION_RULES.
     *
     * @param {string} text - The transition condition text or label.
     * @returns {string} The transition type: 'always', 'formula', 'field', 'button', or 'default'.
     */
    function _classifyTransition(text) {
        if (!text) return 'default';
        for (var i = 0; i < TRANSITION_RULES.length; i++) {
            if (TRANSITION_RULES[i].pattern.test(text)) {
                return TRANSITION_RULES[i].type;
            }
        }
        return 'default';
    }

    // ────────────────────────────────────────────────────────────────
    // DOM processing
    // ────────────────────────────────────────────────────────────────

    /**
     * Extracts readable text from an element, checking labels, titles,
     * and direct text content.
     *
     * @param {HTMLElement} el - The DOM element.
     * @returns {string} Extracted text.
     */
    function _extractText(el) {
        // Try title attribute first (often set on NS workflow nodes)
        var title = el.getAttribute('title') || '';
        if (title) return title;

        // Try aria-label
        var ariaLabel = el.getAttribute('aria-label') || '';
        if (ariaLabel) return ariaLabel;

        // Try nested label element
        var labelEl = el.querySelector(
            SELECTORS.stateLabel + ', .label, [class*="label"], [class*="name"], span, a'
        );
        if (labelEl) {
            return (labelEl.textContent || '').trim();
        }

        // Fall back to the element's own text content
        return (el.textContent || '').trim();
    }

    /**
     * Removes any previously applied workflow-color classes from an element.
     *
     * @param {HTMLElement} el - The DOM element.
     */
    function _clearTypeClasses(el) {
        var classes = el.className.split(/\s+/);
        var cleaned = [];
        for (var i = 0; i < classes.length; i++) {
            if (classes[i].indexOf(CLASS_PREFIX + '-state-') !== 0 &&
                classes[i].indexOf(CLASS_PREFIX + '-trans-') !== 0) {
                cleaned.push(classes[i]);
            }
        }
        el.className = cleaned.join(' ');
    }

    /**
     * Processes a workflow state element: classifies it and applies
     * the appropriate CSS class.
     *
     * @param {HTMLElement} el - A workflow state DOM node.
     */
    function _processState(el) {
        if (el.classList.contains(PROCESSED_CLASS)) return;
        el.classList.add(PROCESSED_CLASS);

        var text = _extractText(el);
        var stateType = _classifyState(text);

        el.classList.add(CLASS_PREFIX + '-state');
        el.classList.add(CLASS_PREFIX + '-state-' + stateType);
    }

    /**
     * Processes a workflow transition element: classifies it and applies
     * the appropriate CSS class.
     *
     * @param {HTMLElement} el - A workflow transition DOM node.
     */
    function _processTransition(el) {
        if (el.classList.contains(PROCESSED_CLASS)) return;
        el.classList.add(PROCESSED_CLASS);

        var text = _extractText(el);
        var transType = _classifyTransition(text);

        el.classList.add(CLASS_PREFIX + '-trans');
        el.classList.add(CLASS_PREFIX + '-trans-' + transType);
    }

    /**
     * Processes table rows that represent states in the list view.
     * Classifies each row and applies a left-border color indicator.
     *
     * @param {HTMLElement} row - A <tr> element representing a workflow state.
     */
    function _processStateRow(row) {
        if (row.classList.contains(PROCESSED_CLASS)) return;
        row.classList.add(PROCESSED_CLASS);

        // In list view, the state name is usually in the first or second cell
        var cells = row.querySelectorAll('td');
        var text = '';
        for (var i = 0; i < Math.min(cells.length, 3); i++) {
            text += ' ' + (cells[i].textContent || '');
        }
        text = text.trim();

        var stateType = _classifyState(text);
        row.classList.add(CLASS_PREFIX + '-state-row');
        row.classList.add(CLASS_PREFIX + '-state-row-' + stateType);
    }

    /**
     * Processes table rows that represent transitions in the list view.
     *
     * @param {HTMLElement} row - A <tr> element representing a workflow transition.
     */
    function _processTransitionRow(row) {
        if (row.classList.contains(PROCESSED_CLASS)) return;
        row.classList.add(PROCESSED_CLASS);

        var cells = row.querySelectorAll('td');
        var text = '';
        for (var i = 0; i < Math.min(cells.length, 4); i++) {
            text += ' ' + (cells[i].textContent || '');
        }
        text = text.trim();

        var transType = _classifyTransition(text);
        row.classList.add(CLASS_PREFIX + '-trans-row');
        row.classList.add(CLASS_PREFIX + '-trans-row-' + transType);
    }

    // ────────────────────────────────────────────────────────────────
    // Full-page scan
    // ────────────────────────────────────────────────────────────────

    /**
     * Scans the entire document for unprocessed workflow state and
     * transition elements, classifies them, and applies CSS classes.
     */
    function _scanAndApply() {
        // Diagram view — state nodes
        var stateNodes = document.querySelectorAll(SELECTORS.stateNode);
        for (var i = 0; i < stateNodes.length; i++) {
            _processState(stateNodes[i]);
        }

        // Diagram view — transition elements
        var transNodes = document.querySelectorAll(SELECTORS.transitionNode);
        for (var j = 0; j < transNodes.length; j++) {
            _processTransition(transNodes[j]);
        }

        // List/table view — state rows
        var stateRows = document.querySelectorAll(SELECTORS.stateListRow);
        for (var k = 0; k < stateRows.length; k++) {
            _processStateRow(stateRows[k]);
        }

        // List/table view — transition rows
        var transRows = document.querySelectorAll(SELECTORS.transitionListRow);
        for (var l = 0; l < transRows.length; l++) {
            _processTransitionRow(transRows[l]);
        }

        // Also scan the workflow sublist table if present
        _scanWorkflowSublist();
    }

    /**
     * Scans generic NS sublists on the workflow page for state/transition
     * data. The workflow setup page often renders states and transitions
     * in standard NetSuite sublists rather than custom diagram elements.
     */
    function _scanWorkflowSublist() {
        // Look for sublist tables that contain workflow state/transition data
        var tables = document.querySelectorAll(
            'table.uir-machine-table, table[id*="workflow"], table[id*="state"], table[id*="transition"]'
        );

        for (var t = 0; t < tables.length; t++) {
            var table = tables[t];
            var rows = table.querySelectorAll('tr:not(.uir-machine-headerrow)');

            for (var r = 0; r < rows.length; r++) {
                var row = rows[r];
                if (row.classList.contains(PROCESSED_CLASS)) continue;

                // Determine if this is a state or transition row based on table context
                var tableId = (table.id || '').toLowerCase();
                var text = (row.textContent || '').trim();

                if (!text) continue;

                if (tableId.indexOf('transition') !== -1) {
                    _processTransitionRow(row);
                } else {
                    // Default to state processing for workflow sublists
                    _processStateRow(row);
                }
            }
        }
    }

    // ────────────────────────────────────────────────────────────────
    // MutationObserver — handle async workflow rendering
    // ────────────────────────────────────────────────────────────────

    /** @type {MutationObserver|null} */
    var _observer = null;

    /** @type {number|null} Debounce timer for scan */
    var _scanTimer = null;

    /**
     * Debounced scan — avoids excessive processing when many DOM nodes
     * are added in rapid succession (common during workflow diagram render).
     */
    function _debouncedScan() {
        if (_scanTimer) clearTimeout(_scanTimer);
        _scanTimer = setTimeout(function () {
            _scanTimer = null;
            _scanAndApply();
        }, 150);
    }

    /**
     * Starts a MutationObserver on `document.body` that watches for new
     * workflow elements being added to the DOM. The workflow editor renders
     * states asynchronously, so we need to detect additions.
     */
    function _startObserver() {
        if (_observer) return;
        if (!document.body) return;

        _observer = new MutationObserver(function (mutations) {
            var needsScan = false;

            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var node = added[j];
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;

                    // Check if the node itself matches workflow selectors
                    if (node.matches) {
                        try {
                            if (node.matches(SELECTORS.stateNode) ||
                                node.matches(SELECTORS.transitionNode) ||
                                node.matches(SELECTORS.stateListRow) ||
                                node.matches(SELECTORS.transitionListRow)) {
                                needsScan = true;
                                break;
                            }
                        } catch (_) { /* invalid selector in this context */ }
                    }

                    // Check if subtree contains workflow elements
                    if (node.querySelector) {
                        try {
                            if (node.querySelector(SELECTORS.stateNode) ||
                                node.querySelector(SELECTORS.transitionNode) ||
                                node.querySelector(SELECTORS.stateListRow) ||
                                node.querySelector(SELECTORS.transitionListRow) ||
                                node.querySelector(SELECTORS.diagramContainer)) {
                                needsScan = true;
                                break;
                            }
                        } catch (_) { /* ignore selector errors */ }
                    }

                    // Also trigger on large subtree additions (workflow diagram redraw)
                    if (node.childElementCount > 5) {
                        needsScan = true;
                        break;
                    }
                }
                if (needsScan) break;
            }

            if (needsScan) {
                _debouncedScan();
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

        // Re-scan after a short delay to catch late-rendering elements
        setTimeout(_scanAndApply, 1000);
        setTimeout(_scanAndApply, 3000);
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
        if (e.detail && e.detail.featureId === 'workflow-colors') {
            _render();
        }
    });

    // Auto-initialize
    init();

})();

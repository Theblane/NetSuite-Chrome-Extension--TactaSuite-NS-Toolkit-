/**
 * record-object.js
 * NetSuite TactaSuite - Record Object Viewer (Content Script)
 *
 * @author Blane Maher
 *
 * Fetches the current NetSuite record as XML via &xml=T, parses it into
 * a structured JSON object, and displays it in a floating panel with an
 * expandable JSON tree, search/filter, click-to-copy, and collapsible
 * sublists.
 *
 * Activation: popup message dispatches 'tacta:featureActivated' event
 * with featureId 'record-object'.
 *
 * @fileoverview Record Object Viewer content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaRecordObjectLoaded) return;
    window.__tactaRecordObjectLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    var FEATURE_ID = 'record-object';
    var SCOPE_CLASS = 'tacta-record-object';
    var PANEL_WIDTH = 600;
    var PANEL_HEIGHT = 500;

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {{ panel: HTMLElement, header: HTMLElement, body: HTMLElement, close: Function }|null} */
    var _panelInstance = null;

    /** @type {Object|null} Parsed record data */
    var _recordData = null;

    /** @type {string} Current search/filter term */
    var _searchTerm = '';

    /** @type {number} Debounce timer for search input */
    var _searchTimer = 0;

    // ────────────────────────────────────────────────────────────────
    // XML Fetch & Parse
    // ────────────────────────────────────────────────────────────────

    /**
     * Fetches the current record as XML by appending &xml=T to the page URL.
     * @returns {Promise<string|null>} Raw XML text or null on failure.
     */
    function _fetchRecordXml() {
        var url = window.location.href;

        // Strip any existing xml=T param to avoid duplication
        var cleanUrl = url.replace(/[?&]xml=T/gi, '');
        // Also strip hash
        cleanUrl = cleanUrl.split('#')[0];

        var xmlUrl = cleanUrl + (cleanUrl.indexOf('?') >= 0 ? '&' : '?') + 'xml=T';

        return fetch(xmlUrl, { credentials: 'same-origin' })
            .then(function (resp) {
                if (!resp.ok) return null;
                return resp.text();
            })
            .catch(function () {
                return null;
            });
    }

    /**
     * Parses NetSuite record XML into a structured JSON object.
     *
     * Structure:
     * {
     *   _metadata: { recordType, id },
     *   bodyFields: { fieldId: value, ... },
     *   sublists: { sublistName: [ { fieldId: value, ... }, ... ], ... }
     * }
     *
     * @param {string} xmlText - Raw XML string from NetSuite.
     * @returns {Object|null} Parsed record data or null.
     */
    function _parseRecordXml(xmlText) {
        if (!xmlText) return null;

        try {
            var parser = new DOMParser();
            var doc = parser.parseFromString(xmlText, 'text/xml');

            // Check for parse errors
            var parseError = doc.querySelector('parsererror');
            if (parseError) return null;

            var recordEl = doc.querySelector('record') || doc.querySelector('nsResponse record');
            if (!recordEl) {
                // Some NS pages wrap in <nsResponse>
                recordEl = doc.documentElement;
                if (!recordEl || recordEl.tagName === 'parsererror') return null;
            }

            var result = {
                _metadata: {
                    recordType: recordEl.getAttribute('recordType') || recordEl.getAttribute('type') || recordEl.tagName || 'unknown',
                    id: recordEl.getAttribute('id') || recordEl.getAttribute('internalId') || ''
                },
                bodyFields: {},
                sublists: {}
            };

            // Iterate direct children of <record>
            for (var i = 0; i < recordEl.children.length; i++) {
                var child = recordEl.children[i];

                if (child.tagName.toLowerCase() === 'machine') {
                    // Sublist (machine element)
                    var slName = child.getAttribute('name') || 'sublist_' + i;
                    var lines = child.querySelectorAll('line');
                    var slLines = [];

                    for (var li = 0; li < lines.length; li++) {
                        var lineData = {};
                        for (var fi = 0; fi < lines[li].children.length; fi++) {
                            var fieldEl = lines[li].children[fi];
                            lineData[fieldEl.tagName] = fieldEl.textContent || '';
                        }
                        slLines.push(lineData);
                    }
                    result.sublists[slName] = slLines;
                } else {
                    // Body field
                    result.bodyFields[child.tagName] = child.textContent || '';
                }
            }

            return result;

        } catch (e) {
            console.warn('[Tacta Record Object] XML parse error:', e);
            return null;
        }
    }

    // ────────────────────────────────────────────────────────────────
    // JSON Tree Renderer
    // ────────────────────────────────────────────────────────────────

    /**
     * Determines the display type of a value for styling purposes.
     * @param {*} value
     * @returns {string} 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'
     */
    function _valueType(value) {
        if (value === null || value === undefined) return 'null';
        if (Array.isArray(value)) return 'array';
        if (typeof value === 'number' || (typeof value === 'string' && value !== '' && !isNaN(Number(value)) && value.trim() === value)) return 'number';
        if (typeof value === 'boolean') return 'boolean';
        if (typeof value === 'object') return 'object';
        return 'string';
    }

    /**
     * Checks whether a value (string) looks numeric for display styling.
     * Pure numbers and dates are styled differently.
     * @param {string} value
     * @returns {boolean}
     */
    function _isNumericString(value) {
        if (typeof value !== 'string' || value === '') return false;
        return !isNaN(Number(value)) && value.trim() === value;
    }

    /**
     * Escapes HTML entities for safe insertion.
     * @param {string} str
     * @returns {string}
     */
    function _escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    /**
     * Tests whether a key or value matches the current search term.
     * @param {string} text
     * @returns {boolean}
     */
    function _matchesSearch(text) {
        if (!_searchTerm) return true;
        return String(text).toLowerCase().indexOf(_searchTerm.toLowerCase()) >= 0;
    }

    /**
     * Wraps matching portions of text in a highlight <mark> tag.
     * @param {string} text
     * @returns {string} HTML string with highlights.
     */
    function _highlightText(text) {
        if (!_searchTerm) return _escapeHtml(String(text));
        var escaped = _escapeHtml(String(text));
        var term = _escapeHtml(_searchTerm);
        var regex = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        return escaped.replace(regex, '<mark class="' + SCOPE_CLASS + '-highlight">$1</mark>');
    }

    /**
     * Recursively checks if any key or value in an object/array matches
     * the current search term.
     * @param {*} obj
     * @param {string} [parentKey]
     * @returns {boolean}
     */
    function _deepMatchesSearch(obj, parentKey) {
        if (!_searchTerm) return true;
        if (parentKey && _matchesSearch(parentKey)) return true;

        if (obj === null || obj === undefined) {
            return _matchesSearch('null');
        }
        if (typeof obj !== 'object') {
            return _matchesSearch(String(obj));
        }
        if (Array.isArray(obj)) {
            for (var a = 0; a < obj.length; a++) {
                if (_deepMatchesSearch(obj[a], String(a))) return true;
            }
            return false;
        }

        var keys = Object.keys(obj);
        for (var k = 0; k < keys.length; k++) {
            if (_matchesSearch(keys[k])) return true;
            if (_deepMatchesSearch(obj[keys[k]], keys[k])) return true;
        }
        return false;
    }

    /**
     * Renders a JSON tree node (key-value pair or nested object/array).
     *
     * @param {string} key - The field/property name.
     * @param {*} value - The value to render.
     * @param {number} depth - Current nesting depth (for indentation).
     * @param {boolean} [forceExpand] - Force expansion for search matches.
     * @returns {HTMLElement|null} The rendered DOM element, or null if filtered out.
     */
    function _renderNode(key, value, depth, forceExpand) {
        var isObject = value !== null && typeof value === 'object';
        var isArray = Array.isArray(value);
        var hasSearch = !!_searchTerm;

        // For search: skip nodes that don't match
        if (hasSearch && !_deepMatchesSearch(value, key)) {
            return null;
        }

        var shouldExpand = forceExpand || (hasSearch && _deepMatchesSearch(value, key));

        var el = window.TactaDOM.createElement;

        if (isObject || isArray) {
            // Collapsible node
            var childKeys = isArray ? value : Object.keys(value);
            var count = isArray ? value.length : Object.keys(value).length;
            var typeLabel = isArray ? 'Array(' + count + ')' : 'Object {' + count + '}';

            var childContainer = el('div', {
                className: SCOPE_CLASS + '-children',
                style: { display: shouldExpand ? 'block' : 'none' }
            });

            var arrow = el('span', {
                className: SCOPE_CLASS + '-arrow' + (shouldExpand ? ' ' + SCOPE_CLASS + '-arrow--open' : ''),
                innerHTML: '&#9654;'
            });

            var keySpan = el('span', {
                className: SCOPE_CLASS + '-key',
                innerHTML: _highlightText(key)
            });

            var typeSpan = el('span', {
                className: SCOPE_CLASS + '-type-label',
                textContent: typeLabel
            });

            var headerRow = el('div', {
                className: SCOPE_CLASS + '-row ' + SCOPE_CLASS + '-row--collapsible'
            }, [arrow, keySpan, typeSpan]);

            headerRow.addEventListener('click', function (e) {
                e.stopPropagation();
                var isOpen = arrow.classList.contains(SCOPE_CLASS + '-arrow--open');
                if (isOpen) {
                    arrow.classList.remove(SCOPE_CLASS + '-arrow--open');
                    childContainer.style.display = 'none';
                } else {
                    arrow.classList.add(SCOPE_CLASS + '-arrow--open');
                    childContainer.style.display = 'block';
                }
            });

            // Render children
            if (isArray) {
                for (var ai = 0; ai < value.length; ai++) {
                    var childNode = _renderNode(String(ai), value[ai], depth + 1, shouldExpand);
                    if (childNode) childContainer.appendChild(childNode);
                }
            } else {
                var objKeys = Object.keys(value);
                for (var oi = 0; oi < objKeys.length; oi++) {
                    var childNode2 = _renderNode(objKeys[oi], value[objKeys[oi]], depth + 1, shouldExpand);
                    if (childNode2) childContainer.appendChild(childNode2);
                }
            }

            var wrapper = el('div', {
                className: SCOPE_CLASS + '-node',
                style: { paddingLeft: (depth > 0 ? 16 : 0) + 'px' }
            }, [headerRow, childContainer]);

            return wrapper;

        } else {
            // Leaf node (primitive value)
            var displayValue = value === null || value === undefined ? 'null' : String(value);
            var valType = _isNumericString(displayValue) ? 'number' : (displayValue === 'null' ? 'null' : 'string');
            if (displayValue === 'true' || displayValue === 'false') valType = 'boolean';

            var leafKeySpan = el('span', {
                className: SCOPE_CLASS + '-key',
                innerHTML: _highlightText(key)
            });

            var leafValSpan = el('span', {
                className: SCOPE_CLASS + '-value ' + SCOPE_CLASS + '-value--' + valType,
                innerHTML: _highlightText(displayValue)
            });

            var leafRow = el('div', {
                className: SCOPE_CLASS + '-row ' + SCOPE_CLASS + '-row--leaf',
                style: { paddingLeft: (depth > 0 ? 16 : 0) + 'px' },
                title: 'Click to copy value'
            }, [leafKeySpan, el('span', { className: SCOPE_CLASS + '-colon', textContent: ':' }), leafValSpan]);

            leafRow.addEventListener('click', function () {
                _copyValue(displayValue, leafRow);
            });

            return leafRow;
        }
    }

    /**
     * Copies a value to the clipboard and shows visual feedback.
     * @param {string} text - Text to copy.
     * @param {HTMLElement} row - The row element for visual feedback.
     */
    function _copyValue(text, row) {
        if (window.TactaDOM && typeof window.TactaDOM.copyToClipboard === 'function') {
            window.TactaDOM.copyToClipboard(text).then(function (ok) {
                if (ok) {
                    row.classList.add(SCOPE_CLASS + '-row--copied');
                    if (window.TactaDOM.showToast) {
                        window.TactaDOM.showToast('Copied: ' + (text.length > 60 ? text.substring(0, 60) + '...' : text), 'success', 1500);
                    }
                    setTimeout(function () {
                        row.classList.remove(SCOPE_CLASS + '-row--copied');
                    }, 800);
                }
            });
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Tree Builder
    // ────────────────────────────────────────────────────────────────

    /**
     * Builds the full tree DOM from parsed record data.
     * @param {Object} data - Parsed record data.
     * @returns {HTMLElement} The tree container.
     */
    function _buildTree(data) {
        var el = window.TactaDOM.createElement;
        var treeContainer = el('div', { className: SCOPE_CLASS + '-tree' });

        // Metadata section
        if (data._metadata) {
            var metaNode = _renderNode('_metadata', data._metadata, 0, false);
            if (metaNode) treeContainer.appendChild(metaNode);
        }

        // Body fields section
        if (data.bodyFields && Object.keys(data.bodyFields).length > 0) {
            var bodyNode = _renderNode('bodyFields', data.bodyFields, 0, false);
            if (bodyNode) treeContainer.appendChild(bodyNode);
        }

        // Sublists section
        if (data.sublists && Object.keys(data.sublists).length > 0) {
            var sublistNode = _renderNode('sublists', data.sublists, 0, false);
            if (sublistNode) treeContainer.appendChild(sublistNode);
        }

        // Empty state
        if (treeContainer.children.length === 0) {
            var emptyMsg = _searchTerm ? 'No matches found for "' + _escapeHtml(_searchTerm) + '"' : 'No data available';
            treeContainer.appendChild(el('div', {
                className: SCOPE_CLASS + '-empty',
                textContent: emptyMsg
            }));
        }

        return treeContainer;
    }

    // ────────────────────────────────────────────────────────────────
    // Panel Management
    // ────────────────────────────────────────────────────────────────

    /**
     * Opens the Record Object panel, fetches XML, and renders the tree.
     */
    function _openPanel() {
        if (!window.TactaDOM) {
            console.error('[Tacta Record Object] TactaDOM not available.');
            return;
        }

        var el = window.TactaDOM.createElement;

        // Create the panel
        _panelInstance = window.TactaDOM.createPanel({
            title: 'Record Object',
            width: PANEL_WIDTH,
            height: PANEL_HEIGHT,
            position: { top: '60px', right: '16px' },
            resizable: true,
            draggable: true,
            onClose: function () {
                _panelInstance = null;
                _recordData = null;
                _searchTerm = '';
            }
        });

        // Add scope class to the panel
        _panelInstance.panel.classList.add(SCOPE_CLASS);

        // Build the toolbar (search + actions)
        var searchInput = el('input', {
            className: 'tacta-input ' + SCOPE_CLASS + '-search',
            placeholder: 'Search fields and values...',
            type: 'text'
        });

        var expandAllBtn = el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Expand All',
            title: 'Expand all sections'
        });

        var collapseAllBtn = el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Collapse All',
            title: 'Collapse all sections'
        });

        var copyAllBtn = el('button', {
            className: 'tacta-btn tacta-btn-sm tacta-btn-primary',
            textContent: 'Copy JSON',
            title: 'Copy full record as JSON'
        });

        var toolbar = el('div', { className: SCOPE_CLASS + '-toolbar' }, [searchInput]);
        var actions = el('div', { className: SCOPE_CLASS + '-actions' }, [expandAllBtn, collapseAllBtn, copyAllBtn]);
        toolbar.appendChild(actions);

        var treeHost = el('div', { className: SCOPE_CLASS + '-tree-host' });

        _panelInstance.body.appendChild(toolbar);
        _panelInstance.body.appendChild(treeHost);

        // Show loading state
        var loadingEl = el('div', { className: SCOPE_CLASS + '-loading' }, [
            el('div', { className: 'tacta-spinner' }),
            el('div', { className: SCOPE_CLASS + '-loading-text', textContent: 'Fetching record XML...' })
        ]);
        treeHost.appendChild(loadingEl);

        // Fetch and render
        _fetchRecordXml().then(function (xmlText) {
            treeHost.innerHTML = '';

            if (!xmlText) {
                treeHost.appendChild(el('div', { className: SCOPE_CLASS + '-error' }, [
                    el('div', { className: SCOPE_CLASS + '-error-icon', textContent: '!' }),
                    el('div', { className: SCOPE_CLASS + '-error-text', textContent: 'Could not fetch record XML. Ensure this is a record page with a valid ID.' })
                ]));
                return;
            }

            _recordData = _parseRecordXml(xmlText);

            if (!_recordData) {
                treeHost.appendChild(el('div', { className: SCOPE_CLASS + '-error' }, [
                    el('div', { className: SCOPE_CLASS + '-error-icon', textContent: '!' }),
                    el('div', { className: SCOPE_CLASS + '-error-text', textContent: 'Could not parse record XML. The response may not be a valid record.' })
                ]));
                return;
            }

            // Render the field count summary
            var bodyCount = Object.keys(_recordData.bodyFields).length;
            var sublistCount = Object.keys(_recordData.sublists).length;
            var lineCount = 0;
            var slNames = Object.keys(_recordData.sublists);
            for (var s = 0; s < slNames.length; s++) {
                lineCount += _recordData.sublists[slNames[s]].length;
            }

            var summary = el('div', { className: SCOPE_CLASS + '-summary' }, [
                _createStat(String(bodyCount), 'Body Fields'),
                _createStat(String(sublistCount), 'Sublists'),
                _createStat(String(lineCount), 'Lines')
            ]);
            treeHost.appendChild(summary);

            // Render the tree
            var tree = _buildTree(_recordData);
            treeHost.appendChild(tree);
        });

        // ── Event handlers ──

        searchInput.addEventListener('input', function () {
            clearTimeout(_searchTimer);
            _searchTimer = setTimeout(function () {
                _searchTerm = searchInput.value.trim();
                if (!_recordData) return;
                // Re-render tree with filter
                var treeEls = treeHost.querySelectorAll('.' + SCOPE_CLASS + '-tree');
                for (var t = 0; t < treeEls.length; t++) {
                    treeEls[t].remove();
                }
                var tree = _buildTree(_recordData);
                treeHost.appendChild(tree);
            }, 250);
        });

        expandAllBtn.addEventListener('click', function () {
            if (!_panelInstance) return;
            var arrows = _panelInstance.panel.querySelectorAll('.' + SCOPE_CLASS + '-arrow');
            var children = _panelInstance.panel.querySelectorAll('.' + SCOPE_CLASS + '-children');
            for (var i = 0; i < arrows.length; i++) {
                arrows[i].classList.add(SCOPE_CLASS + '-arrow--open');
            }
            for (var j = 0; j < children.length; j++) {
                children[j].style.display = 'block';
            }
        });

        collapseAllBtn.addEventListener('click', function () {
            if (!_panelInstance) return;
            var arrows = _panelInstance.panel.querySelectorAll('.' + SCOPE_CLASS + '-arrow');
            var children = _panelInstance.panel.querySelectorAll('.' + SCOPE_CLASS + '-children');
            for (var i = 0; i < arrows.length; i++) {
                arrows[i].classList.remove(SCOPE_CLASS + '-arrow--open');
            }
            for (var j = 0; j < children.length; j++) {
                children[j].style.display = 'none';
            }
        });

        copyAllBtn.addEventListener('click', function () {
            if (!_recordData) return;
            var json = JSON.stringify(_recordData, null, 2);
            if (window.TactaDOM.copyToClipboard) {
                window.TactaDOM.copyToClipboard(json).then(function (ok) {
                    if (ok && window.TactaDOM.showToast) {
                        window.TactaDOM.showToast('Full record JSON copied to clipboard', 'success', 2000);
                    }
                });
            }
        });
    }

    /**
     * Creates a summary stat element.
     * @param {string} count
     * @param {string} label
     * @returns {HTMLElement}
     */
    function _createStat(count, label) {
        var el = window.TactaDOM.createElement;
        return el('div', { className: SCOPE_CLASS + '-stat' }, [
            el('div', { className: SCOPE_CLASS + '-stat-count', textContent: count }),
            el('div', { className: SCOPE_CLASS + '-stat-label', textContent: label })
        ]);
    }

    /**
     * Closes the current panel if open.
     */
    function _closePanel() {
        if (_panelInstance) {
            _panelInstance.close();
            _panelInstance = null;
            _recordData = null;
            _searchTerm = '';
        }
    }

    /**
     * Toggles the panel open/closed.
     */
    function _toggle() {
        if (_panelInstance) {
            _closePanel();
        } else {
            _openPanel();
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Activation Listener
    // ────────────────────────────────────────────────────────────────

    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === FEATURE_ID) {
            _toggle();
        }
    });

})();

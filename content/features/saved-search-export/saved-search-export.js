/**
 * saved-search-export.js
 * NetSuite TactaSuite — Saved Search Export (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Adds one-click CSV, JSON, and Copy buttons to NetSuite saved search
 * results pages. Extracts headers and visible row data from the results
 * table and exports in the chosen format.
 *
 * Approach:
 *   1. Detect the search results table on the page (.listtable or
 *      table with uir-list-* classes).
 *   2. Inject a compact floating toolbar near the results table with
 *      [CSV] [JSON] [Copy] buttons.
 *   3. On click, parse header cells and data rows from the visible page.
 *   4. CSV: RFC 4180 compliant download. JSON: array of objects download.
 *      Copy: tab-delimited text to clipboard.
 *   5. MutationObserver re-detects if the results table is refreshed
 *      (e.g., pagination, re-run).
 *
 * Only exports the currently visible page of results. Filenames include
 * "(page)" to indicate partial data.
 *
 * Runs automatically on search-results and search-list pages.
 *
 * @fileoverview Content script for the Saved Search Export feature.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaSavedSearchExportLoaded) return;
    window.__tactaSavedSearchExportLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} ID of the toolbar element */
    var TOOLBAR_ID = 'tacta-sse-toolbar';

    /** @type {string} Selector for the results table */
    var TABLE_SELECTOR = 'table.listtable, table.uir-list-table, .uir-list-control table';

    /** @type {string} Selectors for header cells */
    var HEADER_ROW_SELECTOR = 'tr.uir-list-headerrow';
    var HEADER_CELL_SELECTOR = 'tr.uir-list-headerrow td, tr.uir-list-headerrow th, thead td, thead th';

    /** @type {string} Selectors for data rows */
    var DATA_ROW_SELECTOR = 'tr.uir-list-row-odd, tr.uir-list-row-even, tr.uir-list-row-tr, tr[class*="lis_row"]';

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {HTMLElement|null} The detected results table */
    var _currentTable = null;

    /** @type {MutationObserver|null} */
    var _observer = null;

    /** @type {number} Debounce timer for observer */
    var _debounceTimer = 0;

    /** @type {{ requestId: string, lines: string[], rowCount: number }|null} */
    var _allExportState = null;

    // ────────────────────────────────────────────────────────────────
    // Table detection
    // ────────────────────────────────────────────────────────────────

    /**
     * Finds the primary search results table on the page.
     * Prefers a table that contains a header row with .listheadertd or
     * .uir-list-headerrow elements.
     * @returns {HTMLTableElement|null}
     */
    /**
     * True when the page is the Saved Search editor (search.nl) rather than a
     * results or list page. The editor's Criteria / Results subtabs are
     * NetSuite "machine" tables that look like list tables; putting the export
     * toolbar inside one breaks NetSuite's own field validation.
     */
    function _isSearchEditor() {
        var info = window.__tactaPageInfo;
        if (info && info.type) return info.type === 'search-edit';
        return /\/app\/common\/search\/search\.nl/i.test(window.location.pathname + window.location.search);
    }

    /**
     * True when a table is part of a NetSuite machine (sublist editor), which
     * is never a results table even though it reuses listheadertd markup.
     */
    function _isMachineTable(table) {
        if (!table) return false;
        if (table.closest('.uir-machine-table-container, [id$="_splits"]')) return true;
        return !!table.querySelector('.uir-machine-headerrow, .uir-machine-row-focused, .uir-machine-row-unfocused');
    }

    /** Wraps a candidate so machine tables are never accepted. */
    function _acceptTable(table) {
        return table && !_isMachineTable(table) ? table : null;
    }

    function _findResultsTable() {
        if (_isSearchEditor()) return null;

        // Strategy 1: Look for a table containing a header row
        var headerRow = document.querySelector(HEADER_ROW_SELECTOR);
        if (headerRow) {
            var table = _acceptTable(headerRow.closest('table'));
            if (table) return table;
        }

        // Strategy 2: Look for rows with listheadertd class
        var headerCell = document.querySelector('td.listheadertd, th.listheadertd');
        if (headerCell) {
            var tbl = _acceptTable(headerCell.closest('table'));
            if (tbl) return tbl;
        }

        // Strategy 3: Generic table selector
        var tables = document.querySelectorAll(TABLE_SELECTOR);
        for (var i = 0; i < tables.length; i++) {
            // Verify it has data rows (not just a layout table)
            var rows = tables[i].querySelectorAll(DATA_ROW_SELECTOR);
            if (rows.length > 0 && !_isMachineTable(tables[i])) return tables[i];
        }

        // Strategy 4: Any table with listheadertd cells
        var allTables = document.querySelectorAll('table');
        for (var j = 0; j < allTables.length; j++) {
            if (allTables[j].querySelector('.listheadertd') && !_isMachineTable(allTables[j])) {
                return allTables[j];
            }
        }

        return null;
    }

    // ────────────────────────────────────────────────────────────────
    // Data extraction
    // ────────────────────────────────────────────────────────────────

    /**
     * Extracts header labels from the results table.
     * @param {HTMLTableElement} table
     * @returns {string[]}
     */
    function _extractHeaders(table) {
        var headers = [];

        // Try uir-list-headerrow first
        var headerRow = table.querySelector(HEADER_ROW_SELECTOR);
        if (headerRow) {
            var cells = headerRow.querySelectorAll('td, th');
            for (var i = 0; i < cells.length; i++) {
                headers.push(_getCellText(cells[i]));
            }
            return headers;
        }

        // Try thead
        var thead = table.querySelector('thead');
        if (thead) {
            var thCells = thead.querySelectorAll('td, th');
            for (var j = 0; j < thCells.length; j++) {
                headers.push(_getCellText(thCells[j]));
            }
            return headers;
        }

        // Fallback: first row with listheadertd cells
        var hdCells = table.querySelectorAll('.listheadertd');
        if (hdCells.length > 0) {
            for (var k = 0; k < hdCells.length; k++) {
                headers.push(_getCellText(hdCells[k]));
            }
            return headers;
        }

        return headers;
    }

    /**
     * Extracts data rows from the results table.
     * @param {HTMLTableElement} table
     * @returns {string[][]}
     */
    function _extractRows(table) {
        var rows = [];

        // Try standard data row classes
        var dataRows = table.querySelectorAll(DATA_ROW_SELECTOR);

        // Fallback: If no rows found with class selectors, try tbody rows
        // excluding the header row
        if (dataRows.length === 0) {
            var allRows = table.querySelectorAll('tbody tr, tr');
            var headerRow = table.querySelector(HEADER_ROW_SELECTOR);
            var headerCells = table.querySelectorAll('.listheadertd');
            var tempRows = [];

            for (var i = 0; i < allRows.length; i++) {
                var row = allRows[i];
                // Skip header rows
                if (row === headerRow) continue;
                if (row.querySelector('.listheadertd')) continue;
                if (row.classList.contains('uir-list-headerrow')) continue;
                // Skip footer/navigation rows
                if (row.querySelector('.listbottom, .listnav')) continue;
                if (row.cells && row.cells.length > 1) {
                    tempRows.push(row);
                }
            }
            dataRows = tempRows;
        }

        for (var r = 0; r < dataRows.length; r++) {
            var cells = dataRows[r].querySelectorAll('td, th');
            var rowData = [];
            for (var c = 0; c < cells.length; c++) {
                rowData.push(_getCellText(cells[c]));
            }
            rows.push(rowData);
        }

        return rows;
    }

    /**
     * Gets the clean text content of a table cell.
     * Handles nested elements, form controls, and link text.
     * @param {HTMLElement} cell
     * @returns {string}
     */
    function _getCellText(cell) {
        // Check for input/select elements inside the cell
        var input = cell.querySelector('input[type="text"], input[type="number"]');
        if (input) return (input.value || '').trim();

        var select = cell.querySelector('select');
        if (select && select.selectedIndex >= 0) {
            return (select.options[select.selectedIndex].text || '').trim();
        }

        var checkbox = cell.querySelector('input[type="checkbox"]');
        if (checkbox) return checkbox.checked ? 'Yes' : 'No';

        // Check for textarea
        var textarea = cell.querySelector('textarea');
        if (textarea) return (textarea.value || '').trim();

        // Get text content, collapsing whitespace
        var text = (cell.textContent || '').replace(/\s+/g, ' ').trim();

        // Strip sort indicator characters that NS sometimes injects
        text = text.replace(/^[\u25B2\u25BC\u2191\u2193]\s*/, '');
        text = text.replace(/\s*[\u25B2\u25BC\u2191\u2193]$/, '');

        return text;
    }

    // ────────────────────────────────────────────────────────────────
    // Search name extraction (for filenames)
    // ────────────────────────────────────────────────────────────────

    /**
     * Attempts to extract the saved search name for use in filenames.
     * @returns {string}
     */
    function _getSearchName() {
        // Try page title
        var titleEl = document.querySelector('.uir-page-title-firstline');
        if (titleEl) {
            var name = (titleEl.textContent || '').trim();
            if (name) return _sanitizeFilename(name);
        }

        // Try the page title element
        var pageTitle = document.querySelector('.uir-page-title');
        if (pageTitle) {
            var pt = (pageTitle.textContent || '').trim();
            if (pt) return _sanitizeFilename(pt);
        }

        // Fallback: search title input
        var titleInput = document.querySelector('input[name="title"], input[name="searchtitle"]');
        if (titleInput && titleInput.value) return _sanitizeFilename(titleInput.value);

        // Fallback: extract from URL
        var match = window.location.href.match(/searchid=(\d+)/);
        if (match) return 'search-' + match[1];

        return 'netsuite-search';
    }

    /**
     * Sanitizes a string for use as a filename.
     * @param {string} name
     * @returns {string}
     */
    function _sanitizeFilename(name) {
        return name
            .replace(/[<>:"/\\|?*]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 80)
            .toLowerCase();
    }

    // ────────────────────────────────────────────────────────────────
    // Export functions
    // ────────────────────────────────────────────────────────────────

    /**
     * Triggers a file download in the browser.
     * @param {string} content - File content.
     * @param {string} filename - Desired filename.
     * @param {string} mimeType - MIME type.
     */
    function _downloadFile(content, filename, mimeType) {
        var blob = new Blob([content], { type: mimeType });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    /**
     * RFC 4180 compliant CSV field escaping.
     * @param {string} value
     * @returns {string}
     */
    function _csvEscape(value) {
        var str = String(value);
        // Must quote if contains comma, double-quote, newline, or carriage return
        if (str.indexOf(',') >= 0 || str.indexOf('"') >= 0 ||
            str.indexOf('\n') >= 0 || str.indexOf('\r') >= 0) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    /**
     * Exports the current results table as CSV.
     */
    function _exportCSV() {
        if (!_currentTable) {
            _showToast('No results table found on this page.', 'warning');
            return;
        }

        var headers = _extractHeaders(_currentTable);
        var rows = _extractRows(_currentTable);

        if (headers.length === 0) {
            _showToast('Could not extract headers from results table.', 'warning');
            return;
        }

        var lines = [];

        // Header line
        lines.push(headers.map(_csvEscape).join(','));

        // Data lines
        for (var i = 0; i < rows.length; i++) {
            // Pad or trim row to match header count
            var row = rows[i];
            var paddedRow = [];
            for (var j = 0; j < headers.length; j++) {
                paddedRow.push(_csvEscape(row[j] !== undefined ? row[j] : ''));
            }
            lines.push(paddedRow.join(','));
        }

        var csv = lines.join('\r\n') + '\r\n';
        var searchName = _getSearchName();
        var filename = searchName + '-page-' + _getTimestamp() + '.csv';

        _downloadFile(csv, filename, 'text/csv;charset=utf-8;');
        _showToast('CSV downloaded (' + rows.length + ' rows, current page)', 'success');
    }

    function _exportAllCSV() {
        var params = _parseQueryParams(window.location.href);
        var searchId = params.searchid || params.id || '';

        if (!searchId) {
            _showToast('Could not find a saved search ID in the page URL.', 'warning');
            return;
        }

        if (_allExportState) {
            _showToast('Full export is already running.', 'warning');
            return;
        }

        var requestId = 'sse-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        _allExportState = {
            requestId: requestId,
            lines: [],
            rowCount: 0
        };

        _showToast('Starting full saved search export...', 'info');
        window.dispatchEvent(new CustomEvent('tacta:sse:exportAllRequest', {
            detail: {
                requestId: requestId,
                searchId: searchId,
                pageSize: 1000
            }
        }));
    }

    /**
     * Exports the current results table as JSON.
     */
    function _exportJSON() {
        if (!_currentTable) {
            _showToast('No results table found on this page.', 'warning');
            return;
        }

        var headers = _extractHeaders(_currentTable);
        var rows = _extractRows(_currentTable);

        if (headers.length === 0) {
            _showToast('Could not extract headers from results table.', 'warning');
            return;
        }

        var data = [];
        for (var i = 0; i < rows.length; i++) {
            var obj = {};
            for (var j = 0; j < headers.length; j++) {
                var key = headers[j] || ('Column ' + (j + 1));
                obj[key] = rows[i][j] !== undefined ? rows[i][j] : '';
            }
            data.push(obj);
        }

        var json = JSON.stringify(data, null, 2);
        var searchName = _getSearchName();
        var filename = searchName + '-page-' + _getTimestamp() + '.json';

        _downloadFile(json, filename, 'application/json;charset=utf-8;');
        _showToast('JSON downloaded (' + rows.length + ' rows, current page)', 'success');
    }

    function _handleAllExportEvent(event) {
        var detail = event.detail || {};
        if (!_allExportState || detail.requestId !== _allExportState.requestId) return;

        if (detail.type === 'start') {
            var headers = detail.headers || [];
            _allExportState.lines.push(headers.map(_csvEscape).join(','));
            _showToast('Exporting ' + (detail.totalRows || 0) + ' rows across ' + (detail.totalPages || 0) + ' pages...', 'info');
            return;
        }

        if (detail.type === 'chunk') {
            var rows = detail.rows || [];
            for (var i = 0; i < rows.length; i++) {
                _allExportState.lines.push(rows[i].map(_csvEscape).join(','));
            }
            _allExportState.rowCount += rows.length;
            return;
        }

        if (detail.type === 'progress') {
            _showToast('Exported page ' + detail.page + ' of ' + detail.totalPages + ' (' + _allExportState.rowCount + ' rows)', 'info');
            return;
        }

        if (detail.type === 'complete') {
            var csv = _allExportState.lines.join('\r\n') + '\r\n';
            var filename = _getSearchName() + '-all-' + _getTimestamp() + '.csv';
            var rowCount = _allExportState.rowCount;
            _downloadFile(csv, filename, 'text/csv;charset=utf-8;');
            _allExportState = null;
            _showToast('Full CSV downloaded (' + rowCount + ' rows)', 'success');
            return;
        }

        if (detail.type === 'error') {
            _showToast('Full export failed: ' + (detail.message || 'Unknown error'), 'error');
            _allExportState = null;
        }
    }

    /**
     * Copies the current results table to the clipboard as tab-delimited text.
     */
    function _copyToClipboard() {
        if (!_currentTable) {
            _showToast('No results table found on this page.', 'warning');
            return;
        }

        var headers = _extractHeaders(_currentTable);
        var rows = _extractRows(_currentTable);

        if (headers.length === 0) {
            _showToast('Could not extract headers from results table.', 'warning');
            return;
        }

        var lines = [];

        // Header line
        lines.push(headers.join('\t'));

        // Data lines
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var paddedRow = [];
            for (var j = 0; j < headers.length; j++) {
                paddedRow.push(row[j] !== undefined ? row[j] : '');
            }
            lines.push(paddedRow.join('\t'));
        }

        var text = lines.join('\n');

        if (window.TactaDOM && typeof window.TactaDOM.copyToClipboard === 'function') {
            window.TactaDOM.copyToClipboard(text).then(function (ok) {
                if (ok) {
                    _showToast('Copied ' + rows.length + ' rows to clipboard (current page)', 'success');
                } else {
                    _showToast('Failed to copy to clipboard', 'error');
                }
            });
        } else {
            // Inline clipboard fallback
            _clipboardFallback(text);
        }
    }

    function _exportTypeScriptScaffold() {
        if (!_currentTable) {
            _showToast('No results table found on this page.', 'warning');
            return;
        }

        var headers = _extractHeaders(_currentTable).filter(function (h) { return !!h; });
        var params = _parseQueryParams(window.location.href);
        var searchId = params.searchid || params.id || '';
        var columns = headers.map(function (header) {
            return "      search.createColumn({ name: '" + _guessFieldId(header) + "' })";
        });

        var code = [
            "/**",
            " * Generated by NetSuite TactaSuite from visible saved search results.",
            " * This scaffold uses visible column labels; review field IDs and filters before deploying.",
            " */",
            "import search = require('N/search');",
            "",
            "export function loadOrCreateSearch(): search.Search {",
            searchId ? "  return search.load({ id: '" + searchId.replace(/'/g, "\\'") + "' });" : "  return search.create({",
            searchId ? "}" : "    type: 'transaction',",
            searchId ? "" : "    filters: [],",
            searchId ? "" : "    columns: [",
            searchId ? "" : (columns.length ? columns.join(",\n") : "      search.createColumn({ name: 'internalid' })"),
            searchId ? "" : "    ]",
            searchId ? "" : "  });",
            searchId ? "" : "}",
            "",
            "export function run(limit = 1000): search.Result[] {",
            "  return loadOrCreateSearch().run().getRange({ start: 0, end: limit }) || [];",
            "}"
        ].filter(function (line) { return line !== ''; }).join('\n');

        _downloadFile(code, _getSearchName() + '-suitescript-' + _getTimestamp() + '.ts', 'text/typescript;charset=utf-8;');
        _showToast('TypeScript scaffold downloaded', 'success');
    }

    function _guessFieldId(label) {
        var known = {
            'Internal ID': 'internalid',
            'Name': 'entityid',
            'Date': 'trandate',
            'Document Number': 'tranid',
            'Amount': 'amount',
            'Status': 'status',
            'Memo': 'memo',
            'External ID': 'externalid'
        };
        if (known[label]) return known[label];
        return String(label || 'internalid')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '')
            .replace(/^$/, 'internalid');
    }

    function _parseQueryParams(url) {
        var params = {};
        var qs = url.split('?')[1];
        if (!qs) return params;
        qs.split('#')[0].split('&').forEach(function (pair) {
            var parts = pair.split('=');
            if (!parts[0]) return;
            params[decodeURIComponent(parts[0]).toLowerCase()] = decodeURIComponent(parts[1] || '');
        });
        return params;
    }

    /**
     * Fallback clipboard copy if TactaDOM is not available.
     * @param {string} text
     */
    function _clipboardFallback(text) {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(function () {
                _showToast('Copied to clipboard (current page)', 'success');
            }).catch(function () {
                _textareaCopy(text);
            });
        } else {
            _textareaCopy(text);
        }
    }

    /**
     * Textarea-based copy fallback.
     * @param {string} text
     */
    function _textareaCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        try {
            var ok = document.execCommand('copy');
            _showToast(ok ? 'Copied to clipboard (current page)' : 'Copy failed', ok ? 'success' : 'error');
        } catch (e) {
            _showToast('Copy failed: ' + e.message, 'error');
        }
        document.body.removeChild(ta);
    }

    // ────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────

    /**
     * Returns a compact timestamp string for filenames.
     * @returns {string}
     */
    function _getTimestamp() {
        var now = new Date();
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return now.getFullYear() +
            pad(now.getMonth() + 1) +
            pad(now.getDate()) + '-' +
            pad(now.getHours()) +
            pad(now.getMinutes()) +
            pad(now.getSeconds());
    }

    /**
     * Shows a toast notification. Uses TactaDOM if available, otherwise
     * falls back to a simple inline toast.
     * @param {string} message
     * @param {string} [type='info']
     */
    function _showToast(message, type) {
        if (window.TactaDOM && typeof window.TactaDOM.showToast === 'function') {
            window.TactaDOM.showToast(message, type, 3000);
            return;
        }

        // Inline fallback toast
        var toast = document.createElement('div');
        toast.className = 'tacta-sse-toast tacta-sse-toast--' + (type || 'info');
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(function () {
            toast.classList.add('tacta-sse-toast--visible');
        });

        setTimeout(function () {
            toast.classList.remove('tacta-sse-toast--visible');
            setTimeout(function () {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 300);
        }, 3000);
    }

    // ────────────────────────────────────────────────────────────────
    // SVG Icons (inline, small)
    // ────────────────────────────────────────────────────────────────

    var ICON_CSV = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">' +
        '<path d="M3 1h7l3 3v11H3z"/><path d="M10 1v3h3"/>' +
        '<path d="M5 8h6M5 10.5h6M5 13h4" stroke-width="1.2"/></svg>';

    var ICON_JSON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">' +
        '<path d="M5 2C3.5 2 3 3 3 4v2c0 1-1 1.5-1.5 2C2 8.5 3 9 3 10v2c0 1 .5 2 2 2"/>' +
        '<path d="M11 2c1.5 0 2 1 2 2v2c0 1 1 1.5 1.5 2-.5.5-1.5 1-1.5 2v2c0 1-.5 2-2 2"/></svg>';

    var ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">' +
        '<rect x="5" y="5" width="8" height="9" rx="1"/>' +
        '<path d="M3 11V3a1 1 0 011-1h6"/></svg>';

    // ────────────────────────────────────────────────────────────────
    // Toolbar UI
    // ────────────────────────────────────────────────────────────────

    /**
     * Creates a single toolbar button.
     * @param {string} label
     * @param {string} iconSvg
     * @param {string} title
     * @param {Function} onClick
     * @returns {HTMLButtonElement}
     */
    function _createButton(label, iconSvg, title, onClick) {
        var btn = document.createElement('button');
        btn.type = 'button'; // never submit NetSuite's main_form
        btn.className = 'tacta-sse-btn';
        btn.title = title;
        btn.innerHTML = iconSvg + '<span class="tacta-sse-btn-label">' + label + '</span>';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    /**
     * Creates and injects the export toolbar into the page.
     */
    function _createToolbar() {
        // Remove existing toolbar if present
        _removeToolbar();

        if (!_currentTable) return;

        var toolbar = document.createElement('div');
        toolbar.id = TOOLBAR_ID;
        toolbar.className = 'tacta-sse-toolbar tacta-toolkit';

        // TactaSuite badge
        var badge = document.createElement('span');
        badge.className = 'tacta-sse-badge';
        badge.textContent = 'Export';
        toolbar.appendChild(badge);

        // Separator
        var sep1 = document.createElement('span');
        sep1.className = 'tacta-sse-sep';
        toolbar.appendChild(sep1);

        // CSV button
        toolbar.appendChild(_createButton('CSV', ICON_CSV, 'Download as CSV (current page)', _exportCSV));

        toolbar.appendChild(_createButton('All CSV', ICON_CSV, 'Download all saved search rows with N/search runPaged', _exportAllCSV));

        // JSON button
        toolbar.appendChild(_createButton('JSON', ICON_JSON, 'Download as JSON (current page)', _exportJSON));

        toolbar.appendChild(_createButton('TS', ICON_JSON, 'Download SuiteScript 2.x TypeScript scaffold', _exportTypeScriptScaffold));

        // Separator
        var sep2 = document.createElement('span');
        sep2.className = 'tacta-sse-sep';
        toolbar.appendChild(sep2);

        // Copy button
        toolbar.appendChild(_createButton('Copy', ICON_COPY, 'Copy tab-delimited to clipboard (current page)', _copyToClipboard));

        // Position the toolbar: try to insert before the results table,
        // or near the NS action buttons area
        var insertTarget = null;

        // Try to find the NS action buttons container above the results
        var actionRow = document.querySelector('.uir-list-control .uir-list-buttons');
        if (actionRow) {
            insertTarget = actionRow;
        }

        // Try to find the div wrapping the table
        if (!insertTarget && _currentTable.parentElement) {
            insertTarget = _currentTable;
        }

        if (insertTarget && insertTarget.parentNode) {
            insertTarget.parentNode.insertBefore(toolbar, insertTarget);
        } else {
            // Absolute fallback: prepend to body
            document.body.insertBefore(toolbar, document.body.firstChild);
        }
    }

    /**
     * Removes the export toolbar from the page.
     */
    function _removeToolbar() {
        var existing = document.getElementById(TOOLBAR_ID);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
    }

    // ────────────────────────────────────────────────────────────────
    // MutationObserver — re-detect on results refresh
    // ────────────────────────────────────────────────────────────────

    /**
     * Starts a MutationObserver to watch for results table changes
     * (pagination clicks, re-running searches, AJAX refreshes).
     */
    function _startObserver() {
        if (_observer) _observer.disconnect();

        _observer = new MutationObserver(function (mutations) {
            // Debounce to avoid processing rapid DOM changes
            clearTimeout(_debounceTimer);
            _debounceTimer = setTimeout(function () {
                var needsRescan = false;

                // Check if the table was removed or new rows were added
                if (_currentTable && !document.body.contains(_currentTable)) {
                    needsRescan = true;
                }

                // Check mutations for table-related changes
                if (!needsRescan) {
                    for (var i = 0; i < mutations.length; i++) {
                        var target = mutations[i].target;
                        if (!target || !target.closest) continue;

                        // Changes inside or near a results table
                        if (target.closest('.listtable, .uir-list-table, .uir-list-control')) {
                            needsRescan = true;
                            break;
                        }

                        // New nodes that might be a results table
                        var added = mutations[i].addedNodes;
                        for (var j = 0; j < added.length; j++) {
                            var node = added[j];
                            if (node.nodeType !== Node.ELEMENT_NODE) continue;
                            if (node.matches && (node.matches(TABLE_SELECTOR) ||
                                node.querySelector && node.querySelector(TABLE_SELECTOR))) {
                                needsRescan = true;
                                break;
                            }
                        }
                        if (needsRescan) break;
                    }
                }

                if (needsRescan) {
                    _detectAndRender();
                }
            }, 500);
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
     * Detects the results table and renders the toolbar.
     */
    function _detectAndRender() {
        var table = _findResultsTable();

        if (table) {
            _currentTable = table;
            _createToolbar();
        } else {
            _currentTable = null;
            _removeToolbar();
        }
    }

    /**
     * Main render function — detects table and starts observer.
     */
    function _render() {
        _detectAndRender();
        _startObserver();
    }

    /**
     * Initializes the feature when the DOM is ready.
     */
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', _render, { once: true });
        } else {
            // Small delay to let NS finish rendering
            setTimeout(_render, 300);
        }
    }

    /**
     * Listen for feature activation events dispatched by the router.
     */
    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === 'saved-search-export') {
            _render();
        }
    });

    window.addEventListener('tacta:sse:allExportEvent', _handleAllExportEvent);

    // Auto-initialize
    init();

})();

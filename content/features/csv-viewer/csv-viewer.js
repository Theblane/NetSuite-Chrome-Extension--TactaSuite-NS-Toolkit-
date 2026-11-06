/**
 * csv-viewer.js
 * NetSuite TactaSuite - CSV Import Viewer
 *
 * @author Blane Maher
 *
 * Previews CSV files in a formatted table before submitting on
 * NetSuite CSV import pages. Reads the file from the file input,
 * parses it, and displays a searchable/scrollable preview table.
 *
 * @fileoverview CSV Viewer content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    if (window.__tactaCsvViewerLoaded) return;
    window.__tactaCsvViewerLoaded = true;

    var MAX_PREVIEW_ROWS = 200;
    var _previewContainer = null;

    // ────────────────────────────────────────────────────────────────
    // CSV Parser
    // ────────────────────────────────────────────────────────────────

    function parseCSV(text, delimiter) {
        delimiter = delimiter || ',';
        var rows = [];
        var row = [];
        var field = '';
        var inQuotes = false;

        for (var i = 0; i < text.length; i++) {
            var ch = text[i];
            if (inQuotes) {
                if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
                else if (ch === '"') { inQuotes = false; }
                else { field += ch; }
            } else {
                if (ch === '"') { inQuotes = true; }
                else if (ch === delimiter) { row.push(field); field = ''; }
                else if (ch === '\r' && text[i + 1] === '\n') { row.push(field); field = ''; rows.push(row); row = []; i++; }
                else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
                else { field += ch; }
            }
        }
        if (field || row.length) { row.push(field); rows.push(row); }

        // Remove trailing empty rows
        while (rows.length > 0 && rows[rows.length - 1].join('').trim() === '') {
            rows.pop();
        }
        return rows;
    }

    // ────────────────────────────────────────────────────────────────
    // Auto-detect delimiter
    // ────────────────────────────────────────────────────────────────

    function detectDelimiter(text) {
        var firstLine = text.split('\n')[0] || '';
        var counts = { ',': 0, '\t': 0, '|': 0, ';': 0 };
        for (var i = 0; i < firstLine.length; i++) {
            if (counts[firstLine[i]] !== undefined) counts[firstLine[i]]++;
        }
        var best = ',';
        var max = 0;
        for (var d in counts) {
            if (counts[d] > max) { max = counts[d]; best = d; }
        }
        return best;
    }

    // ────────────────────────────────────────────────────────────────
    // Preview rendering
    // ────────────────────────────────────────────────────────────────

    function showPreview(fileName, rows) {
        removePreview();

        if (!rows || rows.length < 2) return;

        var headers = rows[0];
        var dataRows = rows.slice(1);
        var totalRows = dataRows.length;
        var displayRows = dataRows.slice(0, MAX_PREVIEW_ROWS);

        _previewContainer = document.createElement('div');
        _previewContainer.className = 'tacta-csv-preview';

        // Header bar
        var headerBar = document.createElement('div');
        headerBar.className = 'tacta-csv-header';

        var title = document.createElement('span');
        title.className = 'tacta-csv-title';
        title.textContent = 'CSV Preview: ' + fileName;

        var badge = document.createElement('span');
        badge.className = 'tacta-csv-badge';
        badge.textContent = totalRows + ' rows, ' + headers.length + ' columns';

        var closeBtn = document.createElement('button');
        closeBtn.className = 'tacta-csv-close';
        closeBtn.innerHTML = '&#10005;';
        closeBtn.title = 'Close preview';
        closeBtn.addEventListener('click', removePreview);

        headerBar.appendChild(title);
        headerBar.appendChild(badge);
        headerBar.appendChild(closeBtn);
        _previewContainer.appendChild(headerBar);

        // Search
        var searchRow = document.createElement('div');
        searchRow.className = 'tacta-csv-search-row';

        var searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'tacta-csv-search';
        searchInput.placeholder = 'Filter rows...';
        searchInput.spellcheck = false;

        var countSpan = document.createElement('span');
        countSpan.className = 'tacta-csv-search-count';

        searchRow.appendChild(searchInput);
        searchRow.appendChild(countSpan);
        _previewContainer.appendChild(searchRow);

        // Table
        var tableWrap = document.createElement('div');
        tableWrap.className = 'tacta-csv-table-wrap';

        var table = document.createElement('table');
        table.className = 'tacta-csv-table';

        // Thead
        var thead = document.createElement('thead');
        var hrow = document.createElement('tr');
        var thNum = document.createElement('th');
        thNum.textContent = '#';
        thNum.style.width = '40px';
        hrow.appendChild(thNum);

        for (var h = 0; h < headers.length; h++) {
            var th = document.createElement('th');
            th.textContent = headers[h];
            th.title = headers[h];
            hrow.appendChild(th);
        }
        thead.appendChild(hrow);
        table.appendChild(thead);

        // Tbody
        var tbody = document.createElement('tbody');
        for (var r = 0; r < displayRows.length; r++) {
            var tr = document.createElement('tr');
            var tdNum = document.createElement('td');
            tdNum.textContent = String(r + 1);
            tdNum.className = 'tacta-csv-rownum';
            tr.appendChild(tdNum);

            for (var c = 0; c < headers.length; c++) {
                var td = document.createElement('td');
                var val = (displayRows[r][c] !== undefined) ? displayRows[r][c] : '';
                td.textContent = val;
                if (!val) td.className = 'tacta-csv-empty';
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        _previewContainer.appendChild(tableWrap);

        // Truncation notice
        if (totalRows > MAX_PREVIEW_ROWS) {
            var notice = document.createElement('div');
            notice.className = 'tacta-csv-notice';
            notice.textContent = 'Showing first ' + MAX_PREVIEW_ROWS + ' of ' + totalRows + ' rows.';
            _previewContainer.appendChild(notice);
        }

        // Search filtering
        searchInput.addEventListener('input', function () {
            var term = searchInput.value.trim().toLowerCase();
            var trs = tbody.querySelectorAll('tr');
            var shown = 0;
            for (var i = 0; i < trs.length; i++) {
                if (!term) {
                    trs[i].style.display = '';
                    shown++;
                } else {
                    var match = trs[i].textContent.toLowerCase().indexOf(term) >= 0;
                    trs[i].style.display = match ? '' : 'none';
                    if (match) shown++;
                }
            }
            countSpan.textContent = term ? shown + ' match' + (shown !== 1 ? 'es' : '') : '';
        });

        // Insert into page
        var insertTarget = document.querySelector('#main_form') || document.querySelector('#div__body') || document.body;
        insertTarget.appendChild(_previewContainer);
    }

    function removePreview() {
        if (_previewContainer && _previewContainer.parentNode) {
            _previewContainer.parentNode.removeChild(_previewContainer);
        }
        _previewContainer = null;
    }

    // ────────────────────────────────────────────────────────────────
    // File input detection and monitoring
    // ────────────────────────────────────────────────────────────────

    /**
     * Finds file inputs and attaches change listeners.
     * @returns {boolean} true if at least one file input was found (new or existing)
     */
    function attachToFileInputs() {
        var inputs = document.querySelectorAll('input[type="file"]');
        if (inputs.length === 0) return false;

        for (var i = 0; i < inputs.length; i++) {
            if (inputs[i]._tactaCsvAttached) continue;
            inputs[i]._tactaCsvAttached = true;

            inputs[i].addEventListener('change', function (e) {
                var file = e.target.files && e.target.files[0];
                if (!file) return;

                // Only handle CSV/TXT files
                var name = file.name.toLowerCase();
                if (!name.endsWith('.csv') && !name.endsWith('.txt') && !name.endsWith('.tsv')) return;

                var reader = new FileReader();
                reader.onload = function (ev) {
                    var text = ev.target.result;
                    var delimiter = detectDelimiter(text);
                    var rows = parseCSV(text, delimiter);
                    showPreview(file.name, rows);
                };
                reader.readAsText(file, 'UTF-8');
            });
        }
        return true;
    }

    // ────────────────────────────────────────────────────────────────
    // Init
    // ────────────────────────────────────────────────────────────────

    var _csvObserver = null;
    var _csvObserverDisconnected = false;

    function init() {
        var found = attachToFileInputs();

        // If file inputs already exist and are attached, no need to observe
        if (found && _csvObserverDisconnected) return;

        if (found) {
            // Inputs found — disconnect any existing observer
            if (_csvObserver) {
                _csvObserver.disconnect();
                _csvObserverDisconnected = true;
            }
            return;
        }

        // No file inputs yet — watch for dynamically added ones
        if (_csvObserver || _csvObserverDisconnected) return;

        _csvObserver = new MutationObserver(function () {
            var attached = attachToFileInputs();
            if (attached) {
                // File inputs found and attached — stop observing
                _csvObserver.disconnect();
                _csvObserver = null;
                _csvObserverDisconnected = true;
            }
        });
        _csvObserver.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === 'csv-viewer') {
            init();
        }
    });
})();

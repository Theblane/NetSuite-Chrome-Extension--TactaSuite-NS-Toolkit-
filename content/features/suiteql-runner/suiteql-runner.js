/**
 * suiteql-runner.js
 * NetSuite TactaSuite - SuiteQL Runner (Content Script)
 *
 * @author Blane Maher
 *
 * Floating panel for running SuiteQL queries against NetSuite.
 * Communicates with the background service worker for query execution.
 *
 * Activation: 'tacta:featureActivated' custom event with featureId 'suiteql-runner'.
 *
 * @fileoverview SuiteQL Runner content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaSuiteQLRunnerLoaded) return;
    window.__tactaSuiteQLRunnerLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} Feature identifier */
    var FEATURE_ID = 'suiteql-runner';

    /** @type {string} CSS class scope for this feature */
    var SCOPE_CLASS = 'tacta-suiteql-runner';

    /** @type {number} Default panel width */
    var DEFAULT_WIDTH = 800;

    /** @type {number} Default panel height */
    var DEFAULT_HEIGHT = 500;

    /** @type {string} Chrome storage key for panel state */
    var STORAGE_KEY_PANEL = 'tacta_sql_panel_state';

    /** @type {string} Chrome storage key for query history */
    var STORAGE_KEY_HISTORY = 'tacta_sql_history';

    /** @type {number} Maximum number of history entries to keep */
    var MAX_HISTORY = 20;

    /** @type {string} Chrome storage key for named saved queries */
    var STORAGE_KEY_SAVED = 'tacta_sql_saved';

    /** @type {number} Maximum number of saved queries to keep */
    var MAX_SAVED = 100;

    /** @type {number} Characters of query text shown in the saved list */
    var SAVED_SNIPPET_LENGTH = 60;

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {{ panel: HTMLElement, header: HTMLElement, body: HTMLElement, close: Function }|null} */
    var _panelInstance = null;

    /** @type {boolean} Whether the panel is minimized */
    var _isMinimized = false;

    /** @type {boolean} Whether the panel is maximized */
    var _isMaximized = false;

    /** @type {{ top: string, left: string, width: string, height: string }|null} */
    var _preMaximizeState = null;

    /** @type {{ columns: string[], rows: object[], count: number, executionTime: number, truncated: boolean }|null} */
    var _suiteqlResults = null;

    /** @type {string|null} Current sort column for results */
    var _sortColumn = null;

    /** @type {boolean} Current sort direction */
    var _sortAsc = true;

    /** @type {string[]} Query history list */
    var _queryHistory = [];

    /** @type {boolean} Whether the history dropdown is visible */
    var _historyOpen = false;

    /** @type {Array<{ id: string, name: string, query: string, createdAt: number, lastRunAt: number|null }>} Saved queries */
    var _savedQueries = [];

    /** @type {boolean} Whether the saved-queries dropdown is visible */
    var _savedOpen = false;

    // ── DOM references ──
    var _editorEl = null;
    var _statusEl = null;
    var _resultsHost = null;
    var _historyDropdown = null;
    var _savedDropdown = null;

    // ────────────────────────────────────────────────────────────────
    // Background Communication
    // ────────────────────────────────────────────────────────────────

    /**
     * Sends a message to the background service worker and returns the response.
     * @param {Object} payload - Message payload with 'action' key.
     * @returns {Promise<Object>}
     */
    function _sendMessage(payload) {
        return new Promise(function (resolve, reject) {
            try {
                chrome.runtime.sendMessage(payload, function (response) {
                    if (chrome.runtime.lastError) {
                        var msg = chrome.runtime.lastError.message || '';
                        if (msg.indexOf('Extension context invalidated') >= 0) {
                            reject(new Error('Extension was reloaded. Please refresh this page (F5) to reconnect.'));
                        } else {
                            reject(new Error(msg));
                        }
                        return;
                    }
                    if (response && response.error) {
                        reject(new Error(response.error));
                    } else {
                        resolve(response);
                    }
                });
            } catch (e) {
                if (String(e).indexOf('Extension context invalidated') >= 0) {
                    reject(new Error('Extension was reloaded. Please refresh this page (F5) to reconnect.'));
                } else {
                    reject(e);
                }
            }
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Storage Helpers
    // ────────────────────────────────────────────────────────────────

    function _storageGet(key) {
        return new Promise(function (resolve) {
            try {
                chrome.storage.local.get(key, function (data) {
                    resolve(data[key] || null);
                });
            } catch (_) {
                resolve(null);
            }
        });
    }

    function _storageSet(key, value) {
        return new Promise(function (resolve) {
            try {
                var data = {};
                data[key] = value;
                chrome.storage.local.set(data, function () { resolve(); });
            } catch (_) {
                resolve();
            }
        });
    }

    function _savePanelState() {
        if (!_panelInstance) return;
        var panel = _panelInstance.panel;
        var rect = panel.getBoundingClientRect();
        _storageSet(STORAGE_KEY_PANEL, {
            top: panel.style.top || (rect.top + 'px'),
            left: panel.style.left || (rect.left + 'px'),
            width: panel.style.width || (rect.width + 'px'),
            height: panel.style.height || (rect.height + 'px')
        });
    }

    function _loadPanelState() {
        return _storageGet(STORAGE_KEY_PANEL);
    }

    function _loadHistory() {
        return _storageGet(STORAGE_KEY_HISTORY).then(function (hist) {
            _queryHistory = Array.isArray(hist) ? hist : [];
        });
    }

    function _saveHistory() {
        return _storageSet(STORAGE_KEY_HISTORY, _queryHistory);
    }

    function _addToHistory(query) {
        var trimmed = query.trim();
        if (!trimmed) return;

        var idx = _queryHistory.indexOf(trimmed);
        if (idx >= 0) {
            _queryHistory.splice(idx, 1);
        }

        _queryHistory.unshift(trimmed);

        if (_queryHistory.length > MAX_HISTORY) {
            _queryHistory = _queryHistory.slice(0, MAX_HISTORY);
        }

        _saveHistory();
    }

    // ── Saved queries ──

    function _loadSaved() {
        return _storageGet(STORAGE_KEY_SAVED).then(function (saved) {
            _savedQueries = Array.isArray(saved) ? saved.filter(function (s) {
                return s && typeof s.query === 'string';
            }) : [];
        });
    }

    function _saveSaved() {
        return _storageSet(STORAGE_KEY_SAVED, _savedQueries);
    }

    function _generateSavedId() {
        return 'sq_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
    }

    /**
     * Stores the current editor query under a name. Newest first, capped at MAX_SAVED.
     * @param {string} name
     * @param {string} query
     * @returns {Object} The saved entry
     */
    function _addSavedQuery(name, query) {
        var entry = {
            id: _generateSavedId(),
            name: name,
            query: query,
            createdAt: Date.now(),
            lastRunAt: null
        };
        _savedQueries.unshift(entry);
        if (_savedQueries.length > MAX_SAVED) {
            _savedQueries = _savedQueries.slice(0, MAX_SAVED);
        }
        _saveSaved();
        return entry;
    }

    function _deleteSavedQuery(id) {
        _savedQueries = _savedQueries.filter(function (s) { return s.id !== id; });
        _saveSaved();
    }

    /**
     * Marks any saved entry whose text matches the executed query as run now.
     * @param {string} query
     */
    function _touchSavedLastRun(query) {
        var trimmed = query.trim();
        var changed = false;
        for (var i = 0; i < _savedQueries.length; i++) {
            if (_savedQueries[i].query.trim() === trimmed) {
                _savedQueries[i].lastRunAt = Date.now();
                changed = true;
            }
        }
        if (changed) _saveSaved();
    }

    // ────────────────────────────────────────────────────────────────
    // Utility Helpers
    // ────────────────────────────────────────────────────────────────

    function _el(tag, attrs, children) {
        return window.TactaDOM.createElement(tag, attrs, children);
    }

    /**
     * Compact "time ago" label for saved-query metadata.
     * @param {number|null} ts
     * @returns {string}
     */
    function _formatAgo(ts) {
        if (!ts) return 'never run';
        var diff = Date.now() - ts;
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
        if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + 'd ago';
        return new Date(ts).toLocaleDateString();
    }

    function _fileTimestamp() {
        return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    }

    function _generateCSV(columns, rows) {
        var lines = [];

        lines.push(columns.map(function (col) {
            return _csvEscapeCell(col);
        }).join(','));

        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            lines.push(columns.map(function (col) {
                var val = row[col];
                return _csvEscapeCell(val === null || val === undefined ? '' : String(val));
            }).join(','));
        }

        return lines.join('\n');
    }

    function _csvEscapeCell(str) {
        if (str.indexOf(',') >= 0 || str.indexOf('"') >= 0 || str.indexOf('\n') >= 0) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    function _downloadFile(content, filename, mimeType) {
        var blob = new Blob([content], { type: mimeType });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ────────────────────────────────────────────────────────────────
    // Panel Lifecycle
    // ────────────────────────────────────────────────────────────────

    /**
     * Toggles the panel. When an incoming query is supplied (another feature
     * handed us a query via the activation event) the panel is opened or kept
     * open and the query is loaded instead of toggling closed.
     * @param {{ query?: string, run?: boolean }} [incoming]
     */
    function _showPanel(incoming) {
        var hasIncoming = !!(incoming && typeof incoming.query === 'string' && incoming.query.trim());

        if (_panelInstance) {
            if (hasIncoming) {
                _applyIncomingQuery(incoming);
            } else {
                _closePanel();
            }
            return;
        }

        if (!window.TactaDOM) {
            console.error('[TactaSuite SuiteQL Runner] TactaDOM not available.');
            return;
        }

        _loadHistory().then(function () {
            return _loadSaved();
        }).then(function () {
            return _loadPanelState();
        }).then(function (savedState) {
            _createPanel(savedState);
            if (hasIncoming) _applyIncomingQuery(incoming);
        });
    }

    /**
     * Loads a query handed in from another feature and optionally runs it.
     * @param {{ query: string, run?: boolean }} incoming
     */
    function _applyIncomingQuery(incoming) {
        if (!_editorEl) return;
        _editorEl.value = incoming.query;
        if (_isMinimized) _toggleMinimize();
        _editorEl.focus();
        if (incoming.run === true) {
            _executeQuery();
        }
    }

    function _closePanel() {
        if (_panelInstance) {
            _savePanelState();
            _panelInstance.close();
            _panelInstance = null;
        }
        _resetState();
    }

    function _resetState() {
        _isMinimized = false;
        _isMaximized = false;
        _preMaximizeState = null;
        _suiteqlResults = null;
        _sortColumn = null;
        _sortAsc = true;
        _historyOpen = false;
        _savedOpen = false;
        _editorEl = null;
        _statusEl = null;
        _resultsHost = null;
        _historyDropdown = null;
        _savedDropdown = null;
    }

    // ────────────────────────────────────────────────────────────────
    // Panel Construction
    // ────────────────────────────────────────────────────────────────

    function _createPanel(savedState) {
        var defaultTop = Math.max(40, Math.floor((window.innerHeight - DEFAULT_HEIGHT) / 2));
        var defaultLeft = Math.max(40, Math.floor((window.innerWidth - DEFAULT_WIDTH) / 2));

        var posTop = (savedState && savedState.top) || (defaultTop + 'px');
        var posLeft = (savedState && savedState.left) || (defaultLeft + 'px');
        var width = (savedState && savedState.width) || (DEFAULT_WIDTH + 'px');
        var height = (savedState && savedState.height) || (DEFAULT_HEIGHT + 'px');

        _panelInstance = window.TactaDOM.createPanel({
            title: 'SuiteQL Runner',
            width: parseInt(width, 10),
            height: parseInt(height, 10),
            position: { top: posTop, left: posLeft, right: 'auto' },
            resizable: true,
            draggable: true,
            closeOnClickOutside: false,
            onClose: function () {
                _savePanelState();
                _panelInstance = null;
                _resetState();
            }
        });

        _panelInstance.panel.classList.add(SCOPE_CLASS);

        _buildHeaderActions();

        var content = _buildSuiteQLContent();
        _panelInstance.body.appendChild(content);

        _panelInstance.panel.addEventListener('mouseup', function () {
            setTimeout(_savePanelState, 100);
        });
    }

    function _buildHeaderActions() {
        var actionsContainer = _panelInstance.header.querySelector('.tacta-panel-actions');
        if (!actionsContainer) return;

        actionsContainer.innerHTML = '';

        var minimizeBtn = _el('button', {
            className: 'tacta-sql-header-btn',
            title: 'Minimize',
            innerHTML: '&#95;'
        });
        minimizeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _toggleMinimize();
        });

        var maximizeBtn = _el('button', {
            className: 'tacta-sql-header-btn',
            title: 'Maximize',
            innerHTML: '&#9744;'
        });
        maximizeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _toggleMaximize();
        });

        var closeBtn = _el('button', {
            className: 'tacta-panel-close',
            title: 'Close',
            innerHTML: '&#10005;'
        });
        closeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _closePanel();
        });

        actionsContainer.appendChild(minimizeBtn);
        actionsContainer.appendChild(maximizeBtn);
        actionsContainer.appendChild(closeBtn);
    }

    function _toggleMinimize() {
        if (!_panelInstance) return;
        _isMinimized = !_isMinimized;
        _panelInstance.panel.classList.toggle('tacta-sql-panel-minimized', _isMinimized);

        if (_isMinimized && _isMaximized) {
            _toggleMaximize();
        }
    }

    function _toggleMaximize() {
        if (!_panelInstance) return;
        var panel = _panelInstance.panel;

        if (_isMaximized) {
            if (_preMaximizeState) {
                panel.style.top = _preMaximizeState.top;
                panel.style.left = _preMaximizeState.left;
                panel.style.width = _preMaximizeState.width;
                panel.style.height = _preMaximizeState.height;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
            }
            panel.classList.remove('tacta-sql-panel-maximized');
            _isMaximized = false;
        } else {
            _preMaximizeState = {
                top: panel.style.top,
                left: panel.style.left,
                width: panel.style.width,
                height: panel.style.height
            };
            panel.classList.add('tacta-sql-panel-maximized');
            _isMaximized = true;

            if (_isMinimized) {
                _isMinimized = false;
                panel.classList.remove('tacta-sql-panel-minimized');
            }
        }
    }

    // ────────────────────────────────────────────────────────────────
    // SuiteQL Content
    // ────────────────────────────────────────────────────────────────

    function _buildSuiteQLContent() {
        var container = _el('div', { className: 'tacta-tab-content tacta-active' });

        // ── Query Editor ──
        _editorEl = _el('textarea', {
            className: 'tacta-sql-editor',
            placeholder: 'SELECT * FROM transaction WHERE rownum <= 10'
        });

        _editorEl.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                _executeQuery();
            }
            if (e.key === 'Tab') {
                e.preventDefault();
                var start = _editorEl.selectionStart;
                var end = _editorEl.selectionEnd;
                _editorEl.value = _editorEl.value.substring(0, start) + '    ' + _editorEl.value.substring(end);
                _editorEl.selectionStart = _editorEl.selectionEnd = start + 4;
            }
        });

        container.appendChild(_editorEl);

        // ── Toolbar ──
        var runBtn = _el('button', {
            className: 'tacta-btn tacta-btn-primary tacta-btn-sm',
            innerHTML: '&#9654; Run'
        });
        runBtn.addEventListener('click', function () {
            _executeQuery();
        });

        var historyWrapper = _el('div', { className: 'tacta-sql-history-wrapper' });
        var historyBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'History'
        });
        historyBtn.addEventListener('click', function () {
            _toggleHistory();
        });

        _historyDropdown = _el('div', { className: 'tacta-sql-history-dropdown' });
        historyWrapper.appendChild(historyBtn);
        historyWrapper.appendChild(_historyDropdown);

        // Saved queries dropdown (named entries, persisted in tacta_sql_saved)
        var savedWrapper = _el('div', { className: 'tacta-sql-history-wrapper' });
        var savedBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Saved',
            title: 'Saved queries'
        });
        savedBtn.addEventListener('click', function () {
            _toggleSaved();
        });

        _savedDropdown = _el('div', { className: 'tacta-sql-history-dropdown tacta-sql-saved-dropdown' });
        savedWrapper.appendChild(savedBtn);
        savedWrapper.appendChild(_savedDropdown);

        _statusEl = _el('span', { className: 'tacta-sql-status' });

        var toolbarLeft = _el('div', { className: 'tacta-sql-toolbar-left' }, [runBtn, historyWrapper, savedWrapper]);
        var toolbarRight = _el('div', { className: 'tacta-sql-toolbar-right' }, [_statusEl]);
        var toolbar = _el('div', { className: 'tacta-sql-toolbar' }, [toolbarLeft, toolbarRight]);

        container.appendChild(toolbar);

        // ── Results Area ──
        _resultsHost = _el('div', { className: 'tacta-sql-results' });
        container.appendChild(_resultsHost);

        // Close dropdowns when clicking outside
        document.addEventListener('mousedown', function (e) {
            if (_historyOpen && _historyDropdown && !_historyDropdown.contains(e.target) && !historyBtn.contains(e.target)) {
                _historyOpen = false;
                _historyDropdown.classList.remove('tacta-visible');
            }
            if (_savedOpen && _savedDropdown && !_savedDropdown.contains(e.target) && !savedBtn.contains(e.target)) {
                _savedOpen = false;
                _savedDropdown.classList.remove('tacta-visible');
            }
        });

        return container;
    }

    function _closeSavedDropdown() {
        _savedOpen = false;
        if (_savedDropdown) _savedDropdown.classList.remove('tacta-visible');
    }

    function _toggleSaved() {
        _savedOpen = !_savedOpen;
        if (!_savedDropdown) return;

        if (_savedOpen) {
            // Only one dropdown open at a time
            _historyOpen = false;
            if (_historyDropdown) _historyDropdown.classList.remove('tacta-visible');
            _renderSaved();
            _savedDropdown.classList.add('tacta-visible');
        } else {
            _savedDropdown.classList.remove('tacta-visible');
        }
    }

    /**
     * Renders the saved-queries dropdown: a "save current" row (inline name
     * input, no window.prompt) followed by the saved entries.
     */
    function _renderSaved() {
        if (!_savedDropdown) return;
        _savedDropdown.innerHTML = '';

        var hasCurrent = !!(_editorEl && _editorEl.value.trim());

        // ── Save current query row ──
        var saveRow = _el('div', { className: 'tacta-sql-saved-form' });
        var saveTrigger = _el('button', {
            className: 'tacta-btn tacta-btn-sm tacta-btn-primary',
            textContent: 'Save current query',
            title: hasCurrent ? 'Save the query in the editor under a name' : 'Enter a query in the editor first'
        });
        if (!hasCurrent) saveTrigger.disabled = true;

        var nameInput = _el('input', {
            type: 'text',
            className: 'tacta-input tacta-sql-saved-name',
            placeholder: 'Name this query...',
            maxlength: '80',
            spellcheck: 'false'
        });
        var confirmBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm tacta-btn-primary',
            textContent: 'Save'
        });
        var cancelBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Cancel'
        });
        var inputRow = _el('div', { className: 'tacta-sql-saved-input-row' }, [nameInput, confirmBtn, cancelBtn]);

        function showInput() {
            saveTrigger.style.display = 'none';
            inputRow.classList.add('tacta-visible');
            nameInput.value = '';
            nameInput.focus();
        }

        function hideInput() {
            inputRow.classList.remove('tacta-visible');
            saveTrigger.style.display = '';
        }

        function commitSave() {
            var name = nameInput.value.trim();
            var query = _editorEl ? _editorEl.value.trim() : '';
            if (!query) {
                hideInput();
                return;
            }
            if (!name) {
                nameInput.classList.add('tacta-sql-saved-name--invalid');
                nameInput.focus();
                return;
            }
            _addSavedQuery(name, query);
            if (window.TactaDOM) window.TactaDOM.showToast('Saved "' + name + '"', 'success', 2000);
            _renderSaved();
        }

        saveTrigger.addEventListener('click', function (e) {
            e.stopPropagation();
            showInput();
        });
        confirmBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            commitSave();
        });
        cancelBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            hideInput();
        });
        nameInput.addEventListener('input', function () {
            nameInput.classList.remove('tacta-sql-saved-name--invalid');
        });
        nameInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                commitSave();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                hideInput();
            }
        });

        saveRow.appendChild(saveTrigger);
        saveRow.appendChild(inputRow);
        _savedDropdown.appendChild(saveRow);

        // ── Saved entries ──
        if (_savedQueries.length === 0) {
            _savedDropdown.appendChild(_el('div', {
                className: 'tacta-sql-history-empty',
                textContent: 'No saved queries yet'
            }));
            return;
        }

        for (var i = 0; i < _savedQueries.length; i++) {
            _savedDropdown.appendChild(_createSavedItem(_savedQueries[i]));
        }
    }

    /**
     * Builds one saved-query row: name, snippet, last run, delete icon.
     * @param {{ id: string, name: string, query: string, lastRunAt: number|null }} entry
     * @returns {HTMLElement}
     */
    function _createSavedItem(entry) {
        var oneLine = entry.query.replace(/\s+/g, ' ').trim();
        var snippet = oneLine.length > SAVED_SNIPPET_LENGTH
            ? oneLine.substring(0, SAVED_SNIPPET_LENGTH) + '...'
            : oneLine;

        var nameEl = _el('span', { className: 'tacta-sql-saved-item-name', textContent: entry.name });
        var metaEl = _el('span', {
            className: 'tacta-sql-saved-item-meta',
            textContent: 'Last run: ' + _formatAgo(entry.lastRunAt)
        });
        var snippetEl = _el('div', {
            className: 'tacta-sql-saved-item-snippet',
            textContent: snippet,
            title: entry.query
        });

        var loadBtn = _el('button', {
            className: 'tacta-sql-saved-item-load',
            title: 'Load into editor'
        }, [
            _el('div', { className: 'tacta-sql-saved-item-top' }, [nameEl, metaEl]),
            snippetEl
        ]);
        loadBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (_editorEl) {
                _editorEl.value = entry.query;
                _editorEl.focus();
            }
            _closeSavedDropdown();
        });

        var deleteBtn = _el('button', {
            className: 'tacta-sql-saved-item-delete',
            title: 'Delete saved query',
            innerHTML: '&#10005;'
        });
        deleteBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _deleteSavedQuery(entry.id);
            _renderSaved();
        });

        return _el('div', { className: 'tacta-sql-saved-item' }, [loadBtn, deleteBtn]);
    }

    function _toggleHistory() {
        _historyOpen = !_historyOpen;
        if (!_historyDropdown) return;

        if (_historyOpen) {
            _renderHistory();
            _historyDropdown.classList.add('tacta-visible');
        } else {
            _historyDropdown.classList.remove('tacta-visible');
        }
    }

    function _renderHistory() {
        if (!_historyDropdown) return;
        _historyDropdown.innerHTML = '';

        if (_queryHistory.length === 0) {
            _historyDropdown.appendChild(_el('div', {
                className: 'tacta-sql-history-empty',
                textContent: 'No query history yet'
            }));
            return;
        }

        for (var i = 0; i < _queryHistory.length; i++) {
            var item = _el('button', {
                className: 'tacta-sql-history-item',
                textContent: _queryHistory[i],
                dataset: { idx: String(i) }
            });
            item.addEventListener('click', function () {
                var idx = parseInt(this.dataset.idx, 10);
                if (_editorEl && _queryHistory[idx]) {
                    _editorEl.value = _queryHistory[idx];
                    _editorEl.focus();
                }
                _historyOpen = false;
                _historyDropdown.classList.remove('tacta-visible');
            });
            _historyDropdown.appendChild(item);
        }
    }

    // ────────────────────────────────────────────────────────────────
    // SuiteQL Execution
    // ────────────────────────────────────────────────────────────────

    function _executeQuery() {
        if (!_editorEl) return;
        var query = _editorEl.value.trim();
        if (!query) {
            _showStatus('Enter a query to execute', 'error');
            return;
        }

        _addToHistory(query);
        _touchSavedLastRun(query);
        _showStatus('Executing...', '');
        _showResultsLoading();

        _sendMessage({ action: 'executeSuiteQL', query: query, params: null })
            .then(function (result) {
                _suiteqlResults = result;
                _sortColumn = null;
                _sortAsc = true;
                var rowCount = result.count || (result.rows ? result.rows.length : 0);
                var timeMs = result.executionTime || 0;
                _showStatus(rowCount + ' row' + (rowCount !== 1 ? 's' : '') + ', ' + timeMs + 'ms', 'success');
                _renderResults();
            })
            .catch(function (err) {
                _suiteqlResults = null;
                _showStatus('Error', 'error');
                _showResultsError(err.message || 'Query execution failed');
            });
    }

    function _showStatus(text, type) {
        if (!_statusEl) return;
        _statusEl.textContent = text;
        _statusEl.className = 'tacta-sql-status';
        if (type === 'success') _statusEl.classList.add('tacta-sql-status--success');
        else if (type === 'error') _statusEl.classList.add('tacta-sql-status--error');
    }

    function _showResultsLoading() {
        if (!_resultsHost) return;
        _resultsHost.innerHTML = '';
        _resultsHost.appendChild(_el('div', { className: 'tacta-sql-loading' }, [
            _el('div', { className: 'tacta-spinner tacta-spinner--sm' }),
            _el('span', { textContent: 'Running query...' })
        ]));
    }

    function _showResultsError(message) {
        if (!_resultsHost) return;
        _resultsHost.innerHTML = '';
        _resultsHost.appendChild(_el('div', {
            className: 'tacta-sql-error',
            textContent: message
        }));
    }

    function _renderResults() {
        if (!_resultsHost || !_suiteqlResults) return;
        _resultsHost.innerHTML = '';

        var columns = _suiteqlResults.columns || [];
        var rows = _suiteqlResults.rows || [];

        if (columns.length === 0 || rows.length === 0) {
            _resultsHost.appendChild(_el('div', {
                className: 'tacta-sql-empty',
                textContent: 'Query returned no results'
            }));
            return;
        }

        var sortedRows = rows.slice();
        if (_sortColumn !== null) {
            var col = _sortColumn;
            var asc = _sortAsc;
            sortedRows.sort(function (a, b) {
                var va = a[col];
                var vb = b[col];
                if (va === null || va === undefined) va = '';
                if (vb === null || vb === undefined) vb = '';

                var na = Number(va);
                var nb = Number(vb);
                if (!isNaN(na) && !isNaN(nb)) {
                    return asc ? na - nb : nb - na;
                }

                va = String(va).toLowerCase();
                vb = String(vb).toLowerCase();
                if (va < vb) return asc ? -1 : 1;
                if (va > vb) return asc ? 1 : -1;
                return 0;
            });
        }

        var tableWrapper = _el('div', { className: 'tacta-table-wrapper' });
        var table = _el('table', { className: 'tacta-table' });

        var thead = _el('thead');
        var headRow = _el('tr');
        for (var h = 0; h < columns.length; h++) {
            var th = _el('th', {
                textContent: columns[h],
                className: 'tacta-sortable',
                dataset: { col: columns[h] }
            });

            if (_sortColumn === columns[h]) {
                th.classList.add(_sortAsc ? 'tacta-sort-asc' : 'tacta-sort-desc');
            }

            th.addEventListener('click', (function (colName) {
                return function () {
                    if (_sortColumn === colName) {
                        _sortAsc = !_sortAsc;
                    } else {
                        _sortColumn = colName;
                        _sortAsc = true;
                    }
                    _renderResults();
                };
            })(columns[h]));

            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = _el('tbody');
        for (var r = 0; r < sortedRows.length; r++) {
            var tr = _el('tr');
            for (var c = 0; c < columns.length; c++) {
                var cellVal = sortedRows[r][columns[c]];
                var td = _el('td', {
                    textContent: cellVal === null || cellVal === undefined ? '' : String(cellVal),
                    title: cellVal === null || cellVal === undefined ? '' : String(cellVal)
                });
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        tableWrapper.appendChild(table);
        _resultsHost.appendChild(tableWrapper);

        if (_suiteqlResults.truncated) {
            _resultsHost.appendChild(_el('div', {
                className: 'tacta-sql-truncated-notice',
                textContent: 'Results were truncated. Add a ROWNUM limit to your query to control the number of rows returned.'
            }));
        }

        var exportBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Export CSV'
        });
        exportBtn.addEventListener('click', function () {
            _exportResultsCSV();
        });

        var exportJsonBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Export JSON',
            title: 'Download result rows as a JSON array'
        });
        exportJsonBtn.addEventListener('click', function () {
            _exportResultsJSON();
        });

        var copyQueryBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Copy Query'
        });
        copyQueryBtn.addEventListener('click', function () {
            _copyCurrentQuery();
        });

        var actionsRow = _el('div', { className: 'tacta-sql-results-actions' }, [exportBtn, exportJsonBtn, copyQueryBtn]);
        _resultsHost.appendChild(actionsRow);
    }

    function _exportResultsCSV() {
        if (!_suiteqlResults || !_suiteqlResults.columns || !_suiteqlResults.rows) {
            if (window.TactaDOM) window.TactaDOM.showToast('No results to export', 'warning', 2000);
            return;
        }

        var csv = _generateCSV(_suiteqlResults.columns, _suiteqlResults.rows);
        _downloadFile(csv, 'suiteql-results-' + _fileTimestamp() + '.csv', 'text/csv;charset=utf-8;');

        if (window.TactaDOM) window.TactaDOM.showToast('CSV exported', 'success', 2000);
    }

    /**
     * Downloads the current result rows as a pretty-printed JSON array.
     */
    function _exportResultsJSON() {
        if (!_suiteqlResults || !Array.isArray(_suiteqlResults.rows)) {
            if (window.TactaDOM) window.TactaDOM.showToast('No results to export', 'warning', 2000);
            return;
        }

        var json = JSON.stringify(_suiteqlResults.rows, null, 2);
        _downloadFile(json, 'suiteql-' + _fileTimestamp() + '.json', 'application/json;charset=utf-8;');

        if (window.TactaDOM) window.TactaDOM.showToast('JSON exported', 'success', 2000);
    }

    function _copyCurrentQuery() {
        if (!_editorEl) return;
        var query = _editorEl.value.trim();
        if (!query) {
            if (window.TactaDOM) window.TactaDOM.showToast('No query to copy', 'warning', 2000);
            return;
        }

        if (window.TactaDOM && typeof window.TactaDOM.copyToClipboard === 'function') {
            window.TactaDOM.copyToClipboard(query).then(function (ok) {
                if (ok && window.TactaDOM) {
                    window.TactaDOM.showToast('Query copied to clipboard', 'success', 2000);
                }
            });
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Event Listener — Feature Activation
    // ────────────────────────────────────────────────────────────────

    // detail.data (optional) may carry { query: string, run: boolean } from
    // another feature that wants to hand a query to the editor. Without it
    // the panel simply toggles as before.
    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === FEATURE_ID) {
            var data = e.detail.data;
            _showPanel(data && typeof data === 'object' ? data : null);
        }
    });

})();

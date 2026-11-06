/**
 * script-explorer.js
 * NetSuite TactaSuite - Script Explorer (Content Script)
 *
 * @author Blane Maher
 *
 * Provides a browsable panel of all scripts and deployments in the
 * NetSuite account. Fetches data via SuiteQL through the background
 * service worker and displays it in a floating, resizable panel with
 * tabs for script types, search/filter, and expandable deployment rows.
 *
 * Activation: popup message dispatches 'tacta:featureActivated' event
 * with featureId 'script-explorer'.
 *
 * @fileoverview Script Explorer content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaScriptExplorerLoaded) return;
    window.__tactaScriptExplorerLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    var FEATURE_ID = 'script-explorer';
    var SCOPE_CLASS = 'tacta-script-explorer';
    var PANEL_WIDTH = 700;
    var PANEL_HEIGHT = 500;

    /** Script type tab definitions */
    var TABS = [
        { id: 'all',       label: 'All Scripts',   filter: null },
        { id: 'ue',        label: 'User Event',    filter: 'USEREVENT' },
        { id: 'cs',        label: 'Client Script',  filter: 'CLIENT' },
        { id: 'sch',       label: 'Scheduled',     filter: 'SCHEDULED' },
        { id: 'mr',        label: 'Map/Reduce',    filter: 'MAPREDUCESCRIPT' },
        { id: 'sl',        label: 'Suitelet',      filter: 'SUITELET' },
        { id: 'rl',        label: 'Restlet',       filter: 'RESTLET' }
    ];

    /** Map of script type values to display labels */
    var TYPE_LABELS = {
        'USEREVENT':       'User Event',
        'CLIENT':          'Client',
        'SCHEDULED':       'Scheduled',
        'MAPREDUCESCRIPT': 'Map/Reduce',
        'SUITELET':        'Suitelet',
        'RESTLET':         'Restlet',
        'WORKFLOWACTIONSCRIPT': 'WF Action',
        'BUNDLEINSTALLATIONSCRIPT': 'Bundle Install',
        'PORTLET':         'Portlet',
        'MASSUPDATE':      'Mass Update',
        'SDFSDFINSTALLATIONSCRIPT': 'SDF Install'
    };

    /** Map of script type to CSS badge modifier */
    var TYPE_BADGE_CLASS = {
        'USEREVENT':       'badge-ue',
        'CLIENT':          'badge-cs',
        'SCHEDULED':       'badge-sch',
        'MAPREDUCESCRIPT': 'badge-mr',
        'SUITELET':        'badge-sl',
        'RESTLET':         'badge-rl'
    };

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {{ panel: HTMLElement, header: HTMLElement, body: HTMLElement, close: Function }|null} */
    var _panelInstance = null;

    /** @type {Array|null} Cached scripts list */
    var _scriptsCache = null;

    /** @type {Object} Cached deployments keyed by script scriptid */
    var _deploymentsCache = {};

    /** @type {string} Current search term */
    var _searchTerm = '';

    /** @type {string} Currently active tab ID */
    var _activeTab = 'all';

    /** @type {string|null} Currently expanded script scriptid */
    var _expandedScriptId = null;

    /** @type {boolean} Whether scripts are currently loading */
    var _isLoadingScripts = false;

    /** @type {Object} DOM element references */
    var _dom = {};

    // ────────────────────────────────────────────────────────────────
    // Service worker communication
    // ────────────────────────────────────────────────────────────────

    /**
     * Executes a SuiteQL query through the background service worker.
     * @param {string} query - The SuiteQL query string.
     * @returns {Promise<Object>} Response with columns, rows, count.
     */
    function _executeSuiteQL(query) {
        return new Promise(function (resolve, reject) {
            chrome.runtime.sendMessage(
                { action: 'executeSuiteQL', query: query },
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

    function _rowValue(row, keys, index) {
        if (!row) return '';
        if (Array.isArray(row)) return row[index];
        for (var i = 0; i < keys.length; i++) {
            if (Object.prototype.hasOwnProperty.call(row, keys[i])) {
                return row[keys[i]];
            }
        }
        return '';
    }

    function _normalizeType(value) {
        return String(value || '').trim().toUpperCase();
    }

    // ────────────────────────────────────────────────────────────────
    // Data fetching
    // ────────────────────────────────────────────────────────────────

    /**
     * Fetches all scripts from the account. Uses cache if available.
     * @returns {Promise<Array>}
     */
    function _fetchScripts() {
        if (_scriptsCache) {
            return Promise.resolve(_scriptsCache);
        }

        var query =
            "SELECT " +
            "s.id AS id, " +
            "s.name AS name, " +
            "s.scriptid AS scriptid, " +
            "s.scripttype AS scripttype, " +
            "s.description AS description " +
            "FROM script s " +
            "ORDER BY s.name";

        return _executeSuiteQL(query).then(function (response) {
            var scripts = [];
            if (response && response.rows) {
                for (var i = 0; i < response.rows.length; i++) {
                    var row = response.rows[i];
                    var id = _rowValue(row, ['id'], 0);
                    var scriptid = _rowValue(row, ['scriptid', 'script_id'], 2);
                    scripts.push({
                        id: id,
                        name: _rowValue(row, ['name'], 1),
                        scriptid: scriptid,
                        scripttype: _normalizeType(_rowValue(row, ['scripttype', 'script_type'], 3)),
                        description: _rowValue(row, ['description'], 4) || ''
                    });
                }
            }
            _scriptsCache = scripts;
            return scripts;
        });
    }

    /**
     * Fetches deployments for a given script. Uses cache if available.
     * @param {string} scriptId - The script's internal ID.
     * @param {string} scriptScriptId - The script's scriptid (e.g., customscript_xxx).
     * @returns {Promise<Array>}
     */
    function _fetchDeployments(scriptId, scriptScriptId) {
        if (_deploymentsCache[scriptScriptId]) {
            return Promise.resolve(_deploymentsCache[scriptScriptId]);
        }

        var query =
            "SELECT " +
            "sd.id AS id, " +
            "sd.scriptid AS scriptid, " +
            "sd.recordtype AS recordtype, " +
            "sd.status AS status, " +
            "sd.loglevel AS loglevel, " +
            "sd.isdeployed AS isdeployed " +
            "FROM scriptdeployment sd " +
            "WHERE sd.script = " + scriptId;

        return _executeSuiteQL(query).then(function (response) {
            var deployments = [];
            if (response && response.rows) {
                for (var i = 0; i < response.rows.length; i++) {
                    var row = response.rows[i];
                    deployments.push({
                        id: _rowValue(row, ['id'], 0),
                        scriptid: _rowValue(row, ['scriptid'], 1),
                        recordtype: _rowValue(row, ['recordtype'], 2) || '-',
                        status: _rowValue(row, ['status'], 3) || 'Unknown',
                        loglevel: _rowValue(row, ['loglevel'], 4) || 'DEBUG',
                        isdeployed: _rowValue(row, ['isdeployed'], 5)
                    });
                }
            }
            _deploymentsCache[scriptScriptId] = deployments;
            return deployments;
        });
    }

    /**
     * Counts deployments per script (batch query).
     * @param {Array} scripts - Array of script objects.
     * @returns {Promise<Object>} Map of script ID to deployment count.
     */
    function _fetchDeploymentCounts(scripts) {
        if (!scripts || scripts.length === 0) return Promise.resolve({});

        var query =
            "SELECT sd.script AS script, COUNT(*) AS cnt " +
            "FROM scriptdeployment sd " +
            "GROUP BY sd.script";

        return _executeSuiteQL(query).then(function (response) {
            var counts = {};
            if (response && response.rows) {
                for (var i = 0; i < response.rows.length; i++) {
                    var row = response.rows[i];
                    var scriptId = _rowValue(row, ['script'], 0);
                    counts[scriptId] = parseInt(_rowValue(row, ['cnt', 'count'], 1), 10) || 0;
                }
            }
            return counts;
        }).catch(function () {
            return {};
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Filtering
    // ────────────────────────────────────────────────────────────────

    /**
     * Filters scripts by active tab and search term.
     * @param {Array} scripts - All scripts.
     * @returns {Array} Filtered scripts.
     */
    function _filterScripts(scripts) {
        if (!scripts) return [];

        var tabDef = null;
        for (var t = 0; t < TABS.length; t++) {
            if (TABS[t].id === _activeTab) {
                tabDef = TABS[t];
                break;
            }
        }

        var filtered = scripts;

        // Filter by tab (script type)
        if (tabDef && tabDef.filter) {
            filtered = filtered.filter(function (s) {
                return s.scripttype === tabDef.filter;
            });
        }

        // Filter by search term
        if (_searchTerm) {
            var term = _searchTerm.toLowerCase();
            filtered = filtered.filter(function (s) {
                return (s.name && s.name.toLowerCase().indexOf(term) !== -1) ||
                       (s.scriptid && s.scriptid.toLowerCase().indexOf(term) !== -1) ||
                       (s.description && s.description.toLowerCase().indexOf(term) !== -1);
            });
        }

        return filtered;
    }

    // ────────────────────────────────────────────────────────────────
    // Rendering
    // ────────────────────────────────────────────────────────────────

    /**
     * Creates a DOM element with optional attributes and children.
     * Falls back to document.createElement if TactaDOM is not available.
     */
    function _el(tag, attrs, children) {
        if (window.TactaDOM && window.TactaDOM.createElement) {
            return window.TactaDOM.createElement(tag, attrs, children);
        }
        var el = document.createElement(tag);
        if (attrs) {
            var keys = Object.keys(attrs);
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                if (key === 'className') {
                    el.className = attrs[key];
                } else if (key === 'textContent') {
                    el.textContent = attrs[key];
                } else if (key === 'innerHTML') {
                    el.innerHTML = attrs[key];
                } else if (key === 'style' && typeof attrs[key] === 'object') {
                    var styleKeys = Object.keys(attrs[key]);
                    for (var s = 0; s < styleKeys.length; s++) {
                        el.style[styleKeys[s]] = attrs[key][styleKeys[s]];
                    }
                } else {
                    el.setAttribute(key, attrs[key]);
                }
            }
        }
        if (children) {
            for (var c = 0; c < children.length; c++) {
                if (typeof children[c] === 'string') {
                    el.appendChild(document.createTextNode(children[c]));
                } else if (children[c]) {
                    el.appendChild(children[c]);
                }
            }
        }
        return el;
    }

    /**
     * Renders the search input at the top of the panel body.
     */
    function _buildSearch() {
        var searchInput = _el('input', {
            className: 'tacta-input ' + SCOPE_CLASS + '-search',
            placeholder: 'Search scripts by name, ID, or description...',
            type: 'text'
        });

        searchInput.addEventListener('input', function () {
            _searchTerm = this.value;
            _renderScriptList();
        });

        _dom.searchInput = searchInput;
        return searchInput;
    }

    /**
     * Renders the tab bar.
     */
    function _buildTabBar() {
        var tabBar = _el('div', { className: SCOPE_CLASS + '-tab-bar' });

        for (var i = 0; i < TABS.length; i++) {
            (function (tab) {
                var tabBtn = _el('button', {
                    className: SCOPE_CLASS + '-tab' + (tab.id === _activeTab ? ' ' + SCOPE_CLASS + '-tab--active' : ''),
                    textContent: tab.label
                });
                tabBtn.setAttribute('data-tab', tab.id);
                tabBtn.addEventListener('click', function () {
                    _activeTab = tab.id;
                    _expandedScriptId = null;
                    _updateTabBar();
                    _renderScriptList();
                });
                tabBar.appendChild(tabBtn);
            })(TABS[i]);
        }

        _dom.tabBar = tabBar;
        return tabBar;
    }

    /**
     * Updates tab bar active state without rebuilding.
     */
    function _updateTabBar() {
        if (!_dom.tabBar) return;
        var tabs = _dom.tabBar.querySelectorAll('.' + SCOPE_CLASS + '-tab');
        for (var i = 0; i < tabs.length; i++) {
            var tabId = tabs[i].getAttribute('data-tab');
            if (tabId === _activeTab) {
                tabs[i].classList.add(SCOPE_CLASS + '-tab--active');
            } else {
                tabs[i].classList.remove(SCOPE_CLASS + '-tab--active');
            }
        }
    }

    /**
     * Renders the script list into the list container.
     */
    function _renderScriptList() {
        if (!_dom.listContainer) return;

        var filtered = _filterScripts(_scriptsCache);
        _dom.listContainer.innerHTML = '';

        // Update count display
        if (_dom.countDisplay) {
            var total = _scriptsCache ? _scriptsCache.length : 0;
            _dom.countDisplay.textContent = filtered.length + ' of ' + total + ' scripts';
        }

        if (filtered.length === 0) {
            _dom.listContainer.appendChild(
                _el('div', { className: SCOPE_CLASS + '-empty', textContent: 'No scripts found matching your criteria.' })
            );
            return;
        }

        for (var i = 0; i < filtered.length; i++) {
            _dom.listContainer.appendChild(_buildScriptCard(filtered[i]));
        }
    }

    /**
     * Builds a single script card element.
     * @param {Object} script - Script data object.
     * @returns {HTMLElement}
     */
    function _buildScriptCard(script) {
        var isExpanded = _expandedScriptId === script.scriptid;
        var badgeClass = TYPE_BADGE_CLASS[script.scripttype] || 'badge-other';
        var typeLabel = TYPE_LABELS[script.scripttype] || script.scripttype || 'Unknown';
        var deployCount = _dom.deploymentCounts ? (_dom.deploymentCounts[script.id] || 0) : 0;

        var card = _el('div', {
            className: SCOPE_CLASS + '-card' + (isExpanded ? ' ' + SCOPE_CLASS + '-card--expanded' : '')
        });

        // Card header (clickable to expand)
        var header = _el('div', { className: SCOPE_CLASS + '-card-header' });

        var headerLeft = _el('div', { className: SCOPE_CLASS + '-card-header-left' });

        var nameEl = _el('div', { className: SCOPE_CLASS + '-card-name', textContent: script.name || '(unnamed)' });
        var idEl = _el('div', { className: SCOPE_CLASS + '-card-id', textContent: script.scriptid || '' });
        nameEl.title = 'Click to open script record';
        nameEl.style.cursor = 'pointer';
        nameEl.addEventListener('click', function (e) {
            e.stopPropagation();
            if (script.id) {
                window.open('/app/common/scripting/script.nl?id=' + encodeURIComponent(script.id), '_blank');
            }
        });

        headerLeft.appendChild(nameEl);
        headerLeft.appendChild(idEl);

        var headerRight = _el('div', { className: SCOPE_CLASS + '-card-header-right' });

        var badge = _el('span', {
            className: SCOPE_CLASS + '-badge ' + SCOPE_CLASS + '-' + badgeClass,
            textContent: typeLabel
        });

        var deployBadge = _el('span', {
            className: SCOPE_CLASS + '-deploy-count',
            textContent: deployCount + ' deploy' + (deployCount !== 1 ? 's' : '')
        });

        headerRight.appendChild(badge);
        headerRight.appendChild(deployBadge);

        header.appendChild(headerLeft);
        header.appendChild(headerRight);

        // Expand chevron
        var chevron = _el('span', {
            className: SCOPE_CLASS + '-chevron' + (isExpanded ? ' ' + SCOPE_CLASS + '-chevron--open' : ''),
            innerHTML: '&#9656;'
        });
        header.insertBefore(chevron, headerLeft);

        header.addEventListener('click', function () {
            if (_expandedScriptId === script.scriptid) {
                _expandedScriptId = null;
                _renderScriptList();
            } else {
                _expandedScriptId = script.scriptid;
                _renderScriptList();
                _loadDeployments(script);
            }
        });

        card.appendChild(header);

        // Description (if present and expanded)
        if (isExpanded && script.description) {
            var descEl = _el('div', {
                className: SCOPE_CLASS + '-card-desc',
                textContent: script.description
            });
            card.appendChild(descEl);
        }

        // Deployments area (only if expanded)
        if (isExpanded) {
            var deploymentsArea = _el('div', {
                className: SCOPE_CLASS + '-deployments'
            });
            deploymentsArea.setAttribute('data-script', script.scriptid);

            if (_deploymentsCache[script.scriptid]) {
                _renderDeployments(deploymentsArea, script, _deploymentsCache[script.scriptid]);
            } else {
                deploymentsArea.appendChild(
                    _el('div', { className: SCOPE_CLASS + '-deploy-loading' }, [
                        _el('div', { className: 'tacta-spinner tacta-spinner--sm' }),
                        _el('span', { textContent: 'Loading deployments...' })
                    ])
                );
            }

            card.appendChild(deploymentsArea);
        }

        return card;
    }

    /**
     * Loads deployments for a script and renders them in place.
     * @param {Object} script - Script data object.
     */
    function _loadDeployments(script) {
        if (_deploymentsCache[script.scriptid]) return; // Already cached

        _fetchDeployments(script.id, script.scriptid).then(function (deployments) {
            // Update deployment count in our counts map
            if (_dom.deploymentCounts) {
                _dom.deploymentCounts[script.id] = deployments.length;
            }

            // Find the deployments area and render
            var area = _dom.listContainer
                ? _dom.listContainer.querySelector('[data-script="' + script.scriptid + '"]')
                : null;

            if (area) {
                area.innerHTML = '';
                _renderDeployments(area, script, deployments);
            }
        }).catch(function (err) {
            var area = _dom.listContainer
                ? _dom.listContainer.querySelector('[data-script="' + script.scriptid + '"]')
                : null;

            if (area) {
                area.innerHTML = '';
                area.appendChild(
                    _el('div', {
                        className: SCOPE_CLASS + '-deploy-error',
                        textContent: 'Failed to load deployments: ' + err.message
                    })
                );
            }
        });
    }

    /**
     * Renders deployment rows inside a container.
     * @param {HTMLElement} container - The deployments area element.
     * @param {Object} script - Parent script data.
     * @param {Array} deployments - Array of deployment objects.
     */
    function _renderDeployments(container, script, deployments) {
        if (deployments.length === 0) {
            container.appendChild(
                _el('div', {
                    className: SCOPE_CLASS + '-deploy-empty',
                    textContent: 'No deployments found for this script.'
                })
            );
            return;
        }

        // Deployment table header
        var headerRow = _el('div', { className: SCOPE_CLASS + '-deploy-row ' + SCOPE_CLASS + '-deploy-row--header' }, [
            _el('span', { className: SCOPE_CLASS + '-deploy-cell ' + SCOPE_CLASS + '-deploy-cell--id', textContent: 'Deployment ID' }),
            _el('span', { className: SCOPE_CLASS + '-deploy-cell ' + SCOPE_CLASS + '-deploy-cell--rec', textContent: 'Record Type' }),
            _el('span', { className: SCOPE_CLASS + '-deploy-cell ' + SCOPE_CLASS + '-deploy-cell--status', textContent: 'Status' }),
            _el('span', { className: SCOPE_CLASS + '-deploy-cell ' + SCOPE_CLASS + '-deploy-cell--log', textContent: 'Log Level' })
        ]);
        container.appendChild(headerRow);

        for (var i = 0; i < deployments.length; i++) {
            (function (dep) {
                var statusClass = _getStatusClass(dep.status);

                var row = _el('div', { className: SCOPE_CLASS + '-deploy-row' }, [
                    _el('span', {
                        className: SCOPE_CLASS + '-deploy-cell ' + SCOPE_CLASS + '-deploy-cell--id',
                        textContent: dep.scriptid || '-'
                    }),
                    _el('span', {
                        className: SCOPE_CLASS + '-deploy-cell ' + SCOPE_CLASS + '-deploy-cell--rec',
                        textContent: dep.recordtype
                    }),
                    _el('span', {
                        className: SCOPE_CLASS + '-deploy-cell ' + SCOPE_CLASS + '-deploy-cell--status'
                    }, [
                        _el('span', {
                            className: SCOPE_CLASS + '-status ' + SCOPE_CLASS + '-' + statusClass,
                            textContent: _formatStatus(dep.status)
                        })
                    ]),
                    _el('span', {
                        className: SCOPE_CLASS + '-deploy-cell ' + SCOPE_CLASS + '-deploy-cell--log',
                        textContent: dep.loglevel || '-'
                    })
                ]);

                // Click to open deployment record in new tab
                row.style.cursor = 'pointer';
                row.title = 'Click to open deployment record';
                row.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (dep.id) {
                        window.open('/app/common/scripting/scriptrecord.nl?id=' + encodeURIComponent(dep.id), '_blank');
                    }
                });

                container.appendChild(row);
            })(deployments[i]);
        }
    }

    /**
     * Returns a CSS class suffix for a deployment status.
     */
    function _getStatusClass(status) {
        if (!status) return 'status-unknown';
        var s = status.toUpperCase();
        if (s === 'RELEASED' || s === 'TESTING') return 'status-released';
        if (s === 'NOTSCHEDULED' || s === 'NOT SCHEDULED') return 'status-notscheduled';
        if (s === 'SCHEDULED') return 'status-scheduled';
        return 'status-unknown';
    }

    /**
     * Formats a status value for display.
     */
    function _formatStatus(status) {
        if (!status) return 'Unknown';
        var s = status.toUpperCase();
        if (s === 'RELEASED') return 'Released';
        if (s === 'TESTING') return 'Testing';
        if (s === 'NOTSCHEDULED' || s === 'NOT SCHEDULED') return 'Not Scheduled';
        if (s === 'SCHEDULED') return 'Scheduled';
        return status;
    }

    /**
     * Returns a numeric script type identifier for NS URLs.
     */
    function _getScriptTypeNum(scripttype) {
        var map = {
            'USEREVENT': 4,
            'CLIENT': 3,
            'SCHEDULED': 1,
            'MAPREDUCESCRIPT': 37,
            'SUITELET': 2,
            'RESTLET': 16
        };
        return map[scripttype] || 1;
    }

    // ────────────────────────────────────────────────────────────────
    // Panel lifecycle
    // ────────────────────────────────────────────────────────────────

    /**
     * Opens the Script Explorer panel, fetches scripts, and renders the UI.
     */
    function _openPanel() {
        if (!window.TactaDOM) {
            console.error('[Tacta Script Explorer] TactaDOM not available.');
            return;
        }

        // Create the panel
        _panelInstance = window.TactaDOM.createPanel({
            title: 'Script Explorer',
            width: PANEL_WIDTH,
            height: PANEL_HEIGHT,
            position: { top: '60px', right: '16px' },
            resizable: true,
            draggable: true,
            onClose: function () {
                _panelInstance = null;
                _expandedScriptId = null;
                _dom = {};
            }
        });

        // Add scope class to the panel
        _panelInstance.panel.classList.add(SCOPE_CLASS);

        // Set up body for flex layout
        _panelInstance.body.style.padding = '0';
        _panelInstance.body.style.display = 'flex';
        _panelInstance.body.style.flexDirection = 'column';
        _panelInstance.body.style.overflow = 'hidden';

        // ── Search bar ───────────────────────────────────────────
        var toolbar = _el('div', { className: SCOPE_CLASS + '-toolbar' });
        toolbar.appendChild(_buildSearch());

        // Count display
        var countDisplay = _el('div', { className: SCOPE_CLASS + '-count' });
        _dom.countDisplay = countDisplay;
        toolbar.appendChild(countDisplay);

        _panelInstance.body.appendChild(toolbar);

        // ── Tab bar ──────────────────────────────────────────────
        _panelInstance.body.appendChild(_buildTabBar());

        // ── Script list container ────────────────────────────────
        var listContainer = _el('div', { className: SCOPE_CLASS + '-list' });
        _dom.listContainer = listContainer;
        _panelInstance.body.appendChild(listContainer);

        // Show loading state
        listContainer.appendChild(
            _el('div', { className: SCOPE_CLASS + '-loading' }, [
                _el('div', { className: 'tacta-spinner' }),
                _el('div', { className: SCOPE_CLASS + '-loading-text', textContent: 'Fetching scripts...' })
            ])
        );

        // Fetch scripts and deployment counts, then render
        _isLoadingScripts = true;

        _fetchScripts().then(function (scripts) {
            return _fetchDeploymentCounts(scripts).then(function (counts) {
                _dom.deploymentCounts = counts;
                _isLoadingScripts = false;
                _renderScriptList();
            });
        }).catch(function (err) {
            _isLoadingScripts = false;
            if (_dom.listContainer) {
                _dom.listContainer.innerHTML = '';
                _dom.listContainer.appendChild(
                    _el('div', { className: SCOPE_CLASS + '-error' }, [
                        _el('div', { className: SCOPE_CLASS + '-error-icon', textContent: '!' }),
                        _el('div', {
                            className: SCOPE_CLASS + '-error-text',
                            textContent: 'Failed to load scripts: ' + err.message
                        }),
                        _el('button', {
                            className: 'tacta-btn tacta-btn-sm tacta-btn-primary',
                            textContent: 'Retry'
                        })
                    ])
                );
                // Retry button handler
                var retryBtn = _dom.listContainer.querySelector('.tacta-btn-primary');
                if (retryBtn) {
                    retryBtn.addEventListener('click', function () {
                        _scriptsCache = null;
                        _dom.listContainer.innerHTML = '';
                        _dom.listContainer.appendChild(
                            _el('div', { className: SCOPE_CLASS + '-loading' }, [
                                _el('div', { className: 'tacta-spinner' }),
                                _el('div', { className: SCOPE_CLASS + '-loading-text', textContent: 'Fetching scripts...' })
                            ])
                        );
                        _fetchScripts().then(function (scripts) {
                            return _fetchDeploymentCounts(scripts).then(function (counts) {
                                _dom.deploymentCounts = counts;
                                _renderScriptList();
                            });
                        }).catch(function (retryErr) {
                            _dom.listContainer.innerHTML = '';
                            _dom.listContainer.appendChild(
                                _el('div', {
                                    className: SCOPE_CLASS + '-error-text',
                                    textContent: 'Retry failed: ' + retryErr.message
                                })
                            );
                        });
                    });
                }
            }
        });
    }

    /**
     * Closes and destroys the panel.
     */
    function _closePanel() {
        if (_panelInstance) {
            _panelInstance.close();
            _panelInstance = null;
            _expandedScriptId = null;
            _dom = {};
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

    /**
     * Also listen for direct chrome.runtime messages (in case the router
     * is not loaded or the activation comes from the background script).
     */
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(function (message) {
            if (message.action === 'activateFeature' && message.featureId === FEATURE_ID) {
                _toggle();
            }
        });
    }

})();

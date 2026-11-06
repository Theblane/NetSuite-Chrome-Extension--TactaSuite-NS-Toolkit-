/**
 * script-analyzer.js
 * NetSuite TactaSuite — Script Analyzer (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Displays which SuiteScript deployments are active on the current record page
 * (User Event scripts, Client Scripts, Workflow Actions, etc.).
 *
 * Approach:
 *   1. Detect the current record type from __tactaPageInfo, the URL, or DOM.
 *   2. Send a SuiteQL query to the background service worker to look up all
 *      deployed scripts targeting that record type.
 *   3. Show a compact floating badge in the bottom-left corner with a script
 *      count. Clicking the badge expands a panel listing each script with
 *      name, type, deployment ID, and status.
 *   4. Clicking a script name opens its record in a new tab.
 *
 * Auto-activates on record-view, record-edit, and script-record pages.
 *
 * @fileoverview Content script for the Script Analyzer feature.
 */
(function () {
    'use strict';

    // Guard against double-init.
    if (window.__tactaScriptAnalyzerLoaded) return;
    window.__tactaScriptAnalyzerLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} Root element ID */
    var ROOT_ID = 'tacta-script-analyzer';

    /** @type {string} Source analysis card ID */
    var SOURCE_CARD_ID = 'tacta-script-analyzer-source';

    /** @type {number} Delay (ms) before querying — let the page settle */
    var INIT_DELAY = 800;

    /**
     * Map from NetSuite URL path segments to SuiteQL scriptdeployment
     * recordtype identifiers. NS uses internal string IDs in the
     * scriptdeployment.recordtype column, which don't always match the
     * URL path segment. This maps common URL filenames to the record
     * type string that NetSuite uses in the deployment record.
     *
     * For custom records, the recordtype column stores the custom
     * record script ID (e.g., 'customrecord_xxx').
     */
    var URL_SEGMENT_TO_RECORD_TYPE = {
        'salesord':       'salesorder',
        'salesorder':     'salesorder',
        'purchord':       'purchaseorder',
        'purchaseorder':  'purchaseorder',
        'estimate':       'estimate',
        'opprtnty':       'opportunity',
        'opportunity':    'opportunity',
        'invoice':        'invoice',
        'custinvc':       'invoice',
        'vendorbill':     'vendorbill',
        'vendbill':       'vendorbill',
        'vendpymt':       'vendorpayment',
        'vendorpayment':  'vendorpayment',
        'custpymt':       'customerpayment',
        'customerpayment':'customerpayment',
        'custdep':        'customerdeposit',
        'customerdeposit':'customerdeposit',
        'custcred':       'creditmemo',
        'creditmemo':     'creditmemo',
        'cashsale':       'cashsale',
        'cashrfnd':       'cashrefund',
        'cashrefund':     'cashrefund',
        'check':          'check',
        'deposit':        'deposit',
        'depappl':        'depositapplication',
        'depositapplication': 'depositapplication',
        'journal':        'journalentry',
        'journalentry':   'journalentry',
        'expensereport':  'expensereport',
        'exprept':        'expensereport',
        'transfer':       'transferorder',
        'transferorder':  'transferorder',
        'trnfrord':       'transferorder',
        'workord':        'workorder',
        'workorder':      'workorder',
        'returnauth':     'returnauthorization',
        'returnauthorization': 'returnauthorization',
        'rtnauth':        'returnauthorization',
        'itemrcpt':       'itemreceipt',
        'itemreceipt':    'itemreceipt',
        'itemship':       'itemfulfillment',
        'itemfulfillment':'itemfulfillment',
        'custrecordentry':'customrecord',
        'customer':       'customer',
        'prospect':       'prospect',
        'lead':           'lead',
        'vendor':         'vendor',
        'employee':       'employee',
        'partner':        'partner',
        'contact':        'contact',
        'invitem':        'inventoryitem',
        'inventoryitem':  'inventoryitem',
        'noninvtpart':    'noninventoryitem',
        'serializedinventoryitem': 'serializedinventoryitem',
        'lotnumberedinventoryitem': 'lotnumberedinventoryitem',
        'kititem':        'kititem',
        'assemblyitem':   'assemblyitem',
        'serviceitem':    'serviceitem',
        'otherchargeitem':'otherchargeitem',
        'discountitem':   'discountitem',
        'markupitem':     'markupitem',
        'paymentitem':    'paymentitem',
        'subtotalitem':   'subtotalitem',
        'descriptionitem':'descriptionitem',
        'giftcertificate':'giftcertificate'
    };

    /**
     * Map script type codes to human-readable labels and colors.
     * @type {Object<string, {label: string, colorClass: string}>}
     */
    var SCRIPT_TYPE_INFO = {
        'USEREVENT':        { label: 'User Event',       colorClass: 'sa-type--ue' },
        'CLIENT':           { label: 'Client Script',    colorClass: 'sa-type--cs' },
        'WORKFLOWACTIONSCRIPT': { label: 'WF Action',    colorClass: 'sa-type--wf' },
        'SCHEDULED':        { label: 'Scheduled',        colorClass: 'sa-type--sch' },
        'MAPREDUCESCRIPT':  { label: 'Map/Reduce',       colorClass: 'sa-type--mr' },
        'SUITELET':         { label: 'Suitelet',         colorClass: 'sa-type--sl' },
        'RESTLET':          { label: 'RESTlet',          colorClass: 'sa-type--rl' },
        'BUNDLEINSTALLATIONSCRIPT': { label: 'Bundle Install', colorClass: 'sa-type--bi' },
        'MASSUPDATESCRIPT': { label: 'Mass Update',      colorClass: 'sa-type--mu' },
        'PORTLET':          { label: 'Portlet',          colorClass: 'sa-type--pt' }
    };

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {HTMLElement|null} Root container */
    var _root = null;

    /** @type {boolean} Whether the panel is expanded */
    var _expanded = false;

    /** @type {Array|null} Cached script deployment results */
    var _scripts = null;

    /** @type {string|null} Detected record type */
    var _recordType = null;

    // ────────────────────────────────────────────────────────────────
    // Background messaging
    // ────────────────────────────────────────────────────────────────

    /**
     * Sends a message to the background service worker and returns a Promise.
     * @param {Object} payload - Must include `action`.
     * @returns {Promise<*>}
     */
    function _sendToBackground(payload) {
        return new Promise(function (resolve, reject) {
            chrome.runtime.sendMessage(payload, function (response) {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else if (response && response.error) {
                    reject(new Error(response.error));
                } else {
                    resolve(response);
                }
            });
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Record Type Detection
    // ────────────────────────────────────────────────────────────────

    /**
     * Detect the current record type using multiple strategies.
     * @returns {string|null}
     */
    function _detectRecordType() {
        // Strategy 1: Use __tactaPageInfo set by the router.
        var pageInfo = window.__tactaPageInfo;
        if (pageInfo && pageInfo.recordType) {
            return _normalizeRecordType(pageInfo.recordType);
        }

        // Strategy 2: Parse the URL.
        var url = window.location.href;
        var params = _parseQueryParams(url);

        // rectype / recordtype / type query params
        if (params.rectype) return _normalizeRecordType(params.rectype);
        if (params.recordtype) return _normalizeRecordType(params.recordtype);
        if (params.type) return _normalizeRecordType(params.type);

        // Path-based: /app/accounting/transactions/salesord.nl?id=123
        var pathMatch = url.match(/\/([a-z_]+)\.nl/i);
        if (pathMatch) {
            var segment = pathMatch[1].toLowerCase();
            if (URL_SEGMENT_TO_RECORD_TYPE[segment]) {
                return URL_SEGMENT_TO_RECORD_TYPE[segment];
            }
            // If it's a custom record entry page, look for rectype param
            if (segment === 'custrecordentry' && params.rectype) {
                return params.rectype;
            }
        }

        // Strategy 3: DOM hidden inputs.
        var typeInput = document.querySelector('input[name="type"], input[name="baserecordtype"], input[id="rectype"]');
        if (typeInput && typeInput.value) {
            return _normalizeRecordType(typeInput.value);
        }

        // Strategy 4: Use TactaNS utility if available.
        if (window.TactaNS && typeof window.TactaNS.getRecordType === 'function') {
            var tnrt = window.TactaNS.getRecordType();
            if (tnrt) return _normalizeRecordType(tnrt);
        }

        return null;
    }

    /**
     * Normalize a record type value: apply URL segment mapping, lowercase.
     * @param {string} raw
     * @returns {string}
     */
    function _normalizeRecordType(raw) {
        if (!raw) return null;
        var lower = raw.toLowerCase().trim();
        return URL_SEGMENT_TO_RECORD_TYPE[lower] || lower;
    }

    /**
     * Parse query params from a URL string.
     * @param {string} url
     * @returns {Object}
     */
    function _parseQueryParams(url) {
        var params = {};
        var qs = url.split('?')[1];
        if (!qs) return params;
        qs.split('#')[0].split('&').forEach(function (pair) {
            var parts = pair.split('=');
            var key = decodeURIComponent(parts[0]).toLowerCase();
            var val = parts[1] ? decodeURIComponent(parts[1]) : '';
            params[key] = val;
        });
        return params;
    }

    // ────────────────────────────────────────────────────────────────
    // SuiteQL Query
    // ────────────────────────────────────────────────────────────────

    /**
     * Query script deployments for the given record type via SuiteQL.
     * @param {string} recordType
     * @returns {Promise<Array>}
     */
    function _queryScriptDeployments(recordType) {
        // SuiteQL query to get deployed scripts for this record type.
        // The scriptdeployment.recordtype field holds the record type string.
        // We also check for deployments set to 'All Records' (recordtype IS NULL
        // in some cases) and for specific record type matches.
        var query =
            "SELECT " +
            "  sd.scriptid AS deployment_id, " +
            "  sd.title AS deployment_title, " +
            "  sd.status, " +
            "  sd.recordtype, " +
            "  sd.isdeployed, " +
            "  s.scriptid AS script_id, " +
            "  s.name AS script_name, " +
            "  s.scripttype AS script_type, " +
            "  s.id AS script_internal_id " +
            "FROM scriptdeployment sd " +
            "JOIN script s ON sd.script = s.id " +
            "WHERE sd.isdeployed = 'T' " +
            "  AND sd.recordtype = '" + _escapeSQL(recordType) + "' " +
            "ORDER BY s.scripttype, s.name";

        return _sendToBackground({ action: 'executeSuiteQL', query: query })
            .then(function (result) {
                // The executeSuiteQL handler returns the result directly as an
                // array of row objects, or wrapped in a result property.
                if (Array.isArray(result)) return result;
                if (result && Array.isArray(result.rows)) return result.rows;
                if (result && Array.isArray(result.items)) return result.items;
                if (result && Array.isArray(result.results)) return result.results;
                // The service worker returns [{ result: [...] }] structure
                // from chrome.scripting.executeScript
                return [];
            });
    }

    /**
     * Simple SQL string escaper to prevent injection in record type values.
     * @param {string} str
     * @returns {string}
     */
    function _escapeSQL(str) {
        if (!str) return '';
        return str.replace(/'/g, "''");
    }

    function _isSuiteQLUnavailableError(err) {
        var message = (err && err.message ? err.message : String(err || '')).toLowerCase();
        return message.indexOf('require() is not available') >= 0 ||
               message.indexOf('failed to load n/query') >= 0 ||
               message.indexOf('n/query') >= 0;
    }

    // ────────────────────────────────────────────────────────────────
    // DOM Construction
    // ────────────────────────────────────────────────────────────────

    /**
     * Builds the root container with the badge and panel.
     */
    function _buildUI() {
        // Remove any existing instance.
        var existing = document.getElementById(ROOT_ID);
        if (existing) existing.remove();

        _root = document.createElement('div');
        _root.id = ROOT_ID;
        _root.className = 'tacta-sa';

        // Restore saved position
        try {
            var saved = localStorage.getItem('tacta_sa_position');
            if (saved) {
                var pos = JSON.parse(saved);
                _root.style.left = pos.left;
                _root.style.top = pos.top;
                _root.style.bottom = 'auto';
                _root.style.right = 'auto';
            }
        } catch (_) {}

        // Badge
        var badge = document.createElement('div');
        badge.className = 'tacta-sa__badge';
        badge.title = 'Script Analyzer — drag to move, click to expand';
        badge.innerHTML = '<span class="tacta-sa__badge-icon">&#x2699;</span>' +
                          '<span class="tacta-sa__badge-text">...</span>';
        badge.style.cursor = 'grab';

        // Draggable badge
        var _isDragging = false;
        var _dragStartX = 0, _dragStartY = 0, _dragStartLeft = 0, _dragStartTop = 0;
        var _didDrag = false;

        badge.addEventListener('mousedown', function (e) {
            _isDragging = true;
            _didDrag = false;
            _dragStartX = e.clientX;
            _dragStartY = e.clientY;
            var rect = _root.getBoundingClientRect();
            _dragStartLeft = rect.left;
            _dragStartTop = rect.top;
            badge.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!_isDragging) return;
            var dx = e.clientX - _dragStartX;
            var dy = e.clientY - _dragStartY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) _didDrag = true;
            var newLeft = Math.max(0, Math.min(_dragStartLeft + dx, window.innerWidth - 60));
            var newTop = Math.max(0, Math.min(_dragStartTop + dy, window.innerHeight - 40));
            _root.style.left = newLeft + 'px';
            _root.style.top = newTop + 'px';
            _root.style.bottom = 'auto';
            _root.style.right = 'auto';
        });

        document.addEventListener('mouseup', function () {
            if (!_isDragging) return;
            _isDragging = false;
            badge.style.cursor = 'grab';
            // Save position
            if (_didDrag) {
                try { localStorage.setItem('tacta_sa_position', JSON.stringify({ left: _root.style.left, top: _root.style.top })); } catch (_) {}
            }
        });

        badge.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!_didDrag) _togglePanel();
        });
        _root.appendChild(badge);

        // Panel (hidden by default)
        var panel = document.createElement('div');
        panel.className = 'tacta-sa__panel';
        panel.innerHTML = '<div class="tacta-sa__panel-header">' +
                          '  <span class="tacta-sa__panel-title">Deployed Scripts</span>' +
                          '  <button class="tacta-sa__panel-close" title="Close">&#10005;</button>' +
                          '</div>' +
                          '<div class="tacta-sa__panel-body">' +
                          '  <div class="tacta-sa__loading"><div class="tacta-sa__spinner"></div> Loading...</div>' +
                          '</div>';
        panel.querySelector('.tacta-sa__panel-close').addEventListener('click', function (e) {
            e.stopPropagation();
            _collapsePanel();
        });
        _root.appendChild(panel);

        // Mount to Shadow DOM root if available, otherwise fallback to body
        if (window.TactaDOM && typeof window.TactaDOM.getToolkitRoot === 'function') {
            window.TactaDOM.getToolkitRoot().appendChild(_root);
        } else {
            document.body.appendChild(_root);
        }
    }

    /**
     * Updates the badge text with the script count.
     * @param {number} count
     */
    function _updateBadge(count) {
        if (!_root) return;
        var textEl = _root.querySelector('.tacta-sa__badge-text');
        if (!textEl) return;

        if (count === 0) {
            textEl.textContent = 'No Scripts';
        } else if (count === 1) {
            textEl.textContent = '1 Script';
        } else {
            textEl.textContent = count + ' Scripts';
        }
    }

    /**
     * Populates the panel body with the list of scripts.
     * @param {Array} scripts
     */
    function _renderScriptList(scripts) {
        if (!_root) return;
        var body = _root.querySelector('.tacta-sa__panel-body');
        if (!body) return;
        body.innerHTML = '';

        if (!scripts || scripts.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'tacta-sa__empty';
            empty.textContent = 'No deployed scripts found for this record type.';
            body.appendChild(empty);
            return;
        }

        // Add record type indicator
        if (_recordType) {
            var rtTag = document.createElement('div');
            rtTag.className = 'tacta-sa__record-type';
            rtTag.textContent = 'Record: ' + _recordType;
            body.appendChild(rtTag);
        }

        // Group by script type
        var groups = {};
        scripts.forEach(function (s) {
            var type = (s.script_type || s.scripttype || 'UNKNOWN').toUpperCase();
            if (!groups[type]) groups[type] = [];
            groups[type].push(s);
        });

        // Render each group
        var typeOrder = ['USEREVENT', 'CLIENT', 'WORKFLOWACTIONSCRIPT', 'SCHEDULED',
                         'MAPREDUCESCRIPT', 'SUITELET', 'RESTLET', 'BUNDLEINSTALLATIONSCRIPT',
                         'MASSUPDATESCRIPT', 'PORTLET'];
        var allTypes = typeOrder.concat(Object.keys(groups).filter(function (t) {
            return typeOrder.indexOf(t) === -1;
        }));

        allTypes.forEach(function (type) {
            if (!groups[type]) return;

            var typeInfo = SCRIPT_TYPE_INFO[type] || { label: type, colorClass: 'sa-type--other' };

            var section = document.createElement('div');
            section.className = 'tacta-sa__section';

            var sectionHeader = document.createElement('div');
            sectionHeader.className = 'tacta-sa__section-header';
            var typeBadge = document.createElement('span');
            typeBadge.className = 'tacta-sa__type-badge ' + typeInfo.colorClass;
            typeBadge.textContent = typeInfo.label;
            sectionHeader.appendChild(typeBadge);
            var countBadge = document.createElement('span');
            countBadge.className = 'tacta-sa__count';
            countBadge.textContent = groups[type].length;
            sectionHeader.appendChild(countBadge);
            section.appendChild(sectionHeader);

            groups[type].forEach(function (script) {
                var row = _buildScriptRow(script);
                section.appendChild(row);
            });

            body.appendChild(section);
        });
    }

    /**
     * Builds a single script row element.
     * @param {Object} script
     * @returns {HTMLElement}
     */
    function _buildScriptRow(script) {
        var row = document.createElement('div');
        row.className = 'tacta-sa__script-row';

        // Script name (clickable link)
        var nameLink = document.createElement('a');
        nameLink.className = 'tacta-sa__script-name';
        nameLink.textContent = script.script_name || script.name || script.script_id || 'Unnamed';
        nameLink.title = 'Open script record in new tab';
        nameLink.href = '#';
        nameLink.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var scriptInternalId = script.script_internal_id || script.scriptinternalid;
            if (scriptInternalId) {
                window.open('/app/common/scripting/script.nl?id=' + scriptInternalId, '_blank');
            }
        });
        row.appendChild(nameLink);

        // Details row
        var details = document.createElement('div');
        details.className = 'tacta-sa__script-details';

        // Deployment ID
        var deployId = script.deployment_id || script.deploymentid || '';
        if (deployId) {
            var deploySpan = document.createElement('span');
            deploySpan.className = 'tacta-sa__deploy-id';
            deploySpan.textContent = deployId;
            deploySpan.title = 'Deployment Script ID — click to copy';
            deploySpan.addEventListener('click', function (e) {
                e.stopPropagation();
                _copyToClipboard(deployId, deploySpan);
            });
            details.appendChild(deploySpan);
        }

        // Script ID
        var scriptId = script.script_id || script.scriptid || '';
        if (scriptId) {
            var scriptSpan = document.createElement('span');
            scriptSpan.className = 'tacta-sa__script-id';
            scriptSpan.textContent = scriptId;
            scriptSpan.title = 'Script ID — click to copy';
            scriptSpan.addEventListener('click', function (e) {
                e.stopPropagation();
                _copyToClipboard(scriptId, scriptSpan);
            });
            details.appendChild(scriptSpan);
        }

        // Status
        var status = script.status || '';
        if (status) {
            var statusSpan = document.createElement('span');
            var statusLower = status.toLowerCase();
            statusSpan.className = 'tacta-sa__status';
            if (statusLower === 'released' || statusLower === 'deployed') {
                statusSpan.classList.add('tacta-sa__status--active');
                statusSpan.textContent = 'Released';
            } else if (statusLower === 'testing') {
                statusSpan.classList.add('tacta-sa__status--testing');
                statusSpan.textContent = 'Testing';
            } else {
                statusSpan.classList.add('tacta-sa__status--other');
                statusSpan.textContent = status;
            }
            details.appendChild(statusSpan);
        }

        row.appendChild(details);
        return row;
    }

    /**
     * Renders an error state in the panel.
     * @param {string} message
     */
    function _renderError(message) {
        if (!_root) return;
        var body = _root.querySelector('.tacta-sa__panel-body');
        if (!body) return;
        body.innerHTML = '';

        var errorDiv = document.createElement('div');
        errorDiv.className = 'tacta-sa__error';
        errorDiv.textContent = message;
        body.appendChild(errorDiv);
    }

    // ────────────────────────────────────────────────────────────────
    // Panel Toggle
    // ────────────────────────────────────────────────────────────────

    /**
     * Toggle the panel open/closed.
     */
    function _togglePanel() {
        if (_expanded) {
            _collapsePanel();
        } else {
            _expandPanel();
        }
    }

    /**
     * Expand the panel.
     */
    function _expandPanel() {
        if (!_root) return;
        _expanded = true;
        _root.classList.add('tacta-sa--expanded');
    }

    /**
     * Collapse the panel.
     */
    function _collapsePanel() {
        if (!_root) return;
        _expanded = false;
        _root.classList.remove('tacta-sa--expanded');
    }

    // ────────────────────────────────────────────────────────────────
    // Clipboard
    // ────────────────────────────────────────────────────────────────

    /**
     * Copy text to clipboard with visual feedback.
     * @param {string} text
     * @param {HTMLElement} el
     */
    function _copyToClipboard(text, el) {
        navigator.clipboard.writeText(text).then(function () {
            var original = el.textContent;
            el.textContent = 'Copied!';
            el.classList.add('tacta-sa--copied');
            setTimeout(function () {
                el.textContent = original;
                el.classList.remove('tacta-sa--copied');
            }, 1200);
        }).catch(function () {
            // Fallback
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (_) {}
            document.body.removeChild(ta);
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Keyboard
    // ────────────────────────────────────────────────────────────────

    /**
     * Handle Escape key to close the panel.
     * @param {KeyboardEvent} e
     */
    function _onKeyDown(e) {
        if (e.key === 'Escape' && _expanded) {
            _collapsePanel();
            e.preventDefault();
        }
    }

    /**
     * Handle click outside the panel to close it.
     * @param {MouseEvent} e
     */
    function _onDocumentClick(e) {
        if (_expanded && _root && !_root.contains(e.target)) {
            _collapsePanel();
        }
    }

    function _isScriptRecordPage() {
        return /\/app\/common\/scripting\/script\.nl/i.test(window.location.href);
    }

    function _getCurrentScriptInternalId() {
        var params = _parseQueryParams(window.location.href);
        if (params.id && /^\d+$/.test(params.id)) return params.id;
        var idInput = document.querySelector('input[name="id"], input#id');
        if (idInput && /^\d+$/.test(idInput.value || '')) return idInput.value;
        return null;
    }

    function _normalizeSuiteQLRows(result) {
        if (Array.isArray(result)) return result;
        if (result && Array.isArray(result.rows)) return result.rows;
        if (result && Array.isArray(result.items)) return result.items;
        if (result && Array.isArray(result.results)) return result.results;
        return [];
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

    function _absoluteUrl(url) {
        if (!url) return '';
        return url.charAt(0) === '/' ? window.location.origin + url : url;
    }

    function _resolveScriptFileFromSuiteQL() {
        var scriptId = _getCurrentScriptInternalId();
        if (!scriptId) return Promise.resolve(null);

        var query = [
            "SELECT",
            "  s.scriptfile AS file_id,",
            "  f.name AS file_name,",
            "  f.url AS file_url",
            "FROM script s",
            "LEFT JOIN file f ON f.id = s.scriptfile",
            "WHERE s.id = " + scriptId
        ].join(' ');

        return _sendToBackground({ action: 'executeSuiteQL', query: query })
            .then(function (result) {
                var rows = _normalizeSuiteQLRows(result);
                if (!rows.length) return null;
                var row = rows[0];
                var fileId = _rowValue(row, ['file_id', 'scriptfile'], 0);
                var name = _rowValue(row, ['file_name', 'name', 'filename'], 1) || '';
                var url = _rowValue(row, ['file_url', 'url', 'fileurl'], 2);
                if (!url && fileId) {
                    url = '/app/common/media/mediaitem.nl?id=' + encodeURIComponent(fileId);
                }
                return {
                    id: fileId,
                    url: _absoluteUrl(url),
                    name: name
                };
            })
            .catch(function (e) {
                console.warn('[Tacta ScriptAnalyzer] Could not resolve script file via SuiteQL:', e);
                return null;
            });
    }

    function _findScriptFileFromDom() {
        var links = document.querySelectorAll('a[href*="/app/common/media/"], a[href*="/core/media/"], a[href*="mediaitem"]');
        for (var i = 0; i < links.length; i++) {
            var href = links[i].href || links[i].getAttribute('href') || '';
            var label = (links[i].textContent || href || '').toLowerCase();
            if (/\.(js|ts|ss)(?:\?|#|$)/i.test(href) || /\.(js|ts|ss)$/i.test(label)) {
                var idMatch = href.match(/[?&]id=(\d+)/);
                return {
                    id: idMatch ? idMatch[1] : '',
                    url: _absoluteUrl(href),
                    name: links[i].textContent || ''
                };
            }
        }
        return null;
    }

    function _resolveScriptFile() {
        return _resolveScriptFileFromSuiteQL().then(function (file) {
            return file || _findScriptFileFromDom();
        });
    }

    function _isNetSuiteHtml(source) {
        return /^\s*<!doctype html/i.test(source) || /^\s*<html[\s>]/i.test(source);
    }

    function _fetchText(url) {
        return fetch(url, { credentials: 'include', cache: 'no-store' }).then(function (res) {
            if (!res.ok) {
                var error = new Error('HTTP ' + res.status);
                error.status = res.status;
                error.url = url;
                throw error;
            }
            return res.text();
        });
    }

    function _extractDownloadUrlFromHtml(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var link = doc.querySelector('a[download][href*="/core/media/"], a[href*="/core/media/media.nl"]');
        if (!link) return '';
        return _absoluteUrl(link.getAttribute('href') || link.href || '');
    }

    function _fetchScriptSource(file) {
        if (!file || !file.url) return Promise.reject(new Error('Could not find the script file URL.'));

        return _fetchText(file.url).then(function (source) {
            if (!_isNetSuiteHtml(source)) {
                return { source: source, fileUrl: file.url };
            }

            var downloadUrl = _extractDownloadUrlFromHtml(source);
            if (!downloadUrl || downloadUrl === file.url) {
                throw new Error('Resolved file page did not expose downloadable source text.');
            }

            return _fetchText(downloadUrl).then(function (downloadSource) {
                return { source: downloadSource, fileUrl: downloadUrl };
            });
        }).catch(function (err) {
            if (err && (err.status === 403 || err.status === 500)) {
                throw new Error('NetSuite returned HTTP ' + err.status + ' for the script file' +
                    (file.id ? ' #' + file.id : '') +
                    '. The file may be locked or unavailable to the current role.');
            }
            throw err;
        });
    }

    function _pushUnique(list, value) {
        value = String(value || '').trim();
        if (value && list.indexOf(value) < 0) list.push(value);
    }

    function _analyzeScriptSource(source) {
        var modules = [], records = [], fields = [], files = [], searches = [], sublists = [], entryPoints = [], actions = [], risks = [];
        source.replace(/(?:define|require)\s*\(\s*\[([\s\S]*?)\]/g, function (_, deps) {
            deps.replace(/['"]([^'"]+)['"]/g, function (_m, dep) {
                _pushUnique(modules, dep);
            });
        });
        source.replace(/\b(beforeLoad|beforeSubmit|afterSubmit|pageInit|saveRecord|validateField|fieldChanged|postSourcing|lineInit|validateLine|validateInsert|validateDelete|sublistChanged|suitelet|onRequest|get|post|execute|summarize|map|reduce)\s*[:=]\s*function\b|\bfunction\s+(beforeLoad|beforeSubmit|afterSubmit|pageInit|saveRecord|validateField|fieldChanged|postSourcing|lineInit|validateLine|validateInsert|validateDelete|sublistChanged|onRequest|execute|summarize|map|reduce)\s*\(/g, function (_, a, b) {
            _pushUnique(entryPoints, a || b);
        });
        source.replace(/record\.Type\.([A-Z0-9_]+)|record\.(?:load|create|copy|transform|submitFields)\s*\(\s*\{[\s\S]*?type\s*:\s*['"]?([a-z0-9_]+)['"]?/gi, function (_, a, b) {
            var value = a || b;
            _pushUnique(records, value);
        });
        source.replace(/fieldId\s*:\s*['"]([^'"]+)['"]|(?:getValue|setValue|getText|setText|lookupFields|submitFields)\s*\(\s*(?:\{[\s\S]*?fieldId\s*:\s*)?['"]([^'"]+)['"]/g, function (_, a, b) {
            _pushUnique(fields, a || b);
        });
        source.replace(/sublistId\s*:\s*['"]([^'"]+)['"]|(?:selectLine|selectNewLine|commitLine|getSublistValue|setSublistValue|getCurrentSublistValue|setCurrentSublistValue)\s*\(\s*(?:\{[\s\S]*?sublistId\s*:\s*)?['"]([^'"]+)['"]/g, function (_, a, b) {
            _pushUnique(sublists, a || b);
        });
        source.replace(/file\.load\s*\(\s*(?:\{[\s\S]*?id\s*:\s*)?['"]?([^'"\}\),\s]+)['"]?/g, function (_, value) {
            _pushUnique(files, value);
        });
        source.replace(/search\.(?:load|create)\s*\(\s*(?:\{[\s\S]*?(?:id|type)\s*:\s*)?['"]([^'"]+)['"]/g, function (_, value) {
            _pushUnique(searches, value);
        });
        [
            { pattern: /record\.(?:create|copy|transform)\s*\(/, label: 'Creates or transforms records' },
            { pattern: /record\.(?:save|submitFields|delete)\s*\(/, label: 'Updates or deletes records' },
            { pattern: /search\.(?:load|create)\s*\(/, label: 'Loads or creates searches' },
            { pattern: /email\.send\s*\(/, label: 'Sends email' },
            { pattern: /https?\.(?:get|post|put|delete)\s*\(/, label: 'Calls external/internal HTTP endpoints' },
            { pattern: /task\.create\s*\(/, label: 'Starts background tasks' },
            { pattern: /redirect\./, label: 'Redirects the user' },
            { pattern: /runtime\.executionContext|runtime\.ContextType/, label: 'Branches by execution context' }
        ].forEach(function (rule) {
            if (rule.pattern.test(source)) _pushUnique(actions, rule.label);
        });
        if (fields.length > 40) risks.push('Large field surface area');
        if (/ignoreMandatoryFields\s*:\s*true/.test(source)) risks.push('Bypasses mandatory field validation');
        if (/governance|usage|yield/i.test(source)) risks.push('Contains governance handling');
        return {
            modules: modules,
            entryPoints: entryPoints,
            records: records,
            fields: fields,
            sublists: sublists,
            searches: searches,
            files: files,
            actions: actions,
            risks: risks
        };
    }

    function _renderAnalysisList(label, values, limit) {
        var list = values || [];
        var shown = list.slice(0, limit || 30);
        var suffix = list.length > shown.length ? ' +' + (list.length - shown.length) + ' more' : '';
        return '<div><strong>' + _escapeHtml(label) + ':</strong> ' + _escapeHtml(shown.join(', ') || '-') + _escapeHtml(suffix) + '</div>';
    }

    function _renderScriptRecordAnalysis() {
        if (document.getElementById(SOURCE_CARD_ID)) return;

        var title = document.querySelector('.uir-page-title') || document.querySelector('h1') || document.body.firstChild;
        var host = document.createElement('span');
        host.id = SOURCE_CARD_ID;
        host.className = 'tacta-sa__source-host';
        host.innerHTML =
            '<button type="button" class="tacta-sa__source-trigger" title="Show source analysis">Source Analysis</button>' +
            '<div class="tacta-sa__source-card" hidden>' +
            '  <div class="tacta-sa__source-title">Source Analysis</div>' +
            '  <div class="tacta-sa__source-body">Loading script file...</div>' +
            '</div>';

        if (title && title.parentNode) title.parentNode.insertBefore(host, title.nextSibling);
        else document.body.appendChild(host);

        var trigger = host.querySelector('.tacta-sa__source-trigger');
        var panel = host.querySelector('.tacta-sa__source-card');

        trigger.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var willOpen = panel.hidden;
            panel.hidden = !willOpen;
            trigger.classList.toggle('tacta-sa__source-trigger--active', willOpen);
            trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        });

        document.addEventListener('click', function (e) {
            if (!panel.hidden && !host.contains(e.target)) {
                panel.hidden = true;
                trigger.classList.remove('tacta-sa__source-trigger--active');
                trigger.setAttribute('aria-expanded', 'false');
            }
        });

        _resolveScriptFile()
            .then(function (file) {
                return _fetchScriptSource(file);
            })
            .then(function (result) {
                var source = result.source;
                var fileUrl = result.fileUrl;
                if (_isNetSuiteHtml(source)) {
                    throw new Error('Resolved link returned a NetSuite page instead of source text.');
                }
                var analysis = _analyzeScriptSource(source);
                panel.querySelector('.tacta-sa__source-body').innerHTML =
                    _renderAnalysisList('Entry points', analysis.entryPoints, 20) +
                    _renderAnalysisList('Modules', analysis.modules, 30) +
                    _renderAnalysisList('Records', analysis.records, 30) +
                    _renderAnalysisList('Fields', analysis.fields, 60) +
                    _renderAnalysisList('Sublists', analysis.sublists, 30) +
                    _renderAnalysisList('Searches', analysis.searches, 30) +
                    _renderAnalysisList('External files', analysis.files, 30) +
                    _renderAnalysisList('Activity notes', analysis.actions, 20) +
                    _renderAnalysisList('Risk notes', analysis.risks, 20) +
                    '<div><a href="' + _escapeHtml(fileUrl) + '" target="_blank" rel="noreferrer">Open script file</a></div>';
            })
            .catch(function (e) {
                panel.querySelector('.tacta-sa__source-body').textContent = 'Could not inspect source file: ' + (e.message || String(e));
            });
    }

    function _escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, function (ch) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Initialization
    // ────────────────────────────────────────────────────────────────

    /** Guard against multiple initialisations (router + feature-loader + auto). */
    var _inited = false;

    /**
     * Main initialization: detect record type, build UI, query scripts.
     */
    function init() {
        if (_inited) return;
        _inited = true;

        if (_isScriptRecordPage()) {
            _renderScriptRecordAnalysis();
        }

        // Detect record type.
        _recordType = _detectRecordType();

        if (!_recordType) {
            // Cannot determine record type — do not render.
            console.log('[Tacta ScriptAnalyzer] Could not detect record type. Skipping.');
            return;
        }

        console.log('[Tacta ScriptAnalyzer] Detected record type:', _recordType);

        // Build the floating badge and panel.
        _buildUI();

        // Set up keyboard and click-outside handlers.
        document.addEventListener('keydown', _onKeyDown, true);
        document.addEventListener('click', _onDocumentClick, true);

        // Query for script deployments.
        _queryScriptDeployments(_recordType)
            .then(function (scripts) {
                _scripts = scripts || [];
                _updateBadge(_scripts.length);
                _renderScriptList(_scripts);
                console.log('[Tacta ScriptAnalyzer] Found', _scripts.length, 'deployed scripts for', _recordType);
            })
            .catch(function (err) {
                if (_isSuiteQLUnavailableError(err)) {
                    console.log('[Tacta ScriptAnalyzer] SuiteQL is not available on this page. Skipping.');
                    if (_root) {
                        _root.remove();
                        _root = null;
                    }
                    return;
                }
                console.warn('[Tacta ScriptAnalyzer] SuiteQL query failed:', err.message);
                _updateBadge(0);
                _renderError('Failed to load scripts: ' + err.message);
            });
    }

    /**
     * Delayed init to give the page time to settle and __tactaPageInfo to populate.
     */
    function _delayedInit() {
        setTimeout(init, INIT_DELAY);
    }

    // Single activation path: router (or feature-loader) dispatches
    // `tacta:featureActivated` after injection. No auto-init — it caused
    // init() to run twice or three times when both loaders fired on the
    // same page.
    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === 'script-analyzer') {
            _delayedInit();
        }
    });

    console.log('[Tacta Toolkit] Script Analyzer feature loaded.');
})();

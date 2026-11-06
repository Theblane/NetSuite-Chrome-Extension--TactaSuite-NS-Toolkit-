/**
 * transaction-tree.js
 * NetSuite TactaSuite — Transaction Tree (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Visualizes the full transaction chain (e.g., SO -> IF -> INV -> Payment)
 * as an interactive tree on NetSuite record pages. Shows a clickable badge
 * near the record header that expands into a floating panel with the
 * complete transaction hierarchy.
 *
 * Data is fetched via SuiteQL through the background service worker
 * (chrome.runtime.sendMessage with action:'executeSuiteQL'). The chain
 * is walked recursively up to a configurable max depth.
 *
 * Runs in the ISOLATED world (content script) with no page-world access
 * needed — all NetSuite data access goes through the service worker.
 *
 * @fileoverview Transaction Tree content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaTransactionTreeLoaded) return;
    window.__tactaTransactionTreeLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {number} Maximum recursion depth for chain walking */
    var MAX_DEPTH = 5;

    /** @type {string} DOM ID for the badge element */
    var BADGE_ID = 'tacta-tt-badge';

    /** @type {string} DOM ID for the panel element */
    var PANEL_ID = 'tacta-tt-panel';

    /** @type {Object} Map of NetSuite internal type codes to display labels */
    var TYPE_LABELS = {
        'SalesOrd':   'SO',
        'ItemFulfil': 'IF',
        'CustInvc':   'INV',
        'CustPymt':   'PMT',
        'CustCred':   'CM',
        'PurchOrd':   'PO',
        'ItemRcpt':   'IR',
        'VendBill':   'BILL',
        'VendPymt':   'BP',
        'RtnAuth':    'RA',
        'Estimate':   'EST',
        'TrnfrOrd':   'TO',
        'WorkOrd':    'WO',
        'Journal':    'JE',
        'Deposit':    'DEP',
        'CashSale':   'CS',
        'CashRfnd':   'CR',
        'Check':      'CHK',
        'VendCred':   'VC',
        'InvTrnfr':   'IT',
        'BinTrnfr':   'BT',
        'InvAdjst':   'IA',
        'OpprtntyO':  'OPP',
        'CardChrg':   'CC',
        'CardRfnd':   'CCR',
        'InbShip':    'ISH'
    };

    /** @type {Object} Map of NetSuite internal type codes to full names */
    var TYPE_FULL_NAMES = {
        'SalesOrd':   'Sales Order',
        'ItemFulfil': 'Item Fulfillment',
        'CustInvc':   'Invoice',
        'CustPymt':   'Customer Payment',
        'CustCred':   'Credit Memo',
        'PurchOrd':   'Purchase Order',
        'ItemRcpt':   'Item Receipt',
        'VendBill':   'Vendor Bill',
        'VendPymt':   'Bill Payment',
        'RtnAuth':    'Return Authorization',
        'Estimate':   'Estimate',
        'TrnfrOrd':   'Transfer Order',
        'WorkOrd':    'Work Order',
        'Journal':    'Journal Entry',
        'Deposit':    'Deposit',
        'CashSale':   'Cash Sale',
        'CashRfnd':   'Cash Refund',
        'Check':      'Check',
        'VendCred':   'Vendor Credit',
        'InvTrnfr':   'Inventory Transfer',
        'BinTrnfr':   'Bin Transfer',
        'InvAdjst':   'Inventory Adjustment',
        'OpprtntyO':  'Opportunity',
        'CardChrg':   'Credit Card Charge',
        'CardRfnd':   'Credit Card Refund',
        'InbShip':    'Inbound Shipment'
    };

    /** @type {Object} Map status keywords to CSS modifier classes */
    var STATUS_CLASS_MAP = {
        'open':       'open',
        'pending':    'pending',
        'approved':   'approved',
        'fulfilled':  'fulfilled',
        'shipped':    'fulfilled',
        'paid':       'paid',
        'applied':    'applied',
        'deposited':  'deposited',
        'closed':     'closed',
        'voided':     'voided',
        'rejected':   'rejected',
        'cancelled':  'cancelled',
        'partially':  'partially',
        'billed':     'fulfilled',
        'received':   'fulfilled'
    };

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {number|null} The internal ID of the current transaction */
    var _currentId = null;

    /** @type {boolean} Whether the panel is currently open */
    var _panelOpen = false;

    /** @type {Object|null} Cached tree data */
    var _cachedTree = null;

    /** @type {Object} Cache of fetched transaction records by ID */
    var _transactionCache = {};

    // ────────────────────────────────────────────────────────────────
    // Background messaging
    // ────────────────────────────────────────────────────────────────

    /**
     * Send a message to the background service worker and return the response.
     * @param {Object} payload - Message payload (must include `action`).
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

    /**
     * Execute a SuiteQL query via the background service worker.
     * @param {string} sql - The SuiteQL query string.
     * @returns {Promise<Array<Object>>} Array of result row objects.
     */
    function _executeSuiteQL(sql) {
        return _sendToBackground({ action: 'executeSuiteQL', query: sql })
            .then(function (result) {
                return (result && result.rows) ? result.rows : [];
            });
    }

    // ────────────────────────────────────────────────────────────────
    // Transaction ID detection
    // ────────────────────────────────────────────────────────────────

    /**
     * Detect the current transaction's internal ID from the page.
     * Tries URL parameter first, then hidden form input.
     * @returns {number|null}
     */
    function _detectTransactionId() {
        // Try URL parameter
        var urlParams = new URLSearchParams(window.location.search);
        var idParam = urlParams.get('id');
        if (idParam && /^\d+$/.test(idParam)) {
            return parseInt(idParam, 10);
        }

        // Try hidden input
        var idInput = document.querySelector('input[name="id"]');
        if (idInput && idInput.value && /^\d+$/.test(idInput.value)) {
            return parseInt(idInput.value, 10);
        }

        return null;
    }

    /**
     * Check if the current page is a transaction record by looking at the URL.
     * @returns {boolean}
     */
    function _isTransactionPage() {
        var url = window.location.pathname.toLowerCase();
        return url.indexOf('/app/accounting/transactions/') !== -1;
    }

    // ────────────────────────────────────────────────────────────────
    // Data fetching — recursive chain walking
    // ────────────────────────────────────────────────────────────────

    /**
     * Fetch all directly linked transactions for a given transaction ID.
     * Returns both upstream (previous) and downstream (next) links.
     *
     * @param {number} transId - The transaction internal ID.
     * @returns {Promise<{prev: Array, next: Array}>}
     */
    function _fetchLinkedTransactions(transId) {
        var sql =
            'SELECT ' +
            '  ntll.previousdoc, ' +
            '  ntll.nextdoc, ' +
            '  t1.id AS prev_id, t1.tranid AS prev_tranid, t1.type AS prev_type, ' +
            '  t1.status AS prev_status, t1.trandate AS prev_trandate, ' +
            '  t1.entity AS prev_entity, ' +
            '  t2.id AS next_id, t2.tranid AS next_tranid, t2.type AS next_type, ' +
            '  t2.status AS next_status, t2.trandate AS next_trandate, ' +
            '  t2.entity AS next_entity ' +
            'FROM nexttransactionlinelink ntll ' +
            'JOIN transaction t1 ON ntll.previousdoc = t1.id ' +
            'JOIN transaction t2 ON ntll.nextdoc = t2.id ' +
            'WHERE ntll.previousdoc = ' + transId + ' OR ntll.nextdoc = ' + transId;

        // Inbound Shipments are linked to POs via inboundshipmentitemmember,
        // not nexttransactionlinelink. Walk that table from either side.
        // Use BUILTIN.DF(m.shipment) for the shipment display name (works
        // regardless of which columns inboundshipment exposes via SuiteQL).
        var inbSql =
            'SELECT DISTINCT ' +
            '  m.shipment, m.purchaseorder, ' +
            '  BUILTIN.DF(m.shipment) AS ship_tranid, ' +
            '  p.tranid AS po_tranid, p.type AS po_type, ' +
            '  p.status AS po_status, p.trandate AS po_trandate, ' +
            '  p.entity AS po_entity ' +
            'FROM inboundshipmentitemmember m ' +
            'LEFT JOIN transaction p ON m.purchaseorder = p.id ' +
            'WHERE m.shipment = ' + transId + ' OR m.purchaseorder = ' + transId;

        return Promise.all([
            _executeSuiteQL(sql),
            _executeSuiteQL(inbSql).catch(function (err) {
                console.warn('[TactaTT] inboundshipment link query failed:', err && err.message);
                return [];
            })
        ]).then(function (results) {
            var rows = results[0];
            var inbRows = results[1];
            var prevMap = {};
            var nextMap = {};

            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];

                // If this record is the previousdoc, the nextdoc is downstream
                if (Number(row.previousdoc) === transId && row.next_id) {
                    if (!nextMap[row.next_id]) {
                        nextMap[row.next_id] = {
                            id: row.next_id,
                            tranid: row.next_tranid,
                            type: row.next_type,
                            status: row.next_status,
                            trandate: row.next_trandate,
                            entity: row.next_entity
                        };
                    }
                }

                // If this record is the nextdoc, the previousdoc is upstream
                if (Number(row.nextdoc) === transId && row.prev_id) {
                    if (!prevMap[row.prev_id]) {
                        prevMap[row.prev_id] = {
                            id: row.prev_id,
                            tranid: row.prev_tranid,
                            type: row.prev_type,
                            status: row.prev_status,
                            trandate: row.prev_trandate,
                            entity: row.prev_entity
                        };
                    }
                }
            }

            // Inbound shipment <-> PO links. PO is upstream of the shipment.
            for (var k = 0; k < inbRows.length; k++) {
                var ir = inbRows[k];
                if (Number(ir.shipment) === transId && ir.purchaseorder) {
                    if (!prevMap[ir.purchaseorder]) {
                        prevMap[ir.purchaseorder] = {
                            id: ir.purchaseorder,
                            tranid: ir.po_tranid,
                            type: ir.po_type || 'PurchOrd',
                            status: ir.po_status,
                            trandate: ir.po_trandate,
                            entity: ir.po_entity
                        };
                    }
                } else if (Number(ir.purchaseorder) === transId && ir.shipment) {
                    if (!nextMap[ir.shipment]) {
                        nextMap[ir.shipment] = {
                            id: ir.shipment,
                            tranid: ir.ship_tranid,
                            type: 'InbShip',
                            status: null,
                            trandate: null,
                            entity: null
                        };
                    }
                }
            }

            var prevList = [];
            var nextList = [];
            var key;
            for (key in prevMap) { if (prevMap.hasOwnProperty(key)) prevList.push(prevMap[key]); }
            for (key in nextMap) { if (nextMap.hasOwnProperty(key)) nextList.push(nextMap[key]); }

            return { prev: prevList, next: nextList };
        });
    }

    /**
     * Fetch the current transaction's own details.
     * @param {number} transId
     * @returns {Promise<Object>}
     */
    function _fetchTransactionDetails(transId) {
        if (_transactionCache[transId]) {
            return Promise.resolve(_transactionCache[transId]);
        }

        var sql =
            'SELECT t.id, t.tranid, t.type, t.status, t.trandate, t.entity ' +
            'FROM transaction t ' +
            'WHERE t.id = ' + transId;

        return _executeSuiteQL(sql).then(function (rows) {
            if (rows.length > 0) {
                _transactionCache[transId] = rows[0];
                return rows[0];
            }
            // Inbound Shipments live in inboundshipment, not transaction.
            // Synthesize a transaction-shaped row. The SuiteQL projection on
            // inboundshipment is narrow (no `status` / `vendor` / etc. in many
            // accounts), so query only id + shipmentnumber and synthesize the
            // rest as null.
            var inbSql =
                'SELECT id, ' +
                '  shipmentnumber AS tranid, ' +
                "  'InbShip' AS type, " +
                '  NULL AS status, ' +
                '  NULL AS trandate, ' +
                '  NULL AS entity ' +
                'FROM inboundshipment ' +
                'WHERE id = ' + transId;
            return _executeSuiteQL(inbSql).then(function (inbRows) {
                if (inbRows.length > 0) {
                    _transactionCache[transId] = inbRows[0];
                    return inbRows[0];
                }
                return null;
            }).catch(function (err) {
                console.warn('[TactaTT] inboundshipment details query failed:', err && err.message);
                return null;
            });
        });
    }

    /**
     * Resolve entity name for display. Queries the entity table to get name.
     * Returns cached value if available.
     * @param {number} entityId
     * @returns {Promise<string>}
     */
    var _entityCache = {};
    function _resolveEntityName(entityId) {
        if (!entityId) return Promise.resolve('');
        if (_entityCache[entityId]) return Promise.resolve(_entityCache[entityId]);

        var sql =
            'SELECT entityid, companyname ' +
            'FROM entity ' +
            'WHERE id = ' + entityId;

        return _executeSuiteQL(sql).then(function (rows) {
            if (rows.length > 0) {
                var name = rows[0].companyname || rows[0].entityid || '';
                _entityCache[entityId] = name;
                return name;
            }
            _entityCache[entityId] = '';
            return '';
        }).catch(function () {
            _entityCache[entityId] = '';
            return '';
        });
    }

    /**
     * Build the full transaction tree by walking the chain recursively.
     * The tree is structured as a node with children arrays for upstream
     * and downstream directions.
     *
     * @param {number} startId - The starting transaction ID.
     * @returns {Promise<Object>} The tree root node.
     */
    function _buildTree(startId) {
        var visited = {};

        function walkDown(transId, depth) {
            if (depth > MAX_DEPTH || visited['d_' + transId]) {
                return Promise.resolve([]);
            }
            visited['d_' + transId] = true;

            return _fetchLinkedTransactions(transId).then(function (links) {
                var nextTrans = links.next;
                if (nextTrans.length === 0) return [];

                var childPromises = nextTrans.map(function (trans) {
                    _transactionCache[trans.id] = trans;
                    return walkDown(trans.id, depth + 1).then(function (children) {
                        return {
                            transaction: trans,
                            children: children,
                            direction: 'down'
                        };
                    });
                });

                return Promise.all(childPromises);
            });
        }

        function walkUp(transId, depth) {
            if (depth > MAX_DEPTH || visited['u_' + transId]) {
                return Promise.resolve([]);
            }
            visited['u_' + transId] = true;

            return _fetchLinkedTransactions(transId).then(function (links) {
                var prevTrans = links.prev;
                if (prevTrans.length === 0) return [];

                var parentPromises = prevTrans.map(function (trans) {
                    _transactionCache[trans.id] = trans;
                    return walkUp(trans.id, depth + 1).then(function (parents) {
                        return {
                            transaction: trans,
                            parents: parents,
                            direction: 'up'
                        };
                    });
                });

                return Promise.all(parentPromises);
            });
        }

        return _fetchTransactionDetails(startId).then(function (currentTrans) {
            if (!currentTrans) {
                return null;
            }

            return Promise.all([
                walkUp(startId, 0),
                walkDown(startId, 0)
            ]).then(function (results) {
                return {
                    transaction: currentTrans,
                    parents: results[0],
                    children: results[1],
                    isCurrent: true
                };
            });
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Rendering
    // ────────────────────────────────────────────────────────────────

    /**
     * Get the CSS class suffix for a transaction type.
     * @param {string} type - NetSuite internal type string.
     * @returns {string}
     */
    function _typeClass(type) {
        if (!type) return 'default';
        // Type may appear as "SalesOrd" or "salesord"
        for (var key in TYPE_LABELS) {
            if (TYPE_LABELS.hasOwnProperty(key) && key.toLowerCase() === type.toLowerCase()) {
                return key;
            }
        }
        return 'default';
    }

    /**
     * Get the short label for a transaction type.
     * @param {string} type
     * @returns {string}
     */
    function _typeLabel(type) {
        if (!type) return '??';
        for (var key in TYPE_LABELS) {
            if (TYPE_LABELS.hasOwnProperty(key) && key.toLowerCase() === type.toLowerCase()) {
                return TYPE_LABELS[key];
            }
        }
        return type.substring(0, 4).toUpperCase();
    }

    /**
     * Get the full name for a transaction type.
     * @param {string} type
     * @returns {string}
     */
    function _typeFullName(type) {
        if (!type) return 'Transaction';
        for (var key in TYPE_FULL_NAMES) {
            if (TYPE_FULL_NAMES.hasOwnProperty(key) && key.toLowerCase() === type.toLowerCase()) {
                return TYPE_FULL_NAMES[key];
            }
        }
        return type;
    }

    /**
     * Get the CSS modifier class for a status string.
     * @param {string} status - The full status string from NS.
     * @returns {string}
     */
    function _statusClass(status) {
        if (!status) return 'default';
        var lower = status.toLowerCase();
        for (var keyword in STATUS_CLASS_MAP) {
            if (STATUS_CLASS_MAP.hasOwnProperty(keyword) && lower.indexOf(keyword) !== -1) {
                return STATUS_CLASS_MAP[keyword];
            }
        }
        return 'default';
    }

    /**
     * Parse the status display text from the full NS status string.
     * NS returns statuses like "SalesOrd:B" (Pending Fulfillment) or
     * readable strings depending on the query.
     * @param {string} status
     * @returns {string}
     */
    function _statusDisplay(status) {
        if (!status) return '';
        // If it contains a colon, it's an internal code — just return as-is
        // The user will see the mapped class color regardless
        return status;
    }

    /**
     * Format a date string for display.
     * @param {string} dateStr
     * @returns {string}
     */
    function _formatDate(dateStr) {
        if (!dateStr) return '';
        // SuiteQL returns dates as "M/D/YYYY" or "YYYY-MM-DD"
        try {
            var d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
        } catch (e) {
            return dateStr;
        }
    }

    /**
     * Build the URL to navigate to a transaction record.
     * @param {Object} trans - Transaction object with id and type.
     * @returns {string}
     */
    function _buildTransactionUrl(trans) {
        // Use the generic record URL pattern that works for all transaction types
        var base = window.location.origin;
        var type = trans.type || '';

        // Map internal type to URL segment
        var urlTypeMap = {
            'SalesOrd':   'salesord',
            'ItemFulfil': 'itemfulfil',
            'CustInvc':   'custinvc',
            'CustPymt':   'custpymt',
            'CustCred':   'custcred',
            'PurchOrd':   'purchord',
            'ItemRcpt':   'itemrcpt',
            'VendBill':   'vendbill',
            'VendPymt':   'vendpymt',
            'RtnAuth':    'rtnauth',
            'Estimate':   'estimate',
            'TrnfrOrd':   'trnfrord',
            'WorkOrd':    'workord',
            'Journal':    'journal',
            'Deposit':    'deposit',
            'CashSale':   'cashsale',
            'CashRfnd':   'cashrefund',
            'Check':      'check',
            'VendCred':   'vendcred',
            'InvTrnfr':   'invtrnfr',
            'BinTrnfr':   'bintrnfr',
            'InvAdjst':   'invadjst',
            'CardChrg':   'cardchrg',
            'CardRfnd':   'cardrefund'
        };

        var urlType = null;
        for (var key in urlTypeMap) {
            if (urlTypeMap.hasOwnProperty(key) && key.toLowerCase() === type.toLowerCase()) {
                urlType = urlTypeMap[key];
                break;
            }
        }

        if (urlType) {
            return base + '/app/accounting/transactions/' + urlType + '.nl?id=' + trans.id;
        }

        // Fallback: use the generic transaction viewer
        return base + '/app/accounting/transactions/transaction.nl?id=' + trans.id;
    }

    /**
     * Create a single node card element.
     * @param {Object} trans - Transaction data object.
     * @param {boolean} isCurrent - Whether this is the current record.
     * @returns {HTMLElement}
     */
    function _createNodeCard(trans, isCurrent) {
        var card = document.createElement('a');
        card.className = 'tacta-tt-node-card' + (isCurrent ? ' tacta-tt-node-card--current' : '');
        card.title = _typeFullName(trans.type) + (trans.tranid ? ' ' + trans.tranid : '');

        if (!isCurrent) {
            card.href = _buildTransactionUrl(trans);
            card.target = '_blank';
            card.rel = 'noopener';
        }

        // Type badge
        var typeBadge = document.createElement('span');
        typeBadge.className = 'tacta-tt-type-badge tacta-tt-type--' + _typeClass(trans.type);
        typeBadge.textContent = _typeLabel(trans.type);
        card.appendChild(typeBadge);

        // Info section
        var info = document.createElement('div');
        info.className = 'tacta-tt-node-info';

        var tranidLine = document.createElement('div');
        tranidLine.className = 'tacta-tt-node-tranid';
        tranidLine.textContent = trans.tranid || ('ID: ' + trans.id);
        info.appendChild(tranidLine);

        var meta = document.createElement('div');
        meta.className = 'tacta-tt-node-meta';

        if (trans.trandate) {
            var dateSpan = document.createElement('span');
            dateSpan.textContent = _formatDate(trans.trandate);
            meta.appendChild(dateSpan);
        }

        info.appendChild(meta);
        card.appendChild(info);

        // Status badge
        if (trans.status) {
            var statusBadge = document.createElement('span');
            statusBadge.className = 'tacta-tt-status tacta-tt-status--' + _statusClass(trans.status);
            statusBadge.textContent = _statusDisplay(trans.status);
            card.appendChild(statusBadge);
        }

        // Current marker
        if (isCurrent) {
            var marker = document.createElement('span');
            marker.className = 'tacta-tt-current-marker';
            marker.title = 'Current record';
            card.appendChild(marker);
        }

        return card;
    }

    /**
     * Recursively render downstream children into a tree container.
     * @param {Array} children - Array of child node objects.
     * @param {HTMLElement} container - Parent container element.
     * @param {number} currentTransId - The current transaction's ID.
     */
    function _renderChildren(children, container, currentTransId) {
        if (!children || children.length === 0) return;

        var group = document.createElement('div');
        group.className = 'tacta-tt-node-group';

        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            var node = document.createElement('div');
            node.className = 'tacta-tt-node';
            node.appendChild(_createNodeCard(child.transaction, child.transaction.id === currentTransId));
            group.appendChild(node);

            if (child.children && child.children.length > 0) {
                _renderChildren(child.children, group, currentTransId);
            }
        }

        container.appendChild(group);
    }

    /**
     * Render upstream parents into a flat list (reversed chain order).
     * @param {Array} parents - Array of parent node objects.
     * @param {HTMLElement} container - Parent container element.
     * @param {number} currentTransId - The current transaction's ID.
     */
    function _renderParents(parents, container, currentTransId) {
        if (!parents || parents.length === 0) return;

        // Flatten the parent chain: walk up from each parent, collecting ancestors
        function flattenUp(parentNodes) {
            var flat = [];
            for (var i = 0; i < parentNodes.length; i++) {
                var p = parentNodes[i];
                // First render this parent's own parents (further upstream)
                if (p.parents && p.parents.length > 0) {
                    var upper = flattenUp(p.parents);
                    flat = flat.concat(upper);
                }
                flat.push(p);
            }
            return flat;
        }

        var flatParents = flattenUp(parents);

        // Deduplicate
        var seen = {};
        var unique = [];
        for (var i = 0; i < flatParents.length; i++) {
            if (!seen[flatParents[i].transaction.id]) {
                seen[flatParents[i].transaction.id] = true;
                unique.push(flatParents[i]);
            }
        }

        var group = document.createElement('div');
        group.className = 'tacta-tt-node-group';

        for (var j = 0; j < unique.length; j++) {
            var node = document.createElement('div');
            node.className = 'tacta-tt-node';
            node.appendChild(_createNodeCard(unique[j].transaction, unique[j].transaction.id === currentTransId));
            group.appendChild(node);
        }

        container.appendChild(group);
    }

    /**
     * Render the full tree into the panel body.
     * @param {Object} tree - The tree root node from _buildTree.
     * @param {HTMLElement} body - The panel body element.
     */
    function _renderTree(tree, body) {
        body.innerHTML = '';

        if (!tree) {
            body.innerHTML = '<div class="tacta-tt-empty">Could not load transaction data.</div>';
            return;
        }

        var hasParents = tree.parents && tree.parents.length > 0;
        var hasChildren = tree.children && tree.children.length > 0;

        if (!hasParents && !hasChildren) {
            // Just show the current node alone
            var soloTree = document.createElement('div');
            soloTree.className = 'tacta-tt-tree';
            var soloGroup = document.createElement('div');
            soloGroup.className = 'tacta-tt-node-group tacta-tt-node-group--root';
            var soloNode = document.createElement('div');
            soloNode.className = 'tacta-tt-node';
            soloNode.appendChild(_createNodeCard(tree.transaction, true));
            soloGroup.appendChild(soloNode);
            soloTree.appendChild(soloGroup);
            body.appendChild(soloTree);

            var emptyNote = document.createElement('div');
            emptyNote.className = 'tacta-tt-empty';
            emptyNote.textContent = 'No linked transactions found.';
            body.appendChild(emptyNote);
            return;
        }

        var treeEl = document.createElement('div');
        treeEl.className = 'tacta-tt-tree';

        // Render parents (upstream)
        if (hasParents) {
            var upLabel = document.createElement('div');
            upLabel.className = 'tacta-tt-direction-label';
            upLabel.textContent = 'Source';
            treeEl.appendChild(upLabel);

            _renderParents(tree.parents, treeEl, _currentId);
        }

        // Current node
        var currentGroup = document.createElement('div');
        currentGroup.className = 'tacta-tt-node-group tacta-tt-node-group--root';
        var currentNode = document.createElement('div');
        currentNode.className = 'tacta-tt-node';
        currentNode.appendChild(_createNodeCard(tree.transaction, true));
        currentGroup.appendChild(currentNode);
        treeEl.appendChild(currentGroup);

        // Render children (downstream)
        if (hasChildren) {
            var downLabel = document.createElement('div');
            downLabel.className = 'tacta-tt-direction-label';
            downLabel.textContent = 'Created From This';
            treeEl.appendChild(downLabel);

            _renderChildren(tree.children, treeEl, _currentId);
        }

        body.appendChild(treeEl);
    }

    /**
     * Count total transactions in the tree.
     * @param {Object} tree - The tree root node.
     * @returns {number}
     */
    function _countTreeNodes(tree) {
        if (!tree) return 0;
        var count = 1; // Current node

        function countChildren(children) {
            if (!children) return 0;
            var c = 0;
            for (var i = 0; i < children.length; i++) {
                c += 1;
                if (children[i].children) c += countChildren(children[i].children);
            }
            return c;
        }

        function countParents(parents) {
            if (!parents) return 0;
            var c = 0;
            for (var i = 0; i < parents.length; i++) {
                c += 1;
                if (parents[i].parents) c += countParents(parents[i].parents);
            }
            return c;
        }

        count += countChildren(tree.children);
        count += countParents(tree.parents);
        return count;
    }

    // ────────────────────────────────────────────────────────────────
    // Badge
    // ────────────────────────────────────────────────────────────────

    /**
     * Create or update the trigger badge.
     * @param {number} [linkedCount] - Number of linked transactions.
     */
    function _createBadge(linkedCount) {
        var existing = document.getElementById(BADGE_ID);
        if (existing) existing.remove();

        // The Transaction Trail strip shows the chain inline and carries a
        // "View chain" chip that opens this panel, so the floating bubble
        // would only duplicate it.
        if (window.__tactaTransactionTrailLoaded || document.getElementById('tacta-trail-strip')) return;

        var badge = document.createElement('div');
        badge.id = BADGE_ID;
        badge.className = 'tacta-tt-badge';
        badge.title = 'View Transaction Chain';

        var icon = document.createElement('span');
        icon.className = 'tacta-tt-badge-icon';
        icon.textContent = '\u{1F517}'; // Link chain emoji as fallback
        icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 3 6 17"></polyline><path d="M6 8h10a4 4 0 0 1 0 8H6"></path><polyline points="6 12 16 12"></polyline><circle cx="6" cy="3" r="2"></circle><circle cx="6" cy="17" r="2"></circle><circle cx="20" cy="12" r="2"></circle></svg>';
        badge.appendChild(icon);

        var label = document.createElement('span');
        label.textContent = 'Chain';
        badge.appendChild(label);

        if (linkedCount && linkedCount > 0) {
            var countBadge = document.createElement('span');
            countBadge.className = 'tacta-tt-badge-count';
            countBadge.textContent = String(linkedCount);
            badge.appendChild(countBadge);
        }

        badge.addEventListener('click', function () {
            if (_panelOpen) {
                _closePanel();
            } else {
                _openPanel();
            }
        });

        document.body.appendChild(badge);
    }

    // ────────────────────────────────────────────────────────────────
    // Panel
    // ────────────────────────────────────────────────────────────────

    /**
     * Open the transaction tree panel.
     */
    function _openPanel() {
        if (_panelOpen) return;
        _panelOpen = true;

        // Hide badge
        var badge = document.getElementById(BADGE_ID);
        if (badge) badge.style.display = 'none';

        var panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'tacta-tt-panel tacta-toolkit';

        // Header
        var header = document.createElement('div');
        header.className = 'tacta-tt-panel-header';

        var title = document.createElement('div');
        title.className = 'tacta-tt-panel-title';
        title.innerHTML = '<span class="tacta-tt-panel-title-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 3 6 17"></polyline><path d="M6 8h10a4 4 0 0 1 0 8H6"></path><circle cx="6" cy="3" r="2"></circle><circle cx="6" cy="17" r="2"></circle><circle cx="20" cy="12" r="2"></circle></svg></span>Transaction Chain';
        header.appendChild(title);

        var closeBtn = document.createElement('button');
        closeBtn.className = 'tacta-tt-panel-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', _closePanel);
        header.appendChild(closeBtn);

        panel.appendChild(header);

        // Body
        var body = document.createElement('div');
        body.className = 'tacta-tt-panel-body';
        body.innerHTML = '<div class="tacta-tt-loading"><div class="tacta-tt-spinner"></div><span>Loading transaction chain...</span></div>';
        panel.appendChild(body);

        // Footer
        var footer = document.createElement('div');
        footer.className = 'tacta-tt-panel-footer';

        var footerInfo = document.createElement('span');
        footerInfo.className = 'tacta-tt-footer-info';
        footerInfo.textContent = 'Max depth: ' + MAX_DEPTH;
        footer.appendChild(footerInfo);

        var refreshBtn = document.createElement('button');
        refreshBtn.className = 'tacta-tt-refresh-btn';
        refreshBtn.innerHTML = '&#x21BB; Refresh';
        refreshBtn.addEventListener('click', function () {
            _cachedTree = null;
            _transactionCache = {};
            _entityCache = {};
            body.innerHTML = '<div class="tacta-tt-loading"><div class="tacta-tt-spinner"></div><span>Refreshing...</span></div>';
            _loadAndRenderTree(body, footerInfo);
        });
        footer.appendChild(refreshBtn);

        panel.appendChild(footer);

        document.body.appendChild(panel);

        // Load data
        if (_cachedTree) {
            _renderTree(_cachedTree, body);
            var nodeCount = _countTreeNodes(_cachedTree);
            footerInfo.textContent = nodeCount + ' transaction' + (nodeCount !== 1 ? 's' : '') + ' in chain';
        } else {
            _loadAndRenderTree(body, footerInfo);
        }
    }

    /**
     * Load tree data and render into the panel body.
     * @param {HTMLElement} body
     * @param {HTMLElement} footerInfo
     */
    function _loadAndRenderTree(body, footerInfo) {
        _buildTree(_currentId).then(function (tree) {
            _cachedTree = tree;
            _renderTree(tree, body);

            var nodeCount = _countTreeNodes(tree);
            footerInfo.textContent = nodeCount + ' transaction' + (nodeCount !== 1 ? 's' : '') + ' in chain';

            // Update badge count
            var linkedCount = nodeCount > 1 ? nodeCount - 1 : 0;
            _createBadge(linkedCount);
            var badge = document.getElementById(BADGE_ID);
            if (badge) badge.style.display = 'none'; // Keep hidden while panel is open
        }).catch(function (err) {
            body.innerHTML =
                '<div class="tacta-tt-error">' +
                '<span class="tacta-tt-error-icon">&#x26A0;</span>' +
                '<span>' + _escapeHtml(err.message || 'Failed to load transaction chain.') + '</span>' +
                '</div>';
            footerInfo.textContent = 'Error loading chain';
        });
    }

    /**
     * Close the panel and show the badge again.
     */
    function _closePanel() {
        _panelOpen = false;
        var panel = document.getElementById(PANEL_ID);
        if (panel) panel.remove();

        var badge = document.getElementById(BADGE_ID);
        if (badge) badge.style.display = '';
    }

    /**
     * Simple HTML escaping for error messages.
     * @param {string} str
     * @returns {string}
     */
    function _escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    // ────────────────────────────────────────────────────────────────
    // Initialization
    // ────────────────────────────────────────────────────────────────

    /**
     * Main initialization. Detects if we're on a transaction page and
     * sets up the badge trigger.
     */
    // Opened from the Transaction Trail strip's "View chain" chip.
    window.addEventListener('tacta:transactionTree:open', function () {
        if (_panelOpen) { _closePanel(); } else { _openPanel(); }
    });
    // If the trail renders after our bubble appeared, drop the bubble.
    window.addEventListener('tacta:trail:rendered', function () {
        var b = document.getElementById(BADGE_ID);
        if (b) b.remove();
    });

    function _init() {
        if (!_isTransactionPage()) return;

        _currentId = _detectTransactionId();
        if (!_currentId) return;

        // Show the badge immediately, then do a quick check for linked transactions
        _createBadge(null);

        // Quick pre-fetch to get linked count for the badge
        var countSql =
            'SELECT COUNT(DISTINCT CASE WHEN ntll.previousdoc = ' + _currentId +
            ' THEN ntll.nextdoc ELSE ntll.previousdoc END) AS linked_count ' +
            'FROM nexttransactionlinelink ntll ' +
            'WHERE ntll.previousdoc = ' + _currentId + ' OR ntll.nextdoc = ' + _currentId;

        var inbCountSql =
            'SELECT COUNT(DISTINCT CASE WHEN m.shipment = ' + _currentId +
            ' THEN m.purchaseorder ELSE m.shipment END) AS linked_count ' +
            'FROM inboundshipmentitemmember m ' +
            'WHERE m.shipment = ' + _currentId + ' OR m.purchaseorder = ' + _currentId;

        Promise.all([
            _executeSuiteQL(countSql).catch(function () { return []; }),
            _executeSuiteQL(inbCountSql).catch(function () { return []; })
        ]).then(function (results) {
            var count = 0;
            if (results[0].length > 0 && results[0][0].linked_count) {
                count += parseInt(results[0][0].linked_count, 10) || 0;
            }
            if (results[1].length > 0 && results[1][0].linked_count) {
                count += parseInt(results[1][0].linked_count, 10) || 0;
            }
            _createBadge(count);
        });
    }

    // Run after a short delay to ensure the page is fully loaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(_init, 300);
        });
    } else {
        setTimeout(_init, 300);
    }

})();

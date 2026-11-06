/**
 * transaction-trail.js
 * NetSuite TactaSuite - Transaction Trail (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Renders a breadcrumb strip of chips just under the page title on
 * transaction pages showing the linear document chain through the current
 * transaction (e.g. EST > SO > IF > INV > PMT). Walks nexttransactionlinelink
 * up to 4 hops upstream and 4 hops downstream via SuiteQL, de-duplicates,
 * and orders the result chronologically.
 *
 * Each chip is a link to the transaction. Hovering shows type, date, status
 * and amount. When more than 7 documents are found, the middle is collapsed
 * into "+N" chips that expand on click.
 *
 * Uses the same tables/columns as transaction-tree (nexttransactionlinelink
 * joined to transaction). All data access goes through the background
 * service worker (chrome.runtime.sendMessage action 'executeSuiteQL').
 *
 * @fileoverview Transaction Trail content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaTransactionTrailLoaded) return;
    window.__tactaTransactionTrailLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} DOM ID of the strip */
    var STRIP_ID = 'tacta-trail-strip';

    /** @type {string} CSS class scope */
    var SC = 'tacta-trail';

    /** @type {number} Max hops walked in each direction */
    var MAX_HOPS = 4;

    /** @type {number} Max ids per hop (keeps the IN list bounded) */
    var MAX_FRONTIER = 25;

    /** @type {number} Chips shown before collapsing the middle */
    var COLLAPSE_THRESHOLD = 7;

    /** @type {Object} NetSuite type codes to short labels (same set as transaction-tree) */
    var TYPE_LABELS = {
        'SalesOrd': 'SO', 'ItemFulfil': 'IF', 'CustInvc': 'INV', 'CustPymt': 'PMT',
        'CustCred': 'CM', 'PurchOrd': 'PO', 'ItemRcpt': 'IR', 'VendBill': 'BILL',
        'VendPymt': 'BP', 'RtnAuth': 'RA', 'Estimate': 'EST', 'TrnfrOrd': 'TO',
        'WorkOrd': 'WO', 'Journal': 'JE', 'Deposit': 'DEP', 'CashSale': 'CS',
        'CashRfnd': 'CR', 'Check': 'CHK', 'VendCred': 'VC', 'InvTrnfr': 'IT',
        'BinTrnfr': 'BT', 'InvAdjst': 'IA', 'OpprtntyO': 'OPP', 'CardChrg': 'CC',
        'CardRfnd': 'CCR', 'InbShip': 'ISH', 'VendAuth': 'VRA', 'CustDep': 'CD',
        'DepAppl': 'DA', 'CustRfnd': 'RFD', 'WOIssue': 'WOI', 'WOCompl': 'WOC',
        'WOClose': 'WOX', 'PurchReq': 'PR', 'VPrep': 'VP', 'VPrepApp': 'VPA'
    };

    /** @type {Object} NetSuite type codes to full names */
    var TYPE_FULL_NAMES = {
        'SalesOrd': 'Sales Order', 'ItemFulfil': 'Item Fulfillment', 'CustInvc': 'Invoice',
        'CustPymt': 'Customer Payment', 'CustCred': 'Credit Memo', 'PurchOrd': 'Purchase Order',
        'ItemRcpt': 'Item Receipt', 'VendBill': 'Vendor Bill', 'VendPymt': 'Bill Payment',
        'RtnAuth': 'Return Authorization', 'Estimate': 'Estimate', 'TrnfrOrd': 'Transfer Order',
        'WorkOrd': 'Work Order', 'Journal': 'Journal Entry', 'Deposit': 'Deposit',
        'CashSale': 'Cash Sale', 'CashRfnd': 'Cash Refund', 'Check': 'Check',
        'VendCred': 'Vendor Credit', 'InvTrnfr': 'Inventory Transfer', 'BinTrnfr': 'Bin Transfer',
        'InvAdjst': 'Inventory Adjustment', 'OpprtntyO': 'Opportunity', 'CardChrg': 'Credit Card Charge',
        'CardRfnd': 'Credit Card Refund', 'InbShip': 'Inbound Shipment', 'VendAuth': 'Vendor Return Authorization',
        'CustDep': 'Customer Deposit', 'DepAppl': 'Deposit Application', 'CustRfnd': 'Customer Refund',
        'WOIssue': 'Work Order Issue', 'WOCompl': 'Work Order Completion', 'WOClose': 'Work Order Close',
        'PurchReq': 'Purchase Requisition', 'VPrep': 'Vendor Prepayment', 'VPrepApp': 'Vendor Prepayment Application'
    };

    /** @type {Object<string, Object>} id -> node */
    var _nodes = {};

    /** @type {number} Current transaction internal id */
    var _currentId = 0;

    /** @type {boolean} Whether the collapsed middle has been expanded */
    var _expanded = false;

    // ────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────

    function sendMessage(payload) {
        return new Promise(function (resolve, reject) {
            try {
                chrome.runtime.sendMessage(payload, function (response) {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else if (response && response.error) {
                        reject(new Error(response.error));
                    } else {
                        resolve(response);
                    }
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    function runSuiteQL(query) {
        return sendMessage({ action: 'executeSuiteQL', query: query }).then(function (result) {
            return (result && result.rows) ? result.rows : [];
        });
    }

    function isTransactionPage() {
        return /\/app\/accounting\/transactions\//i.test(window.location.pathname);
    }

    function getRecordId() {
        var m = window.location.search.match(/[?&]id=(\d+)/);
        return m ? parseInt(m[1], 10) : 0;
    }

    function typeLabel(type) {
        return TYPE_LABELS[type] || (type ? String(type).toUpperCase().slice(0, 4) : '?');
    }

    function typeFullName(type) {
        return TYPE_FULL_NAMES[type] || type || 'Transaction';
    }

    /**
     * SuiteQL dates arrive as "M/D/YYYY" or "YYYY-MM-DD". Returns epoch ms
     * or 0 when unparseable.
     */
    function dateValue(str) {
        if (!str) return 0;
        var d = new Date(str);
        return isNaN(d.getTime()) ? 0 : d.getTime();
    }

    function formatDate(str) {
        var v = dateValue(str);
        if (!v) return str || '';
        var d = new Date(v);
        return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
    }

    function formatAmount(val) {
        if (val === null || val === undefined || val === '') return '';
        var n = Number(val);
        if (isNaN(n)) return String(val);
        return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    /**
     * Prefer the display status; otherwise strip the "SalesOrd:" prefix from
     * the raw status code.
     */
    function statusDisplay(node) {
        if (node.statusText) return node.statusText;
        if (!node.status) return '';
        var s = String(node.status);
        var idx = s.indexOf(':');
        return idx >= 0 ? s.slice(idx + 1) : s;
    }

    function transactionUrl(id) {
        return '/app/accounting/transactions/transaction.nl?id=' + id;
    }

    // ────────────────────────────────────────────────────────────────
    // Data: walk the chain
    // ────────────────────────────────────────────────────────────────

    /**
     * Build the per-hop query. Direction 'up' finds previousdoc for the given
     * nextdoc ids; 'down' finds nextdoc for the given previousdoc ids.
     * @param {number[]} ids
     * @param {string} direction
     * @param {boolean} withDf  Include BUILTIN.DF(t.status) for display text.
     */
    function hopQuery(ids, direction, withDf) {
        var joinCol = direction === 'up' ? 'ntll.previousdoc' : 'ntll.nextdoc';
        var whereCol = direction === 'up' ? 'ntll.nextdoc' : 'ntll.previousdoc';
        return 'SELECT DISTINCT t.id, t.tranid, t.type, t.status, ' +
            (withDf ? 'BUILTIN.DF(t.status) AS status_text, ' : '') +
            't.trandate, t.foreigntotal ' +
            'FROM nexttransactionlinelink ntll ' +
            'JOIN transaction t ON t.id = ' + joinCol + ' ' +
            'WHERE ' + whereCol + ' IN (' + ids.join(',') + ')';
    }

    function currentQuery(id, withDf) {
        return 'SELECT t.id, t.tranid, t.type, t.status, ' +
            (withDf ? 'BUILTIN.DF(t.status) AS status_text, ' : '') +
            't.trandate, t.foreigntotal ' +
            'FROM transaction t WHERE t.id = ' + id;
    }

    /**
     * Run a query, retrying without BUILTIN.DF if the first attempt fails.
     */
    function runWithFallback(buildQuery) {
        return runSuiteQL(buildQuery(true)).catch(function () {
            return runSuiteQL(buildQuery(false));
        });
    }

    function addNode(row, rank) {
        var id = Number(row.id);
        if (!id) return false;
        if (_nodes[id]) return false;
        _nodes[id] = {
            id: id,
            tranid: row.tranid || ('#' + id),
            type: row.type || '',
            status: row.status || '',
            statusText: row.status_text || '',
            trandate: row.trandate || '',
            amount: row.foreigntotal,
            rank: rank
        };
        return true;
    }

    /**
     * Walk one direction up to MAX_HOPS. Resolves when done.
     * @param {string} direction 'up' | 'down'
     */
    function walk(direction) {
        var frontier = [_currentId];
        var hop = 0;

        function step() {
            if (hop >= MAX_HOPS || frontier.length === 0) return Promise.resolve();
            hop++;
            var ids = frontier.slice(0, MAX_FRONTIER);
            return runWithFallback(function (df) { return hopQuery(ids, direction, df); })
                .then(function (rows) {
                    var next = [];
                    rows.forEach(function (row) {
                        var rank = direction === 'up' ? -hop : hop;
                        if (addNode(row, rank)) next.push(Number(row.id));
                    });
                    frontier = next;
                    return step();
                })
                .catch(function () { /* stop walking this direction */ });
        }
        return step();
    }

    function loadChain() {
        return runWithFallback(function (df) { return currentQuery(_currentId, df); })
            .then(function (rows) {
                if (!rows.length) throw new Error('Transaction not found');
                addNode(rows[0], 0);
                return Promise.all([walk('up'), walk('down')]);
            })
            .then(function () {
                var list = Object.keys(_nodes).map(function (k) { return _nodes[k]; });
                list.sort(function (a, b) {
                    var da = dateValue(a.trandate), db = dateValue(b.trandate);
                    if (da !== db) return da - db;
                    if (a.rank !== b.rank) return a.rank - b.rank;
                    return a.id - b.id;
                });
                return list;
            });
    }

    // ────────────────────────────────────────────────────────────────
    // Render
    // ────────────────────────────────────────────────────────────────

    function buildTooltip(node) {
        var lines = [typeFullName(node.type) + ' ' + node.tranid];
        if (node.trandate) lines.push('Date: ' + formatDate(node.trandate));
        var st = statusDisplay(node);
        if (st) lines.push('Status: ' + st);
        var amt = formatAmount(node.amount);
        if (amt) lines.push('Amount: ' + amt);
        return lines.join('\n');
    }

    function buildChip(node) {
        var isCurrent = node.id === _currentId;
        var chip = document.createElement(isCurrent ? 'span' : 'a');
        chip.className = SC + '-chip ' + SC + '-chip--' + (node.type || 'unknown').toLowerCase() +
            (isCurrent ? ' ' + SC + '-chip--current' : '');
        if (!isCurrent) {
            chip.href = transactionUrl(node.id);
            chip.addEventListener('click', function (e) {
                // Plain click navigates in place; modified clicks keep browser defaults
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
                e.preventDefault();
                window.location.href = transactionUrl(node.id);
            });
        } else {
            chip.setAttribute('aria-current', 'page');
        }
        chip.setAttribute('data-tip', buildTooltip(node));

        var t = document.createElement('span');
        t.className = SC + '-type';
        t.textContent = typeLabel(node.type);
        chip.appendChild(t);

        var n = document.createElement('span');
        n.className = SC + '-num';
        n.textContent = node.tranid;
        chip.appendChild(n);

        return chip;
    }

    function buildSeparator() {
        var sep = document.createElement('span');
        sep.className = SC + '-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '>';
        return sep;
    }

    function buildMore(count, strip, list) {
        var more = document.createElement('button');
        more.type = 'button';
        more.className = SC + '-chip ' + SC + '-chip--more';
        more.textContent = '+' + count;
        more.title = 'Show ' + count + ' more document' + (count === 1 ? '' : 's');
        more.addEventListener('click', function (e) {
            e.preventDefault();
            _expanded = true;
            renderInto(strip, list);
        });
        return more;
    }

    /**
     * Decide which indices stay visible when collapsing: the first two, the
     * last two, and the current document with its neighbours.
     */
    function visibleIndices(list) {
        var n = list.length;
        var keep = {};
        if (_expanded || n <= COLLAPSE_THRESHOLD) {
            for (var i = 0; i < n; i++) keep[i] = true;
            return keep;
        }
        var ci = 0;
        for (var j = 0; j < n; j++) if (list[j].id === _currentId) { ci = j; break; }
        [0, 1, n - 2, n - 1, ci - 1, ci, ci + 1].forEach(function (idx) {
            if (idx >= 0 && idx < n) keep[idx] = true;
        });
        return keep;
    }

    function renderInto(strip, list) {
        strip.innerHTML = '';

        var label = document.createElement('span');
        label.className = SC + '-label';
        label.textContent = 'Trail';
        strip.appendChild(label);

        var keep = visibleIndices(list);
        var hiddenRun = 0;
        var first = true;

        function flushHidden() {
            if (hiddenRun > 0) {
                if (!first) strip.appendChild(buildSeparator());
                strip.appendChild(buildMore(hiddenRun, strip, list));
                first = false;
                hiddenRun = 0;
            }
        }

        for (var i = 0; i < list.length; i++) {
            if (!keep[i]) { hiddenRun++; continue; }
            flushHidden();
            if (!first) strip.appendChild(buildSeparator());
            strip.appendChild(buildChip(list[i]));
            first = false;
        }
        flushHidden();

        // The Transaction Tree feature used to float its own "Chain" bubble;
        // the trail replaces it, so the tree panel opens from here instead.
        if (window.__tactaTransactionTreeLoaded) {
            strip.appendChild(buildTreeChip());
        }
        window.dispatchEvent(new CustomEvent('tacta:trail:rendered', { detail: { count: list.length } }));
    }

    function buildTreeChip() {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = SC + '-chip ' + SC + '-chip--tree';
        btn.title = 'Open the full transaction chain as a tree';
        btn.setAttribute('aria-label', 'Open transaction tree');
        var icon = document.createElement('span');
        icon.className = SC + '-type';
        icon.textContent = 'TREE';
        btn.appendChild(icon);
        var txt = document.createElement('span');
        txt.className = SC + '-num';
        txt.textContent = 'View chain';
        btn.appendChild(txt);
        btn.addEventListener('click', function () {
            window.dispatchEvent(new CustomEvent('tacta:transactionTree:open'));
        });
        return btn;
    }

    /**
     * Insert the strip under the page title. Falls back through several
     * anchors; returns null if nothing usable exists yet.
     */
    function mountStrip() {
        var existing = document.getElementById(STRIP_ID);
        if (existing) return existing;

        var strip = document.createElement('div');
        strip.id = STRIP_ID;
        strip.className = SC;
        strip.setAttribute('role', 'navigation');
        strip.setAttribute('aria-label', 'Transaction trail');

        // The record content area starts below NetSuite's fixed header and blue
        // menu bar, so the top of #div__body is the first spot that cannot be
        // covered by them. The title containers sit under the fixed bar.
        var body = document.getElementById('div__body');
        if (body) {
            body.insertBefore(strip, body.firstChild);
            return strip;
        }
        var title = document.querySelector('.uir-page-title');
        if (title && title.parentNode) {
            title.parentNode.insertBefore(strip, title.nextSibling);
            return strip;
        }
        var divTitle = document.getElementById('div__title');
        if (divTitle && divTitle.parentNode) {
            divTitle.parentNode.insertBefore(strip, divTitle.nextSibling);
            return strip;
        }
        var form = document.getElementById('main_form');
        if (form) {
            form.insertBefore(strip, form.firstChild);
            return strip;
        }
        return null;
    }

    // ────────────────────────────────────────────────────────────────
    // Init
    // ────────────────────────────────────────────────────────────────

    function init() {
        if (!isTransactionPage()) return;
        _currentId = getRecordId();
        if (!_currentId) return;

        loadChain().then(function (list) {
            // Nothing linked: stay out of the way
            if (list.length <= 1) return;
            var strip = mountStrip();
            if (!strip) return;
            renderInto(strip, list);
        }).catch(function (err) {
            console.warn('[Tacta Transaction Trail] ' + (err && err.message ? err.message : err));
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();

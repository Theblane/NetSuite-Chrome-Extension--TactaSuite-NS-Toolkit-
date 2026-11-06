/**
 * csv-template-generator-client.js
 * NetSuite TactaSuite - CSV Template Generator (Page-World Script)
 *
 * @author Blane Maher
 *
 * Runs in the MAIN (page) world. Registers a TactaNSBridge handler
 * 'extractCSVData' that scrapes the current NetSuite record page and
 * returns body fields, sublist headers/rows, record type, ID, and mode.
 *
 * Communication: content script calls TactaNSBridge.request('extractCSVData').
 */
(function () {
    'use strict';

    if (window.__tactaCSVTemplateClientLoaded) return;
    window.__tactaCSVTemplateClientLoaded = true;

    // ── Constants ────────────────────────────────────────────────────

    var ACTION_LABELS = [
        'go to register', 'make copy', 'print', 'void', 'copy',
        'new record', 'attach', 'detach', 'submit', 'save',
        'cancel', 'reset', 'accept', 'reject', 'pdf',
        'fax', 'email this transaction', 'bill', 'fulfill',
        'receive', 'return', 'get auth', 'accept payment',
        'make payment', 'back', 'edit', 'gl impact',
        'print gl impact', 'show activity', 'activity',
    ];

    var PATH_MAP = {
        'journal': 'Journal Entry',
        'purchaseorder': 'Purchase Order',
        'vendorbill': 'Vendor Bill',
        'vendorpayment': 'Vendor Payment',
        'expensereport': 'Expense Report',
        'salesorder': 'Sales Order',
        'invoice': 'Invoice',
        'cashsale': 'Cash Sale',
        'cashrefund': 'Cash Refund',
        'creditmemo': 'Credit Memo',
        'returnauthorization': 'Return Authorization',
        'itemreceipt': 'Item Receipt',
        'itemfulfillment': 'Item Fulfillment',
        'inventoryadjustment': 'Inventory Adjustment',
        'transfer': 'Transfer Order',
        'customerdeposit': 'Customer Deposit',
        'customerpayment': 'Customer Payment',
        'check': 'Check',
        'deposit': 'Deposit',
    };

    var ALLOWED_SUBLIST_PATTERNS = [/\bitems?\b/i, /\bexpenses?\b/i, /\bline\s+splits?\b/i];
    var BLOCKED_SUBLISTS = ['mediaitem', 'mediaitem div', 'lines'];

    // ── Helpers ──────────────────────────────────────────────────────

    function isActionLabel(label) {
        var lower = label.toLowerCase();
        return ACTION_LABELS.some(function (a) { return lower === a || lower.includes(a); });
    }

    function isAllowedSublist(name) {
        var lower = name.toLowerCase().trim();
        if (BLOCKED_SUBLISTS.some(function (b) { return lower.includes(b); })) return false;
        return ALLOWED_SUBLIST_PATTERNS.some(function (re) { return re.test(name); });
    }

    function extractValueFromEl(el) {
        if (!el) return '';
        if (el.tagName === 'INPUT' && el.type === 'checkbox') return el.checked ? 'Yes' : 'No';
        var cbInner = el.querySelector('input[type="checkbox"]');
        if (cbInner) return cbInner.checked ? 'Yes' : 'No';
        if (el.getAttribute('data-fieldtype') === 'checkbox') {
            var cbImg = el.querySelector('img.checkboximage, img[class*="checkbox"]');
            if (cbImg) return (cbImg.getAttribute('alt') || '').toLowerCase() === 'checked' ? 'Yes' : 'No';
            return 'No';
        }
        var cbImg2 = el.querySelector('img.checkboximage, img[class*="checkbox"]');
        if (cbImg2) return (cbImg2.getAttribute('alt') || '').toLowerCase() === 'checked' ? 'Yes' : 'No';
        var img = el.querySelector('img');
        if (img) {
            var src = (img.getAttribute('src') || '').toLowerCase();
            if (src.includes('checkbox') || src.includes('checkmark') || src.includes('check_')) {
                return (src.includes('uncheck') || src.includes('_f.') || src.includes('_false') || src.includes('empty')) ? 'No' : 'Yes';
            }
        }
        var linkEl = el.querySelector('a');
        return linkEl ? linkEl.textContent.trim() : el.textContent.trim();
    }

    // ── Core extraction ──────────────────────────────────────────────

    function extractData() {
        try {
            var url = window.location.href;

            // Detect mode
            var hasId = /[?&]id=(\d+)/.test(url);
            var isEdit = url.includes('e=T') || url.includes('/e?');
            var hasForm = !!document.getElementById('main_form');
            var mode = null;

            if (isEdit && hasId) mode = 'edit';
            else if (isEdit || (hasForm && !hasId)) mode = 'create';
            else if (hasId) mode = 'view';
            else if (hasForm) mode = 'create';

            if (!mode) {
                return { error: 'Could not detect record mode. Open a NetSuite transaction record first.' };
            }

            // Record type
            var recordType = 'Transaction';
            var ttMatch = url.match(/[?&]transactiontype=([^&]+)/i);
            if (ttMatch) {
                recordType = decodeURIComponent(ttMatch[1]);
            } else {
                var pathMatch = url.match(/\/transactions\/([^.?/]+)\.nl/i) ||
                    url.match(/\/accounting\/([^.?/]+)\.nl/i) ||
                    url.match(/\/([^.?/]+)\.nl/i);
                if (pathMatch) {
                    var key = pathMatch[1].toLowerCase();
                    recordType = PATH_MAP[key] || (key.charAt(0).toUpperCase() + key.slice(1));
                } else {
                    var titleEl = document.querySelector('.uir-page-title-secondline, .uir-record-type, #spn_cg_pagetitle');
                    if (titleEl) {
                        var raw = titleEl.textContent.trim();
                        recordType = raw.split(/[|\n\r]/)[0].trim() || 'Transaction';
                    }
                }
            }

            // Record ID
            var idMatch = url.match(/[?&]id=(\d+)/);
            var recordId = idMatch ? idMatch[1] : null;
            var includeValues = (mode === 'view');

            // Sublist container detection for exclusion
            var sublistContainers = document.querySelectorAll(
                'div.uir-machine-table-container, table.uir-machine-table, .machineTableContainer, .uir-sublist'
            );
            function isInsideSublist(el) {
                for (var i = 0; i < sublistContainers.length; i++) {
                    if (sublistContainers[i].contains(el)) return true;
                }
                return false;
            }

            var bodyFields = [];
            var bodyFieldsSeen = new Set();
            var mainForm = document.getElementById('main_form');

            // Strategy A: ID-based label->value mapping (primary)
            if (mainForm) {
                var labelSpans = mainForm.querySelectorAll('span[id$="_lbl"]');
                labelSpans.forEach(function (span) {
                    if (isInsideSublist(span)) return;
                    var anchor = span.querySelector('a');
                    var rawLabel = anchor ? anchor.textContent.trim() : span.textContent.trim();
                    var isMandatory = rawLabel.includes('*');
                    var label = rawLabel.replace(/[:\*]/g, '').trim();
                    if (isMandatory) label = label + ' *';
                    if (!label || label.length <= 2 || isActionLabel(label)) return;

                    var baseId = span.id.replace(/_lbl$/, '');
                    var value = '';
                    if (includeValues) {
                        var valEl = document.getElementById(baseId + '_val') ||
                            document.getElementById(baseId) ||
                            document.getElementById(baseId + '_display') ||
                            document.getElementById(baseId + '_text');
                        if (valEl) {
                            value = extractValueFromEl(valEl);
                        }
                        if (!value && value !== 'No') {
                            var parentRow = span.closest('tr');
                            if (parentRow) {
                                var roEl = parentRow.querySelector('.inputreadonly');
                                if (roEl) value = extractValueFromEl(roEl);
                                if (!value && value !== 'No') {
                                    var rowCbs = parentRow.querySelectorAll('td input[type="checkbox"]');
                                    if (rowCbs.length === 1) value = rowCbs[0].checked ? 'Yes' : 'No';
                                }
                            }
                            if (!value && value !== 'No') {
                                var parentCell = span.closest('td');
                                if (parentCell) {
                                    var pcEl = parentCell.querySelector('.inputreadonly');
                                    if (pcEl) value = extractValueFromEl(pcEl);
                                }
                            }
                        }
                    }

                    if (!bodyFieldsSeen.has(label)) {
                        bodyFieldsSeen.add(label);
                        bodyFields.push({ label: label, value: value });
                    }
                });
            }

            // Strategy B: .uir-label fallback
            if (bodyFields.length === 0 && mainForm) {
                mainForm.querySelectorAll('.uir-label').forEach(function (lbl) {
                    if (isInsideSublist(lbl)) return;
                    var anchor = lbl.querySelector('a');
                    var rawLabel = anchor ? anchor.textContent.trim() : lbl.textContent.trim();
                    var isMandatory = rawLabel.includes('*');
                    var label = rawLabel.replace(/[:\*]/g, '').trim();
                    if (isMandatory) label = label + ' *';
                    if (!label || label.length <= 2 || isActionLabel(label)) return;

                    var value = '';
                    if (includeValues) {
                        var parentRow = lbl.closest('tr') || lbl.closest('td');
                        if (parentRow) {
                            var roEl = parentRow.querySelector('.inputreadonly');
                            if (roEl) {
                                var linkEl = roEl.querySelector('a');
                                value = linkEl ? linkEl.textContent.trim() : roEl.textContent.trim();
                            }
                        }
                    }

                    if (!bodyFieldsSeen.has(label)) {
                        bodyFieldsSeen.add(label);
                        bodyFields.push({ label: label, value: value });
                    }
                });
            }

            // Strategy C: NS API (last resort, SS1 globals)
            if (bodyFields.length === 0) {
                if (typeof nlapiGetRecord === 'function' && typeof nlapiGetField === 'function') {
                    try {
                        var rec = nlapiGetRecord();
                        if (rec && typeof rec.getAllFields === 'function') {
                            var GOOD_TYPES = new Set([
                                'text', 'email', 'url', 'phone', 'textarea', 'richtext',
                                'select', 'multiselect', 'date', 'datetime', 'datetimetz',
                                'checkbox', 'currency', 'float', 'integer', 'percent',
                                'number', 'radio', 'timeofday', 'address', 'clobtext',
                                'namevaluelist', 'ccnumber', 'file',
                            ]);
                            rec.getAllFields().forEach(function (fid) {
                                try {
                                    var fieldObj = nlapiGetField(fid);
                                    if (!fieldObj) return;
                                    var ftype = (fieldObj.getType ? fieldObj.getType() : '') || '';
                                    var flabel = (fieldObj.getLabel ? fieldObj.getLabel() : '') || '';
                                    if (!GOOD_TYPES.has(ftype.toLowerCase())) return;
                                    var header = flabel.trim() || fid;
                                    if (isActionLabel(header)) return;
                                    var text = rec.getFieldText(fid) || rec.getFieldValue(fid) || '';
                                    if (!bodyFieldsSeen.has(header)) {
                                        bodyFieldsSeen.add(header);
                                        bodyFields.push({ label: header, value: includeValues ? String(text) : '' });
                                    }
                                } catch (e) { /* skip individual field errors */ }
                            });
                        }
                    } catch (e) { /* SS1 not available */ }
                }
            }

            // Sublist extraction
            var sublists = {};
            document.querySelectorAll(
                'div.uir-machine-table-container, table.uir-machine-table, .machineTableContainer'
            ).forEach(function (container) {
                var sublistName = 'Lines';
                var stitleEl = container.querySelector('.uir-sublist-title, .bglt caption');
                if (stitleEl) sublistName = stitleEl.textContent.trim();
                else if (container.id) sublistName = container.id.replace(/div__|_/g, ' ').trim();

                if (!isAllowedSublist(sublistName)) return;

                var headerRow = container.querySelector('tr.uir-machine-headerrow, thead tr, tr:first-child');
                if (!headerRow) return;

                var headers = [];
                headerRow.querySelectorAll('td, th').forEach(function (cell) {
                    var text = cell.textContent.trim();
                    if (text && text !== ' ' && text !== '') headers.push(text);
                });
                if (headers.length === 0) return;

                var rows = [];
                if (includeValues) {
                    container.querySelectorAll('tr.uir-machine-row, tr.uir-machine-row-odd, tr.uir-machine-row-even').forEach(function (row) {
                        var cells = row.querySelectorAll('td');
                        var rowData = {};
                        cells.forEach(function (cell, idx) {
                            if (idx < headers.length) rowData[headers[idx]] = cell.textContent.trim();
                        });
                        if (Object.keys(rowData).length > 0) rows.push(rowData);
                    });
                }

                sublists[sublistName] = { headers: headers, rows: rows };
            });

            return {
                mode: mode,
                recordType: recordType,
                recordId: recordId,
                bodyFields: bodyFields,
                sublists: sublists,
                fieldCount: bodyFields.length,
                sublistCount: Object.keys(sublists).length
            };

        } catch (err) {
            return { error: 'Extraction error: ' + err.message };
        }
    }

    // ── Register Bridge handler ──────────────────────────────────────
    // Poll briefly in case ns-bridge.js is still initializing
    if (window.TactaNSBridge) {
        window.TactaNSBridge.registerHandler('extractCSVData', extractData);
    } else {
        var maxWait = 20;
        var checkInterval = setInterval(function () {
            if (window.TactaNSBridge) {
                clearInterval(checkInterval);
                window.TactaNSBridge.registerHandler('extractCSVData', extractData);
            } else if (--maxWait <= 0) {
                clearInterval(checkInterval);
                console.warn('[Tacta CSV Template] TactaNSBridge not found - cannot register handler.');
            }
        }, 50);
    }

})();

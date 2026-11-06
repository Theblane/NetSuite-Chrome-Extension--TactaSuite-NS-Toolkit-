/**
 * console-snippets-data.js
 * NetSuite TactaSuite - Console Snippet Library (Content Script)
 *
 * @author Blane Maher
 *
 * The snippet catalogue for the Console Snippets panel. Pure data plus a
 * matcher - no DOM, no NetSuite calls. Each snippet builds its code string
 * from the page context so internal IDs are pre-filled.
 *
 * Snippet shape:
 *   id          - unique slug
 *   title       - short label shown in the panel
 *   description - one line explaining what it does / what to watch for
 *   recordTypes - ['*'] for any page, or SuiteScript record type ids.
 *                 A trailing '*' matches by prefix (e.g. 'customrecord*').
 *   kind        - 'read' | 'write' | 'form' | 'query' | 'danger'
 *   code(ctx)   - returns the snippet source. ctx = { recordType, recordId,
 *                 typeToken, idToken }
 *
 * Exposes: window.TactaSnippetLibrary
 */
(function () {
    'use strict';

    if (window.TactaSnippetLibrary) return;

    /**
     * Transaction/entity URL stems mapped to their SuiteScript record type.
     * Only used when N/currentRecord is unavailable (list pages, new records,
     * pages where the AMD loader has not booted).
     */
    var URL_TYPE_ALIASES = {
        salesord:   'salesorder',
        purchord:   'purchaseorder',
        custinvc:   'invoice',
        itemship:   'itemfulfillment',
        itemrcpt:   'itemreceipt',
        trnfrord:   'transferorder',
        custcred:   'creditmemo',
        custpymt:   'customerpayment',
        custrfnd:   'customerrefund',
        vendbill:   'vendorbill',
        vendpymt:   'vendorpayment',
        vendcred:   'vendorcredit',
        vendauth:   'vendorreturnauthorization',
        custauth:   'returnauthorization',
        estimate:   'estimate',
        opprtnty:   'opportunity',
        workord:    'workorder',
        invadjst:   'inventoryadjustment',
        invtrnfr:   'inventorytransfer',
        journal:    'journalentry',
        custjob:    'customer',
        vendor:     'vendor',
        contact:    'contact',
        employee:   'employee',
        partner:    'partner',
        custrecordentry: null
    };

    /* ── Code builders ────────────────────────────────────────────── */

    /**
     * Wraps a submitFields call in the alert + reload pattern.
     * One value stays inline; several break onto their own lines.
     * @param {string} type - Record type id.
     * @param {string} id - Internal id or placeholder token.
     * @param {string[]} values - Entries for the `values` object, e.g. "'memo': 'x'".
     * @param {string} [message] - Alert text.
     * @returns {string}
     */
    function submitFields(type, id, values, message) {
        var lines = [
            "require(['N/record'], function (r) {",
            '    r.submitFields({',
            "        type: '" + type + "',",
            '        id: ' + id + ','
        ];

        if (values.length === 1) {
            lines.push('        values: { ' + values[0] + ' }');
        } else {
            lines.push('        values: {');
            values.forEach(function (v, i) {
                lines.push('            ' + v + (i < values.length - 1 ? ',' : ''));
            });
            lines.push('        }');
        }

        lines.push('    });');
        lines.push("    alert('" + (message || 'Updated! Reloading...') + "');");
        lines.push('    location.reload();');
        lines.push('});');

        return lines.join('\n');
    }

    /**
     * Builds a dynamic sublist dump. Field ids are discovered at runtime so
     * the snippet keeps working when a sublist is customised.
     * @param {string} sublistId
     * @returns {string}
     */
    function dumpSublist(sublistId) {
        return [
            "require(['N/currentRecord'], function (cr) {",
            '    var rec = cr.get();',
            "    var sublistId = '" + sublistId + "';",
            '    var fields = rec.getSublistFields({ sublistId: sublistId });',
            '    var lines = rec.getLineCount({ sublistId: sublistId });',
            '    var rows = [];',
            '    for (var i = 0; i < lines; i++) {',
            '        var row = { line: i };',
            '        fields.forEach(function (f) {',
            '            try {',
            '                var v = rec.getSublistValue({ sublistId: sublistId, fieldId: f, line: i });',
            "                if (v !== '' && v !== null && v !== undefined) row[f] = v;",
            '            } catch (e) { /* write-only or unavailable column */ }',
            '        });',
            '        rows.push(row);',
            '    }',
            "    console.log(sublistId + ': ' + lines + ' line(s)');",
            '    console.table(rows);',
            '});'
        ].join('\n');
    }

    /* ── The catalogue ───────────────────────────────────────────── */

    var SNIPPETS = [

        // ── Context ──────────────────────────────────────────────────
        {
            id: 'ctx-record',
            title: 'What record am I on?',
            description: 'Echoes the SuiteScript record type and internal id - the two things every other snippet needs.',
            recordTypes: ['*'],
            kind: 'read',
            code: function () {
                return [
                    "require(['N/currentRecord'], function (cr) {",
                    '    var rec = cr.get();',
                    "    console.log('type:', rec.type, '| id:', rec.id);",
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'ctx-runtime',
            title: 'Who am I / which account',
            description: 'Current user, role, subsidiary, location and the account + environment you are actually pointed at.',
            recordTypes: ['*'],
            kind: 'read',
            code: function () {
                return [
                    "require(['N/runtime'], function (rt) {",
                    '    var u = rt.getCurrentUser();',
                    '    console.table({',
                    '        account:     rt.accountId,',
                    '        environment: rt.envType,',
                    '        apiVersion:  rt.version,',
                    "        user:        u.name + ' (' + u.id + ')',",
                    '        roleId:      u.role,',
                    '        roleScript:  u.roleId,',
                    '        subsidiary:  u.subsidiary,',
                    '        location:    u.location,',
                    '        department:  u.department',
                    '    });',
                    '});'
                ].join('\n');
            }
        },

        // ── Reading the open record ──────────────────────────────────
        {
            id: 'read-all-fields',
            title: 'Dump every body field',
            description: 'Table of every field id on the form with its value and display text. The fastest way to find a field id.',
            recordTypes: ['*'],
            kind: 'read',
            code: function () {
                return [
                    "require(['N/currentRecord'], function (cr) {",
                    '    var rec = cr.get();',
                    '    console.table(rec.getFields().map(function (f) {',
                    '        var v = null, t = null;',
                    '        try { v = rec.getValue({ fieldId: f }); } catch (e) {}',
                    '        try { t = rec.getText({ fieldId: f }); } catch (e) {}',
                    '        return { field: f, value: v, text: t };',
                    '    }));',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'read-populated-fields',
            title: 'Dump only populated fields',
            description: 'Same as above but skips empty fields - much easier to read on a transaction with 300+ fields.',
            recordTypes: ['*'],
            kind: 'read',
            code: function () {
                return [
                    "require(['N/currentRecord'], function (cr) {",
                    '    var rec = cr.get();',
                    '    console.table(rec.getFields().map(function (f) {',
                    '        var v = null;',
                    '        try { v = rec.getValue({ fieldId: f }); } catch (e) {}',
                    '        return { field: f, value: v };',
                    "    }).filter(function (r) { return r.value !== '' && r.value !== null && r.value !== false; }));",
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'read-one-field',
            title: 'Read one field (value + text)',
            description: 'Value and display text for a single field. Change fieldId on the first line.',
            recordTypes: ['*'],
            kind: 'read',
            code: function () {
                return [
                    "require(['N/currentRecord'], function (cr) {",
                    "    var fieldId = 'memo';",
                    '    var rec = cr.get();',
                    "    console.log(fieldId, '| value:', rec.getValue({ fieldId: fieldId }),",
                    "                         '| text:', rec.getText({ fieldId: fieldId }));",
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'read-sublists',
            title: 'List sublists + line counts',
            description: 'Every sublist id on the record and how many lines it has. Run this before dumping a sublist.',
            recordTypes: ['*'],
            kind: 'read',
            code: function () {
                return [
                    "require(['N/currentRecord'], function (cr) {",
                    '    var rec = cr.get();',
                    '    console.table(rec.getSublists().map(function (s) {',
                    '        var n = null;',
                    '        try { n = rec.getLineCount({ sublistId: s }); } catch (e) {}',
                    '        return { sublist: s, lines: n };',
                    '    }));',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'read-sublist-dump',
            title: 'Dump a sublist to a table',
            description: 'Discovers the sublist columns at runtime, so it works on customised sublists. Change sublistId.',
            recordTypes: ['*'],
            kind: 'read',
            code: function () { return dumpSublist('item'); }
        },
        {
            id: 'read-copy-json',
            title: 'Copy the record as JSON',
            description: 'Puts a JSON snapshot of every field on your clipboard. Uses the DevTools copy() helper, so it only works in the console.',
            recordTypes: ['*'],
            kind: 'read',
            code: function () {
                return [
                    "require(['N/currentRecord'], function (cr) {",
                    '    var rec = cr.get();',
                    '    var out = { type: rec.type, id: rec.id, fields: {} };',
                    '    rec.getFields().forEach(function (f) {',
                    '        try { out.fields[f] = rec.getValue({ fieldId: f }); } catch (e) {}',
                    '    });',
                    '    copy(JSON.stringify(out, null, 2));',
                    "    console.log('Copied', Object.keys(out.fields).length, 'fields to the clipboard');",
                    '});'
                ].join('\n');
            }
        },

        // ── Writing ──────────────────────────────────────────────────
        {
            id: 'write-form-field',
            title: 'Set a field on the open form',
            description: 'Changes the field in the browser only - nothing is saved until you click Save. Fires sourcing and client field-change logic.',
            recordTypes: ['*'],
            kind: 'form',
            code: function () {
                return [
                    "require(['N/currentRecord'], function (cr) {",
                    '    cr.get().setValue({',
                    "        fieldId: 'memo',",
                    "        value: 'Updated from console',",
                    '        ignoreFieldChange: false',
                    '    });',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'write-submitfields',
            title: 'submitFields on this record',
            description: 'Writes straight to the database. Skips client scripts and sourcing, so it can set fields the UI will not let you touch.',
            recordTypes: ['*'],
            kind: 'write',
            code: function (ctx) {
                return submitFields(ctx.typeToken, ctx.idToken, ["'<FIELD ID>': '<VALUE>'"], 'Saved! Reloading...');
            }
        },
        {
            id: 'write-load-save',
            title: 'Load, change, save',
            description: 'Full load + save cycle, so User Event scripts and mandatory-field validation all run. Use when submitFields is too blunt.',
            recordTypes: ['*'],
            kind: 'write',
            code: function (ctx) {
                return [
                    "require(['N/record'], function (r) {",
                    '    r.load.promise({',
                    "        type: '" + ctx.typeToken + "',",
                    '        id: ' + ctx.idToken + ',',
                    '        isDynamic: true',
                    '    }).then(function (rec) {',
                    "        rec.setValue({ fieldId: 'memo', value: 'Updated from console' });",
                    '        return rec.save.promise({ enableSourcing: true, ignoreMandatoryFields: false });',
                    '    }).then(function (id) {',
                    "        console.log('Saved', id);",
                    '        location.reload();',
                    '    }).catch(function (e) {',
                    '        console.error(e.name, e.message);',
                    '    });',
                    '});'
                ].join('\n');
            }
        },

        // ── Form tricks ──────────────────────────────────────────────
        {
            id: 'form-enable-field',
            title: 'Make a greyed-out field editable',
            description: 'Un-disables a field in the DOM so you can type in it. The server may still reject the value on save - this is for inspection, not a bypass.',
            recordTypes: ['*'],
            kind: 'form',
            code: function () {
                return [
                    "var fieldId = 'custbody_example';",
                    "var el = document.getElementById(fieldId) || document.querySelector('[name=\"' + fieldId + '\"]');",
                    'if (el) {',
                    '    el.disabled = false;',
                    '    el.readOnly = false;',
                    "    el.style.backgroundColor = '#fffbe6';",
                    "    console.log('Enabled', fieldId);",
                    "} else if (typeof nlapiGetField === 'function' && nlapiGetField(fieldId)) {",
                    "    nlapiGetField(fieldId).setDisplayType('normal');",
                    "    console.log('Enabled via nlapiGetField:', fieldId);",
                    '} else {',
                    "    console.warn('Field not found on this form:', fieldId);",
                    '}'
                ].join('\n');
            }
        },
        {
            id: 'form-hidden-values',
            title: 'List hidden field values',
            description: 'Dumps the hidden inputs NetSuite keeps on the form - often where the real internal ids live.',
            recordTypes: ['*'],
            kind: 'read',
            code: function () {
                return [
                    "console.table(Array.prototype.slice.call(document.querySelectorAll('input[type=hidden]'))",
                    '    .filter(function (el) { return (el.name || el.id) && el.value; })',
                    '    .map(function (el) { return { field: el.name || el.id, value: el.value }; }));'
                ].join('\n');
            }
        },
        {
            id: 'form-open-edit',
            title: 'Reopen this record in edit mode',
            description: 'Flips the current URL to e=T without hunting for the Edit button.',
            recordTypes: ['*'],
            kind: 'form',
            code: function () {
                return [
                    'var u = new URL(location.href);',
                    "u.searchParams.set('e', 'T');",
                    'location.href = u.toString();'
                ].join('\n');
            }
        },

        // ── SuiteQL ──────────────────────────────────────────────────
        {
            id: 'query-suiteql',
            title: 'Run SuiteQL from the console',
            description: 'Any SuiteQL query, straight to a console table. Remember ROWNUM limits - there is no paging here.',
            recordTypes: ['*'],
            kind: 'query',
            code: function () {
                return [
                    "require(['N/query'], function (q) {",
                    '    q.runSuiteQL.promise({',
                    '        query: "SELECT id, tranid, trandate, status FROM transaction " +',
                    '               "WHERE type = \'SalesOrd\' AND ROWNUM <= 25 ORDER BY id DESC"',
                    '    }).then(function (res) {',
                    '        console.table(res.asMappedResults());',
                    '    }).catch(function (e) {',
                    '        console.error(e.name, e.message);',
                    '    });',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'query-scripts-on-type',
            title: 'Which scripts are deployed on this record type?',
            description: 'Lists script deployments bound to this record type with status and log level - the first thing to check when a record behaves oddly.',
            recordTypes: ['*'],
            kind: 'query',
            code: function (ctx) {
                return [
                    "require(['N/query'], function (q) {",
                    '    q.runSuiteQL.promise({',
                    '        query: "SELECT s.scriptid, s.name, s.scripttype, sd.status, " +',
                    '               "sd.isdeployed, sd.loglevel, sd.allemployees " +',
                    '               "FROM scriptdeployment sd " +',
                    '               "JOIN script s ON s.id = sd.script " +',
                    '               "WHERE sd.recordtype = \'' + ctx.typeToken + '\' " +',
                    '               "ORDER BY s.scripttype, s.scriptid"',
                    '    }).then(function (res) {',
                    '        console.table(res.asMappedResults());',
                    '    }).catch(function (e) {',
                    '        console.error(e.name, e.message);',
                    '    });',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'query-system-notes',
            title: 'System notes for this record',
            description: 'Raw field-change history for this internal id. Narrower than the Audit Trail panel, but you can filter and join it.',
            recordTypes: ['*'],
            kind: 'query',
            code: function (ctx) {
                return [
                    "require(['N/query'], function (q) {",
                    '    q.runSuiteQL.promise({',
                    '        query: "SELECT sn.date, sn.field, sn.oldvalue, sn.newvalue, " +',
                    '               "BUILTIN.DF(sn.name) AS changed_by, sn.type " +',
                    '               "FROM systemnote sn " +',
                    '               "WHERE sn.recordid = ' + ctx.idToken + ' " +',
                    '               "ORDER BY sn.date DESC"',
                    '    }).then(function (res) {',
                    '        console.table(res.asMappedResults());',
                    '    }).catch(function (e) {',
                    '        console.error(e.name, e.message);',
                    '    });',
                    '});'
                ].join('\n');
            }
        },

        // ── Inbound Shipment ─────────────────────────────────────────
        {
            id: 'ib-status-tobeshipped',
            title: 'Set status: To Be Shipped',
            description: 'Rolls an inbound shipment back to To Be Shipped. Handy after a bad receipt or an integration mis-step.',
            recordTypes: ['inboundshipment'],
            kind: 'write',
            code: function (ctx) {
                return submitFields('inboundshipment', ctx.idToken, ["'shipmentstatus': 'toBeShipped'"], 'Status updated! Reloading...');
            }
        },
        {
            id: 'ib-status-intransit',
            title: 'Set status: In Transit',
            description: 'Marks the shipment as departed so it shows on the in-transit reports.',
            recordTypes: ['inboundshipment'],
            kind: 'write',
            code: function (ctx) {
                return submitFields('inboundshipment', ctx.idToken, ["'shipmentstatus': 'inTransit'"], 'Status updated! Reloading...');
            }
        },
        {
            id: 'ib-status-any',
            title: 'Set status: any value',
            description: 'All five inbound shipment statuses in one snippet - edit the status variable on the first line.',
            recordTypes: ['inboundshipment'],
            kind: 'write',
            code: function (ctx) {
                return [
                    "// toBeShipped | inTransit | partiallyReceived | received | closed",
                    "var status = 'received';",
                    '',
                    "require(['N/record'], function (r) {",
                    '    r.submitFields({',
                    "        type: 'inboundshipment',",
                    '        id: ' + ctx.idToken + ',',
                    "        values: { 'shipmentstatus': status }",
                    '    });',
                    "    alert('Status set to ' + status + '! Reloading...');",
                    '    location.reload();',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'ib-dates',
            title: 'Set expected / actual shipping dates',
            description: 'Dates that are read-only once the shipment advances. Pass real Date objects, not strings.',
            recordTypes: ['inboundshipment'],
            kind: 'write',
            code: function (ctx) {
                return [
                    "require(['N/record'], function (r) {",
                    '    r.submitFields({',
                    "        type: 'inboundshipment',",
                    '        id: ' + ctx.idToken + ',',
                    '        values: {',
                    "            'expecteddeliverydate': new Date('2026-01-31T00:00:00'),",
                    "            'actualshippingdate':   new Date('2026-01-15T00:00:00')",
                    '        }',
                    '    });',
                    "    alert('Dates updated! Reloading...');",
                    '    location.reload();',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'ib-dump-items',
            title: 'Dump shipment item lines',
            description: 'Every line on the items sublist with the linked PO, expected and received quantities.',
            recordTypes: ['inboundshipment'],
            kind: 'read',
            code: function () { return dumpSublist('items'); }
        },

        // ── Sales Order ──────────────────────────────────────────────
        {
            id: 'so-status-pending-fulfillment',
            title: 'Set status: Pending Fulfillment',
            description: 'Pushes the order back to Pending Fulfillment (B). Will not stick if fulfillments or invoices already exist.',
            recordTypes: ['salesorder'],
            kind: 'write',
            code: function (ctx) {
                return submitFields('salesorder', ctx.idToken, ["'orderstatus': 'B'"], 'Status updated! Reloading...');
            }
        },
        {
            id: 'so-status-any',
            title: 'Set order status: any value',
            description: 'The full orderstatus code list for sales orders in one place.',
            recordTypes: ['salesorder'],
            kind: 'write',
            code: function (ctx) {
                return [
                    '// A Pending Approval      | B Pending Fulfillment',
                    '// C Cancelled             | D Partially Fulfilled',
                    '// E Pending Billing/Partially Fulfilled',
                    '// F Pending Billing       | G Billed            | H Closed',
                    "var status = 'B';",
                    '',
                    "require(['N/record'], function (r) {",
                    '    r.submitFields({',
                    "        type: 'salesorder',",
                    '        id: ' + ctx.idToken + ',',
                    "        values: { 'orderstatus': status }",
                    '    });',
                    "    alert('Status set to ' + status + '! Reloading...');",
                    '    location.reload();',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'so-dump-lines',
            title: 'Dump order lines with commit/fulfil quantities',
            description: 'Item, quantity, committed, fulfilled, billed, rate, location and closed flag per line.',
            recordTypes: ['salesorder'],
            kind: 'read',
            code: function () {
                return [
                    "require(['N/currentRecord'], function (cr) {",
                    '    var rec = cr.get();',
                    "    var cols = ['item', 'quantity', 'quantitycommitted', 'quantityfulfilled',",
                    "                'quantitybilled', 'units', 'rate', 'amount', 'location', 'isclosed'];",
                    '    var rows = [];',
                    "    for (var i = 0; i < rec.getLineCount({ sublistId: 'item' }); i++) {",
                    '        var row = { line: i };',
                    '        cols.forEach(function (c) {',
                    "            try { row[c] = rec.getSublistValue({ sublistId: 'item', fieldId: c, line: i }); } catch (e) {}",
                    '        });',
                    "        try { row.itemText = rec.getSublistText({ sublistId: 'item', fieldId: 'item', line: i }); } catch (e) {}",
                    '        rows.push(row);',
                    '    }',
                    '    console.table(rows);',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'so-close-all-lines',
            title: 'Close every open line',
            description: 'Loads the order, ticks isclosed on all lines and saves. The usual way to retire a stuck order without cancelling it.',
            recordTypes: ['salesorder', 'purchaseorder', 'transferorder'],
            kind: 'write',
            code: function (ctx) {
                return [
                    "require(['N/record'], function (r) {",
                    '    r.load.promise({',
                    "        type: '" + ctx.typeToken + "',",
                    '        id: ' + ctx.idToken + ',',
                    '        isDynamic: false',
                    '    }).then(function (rec) {',
                    "        var n = rec.getLineCount({ sublistId: 'item' });",
                    '        for (var i = 0; i < n; i++) {',
                    '            rec.setSublistValue({',
                    "                sublistId: 'item', fieldId: 'isclosed', line: i, value: true",
                    '            });',
                    '        }',
                    "        console.log('Closing', n, 'line(s)');",
                    '        return rec.save.promise({ ignoreMandatoryFields: true });',
                    '    }).then(function (id) {',
                    "        console.log('Saved', id);",
                    '        location.reload();',
                    '    }).catch(function (e) {',
                    '        console.error(e.name, e.message);',
                    '    });',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'so-moq-override',
            title: 'Force the MOQ override on',
            description: 'Sets custbody_force_moq_override with a reason so the MOQ validation lets the order through.',
            recordTypes: ['salesorder'],
            kind: 'write',
            code: function (ctx) {
                return submitFields(
                    'salesorder',
                    ctx.idToken,
                    [
                        "'custbody_force_moq_override': true",
                        "'custbody_override_reason': 'Console override - <REASON>'"
                    ],
                    'MOQ override set! Reloading...'
                );
            }
        },

        // ── Item Fulfillment ─────────────────────────────────────────
        {
            id: 'if-shipstatus',
            title: 'Set fulfillment ship status',
            description: 'Picked (A), Packed (B) or Shipped (C). Going backwards from Shipped is often blocked once the invoice exists.',
            recordTypes: ['itemfulfillment'],
            kind: 'write',
            code: function (ctx) {
                return [
                    '// A Picked | B Packed | C Shipped',
                    "var status = 'C';",
                    '',
                    "require(['N/record'], function (r) {",
                    '    r.submitFields({',
                    "        type: 'itemfulfillment',",
                    '        id: ' + ctx.idToken + ',',
                    "        values: { 'shipstatus': status }",
                    '    });',
                    "    alert('Ship status set to ' + status + '! Reloading...');",
                    '    location.reload();',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'if-tracking',
            title: 'Dump package + tracking numbers',
            description: 'Walks all four package sublists (generic, FedEx, UPS, USPS) and prints whichever one the fulfillment actually uses.',
            recordTypes: ['itemfulfillment'],
            kind: 'read',
            code: function () {
                return [
                    "require(['N/currentRecord'], function (cr) {",
                    '    var rec = cr.get();',
                    "    ['package', 'packagefedex', 'packageups', 'packageusps'].forEach(function (sub) {",
                    '        var n = 0;',
                    '        try { n = rec.getLineCount({ sublistId: sub }); } catch (e) { return; }',
                    '        if (n <= 0) return;',
                    '        var fields = rec.getSublistFields({ sublistId: sub });',
                    '        var rows = [];',
                    '        for (var i = 0; i < n; i++) {',
                    '            var row = { line: i };',
                    '            fields.forEach(function (f) {',
                    '                try {',
                    '                    var v = rec.getSublistValue({ sublistId: sub, fieldId: f, line: i });',
                    "                    if (v !== '' && v !== null && v !== undefined) row[f] = v;",
                    '                } catch (e) {}',
                    '            });',
                    '            rows.push(row);',
                    '        }',
                    '        console.log(sub);',
                    '        console.table(rows);',
                    '    });',
                    '});'
                ].join('\n');
            }
        },

        // ── Purchase Order ───────────────────────────────────────────
        {
            id: 'po-approve',
            title: 'Approve this PO',
            description: 'Sets approvalstatus to 2 (Approved), bypassing the approval workflow.',
            recordTypes: ['purchaseorder'],
            kind: 'write',
            code: function (ctx) {
                return submitFields('purchaseorder', ctx.idToken, ["'approvalstatus': 2"], 'PO approved! Reloading...');
            }
        },
        {
            id: 'po-status-any',
            title: 'Set PO status: any value',
            description: 'The purchase order orderstatus code list - useful for reopening a PO stuck at Fully Billed or Closed.',
            recordTypes: ['purchaseorder'],
            kind: 'write',
            code: function (ctx) {
                return [
                    '// A Pending Approval  | B Pending Receipt',
                    '// D Partially Received | E Pending Billing/Partially Received',
                    '// F Pending Bill       | G Fully Billed  | H Closed',
                    "var status = 'B';",
                    '',
                    "require(['N/record'], function (r) {",
                    '    r.submitFields({',
                    "        type: 'purchaseorder',",
                    '        id: ' + ctx.idToken + ',',
                    "        values: { 'orderstatus': status }",
                    '    });',
                    "    alert('Status set to ' + status + '! Reloading...');",
                    '    location.reload();',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'po-dump-lines',
            title: 'Dump PO lines with received/billed quantities',
            description: 'Shows where a PO is actually sitting line by line, which rarely matches the header status.',
            recordTypes: ['purchaseorder'],
            kind: 'read',
            code: function () {
                return [
                    "require(['N/currentRecord'], function (cr) {",
                    '    var rec = cr.get();',
                    "    var cols = ['item', 'quantity', 'quantityreceived', 'quantitybilled',",
                    "                'units', 'rate', 'amount', 'expectedreceiptdate', 'isclosed'];",
                    '    var rows = [];',
                    "    for (var i = 0; i < rec.getLineCount({ sublistId: 'item' }); i++) {",
                    '        var row = { line: i };',
                    '        cols.forEach(function (c) {',
                    "            try { row[c] = rec.getSublistValue({ sublistId: 'item', fieldId: c, line: i }); } catch (e) {}",
                    '        });',
                    '        rows.push(row);',
                    '    }',
                    '    console.table(rows);',
                    '});'
                ].join('\n');
            }
        },

        // ── Invoice ──────────────────────────────────────────────────
        {
            id: 'inv-approve',
            title: 'Approve this invoice',
            description: 'Sets approvalstatus to 2 (Approved).',
            recordTypes: ['invoice'],
            kind: 'write',
            code: function (ctx) {
                return submitFields('invoice', ctx.idToken, ["'approvalstatus': 2"], 'Invoice approved! Reloading...');
            }
        },
        {
            id: 'inv-overwrite-tax',
            title: 'Tick Overwrite Sales Tax',
            description: 'Lets you hand-enter tax on an invoice the tax engine has already calculated.',
            recordTypes: ['invoice', 'creditmemo', 'cashsale'],
            kind: 'write',
            code: function (ctx) {
                return submitFields(ctx.typeToken, ctx.idToken, ["'overwritesalestax': true"], 'Overwrite Sales Tax enabled! Reloading...');
            }
        },

        // ── Customer ─────────────────────────────────────────────────
        {
            id: 'cust-credit-hold',
            title: 'Change the credit hold override',
            description: 'AUTO follows the credit limit rules, ON forces a hold, OFF releases one.',
            recordTypes: ['customer'],
            kind: 'write',
            code: function (ctx) {
                return [
                    '// AUTO | ON | OFF',
                    "var hold = 'OFF';",
                    '',
                    "require(['N/record'], function (r) {",
                    '    r.submitFields({',
                    "        type: 'customer',",
                    '        id: ' + ctx.idToken + ',',
                    "        values: { 'creditholdoverride': hold }",
                    '    });',
                    "    alert('Credit hold set to ' + hold + '! Reloading...');",
                    '    location.reload();',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'cust-moq-flags',
            title: 'Set the MOQ flags on this customer',
            description: 'Turns on custentity_moq_use and points custentity_moq_group_assignment at an MOQ Group internal id.',
            recordTypes: ['customer'],
            kind: 'write',
            code: function (ctx) {
                return submitFields(
                    'customer',
                    ctx.idToken,
                    [
                        "'custentity_moq_use': true",
                        "'custentity_moq_group_assignment': '<MOQ GROUP INTERNAL ID>'"
                    ],
                    'MOQ settings updated! Reloading...'
                );
            }
        },
        {
            id: 'cust-dump-addresses',
            title: 'Dump the address book',
            description: 'Every address on the customer with its internal id - the ids you need for order imports.',
            recordTypes: ['customer', 'vendor', 'partner'],
            kind: 'read',
            code: function () { return dumpSublist('addressbook'); }
        },

        // ── Items ────────────────────────────────────────────────────
        {
            id: 'item-case-eaches',
            title: 'Set inner / master case eaches',
            description: 'The two item fields the MOQ rules read when a line is entered in Inner or Master case UOM.',
            recordTypes: ['inventoryitem', 'assemblyitem', 'noninventoryitem', 'kititem',
                'serializedinventoryitem', 'lotnumberedinventoryitem'],
            kind: 'write',
            code: function (ctx) {
                return submitFields(
                    ctx.typeToken,
                    ctx.idToken,
                    [
                        "'custitem_inner_case_eaches': 6",
                        "'custitem_master_case_eaches': 24"
                    ],
                    'Case quantities updated! Reloading...'
                );
            }
        },
        {
            id: 'item-locations',
            title: 'Dump per-location inventory',
            description: 'On hand, available, committed and back-ordered by location straight off the item record.',
            recordTypes: ['inventoryitem', 'assemblyitem', 'serializedinventoryitem', 'lotnumberedinventoryitem'],
            kind: 'read',
            code: function () { return dumpSublist('locations'); }
        },

        // ── Custom records ───────────────────────────────────────────
        {
            id: 'cr-submitfields',
            title: 'submitFields on this custom record',
            description: 'Writes a custrecord_ field directly, skipping the form and any client-side validation.',
            recordTypes: ['customrecord*'],
            kind: 'write',
            code: function (ctx) {
                return submitFields(ctx.typeToken, ctx.idToken, ["'custrecord_<FIELD>': '<VALUE>'"], 'Saved! Reloading...');
            }
        },
        {
            id: 'cr-dump-custfields',
            title: 'Dump only the custrecord_ fields',
            description: 'Filters out the standard housekeeping fields so you see just your own columns.',
            recordTypes: ['customrecord*'],
            kind: 'read',
            code: function () {
                return [
                    "require(['N/currentRecord'], function (cr) {",
                    '    var rec = cr.get();',
                    '    console.table(rec.getFields()',
                    "        .filter(function (f) { return f.indexOf('custrecord') === 0; })",
                    '        .map(function (f) {',
                    '            var v = null, t = null;',
                    '            try { v = rec.getValue({ fieldId: f }); } catch (e) {}',
                    '            try { t = rec.getText({ fieldId: f }); } catch (e) {}',
                    '            return { field: f, value: v, text: t };',
                    '        }));',
                    '});'
                ].join('\n');
            }
        },
        {
            id: 'cr-delete',
            title: 'Delete this custom record',
            description: 'Permanent. There is no undo and no recycle bin - read the id in the snippet before you run it.',
            recordTypes: ['customrecord*'],
            kind: 'danger',
            code: function (ctx) {
                return [
                    "require(['N/record'], function (r) {",
                    "    if (!confirm('Delete " + ctx.typeToken + ' id ' + ctx.idToken + " permanently?')) return;",
                    '    r.delete.promise({',
                    "        type: '" + ctx.typeToken + "',",
                    '        id: ' + ctx.idToken,
                    '    }).then(function (id) {',
                    "        console.log('Deleted', id);",
                    '    }).catch(function (e) {',
                    '        console.error(e.name, e.message);',
                    '    });',
                    '});'
                ].join('\n');
            }
        },

        // ── Script deployments ───────────────────────────────────────
        {
            id: 'sd-set-status',
            title: 'Flip deployment status / log level',
            description: 'Move a deployment between Testing and Released, or crank the log level, without reloading the deployment form.',
            recordTypes: ['scriptdeployment'],
            kind: 'write',
            code: function (ctx) {
                return [
                    "// status:   TESTING | RELEASED | NOTSCHEDULED | SCHEDULED",
                    "// loglevel: DEBUG | AUDIT | ERROR | EMERGENCY",
                    "require(['N/record'], function (r) {",
                    '    r.submitFields({',
                    "        type: 'scriptdeployment',",
                    '        id: ' + ctx.idToken + ',',
                    '        values: {',
                    "            'status': 'TESTING',",
                    "            'loglevel': 'DEBUG',",
                    "            'isdeployed': true",
                    '        }',
                    '    });',
                    "    alert('Deployment updated! Reloading...');",
                    '    location.reload();',
                    '});'
                ].join('\n');
            }
        }
    ];

    /* ── Matching ─────────────────────────────────────────────────── */

    /**
     * True when a snippet's recordTypes list covers the given record type.
     * Supports '*' (any page) and trailing-'*' prefix matching.
     * @param {Object} snippet
     * @param {string|null} recordType
     * @returns {boolean}
     */
    function matchesType(snippet, recordType) {
        var types = snippet.recordTypes || [];
        for (var i = 0; i < types.length; i++) {
            var t = types[i];
            if (t === '*') return true;
            if (!recordType) continue;
            if (t.charAt(t.length - 1) === '*') {
                if (recordType.indexOf(t.slice(0, -1)) === 0) return true;
            } else if (t === recordType) {
                return true;
            }
        }
        return false;
    }

    /**
     * Splits the catalogue into the snippets scoped to this record type and
     * the ones that work anywhere.
     * @param {string|null} recordType
     * @returns {{ specific: Object[], general: Object[], other: Object[] }}
     */
    function partition(recordType) {
        var specific = [];
        var general = [];
        var other = [];

        SNIPPETS.forEach(function (s) {
            var isGeneral = (s.recordTypes || []).indexOf('*') >= 0;
            if (isGeneral) {
                general.push(s);
            } else if (matchesType(s, recordType)) {
                specific.push(s);
            } else {
                other.push(s);
            }
        });

        return { specific: specific, general: general, other: other };
    }

    window.TactaSnippetLibrary = {
        all: SNIPPETS,
        partition: partition,
        matchesType: matchesType,
        URL_TYPE_ALIASES: URL_TYPE_ALIASES
    };
})();

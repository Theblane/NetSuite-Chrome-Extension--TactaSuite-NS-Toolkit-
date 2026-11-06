/**
 * csv-template-generator.js
 * NetSuite TactaSuite - CSV Template Generator (Content Script)
 *
 * @author Blane Maher
 *
 * Opens a floating panel on NetSuite record pages, extracts all body fields
 * and sublist data via TactaNSBridge, and lets users download a CSV template
 * (all fields, mandatory only, with values, or manually selected).
 *
 * Activation: popup dispatches 'tacta:featureActivated' with featureId
 * 'csv-template-generator'. The service worker injects the MAIN-world client
 * script first so the Bridge handler is registered before this runs.
 */
(function () {
    'use strict';

    if (window.__tactaCSVTemplateGeneratorLoaded) return;
    window.__tactaCSVTemplateGeneratorLoaded = true;

    var FEATURE_ID = 'csv-template-generator';
    var SC = 'tacta-csv-tmpl'; // CSS scope prefix

    var _panelInstance = null;
    var _extractedData = null;

    // ── CSV helpers ──────────────────────────────────────────────────

    function escapeCsv(val) {
        if (val == null) return '';
        var str = String(val);
        if (str.indexOf(',') >= 0 || str.indexOf('"') >= 0 || str.indexOf('\n') >= 0) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    function sanitize(str) {
        return str.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 50);
    }

    function trunc(str, max) {
        if (!str) return '';
        max = max || 28;
        return str.length > max ? str.substring(0, max) + '…' : str;
    }

    // ── Build CSV content from extracted data + user options ─────────

    function buildCsv(data, opts) {
        var parts = [];
        var mode = data.mode;

        if (opts.fieldFilter === 'manual') {
            var selBody = opts.manualBodyFields || [];
            if (opts.sectionHeaders) parts.push('=== BODY FIELDS ===');
            var hdrs = selBody.map(function (f) { return f.label; });
            if (mode === 'view') {
                parts.push(['Internal ID'].concat(hdrs).map(escapeCsv).join(','));
                parts.push([escapeCsv(data.recordId || '')].concat(selBody.map(function (f) { return escapeCsv(f.value); })).join(','));
            } else {
                parts.push(['External ID'].concat(hdrs).map(escapeCsv).join(','));
                parts.push([''].concat(hdrs.map(function () { return ''; })).join(','));
            }
            parts.push('');

            var manualSubs = opts.manualSublists || {};
            Object.keys(manualSubs).forEach(function (name) {
                var ms = manualSubs[name];
                if (!ms.included || !ms.columns || ms.columns.length === 0) return;
                var sub = data.sublists[name];
                if (!sub) return;
                if (opts.sectionHeaders) parts.push('=== SUBLIST: ' + name.toUpperCase() + ' ===');
                parts.push(ms.columns.map(escapeCsv).join(','));
                if (mode === 'view' && sub.rows.length > 0) {
                    sub.rows.forEach(function (row) {
                        parts.push(ms.columns.map(function (h) { return escapeCsv(row[h] || ''); }).join(','));
                    });
                } else {
                    parts.push(ms.columns.map(function () { return ''; }).join(','));
                }
                parts.push('');
            });

        } else {
            var fields = data.bodyFields;
            if (opts.fieldFilter === 'mandatory') {
                fields = data.bodyFields.filter(function (f) { return f.label.endsWith(' *'); });
            } else if (opts.fieldFilter === 'withValues' && mode === 'view') {
                fields = data.bodyFields.filter(function (f) { return f.value && f.value.trim() !== ''; });
            }

            if (opts.sectionHeaders) parts.push('=== BODY FIELDS ===');
            var bHdrs = fields.map(function (f) { return f.label; });
            if (mode === 'view') {
                parts.push(['Internal ID'].concat(bHdrs).map(escapeCsv).join(','));
                parts.push([escapeCsv(data.recordId || '')].concat(fields.map(function (f) { return escapeCsv(f.value); })).join(','));
            } else {
                parts.push(['External ID'].concat(bHdrs).map(escapeCsv).join(','));
                parts.push([''].concat(bHdrs.map(function () { return ''; })).join(','));
            }
            parts.push('');

            if (opts.includeSublists) {
                var selSubs = opts.sublistSelections || {};
                Object.keys(data.sublists).forEach(function (name) {
                    if (selSubs.hasOwnProperty(name) && selSubs[name] === false) return;
                    var sub = data.sublists[name];
                    var subHdrs = sub.headers;
                    if (opts.fieldFilter === 'withValues' && mode === 'view' && sub.rows.length > 0) {
                        subHdrs = sub.headers.filter(function (h) {
                            return sub.rows.some(function (r) { return r[h] && String(r[h]).trim() !== ''; });
                        });
                    }
                    if (subHdrs.length === 0) return;
                    if (opts.sectionHeaders) parts.push('=== SUBLIST: ' + name.toUpperCase() + ' ===');
                    parts.push(subHdrs.map(escapeCsv).join(','));
                    if (mode === 'view' && sub.rows.length > 0) {
                        sub.rows.forEach(function (row) {
                            parts.push(subHdrs.map(function (h) { return escapeCsv(row[h] || ''); }).join(','));
                        });
                    } else {
                        parts.push(subHdrs.map(function () { return ''; }).join(','));
                    }
                    parts.push('');
                });
            }
        }

        return parts.join('\n');
    }

    // ── Download trigger ─────────────────────────────────────────────

    function triggerDownload(data, opts) {
        var csv = buildCsv(data, opts);
        var BOM = '﻿';
        var blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var fileName = 'NS_' + sanitize(data.recordType) + '_' + (data.recordId || 'new') + '_template.csv';
        var a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            if (a.parentNode) a.parentNode.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    // ── Render manual field-selection list ───────────────────────────

    function buildManualList(el, data) {
        var container = el('div', { className: SC + '-manual-list' });

        var bodyHeader = el('div', { className: SC + '-section-lbl', textContent: 'Body Fields' });
        container.appendChild(bodyHeader);

        data.bodyFields.forEach(function (field, idx) {
            var row = el('div', { className: SC + '-field-row' });
            var cb = el('input', { type: 'checkbox', id: SC + '-mf-b-' + idx });
            cb.checked = true;
            cb.dataset.type = 'body';
            cb.dataset.index = String(idx);
            var lbl = el('label', { htmlFor: SC + '-mf-b-' + idx, className: SC + '-field-lbl', textContent: field.label, title: field.label });
            row.appendChild(cb);
            row.appendChild(lbl);
            if (data.mode === 'view' && field.value) {
                row.appendChild(el('span', { className: SC + '-field-val', textContent: trunc(field.value), title: field.value }));
            }
            container.appendChild(row);
        });

        Object.keys(data.sublists).forEach(function (name) {
            var sub = data.sublists[name];
            var safeId = name.replace(/\W+/g, '_');

            var masterRow = el('div', { className: SC + '-sl-master-row' });
            var masterCb = el('input', { type: 'checkbox', id: SC + '-mf-slm-' + safeId });
            masterCb.checked = true;
            masterCb.dataset.type = 'sublistMaster';
            masterCb.dataset.sublist = name;
            var masterLbl = el('label', { htmlFor: SC + '-mf-slm-' + safeId, className: SC + '-sl-master-lbl', textContent: name });
            masterRow.appendChild(masterCb);
            masterRow.appendChild(masterLbl);
            container.appendChild(masterRow);

            var colGroup = el('div', { className: SC + '-sl-col-group' });
            colGroup.dataset.sublistGroup = name;
            var firstRow = (sub.rows && sub.rows[0]) || {};

            sub.headers.forEach(function (hdr, hidx) {
                var colRow = el('div', { className: SC + '-field-row' });
                var colCb = el('input', { type: 'checkbox', id: SC + '-mf-slc-' + safeId + '-' + hidx });
                colCb.checked = true;
                colCb.dataset.type = 'sublistCol';
                colCb.dataset.sublist = name;
                colCb.dataset.colIndex = String(hidx);
                var colLbl = el('label', { htmlFor: SC + '-mf-slc-' + safeId + '-' + hidx, className: SC + '-field-lbl', textContent: hdr, title: hdr });
                colRow.appendChild(colCb);
                colRow.appendChild(colLbl);
                if (data.mode === 'view' && firstRow[hdr]) {
                    colRow.appendChild(el('span', { className: SC + '-field-val', textContent: trunc(String(firstRow[hdr])), title: String(firstRow[hdr]) }));
                }
                colGroup.appendChild(colRow);
            });

            masterCb.addEventListener('change', function () {
                colGroup.classList.toggle(SC + '-sl-col-group--off', !masterCb.checked);
                colGroup.querySelectorAll('input[type="checkbox"]').forEach(function (c) { c.disabled = !masterCb.checked; });
            });

            container.appendChild(colGroup);
        });

        return container;
    }

    // ── Open panel ───────────────────────────────────────────────────

    function openPanel() {
        if (!window.TactaDOM) {
            console.error('[Tacta CSV Template] TactaDOM not available.');
            return;
        }

        var el = window.TactaDOM.createElement;

        // Inject feature CSS into shadow root
        if (window.TactaDOM.injectStylesheet) {
            try {
                var cssUrl = chrome.runtime.getURL('content/features/csv-template-generator/csv-template-generator.css');
                window.TactaDOM.injectStylesheet(cssUrl).catch(function () {});
            } catch (e) { /* ignore */ }
        }

        _panelInstance = window.TactaDOM.createPanel({
            title: 'CSV Template Generator',
            width: 430,
            height: 560,
            position: { top: '60px', right: '16px' },
            resizable: true,
            draggable: true,
            onClose: function () {
                _panelInstance = null;
                _extractedData = null;
            }
        });

        var panel = _panelInstance.panel;
        panel.classList.add(SC);

        var body = _panelInstance.body;
        body.style.overflowY = 'auto';

        // Loading state
        var loadingEl = el('div', { className: SC + '-loading' }, [
            el('div', { className: 'tacta-spinner' }),
            el('span', { className: SC + '-loading-txt', textContent: 'Detecting record…' })
        ]);
        body.appendChild(loadingEl);

        // Request data from MAIN world via Bridge
        var bridgeReq;
        try {
            bridgeReq = window.TactaNSBridge.request('extractCSVData', null, { timeout: 8000 });
        } catch (e) {
            bridgeReq = Promise.reject(new Error('TactaNSBridge not available: ' + e.message));
        }

        bridgeReq.then(function (data) {
            body.innerHTML = '';

            if (!data) {
                body.appendChild(el('div', { className: SC + '-error', textContent: 'No data returned. Open a NetSuite record page first.' }));
                return;
            }
            if (data.error) {
                body.appendChild(el('div', { className: SC + '-error', textContent: data.error }));
                return;
            }

            _extractedData = data;

            // ── Record info ──────────────────────────────────────────
            var modeBadge = { view: 'View', edit: 'Edit', create: 'New' };
            body.appendChild(el('div', { className: SC + '-info' }, [
                el('div', { className: SC + '-info-row' }, [
                    el('span', { className: SC + '-info-key', textContent: 'Type' }),
                    el('span', { className: SC + '-info-val', textContent: data.recordType })
                ]),
                el('div', { className: SC + '-info-row' }, [
                    el('span', { className: SC + '-info-key', textContent: 'ID' }),
                    el('span', { className: SC + '-info-val', textContent: data.recordId || 'New' })
                ]),
                el('div', { className: SC + '-info-row' }, [
                    el('span', { className: SC + '-info-key', textContent: 'Mode' }),
                    el('span', { className: SC + '-badge ' + SC + '-badge--' + data.mode, textContent: modeBadge[data.mode] || data.mode })
                ]),
                el('div', { className: SC + '-info-row' }, [
                    el('span', { className: SC + '-info-key', textContent: 'Fields' }),
                    el('span', { className: SC + '-info-val', textContent: data.fieldCount + ' body, ' + data.sublistCount + ' sublists' })
                ])
            ]));

            // ── Field filter ─────────────────────────────────────────
            var filterGroup = el('div', { className: SC + '-opt-group' });
            filterGroup.appendChild(el('div', { className: SC + '-opt-lbl', textContent: 'Fields to include' }));

            var filterDefs = [
                { value: 'all',        label: 'All fields',          disabled: false },
                { value: 'mandatory',  label: 'Mandatory only',       disabled: data.mode === 'view' },
                { value: 'withValues', label: 'With values only',     disabled: data.mode !== 'view' },
                { value: 'manual',     label: 'Manual selection ▼', disabled: false }
            ];

            var filterRadios = {};
            filterDefs.forEach(function (fd) {
                var row = el('div', { className: SC + '-opt-row' + (fd.disabled ? ' ' + SC + '-opt-row--off' : '') });
                var radio = el('input', { type: 'radio', name: SC + '-filter', id: SC + '-f-' + fd.value, value: fd.value });
                radio.checked = (fd.value === 'all');
                if (fd.disabled) radio.disabled = true;
                row.appendChild(radio);
                row.appendChild(el('label', { htmlFor: SC + '-f-' + fd.value, textContent: fd.label }));
                filterGroup.appendChild(row);
                filterRadios[fd.value] = radio;
            });
            body.appendChild(filterGroup);

            // ── Output options ───────────────────────────────────────
            var outGroup = el('div', { className: SC + '-opt-group' });
            outGroup.appendChild(el('div', { className: SC + '-opt-lbl', textContent: 'Output options' }));

            var inclSubCb = el('input', { type: 'checkbox', id: SC + '-incl-sl' });
            inclSubCb.checked = true;
            outGroup.appendChild(el('div', { className: SC + '-opt-row' }, [inclSubCb, el('label', { htmlFor: SC + '-incl-sl', textContent: 'Include sublists' })]));

            var inclHdrCb = el('input', { type: 'checkbox', id: SC + '-incl-hdr' });
            inclHdrCb.checked = true;
            outGroup.appendChild(el('div', { className: SC + '-opt-row' }, [inclHdrCb, el('label', { htmlFor: SC + '-incl-hdr', textContent: 'Include section headers' })]));
            body.appendChild(outGroup);

            // ── Per-sublist picker ────────────────────────────────────
            var subNames = Object.keys(data.sublists);
            var slPickerGroup = null;
            var slPickerCbs = {};

            if (subNames.length > 0) {
                slPickerGroup = el('div', { className: SC + '-opt-group' });
                slPickerGroup.appendChild(el('div', { className: SC + '-opt-lbl', textContent: 'Sublists to include' }));
                subNames.forEach(function (name) {
                    var cb = el('input', { type: 'checkbox', id: SC + '-sl-' + name.replace(/\W+/g, '_') });
                    cb.checked = true;
                    slPickerCbs[name] = cb;
                    slPickerGroup.appendChild(el('div', { className: SC + '-opt-row' }, [
                        cb,
                        el('label', { htmlFor: SC + '-sl-' + name.replace(/\W+/g, '_'), textContent: name })
                    ]));
                });
                body.appendChild(slPickerGroup);
            }

            // ── Manual selection panel ────────────────────────────────
            var manualEl = el('div', { className: SC + '-manual-panel', style: { display: 'none' } });
            var manualToggle = el('div', { className: SC + '-manual-toggle' });
            var manualArrow = el('span', { className: SC + '-arrow expanded', innerHTML: '&#9658;' });
            manualToggle.appendChild(manualArrow);
            manualToggle.appendChild(el('span', { textContent: 'Preview & select fields' }));
            var manualBody = el('div', { className: SC + '-manual-body open' });
            manualBody.appendChild(buildManualList(el, data));
            manualEl.appendChild(manualToggle);
            manualEl.appendChild(manualBody);
            body.appendChild(manualEl);

            manualToggle.addEventListener('click', function () {
                manualArrow.classList.toggle('expanded');
                manualBody.classList.toggle('open');
            });

            // ── Include-Sublists toggle interactions ─────────────────
            function setSublistPickerEnabled(enabled) {
                if (slPickerGroup) {
                    slPickerGroup.style.opacity = enabled ? '1' : '0.45';
                    Object.keys(slPickerCbs).forEach(function (n) { slPickerCbs[n].disabled = !enabled; });
                }
            }

            inclSubCb.addEventListener('change', function () {
                if (!filterRadios.manual.checked) setSublistPickerEnabled(inclSubCb.checked);
            });

            // ── Field filter change ──────────────────────────────────
            Object.keys(filterRadios).forEach(function (val) {
                filterRadios[val].addEventListener('change', function () {
                    if (!filterRadios[val].checked) return;
                    var isManual = (val === 'manual');
                    manualEl.style.display = isManual ? 'block' : 'none';
                    inclSubCb.disabled = isManual;
                    setSublistPickerEnabled(isManual ? false : inclSubCb.checked);
                });
            });

            // ── Download button ───────────────────────────────────────
            var dlBtn = el('button', { className: 'tacta-btn tacta-btn-primary ' + SC + '-dl-btn', textContent: 'Download CSV Template' });
            dlBtn.addEventListener('click', function () {
                if (!_extractedData) return;

                var filterVal = 'all';
                Object.keys(filterRadios).forEach(function (v) { if (filterRadios[v].checked) filterVal = v; });

                var opts = {
                    fieldFilter: filterVal,
                    includeSublists: inclSubCb.checked,
                    sectionHeaders: inclHdrCb.checked,
                    sublistSelections: {}
                };
                Object.keys(slPickerCbs).forEach(function (n) { opts.sublistSelections[n] = slPickerCbs[n].checked; });

                if (filterVal === 'manual') {
                    var manBodyFields = [];
                    panel.querySelectorAll('input[data-type="body"]').forEach(function (cb) {
                        if (cb.checked) manBodyFields.push(_extractedData.bodyFields[parseInt(cb.dataset.index)]);
                    });
                    var manSubs = {};
                    panel.querySelectorAll('input[data-type="sublistMaster"]').forEach(function (masterCb) {
                        var slName = masterCb.dataset.sublist;
                        var cols = [];
                        if (masterCb.checked) {
                            panel.querySelectorAll('input[data-type="sublistCol"][data-sublist="' + slName + '"]').forEach(function (cb) {
                                if (cb.checked) {
                                    var sub = _extractedData.sublists[slName];
                                    if (sub) cols.push(sub.headers[parseInt(cb.dataset.colIndex)]);
                                }
                            });
                        }
                        manSubs[slName] = { included: masterCb.checked, columns: cols };
                    });
                    opts.manualBodyFields = manBodyFields;
                    opts.manualSublists = manSubs;
                }

                triggerDownload(_extractedData, opts);

                var orig = dlBtn.textContent;
                dlBtn.textContent = 'Downloaded!';
                dlBtn.classList.add(SC + '-dl-btn--ok');
                setTimeout(function () {
                    dlBtn.textContent = orig;
                    dlBtn.classList.remove(SC + '-dl-btn--ok');
                }, 2000);
            });

            var dlWrap = el('div', { className: SC + '-dl-wrap' });
            dlWrap.appendChild(dlBtn);
            body.appendChild(dlWrap);

        }).catch(function (err) {
            body.innerHTML = '';
            body.appendChild(el('div', { className: SC + '-error', textContent: 'Error: ' + err.message }));
        });
    }

    function closePanel() {
        if (_panelInstance) {
            _panelInstance.close();
            _panelInstance = null;
            _extractedData = null;
        }
    }

    // ── Activation ───────────────────────────────────────────────────

    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === FEATURE_ID) {
            if (_panelInstance) {
                closePanel();
            } else {
                openPanel();
            }
        }
    });

})();

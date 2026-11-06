/**
 * screenshot-studio.js
 * NetSuite TactaSuite - Screenshot Studio (Content Script)
 *
 * @author Blane Maher
 *
 * Capture the current NetSuite page as a PNG with optional privacy masking
 * and a "clean" mode that hides NetSuite chrome. Three capture modes:
 *   Visible      - what is on screen right now
 *   Full page    - scroll-and-stitch of the whole document (background module)
 *   Record area  - the bounding box of #main_form clipped to the viewport
 *
 * Privacy masking wraps matching text in <span class="tacta-shot-mask"> so it
 * renders as a solid bar, and overlays input/textarea values that match. Every
 * change is recorded and reverted exactly after the capture.
 *
 * Activation: popup dispatches 'tacta:featureActivated' with featureId
 * 'screenshot-studio'. The background module drives full-page stitching by
 * sending shotPrepare / shotTagFixed / shotScrollTo / shotUntagFixed /
 * shotRestore to this script via chrome.tabs.sendMessage.
 */
(function () {
    'use strict';

    if (window.__tactaScreenshotStudioLoaded) return;
    window.__tactaScreenshotStudioLoaded = true;

    var FEATURE_ID = 'screenshot-studio';
    var SC = 'tacta-shot';
    var STORAGE_KEY = 'tacta_shot_settings';
    var PANEL_CSS = 'content/features/screenshot-studio/screenshot-studio.css';
    var PAGE_CSS = 'content/features/screenshot-studio/screenshot-studio-page.css';

    var HOST_ID = 'tacta-toolkit-host';
    var MASK_CLASS = 'tacta-shot-mask';
    var MASK_LAYER_CLASS = 'tacta-shot-mask-layer';
    var MASK_OVERLAY_CLASS = 'tacta-shot-mask-overlay';
    var FIXED_CLASS = 'tacta-shot-fixed';
    var BODY_CAPTURING = 'tacta-shot-capturing';
    var BODY_CLEAN = 'tacta-shot-clean';

    var DEFAULTS = {
        mode: 'visible',
        mask: true,
        emails: true,
        phones: true,
        taxIds: true,
        cards: true,
        currency: true,
        names: true,
        customText: '',
        clean: false
    };

    var _panel = null;
    var _settings = null;
    var _busy = false;
    var _pageCssInjected = false;
    var _lastResult = null;
    var _ui = {};

    // Scroll position remembered by shotPrepare, restored by shotRestore.
    var _savedScroll = null;
    // Elements tagged by tagFixedElements, cleared by untagFixedElements.
    var _taggedFixed = [];

    // ── Messaging ────────────────────────────────────────────────────

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

    // ── Small helpers ────────────────────────────────────────────────

    function settle(ms) {
        return new Promise(function (resolve) {
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    setTimeout(resolve, ms === undefined ? 120 : ms);
                });
            });
        });
    }

    function getMetrics() {
        var doc = document.documentElement;
        var body = document.body;
        return {
            scrollHeight: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
            scrollWidth: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0),
            viewportHeight: doc.clientHeight,
            viewportWidth: doc.clientWidth,
            innerHeight: window.innerHeight,
            innerWidth: window.innerWidth,
            dpr: window.devicePixelRatio || 1,
            scrollX: window.scrollX,
            scrollY: window.scrollY
        };
    }

    function scrollToInstant(x, y) {
        try {
            window.scrollTo({ left: x, top: y, behavior: 'instant' });
        } catch (_) {
            window.scrollTo(x, y);
        }
    }

    function getPageContext() {
        var info = window.__tactaPageInfo || null;
        var recordType = info && info.recordType ? String(info.recordType) : null;
        var recordId = info && info.recordId ? String(info.recordId) : null;
        if (!recordType) {
            var m = window.location.href.match(/[?&](?:rectype|recordtype|type)=([^&#]+)/i);
            if (m) recordType = decodeURIComponent(m[1]);
        }
        if (!recordId) {
            var im = window.location.href.match(/[?&]id=(\d+)/);
            if (im) recordId = im[1];
        }
        return { recordType: recordType, recordId: recordId };
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function buildFilename() {
        var ctx = getPageContext();
        var d = new Date();
        var stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
            pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
        var parts = ['netsuite'];
        if (ctx.recordType) parts.push(ctx.recordType);
        parts.push(ctx.recordId || 'page');
        parts.push(stamp);
        return parts.map(function (p) {
            return String(p).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
        }).filter(Boolean).join('-') + '.png';
    }

    function escapeRegExp(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ── Settings ─────────────────────────────────────────────────────

    function loadSettings() {
        return new Promise(function (resolve) {
            try {
                chrome.storage.local.get(STORAGE_KEY, function (data) {
                    var stored = (data && data[STORAGE_KEY]) || {};
                    var merged = {};
                    Object.keys(DEFAULTS).forEach(function (k) {
                        merged[k] = Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : DEFAULTS[k];
                    });
                    resolve(merged);
                });
            } catch (_) {
                resolve(Object.assign({}, DEFAULTS));
            }
        });
    }

    function saveSettings() {
        try {
            var out = {};
            out[STORAGE_KEY] = _settings;
            chrome.storage.local.set(out);
        } catch (_) { /* ignore */ }
    }

    // ── Fixed / sticky element handling ──────────────────────────────

    /**
     * Tag every fixed/sticky element outside the toolkit with a class and add
     * a body class; the page CSS turns them static for the capture. Idempotent.
     * @returns {Object} fresh metrics after layout settles
     */
    function tagFixedElements() {
        if (!document.body.classList.contains(BODY_CAPTURING)) {
            var all = document.body.getElementsByTagName('*');
            var limit = Math.min(all.length, 60000);
            for (var i = 0; i < limit; i++) {
                var elm = all[i];
                if (elm.id === HOST_ID) continue;
                var pos;
                try { pos = window.getComputedStyle(elm).position; } catch (_) { continue; }
                if (pos === 'fixed' || pos === 'sticky') {
                    elm.classList.add(FIXED_CLASS);
                    _taggedFixed.push(elm);
                }
            }
            document.body.classList.add(BODY_CAPTURING);
        }
        return getMetrics();
    }

    function untagFixedElements() {
        for (var i = 0; i < _taggedFixed.length; i++) {
            try { _taggedFixed[i].classList.remove(FIXED_CLASS); } catch (_) { /* ignore */ }
        }
        _taggedFixed = [];
        document.body.classList.remove(BODY_CAPTURING);
    }

    // ── Privacy masking ──────────────────────────────────────────────

    /**
     * Build the list of active matchers from settings.
     * Each matcher: { re: RegExp (global), cellsOnly?: boolean, accept?: fn(hit) }
     *
     * NetSuite pages are full of long digit runs that are NOT secrets:
     * document numbers (SOR2205085076), internal ids, IMEIs, line keys. The
     * patterns therefore require the formatting people actually type for a
     * phone number or tax id, refuse to start inside an alphanumeric token,
     * and card numbers must pass the Luhn check.
     */
    function luhnOk(digits) {
        var sum = 0, dbl = false;
        for (var i = digits.length - 1; i >= 0; i--) {
            var d = digits.charCodeAt(i) - 48;
            if (dbl) { d *= 2; if (d > 9) d -= 9; }
            sum += d; dbl = !dbl;
        }
        return sum % 10 === 0;
    }
    function buildMatchers(s) {
        var list = [];
        if (!s.mask) return list;
        if (s.emails) {
            list.push({ re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g });
        }
        if (s.phones) {
            // (555) 123-4567, 555-123-4567, 555.123.4567, +1 555 123 4567: separators required
            list.push({ re: /(?<![A-Za-z0-9-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![A-Za-z0-9-])/g });
        }
        if (s.taxIds) {
            // SSN/ITIN 123-45-6789 or EIN 12-3456789; bare 9-digit runs are internal ids far more often than tax ids
            list.push({ re: /(?<![A-Za-z0-9-])(?:\d{3}-\d{2}-\d{4}|\d{2}-\d{7})(?![A-Za-z0-9-])/g });
        }
        if (s.cards) {
            // 13 to 19 digits with optional single space/dash separators, Luhn-valid, not part of a longer token
            list.push({
                re: /(?<![A-Za-z0-9-])\d(?:[ -]?\d){12,18}(?![A-Za-z0-9-])/g,
                accept: function (hit) {
                    var bare = hit.replace(/[ -]/g, '');
                    // A bare 15-digit run is an IMEI (also Luhn-valid) far more often than an
                    // unformatted Amex number; Amex numbers on screen carry separators.
                    if (bare.length === 15 && bare === hit) return false;
                    return luhnOk(bare);
                }
            });
        }
        if (s.currency) {
            list.push({ re: /[$€£]\s?-?\(?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\)?/g });
            list.push({ re: /(?<![\d.,-])-?\(?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?![\d.])/g, cellsOnly: true });
        }
        var custom = String(s.customText || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
        if (custom.length) {
            custom.sort(function (a, b) { return b.length - a.length; });
            list.push({ re: new RegExp(custom.map(escapeRegExp).join('|'), 'gi') });
        }
        return list;
    }

    function collectRanges(text, matchers, cellsOk) {
        var ranges = [];
        for (var m = 0; m < matchers.length; m++) {
            var matcher = matchers[m];
            if (matcher.cellsOnly && !cellsOk) continue;
            matcher.re.lastIndex = 0;
            var hit;
            while ((hit = matcher.re.exec(text)) !== null) {
                if (hit[0].length === 0) { matcher.re.lastIndex++; continue; }
                if (matcher.accept && !matcher.accept(hit[0])) continue;
                ranges.push([hit.index, hit.index + hit[0].length]);
            }
        }
        if (ranges.length < 2) return ranges;
        ranges.sort(function (a, b) { return a[0] - b[0]; });
        var merged = [ranges[0]];
        for (var i = 1; i < ranges.length; i++) {
            var last = merged[merged.length - 1];
            if (ranges[i][0] <= last[1]) {
                last[1] = Math.max(last[1], ranges[i][1]);
            } else {
                merged.push(ranges[i]);
            }
        }
        return merged;
    }

    function matchesAny(text, matchers, cellsOk) {
        for (var m = 0; m < matchers.length; m++) {
            if (matchers[m].cellsOnly && !cellsOk) continue;
            matchers[m].re.lastIndex = 0;
            var hit;
            while ((hit = matchers[m].re.exec(text)) !== null) {
                if (hit[0].length === 0) { matchers[m].re.lastIndex++; continue; }
                if (!matchers[m].accept || matchers[m].accept(hit[0])) { matchers[m].re.lastIndex = 0; return true; }
            }
            matchers[m].re.lastIndex = 0;
        }
        return false;
    }

    var SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION|SELECT|TITLE|IFRAME|SVG|CANVAS)$/i;

    function isSkippableParent(parent) {
        if (!parent || parent.nodeType !== 1) return true;
        if (SKIP_TAGS.test(parent.tagName)) return true;
        if (parent.closest('#' + HOST_ID + ', .' + MASK_CLASS + ', .' + MASK_LAYER_CLASS + ', [contenteditable="true"]')) return true;
        return false;
    }

    function collectTextNodes(root) {
        var nodes = [];
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function (n) {
                if (!n.nodeValue || !/\S/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
                return isSkippableParent(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            }
        });
        var n;
        while ((n = walker.nextNode())) nodes.push(n);
        return nodes;
    }

    /**
     * Replace one text node with text + mask spans. Keeps the original node so
     * restore is exact.
     */
    function wrapRanges(textNode, ranges, records) {
        var parent = textNode.parentNode;
        if (!parent || !ranges.length) return;
        var text = textNode.nodeValue;
        var frag = document.createDocumentFragment();
        var inserted = [];
        var pos = 0;
        for (var i = 0; i < ranges.length; i++) {
            var r = ranges[i];
            if (r[0] > pos) {
                var lead = document.createTextNode(text.slice(pos, r[0]));
                frag.appendChild(lead);
                inserted.push(lead);
            }
            var span = document.createElement('span');
            span.className = MASK_CLASS;
            span.textContent = text.slice(r[0], r[1]);
            frag.appendChild(span);
            inserted.push(span);
            pos = r[1];
        }
        if (pos < text.length) {
            var tail = document.createTextNode(text.slice(pos));
            frag.appendChild(tail);
            inserted.push(tail);
        }
        parent.replaceChild(frag, textNode);
        records.push({ parent: parent, original: textNode, inserted: inserted });
    }

    var ENTITY_LINK_SEL = 'a[href*="custjob.nl"], a[href*="/entity/"], a[href*="vendor.nl"], a[href*="contact.nl"], ' +
        'a[href*="employee.nl"], a[href*="partner.nl"], a[href*="otherlists/customer"]';
    var ENTITY_INPUT_SEL = '#inpt_entity, #inpt_customer, #inpt_vendor, #inpt_employee, #inpt_contact, #inpt_partner, ' +
        '#inpt_billaddresslist, #inpt_shipaddresslist';
    var ADDRESS_SEL = '.uir-field-wrapper[data-field-name$="address"] .uir-field-input, ' +
        '.uir-field-wrapper[data-field-name$="addressee"] .uir-field-input, ' +
        '#billaddress_fs, #shipaddress_fs, #billaddressee_fs, #shipaddressee_fs, #address_fs, .uir-address, ' +
        '[id$="address_fs"], [id$="addressee_fs"]';

    function maskWholeElement(elm, records) {
        var nodes = collectTextNodes(elm);
        for (var n = 0; n < nodes.length; n++) {
            var txt = nodes[n].nodeValue;
            var start = txt.search(/\S/);
            var end = txt.replace(/\s+$/, '').length;
            if (start < 0 || end <= start) continue;
            wrapRanges(nodes[n], [[start, end]], records);
        }
    }

    /**
     * Names worth masking: the record's entity name in the header, every
     * customer / vendor / employee / contact link, and the entity field value
     * (view or edit mode). A name that starts with an id ("534921 Acme Corp")
     * is also added without the id so a bare mention elsewhere is caught.
     */
    function collectEntityNames() {
        var names = [];
        function add(t) {
            t = String(t || '').replace(/\s+/g, ' ').trim();
            if (t.length < 3 || names.indexOf(t) !== -1) return;
            names.push(t);
            var m = t.match(/^\d+\s+(.{3,})$/);
            if (m && names.indexOf(m[1]) === -1) names.push(m[1]);
        }
        var rn = document.querySelector('.uir-record-name');
        if (rn) add(rn.textContent);
        var links = document.querySelectorAll(ENTITY_LINK_SEL);
        for (var i = 0; i < links.length; i++) {
            if (links[i].closest('#ns_header, #ns_navigation, .ns-header, #' + HOST_ID)) continue;
            add(links[i].textContent);
        }
        var ew = document.querySelector('.uir-field-wrapper[data-field-name="entity"] .uir-field-input, .uir-field-wrapper[data-field-name="customer"] .uir-field-input');
        if (ew) add(ew.textContent);
        var inputs = document.querySelectorAll(ENTITY_INPUT_SEL);
        for (var k = 0; k < inputs.length; k++) add(inputs[k].value);
        return names;
    }

    function maskEntities(records, matchers) {
        var names = collectEntityNames();
        if (names.length) {
            names.sort(function (a, b) { return b.length - a.length; });
            // Every occurrence anywhere on the page (memo, sublists, titles), plus inputs via maskInputs.
            matchers.push({ re: new RegExp(names.map(escapeRegExp).join('|'), 'gi') });
        }
        // Black out the header name, entity links and address blocks wholesale.
        var els = document.querySelectorAll('.uir-record-name, ' + ENTITY_LINK_SEL + ', ' + ADDRESS_SEL);
        for (var i = 0; i < els.length; i++) {
            var elm = els[i];
            if (elm.closest('#ns_header, #ns_navigation, .ns-header, #' + HOST_ID)) continue;
            maskWholeElement(elm, records);
        }
    }

    function maskTextNodes(matchers, records) {
        if (!matchers.length) return;
        var nodes = collectTextNodes(document.body);
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var parent = node.parentElement;
            if (!parent || !node.parentNode) continue;
            var cellsOk = !!parent.closest('td, th, span');
            var ranges = collectRanges(node.nodeValue, matchers, cellsOk);
            if (ranges.length) wrapRanges(node, ranges, records);
        }
    }

    /**
     * Inputs cannot contain spans, so matching values get an absolutely
     * positioned overlay bar in a layer appended to body.
     * @returns {HTMLElement|null} the overlay layer
     */
    function maskInputs(matchers) {
        if (!matchers.length) return null;
        var controls = document.querySelectorAll('input, textarea');
        var layer = null;
        var offsetX = 0;
        var offsetY = 0;
        for (var i = 0; i < controls.length; i++) {
            var c = controls[i];
            if (c.closest('#' + HOST_ID)) continue;
            var type = String(c.type || '').toLowerCase();
            if (/^(hidden|checkbox|radio|button|submit|reset|image|file|range|color|password)$/.test(type)) continue;
            var val = String(c.value || '');
            if (!val.trim() || !matchesAny(val, matchers, true)) continue;
            var rect = c.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) continue;
            if (!layer) {
                layer = document.createElement('div');
                layer.className = MASK_LAYER_CLASS;
                layer.setAttribute('aria-hidden', 'true');
                document.body.appendChild(layer);
                var lr = layer.getBoundingClientRect();
                offsetX = lr.left + window.scrollX;
                offsetY = lr.top + window.scrollY;
            }
            var o = document.createElement('div');
            o.className = MASK_OVERLAY_CLASS;
            o.style.left = (rect.left + window.scrollX - offsetX) + 'px';
            o.style.top = (rect.top + window.scrollY - offsetY) + 'px';
            o.style.width = rect.width + 'px';
            o.style.height = rect.height + 'px';
            layer.appendChild(o);
        }
        return layer;
    }

    function restoreMasks(records, layer) {
        var parents = [];
        for (var i = records.length - 1; i >= 0; i--) {
            var rec = records[i];
            var anchor = null;
            for (var k = 0; k < rec.inserted.length; k++) {
                if (rec.inserted[k].parentNode === rec.parent) { anchor = rec.inserted[k]; break; }
            }
            if (anchor) {
                rec.parent.insertBefore(rec.original, anchor);
            } else if (rec.parent.isConnected) {
                rec.parent.appendChild(rec.original);
            }
            for (var j = 0; j < rec.inserted.length; j++) {
                var node = rec.inserted[j];
                if (node.parentNode) node.parentNode.removeChild(node);
            }
            if (parents.indexOf(rec.parent) === -1) parents.push(rec.parent);
        }
        for (var p = 0; p < parents.length; p++) {
            try { parents[p].normalize(); } catch (_) { /* ignore */ }
        }
        if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    }

    // ── Capture session (hide UI, clean, mask; then undo) ────────────

    function beginSession(settings, mode, opts) {
        opts = opts || {};
        var records = [];
        var layer = null;
        var host = document.getElementById(HOST_ID);
        var panelEl = _panel ? _panel.panel : null;
        var prevPanelVis = panelEl ? panelEl.style.visibility : '';
        var prevHostVis = host ? host.style.visibility : '';
        var hostHidden = false;
        var scroll = { x: window.scrollX, y: window.scrollY };

        if (panelEl && !opts.keepPanel) panelEl.style.visibility = 'hidden';
        if (host && !opts.keepPanel && (mode === 'full' || settings.clean)) {
            host.style.visibility = 'hidden';
            hostHidden = true;
        }
        if (settings.clean) document.body.classList.add(BODY_CLEAN);
        if (mode === 'full') tagFixedElements();

        if (settings.mask) {
            var matchers = buildMatchers(settings);
            if (settings.names) maskEntities(records, matchers);
            maskTextNodes(matchers, records);
            layer = maskInputs(matchers);
        }

        return {
            maskCount: records.length + (layer ? layer.childNodes.length : 0),
            restore: function () {
                try { restoreMasks(records, layer); } catch (e) { console.warn('[Tacta Screenshot] mask restore:', e); }
                if (mode === 'full') untagFixedElements();
                document.body.classList.remove(BODY_CLEAN);
                if (hostHidden && host) host.style.visibility = prevHostVis;
                if (panelEl && !opts.keepPanel) panelEl.style.visibility = prevPanelVis;
                if (!opts.keepPanel) scrollToInstant(scroll.x, scroll.y);
            }
        };
    }

    // ── Record area ──────────────────────────────────────────────────

    function getRecordAreaRect() {
        var form = document.getElementById('main_form');
        if (!form) {
            var title = document.querySelector('.uir-page-title');
            form = title ? title.closest('form') : null;
        }
        if (!form) return null;
        var r = form.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return null;

        // Bring the top of the form into view so the crop starts at the title.
        if (r.top < 0 || r.top > window.innerHeight * 0.5) {
            scrollToInstant(window.scrollX, Math.max(0, window.scrollY + r.top - 8));
            r = form.getBoundingClientRect();
        }
        var vw = document.documentElement.clientWidth;
        var vh = document.documentElement.clientHeight;
        var left = Math.max(0, r.left);
        var top = Math.max(0, r.top);
        var right = Math.min(vw, r.right);
        var bottom = Math.min(vh, r.bottom);
        if (right - left < 10 || bottom - top < 10) return null;
        return { left: left, top: top, width: right - left, height: bottom - top };
    }

    // ── Capture flow ─────────────────────────────────────────────────

    function runCapture() {
        if (_busy || !_panel) return;
        endMaskPreview();
        _busy = true;
        setStatus('Capturing...', '');
        setButtonsDisabled(true);

        var settings = Object.assign({}, _settings);
        var mode = settings.mode;
        var session = null;
        var effectiveMode = mode;

        Promise.resolve().then(function () {
            session = beginSession(settings, mode);
            return settle(mode === 'full' ? 200 : 120);
        }).then(function () {
            if (mode === 'full') {
                return sendMessage({ action: 'shotCaptureFull' });
            }
            if (mode === 'area') {
                var rect = getRecordAreaRect();
                if (rect) {
                    return settle(120).then(function () {
                        return sendMessage({ action: 'shotCaptureArea', rect: rect, viewport: getMetrics() });
                    });
                }
                effectiveMode = 'visible';
            }
            return sendMessage({ action: 'shotCaptureVisible' });
        }).then(function (result) {
            if (session) { session.restore(); }
            if (!result || !result.dataUrl) throw new Error('No image was returned.');
            result.maskCount = session ? session.maskCount : 0;
            result.fellBack = (mode === 'area' && effectiveMode === 'visible');
            _lastResult = result;
            showPreview(result);
            var note = result.width + ' x ' + result.height + ' px';
            if (result.truncated) note += ' (truncated)';
            window.TactaDOM.showToast('Screenshot captured: ' + note, 'success', 2500);
        }).catch(function (err) {
            if (session) { try { session.restore(); } catch (_) { /* ignore */ } }
            var msg = err && err.message ? err.message : String(err);
            // captureVisibleTab needs the one-time activeTab grant that only a click
            // on the toolbar icon provides. Opening the studio another way (console
            // hook, automation) lands here.
            if (/activeTab|all_urls/i.test(msg)) {
                msg = 'Chrome needs permission to capture this tab. Click the TactaSuite toolbar icon, then press Capture again.';
            }
            setStatus('Capture failed: ' + msg, 'error');
            try { window.TactaDOM.showToast('Screenshot failed: ' + msg, 'error', 5000); } catch (_) { /* ignore */ }
        }).then(function () {
            _busy = false;
            setButtonsDisabled(false);
        });
    }

    // ── Output actions ───────────────────────────────────────────────

    function copyToClipboard(result) {
        if (!result) return;
        if (typeof ClipboardItem !== 'function' || !navigator.clipboard || !navigator.clipboard.write) {
            setStatus('Clipboard image write is not supported in this browser.', 'error');
            return;
        }
        fetch(result.dataUrl).then(function (r) { return r.blob(); }).then(function (blob) {
            var item = {};
            item['image/png'] = blob;
            return navigator.clipboard.write([new ClipboardItem(item)]);
        }).then(function () {
            setStatus('Copied to clipboard.', 'ok');
            window.TactaDOM.showToast('Screenshot copied to clipboard', 'success', 2000);
        }).catch(function (err) {
            setStatus('Copy failed: ' + (err && err.message ? err.message : String(err)), 'error');
        });
    }

    function downloadImage(result) {
        if (!result) return;
        var name = buildFilename();
        var a = document.createElement('a');
        a.href = result.dataUrl;
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 0);
        setStatus('Downloaded ' + name, 'ok');
    }

    // ── Panel UI ─────────────────────────────────────────────────────

    function el(tag, attrs, children) {
        return window.TactaDOM.createElement(tag, attrs, children);
    }

    function setStatus(text, kind) {
        if (!_ui.status) return;
        _ui.status.textContent = text || '';
        _ui.status.className = SC + '-status' + (kind ? ' ' + SC + '-status--' + kind : '');
    }

    function setButtonsDisabled(disabled) {
        [_ui.captureBtn, _ui.copyBtn, _ui.downloadBtn, _ui.recaptureBtn].forEach(function (b) {
            if (b) b.disabled = !!disabled;
        });
    }

    function makeCheckbox(key, label, onChange) {
        var input = el('input', { type: 'checkbox' });
        input.checked = !!_settings[key];
        input.addEventListener('change', function () {
            _settings[key] = input.checked;
            saveSettings();
            if (onChange) onChange();
        });
        var wrap = el('label', { className: SC + '-check' }, [input, el('span', { textContent: label })]);
        wrap._input = input;
        return wrap;
    }

    function makeRadio(value, label) {
        var input = el('input', { type: 'radio', name: SC + '-mode', value: value });
        input.checked = _settings.mode === value;
        input.addEventListener('change', function () {
            if (input.checked) {
                _settings.mode = value;
                saveSettings();
            }
        });
        return el('label', { className: SC + '-radio' }, [input, el('span', { textContent: label })]);
    }

    function updateMaskEnabledState() {
        var on = !!_settings.mask;
        if (_ui.maskGroup) _ui.maskGroup.classList.toggle(SC + '-disabled', !on);
        (_ui.maskInputs || []).forEach(function (i) { i.disabled = !on; });
        if (_ui.customInput) _ui.customInput.disabled = !on;
    }

    function buildControls(body) {
        // Mode
        body.appendChild(el('div', { className: SC + '-section' }, [
            el('div', { className: SC + '-section-title', textContent: 'Mode' }),
            el('div', { className: SC + '-row' }, [
                makeRadio('visible', 'Visible'),
                makeRadio('full', 'Full page'),
                makeRadio('area', 'Record area')
            ])
        ]));

        // Privacy mask
        var masterCb = makeCheckbox('mask', 'Privacy mask', updateMaskEnabledState);
        masterCb.classList.add(SC + '-check--master');

        var subChecks = [
            makeCheckbox('emails', 'Emails'),
            makeCheckbox('phones', 'Phone numbers'),
            makeCheckbox('taxIds', 'Tax / SSN / EIN ids'),
            makeCheckbox('cards', 'Card numbers'),
            makeCheckbox('currency', 'Currency amounts'),
            makeCheckbox('names', 'Customers, vendors and people (incl. addresses)')
        ];
        _ui.maskInputs = subChecks.map(function (c) { return c._input; });

        _ui.customInput = el('input', {
            type: 'text',
            className: 'tacta-input ' + SC + '-custom',
            placeholder: 'Custom text to mask, comma-separated'
        });
        _ui.customInput.value = _settings.customText || '';
        _ui.customInput.addEventListener('input', function () {
            _settings.customText = _ui.customInput.value;
            saveSettings();
        });

        _ui.maskGroup = el('div', { className: SC + '-mask-group' }, [
            el('div', { className: SC + '-grid' }, subChecks),
            _ui.customInput
        ]);

        body.appendChild(el('div', { className: SC + '-section' }, [
            masterCb,
            _ui.maskGroup
        ]));
        updateMaskEnabledState();

        // Clean mode
        body.appendChild(el('div', { className: SC + '-section' }, [
            makeCheckbox('clean', 'Clean mode (hide NetSuite header, nav and toolkit UI)')
        ]));

        // Capture
        _ui.captureBtn = el('button', { className: 'tacta-btn tacta-btn-primary', textContent: 'Capture' });
        _ui.captureBtn.addEventListener('click', runCapture);
        _ui.previewMaskBtn = el('button', { className: 'tacta-btn tacta-btn-sm', textContent: 'Preview masks', title: 'Show on the page what the capture will black out' });
        _ui.previewMaskBtn.addEventListener('click', toggleMaskPreview);
        _ui.status = el('div', { className: SC + '-status' });
        body.appendChild(el('div', { className: SC + '-actions' }, [_ui.captureBtn, _ui.previewMaskBtn, _ui.status]));

        // Preview (hidden until first capture)
        _ui.previewImg = el('img', { className: SC + '-preview-img', alt: 'Screenshot preview' });
        _ui.previewMeta = el('div', { className: SC + '-preview-meta' });
        _ui.copyBtn = el('button', { className: 'tacta-btn tacta-btn-sm', textContent: 'Copy to clipboard' });
        _ui.downloadBtn = el('button', { className: 'tacta-btn tacta-btn-sm', textContent: 'Download' });
        _ui.recaptureBtn = el('button', { className: 'tacta-btn tacta-btn-sm', textContent: 'Re-capture' });
        _ui.copyBtn.addEventListener('click', function () { copyToClipboard(_lastResult); });
        _ui.downloadBtn.addEventListener('click', function () { downloadImage(_lastResult); });
        _ui.recaptureBtn.addEventListener('click', runCapture);

        _ui.preview = el('div', { className: SC + '-preview' }, [
            el('div', { className: SC + '-section-title', textContent: 'Preview' }),
            el('div', { className: SC + '-preview-frame' }, [_ui.previewImg]),
            _ui.previewMeta,
            el('div', { className: SC + '-row' }, [_ui.copyBtn, _ui.downloadBtn, _ui.recaptureBtn])
        ]);
        _ui.preview.style.display = 'none';
        body.appendChild(_ui.preview);
    }

    // ── Mask preview on the live page ───────────────────────────────

    var _maskPreview = null;

    function toggleMaskPreview() {
        if (_maskPreview) { endMaskPreview(); return; }
        if (!_settings.mask) { setStatus('Turn on Privacy mask first.', 'error'); return; }
        try {
            _maskPreview = beginSession(_settings, 'visible', { keepPanel: true });
            if (_ui.previewMaskBtn) _ui.previewMaskBtn.textContent = 'Clear preview';
            setStatus(_maskPreview.maskCount + ' masked on the page. Adjust the options, then Capture.', '');
        } catch (e) {
            _maskPreview = null;
            setStatus('Preview failed: ' + (e && e.message ? e.message : String(e)), 'error');
        }
    }

    function endMaskPreview() {
        if (!_maskPreview) return;
        try { _maskPreview.restore(); } catch (_) { /* ignore */ }
        _maskPreview = null;
        if (_ui.previewMaskBtn) _ui.previewMaskBtn.textContent = 'Preview masks';
    }

    function showPreview(result) {
        if (!_ui.preview) return;
        _ui.previewImg.src = result.dataUrl;
        _ui.preview.style.display = '';

        var bits = [result.width + ' x ' + result.height + ' px'];
        var modeLabel = { visible: 'visible', full: 'full page', area: 'record area' }[result.mode] || result.mode;
        bits.push(modeLabel);
        if (result.tiles) bits.push(result.tiles + ' tiles');
        if (result.maskCount) bits.push(result.maskCount + ' masked');
        _ui.previewMeta.innerHTML = '';
        _ui.previewMeta.appendChild(el('span', { textContent: bits.join('  |  ') }));
        if (result.truncated) {
            _ui.previewMeta.appendChild(el('span', {
                className: 'tacta-badge tacta-badge--warning ' + SC + '-badge',
                textContent: 'Truncated at 8000 px'
            }));
        }
        if (result.fellBack) {
            _ui.previewMeta.appendChild(el('span', {
                className: 'tacta-badge tacta-badge--info ' + SC + '-badge',
                textContent: 'No record form found, captured visible area'
            }));
        }
        setStatus('Ready.', 'ok');
    }

    function ensurePageCss() {
        if (_pageCssInjected) return Promise.resolve();
        _pageCssInjected = true;
        return sendMessage({
            action: 'injectFeatureFiles',
            featureId: FEATURE_ID,
            css: [PAGE_CSS],
            js: [],
            injectScripts: []
        }).catch(function (err) {
            _pageCssInjected = false;
            console.warn('[Tacta Screenshot] page CSS injection failed:', err);
        });
    }

    function openPanel() {
        if (!window.TactaDOM) {
            console.error('[Tacta Screenshot] TactaDOM not available.');
            return;
        }

        if (window.TactaDOM.injectStylesheet) {
            try {
                window.TactaDOM.injectStylesheet(chrome.runtime.getURL(PANEL_CSS)).catch(function () {});
            } catch (_) { /* ignore */ }
        }
        ensurePageCss();

        loadSettings().then(function (settings) {
            if (_panel) return;
            _settings = settings;
            _ui = {};

            _panel = window.TactaDOM.createPanel({
                title: 'Screenshot Studio',
                width: 440,
                height: 'auto',
                position: { top: '60px', right: '16px' },
                resizable: true,
                draggable: true,
                closeOnClickOutside: false,
                onClose: function () { endMaskPreview(); _panel = null; _ui = {}; }
            });
            _panel.panel.classList.add(SC);
            buildControls(_panel.body);
            setStatus('Choose a mode and press Capture.', '');
        });
    }

    function closePanel() {
        if (_panel) {
            _panel.close();
            _panel = null;
        }
    }

    // ── Background protocol handlers ─────────────────────────────────

    function handleShotMessage(message, sendResponse) {
        switch (message.action) {
            case 'shotPrepare': {
                _savedScroll = { x: window.scrollX, y: window.scrollY };
                sendResponse(getMetrics());
                return false;
            }
            case 'shotTagFixed': {
                // Layout shifts when fixed elements go static; report fresh
                // metrics once the page has had a frame to settle.
                tagFixedElements();
                settle(80).then(function () { sendResponse(getMetrics()); });
                return true;
            }
            case 'shotUntagFixed': {
                untagFixedElements();
                sendResponse({ ok: true });
                return false;
            }
            case 'shotScrollTo': {
                var y = Math.max(0, Number(message.y) || 0);
                var x = Math.max(0, Number(message.x) || 0);
                scrollToInstant(x, y);
                settle(0).then(function () {
                    sendResponse({ scrollX: window.scrollX, scrollY: window.scrollY });
                });
                return true;
            }
            case 'shotRestore': {
                untagFixedElements();
                if (_savedScroll) scrollToInstant(_savedScroll.x, _savedScroll.y);
                _savedScroll = null;
                sendResponse({ ok: true });
                return false;
            }
            default:
                return undefined;
        }
    }

    try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
            chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
                if (!message || typeof message.action !== 'string' || message.action.indexOf('shot') !== 0) return;
                try {
                    return handleShotMessage(message, sendResponse);
                } catch (e) {
                    sendResponse({ error: e && e.message ? e.message : String(e) });
                    return false;
                }
            });
        }
    } catch (e) {
        console.warn('[Tacta Screenshot] could not register message listener:', e);
    }

    // ── Activation ───────────────────────────────────────────────────

    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === FEATURE_ID) {
            if (_panel) closePanel();
            else openPanel();
        }
    });

})();

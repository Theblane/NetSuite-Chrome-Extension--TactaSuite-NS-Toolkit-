/**
 * pdf-tools.js
 * NetSuite TactaSuite — PDF Tools (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Adds syntax helpers and live preview capabilities for NetSuite Advanced
 * PDF/HTML templates. Provides:
 *   1. Tag Reference — popup panel with common BFO/FreeMarker tags.
 *   2. Insert Snippet — dropdown to insert common code patterns at cursor.
 *   3. Format XML — pretty-prints the template HTML/XML in the editor.
 *
 * Auto-activates on pdf-template pages:
 *   /app/common/scripting/scripttemplate.nl*
 *   /app/common/custom/custhtml.nl*
 *
 * The NS template editor is typically a <textarea>. This script uses a
 * MutationObserver to detect the textarea if it loads dynamically.
 *
 * @fileoverview Content script for the PDF Tools feature.
 */
(function () {
    'use strict';

    // Guard against double-init.
    if (window.__tactaPdfToolsLoaded) return;
    window.__tactaPdfToolsLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} Root element ID */
    var ROOT_ID = 'tacta-pdf-tools';

    /** @type {string} CSS prefix for all classes */
    var CLS = 'tacta-pt';

    /** @type {number} Delay (ms) before initial scan — let the page settle */
    var INIT_DELAY = 600;

    /** @type {number} Max time (ms) to wait for the textarea via observer */
    var OBSERVER_TIMEOUT = 15000;

    // ────────────────────────────────────────────────────────────────
    // Tag Reference Data
    // ────────────────────────────────────────────────────────────────

    var TAG_CATEGORIES = [
        {
            name: 'Field Values',
            tags: [
                { syntax: '${record.fieldId}',               desc: 'Record field value' },
                { syntax: '${record.custbody_field}',        desc: 'Custom body field' },
                { syntax: '${record.entity}',                desc: 'Entity (customer/vendor)' },
                { syntax: '${record.tranid}',                desc: 'Transaction number' },
                { syntax: '${record.trandate}',              desc: 'Transaction date' },
                { syntax: '${record.total}',                 desc: 'Transaction total' },
                { syntax: '${record.currency}',              desc: 'Currency' },
                { syntax: '${companyinformation.companyname}', desc: 'Company name' }
            ]
        },
        {
            name: 'FreeMarker Directives',
            tags: [
                { syntax: '<#list record.item as item>',     desc: 'Line item loop' },
                { syntax: '<#if condition>',                 desc: 'Conditional block' },
                { syntax: '<#elseif condition>',             desc: 'Else-if branch' },
                { syntax: '<#else>',                         desc: 'Else branch' },
                { syntax: '</#if>',                          desc: 'End conditional' },
                { syntax: '</#list>',                        desc: 'End list loop' },
                { syntax: '<#assign var = value>',           desc: 'Assign variable' },
                { syntax: '<#macro name>',                   desc: 'Define macro' }
            ]
        },
        {
            name: 'HTML / PDF Elements',
            tags: [
                { syntax: '<table>',                         desc: 'Table element' },
                { syntax: '<tr>',                            desc: 'Table row' },
                { syntax: '<td>',                            desc: 'Table cell' },
                { syntax: '<th>',                            desc: 'Table header cell' },
                { syntax: '<barcode>',                       desc: 'Barcode tag (BFO)' },
                { syntax: '<pbr>',                           desc: 'Page break (BFO)' },
                { syntax: '<img>',                           desc: 'Image element' },
                { syntax: '<span>',                          desc: 'Inline text wrapper' }
            ]
        },
        {
            name: 'CSS for PDF',
            tags: [
                { syntax: '@page { size: letter }',          desc: 'Page size (letter/A4)' },
                { syntax: '@page { margin: 0.5in }',        desc: 'Page margins' },
                { syntax: 'font-family: sans-serif',         desc: 'Font family' },
                { syntax: 'font-size: 10pt',                 desc: 'Font size in points' },
                { syntax: 'page-break-after: always',        desc: 'Force page break after' },
                { syntax: 'page-break-inside: avoid',        desc: 'Avoid breaking inside' },
                { syntax: '-fs-table-paginate: paginate',    desc: 'Table pagination (BFO)' },
                { syntax: 'white-space: nowrap',             desc: 'Prevent text wrapping' }
            ]
        }
    ];

    // ────────────────────────────────────────────────────────────────
    // Snippet Data
    // ────────────────────────────────────────────────────────────────

    var SNIPPETS = [
        {
            name: 'Table with Headers',
            code:
                '<table style="width: 100%; border-collapse: collapse;">\n' +
                '    <thead>\n' +
                '        <tr>\n' +
                '            <th style="border-bottom: 1px solid #000; padding: 4px; text-align: left;">Column 1</th>\n' +
                '            <th style="border-bottom: 1px solid #000; padding: 4px; text-align: left;">Column 2</th>\n' +
                '            <th style="border-bottom: 1px solid #000; padding: 4px; text-align: right;">Column 3</th>\n' +
                '        </tr>\n' +
                '    </thead>\n' +
                '    <tbody>\n' +
                '        <tr>\n' +
                '            <td style="padding: 4px;">Data</td>\n' +
                '            <td style="padding: 4px;">Data</td>\n' +
                '            <td style="padding: 4px; text-align: right;">Data</td>\n' +
                '        </tr>\n' +
                '    </tbody>\n' +
                '</table>'
        },
        {
            name: 'Line Item Loop',
            code:
                '<#list record.item as item>\n' +
                '<tr>\n' +
                '    <td>${item.quantity}</td>\n' +
                '    <td>${item.item}</td>\n' +
                '    <td>${item.description}</td>\n' +
                '    <td style="text-align: right;">${item.rate}</td>\n' +
                '    <td style="text-align: right;">${item.amount}</td>\n' +
                '</tr>\n' +
                '</#list>'
        },
        {
            name: 'Conditional Block',
            code:
                '<#if record.custbody_field?has_content>\n' +
                '    <!-- Content when field has a value -->\n' +
                '    <p>${record.custbody_field}</p>\n' +
                '<#else>\n' +
                '    <!-- Fallback content -->\n' +
                '</#if>'
        },
        {
            name: 'Page Break',
            code: '<pbr />'
        },
        {
            name: 'Barcode',
            code:
                '<barcode codetype="Code128" showtext="true" \n' +
                '    value="${record.tranid}" \n' +
                '    style="width: 2in; height: 0.5in;" />'
        },
        {
            name: 'Company Logo',
            code:
                '<#if companyinformation.logoUrl?has_content>\n' +
                '<img src="${companyinformation.logoUrl}" \n' +
                '     style="max-width: 200px; max-height: 80px;" />\n' +
                '</#if>'
        },
        {
            name: 'Address Block',
            code:
                '<table style="width: 100%;">\n' +
                '    <tr>\n' +
                '        <td style="width: 50%; vertical-align: top;">\n' +
                '            <strong>Bill To:</strong><br />\n' +
                '            ${record.billingaddress.addressee}<br />\n' +
                '            ${record.billingaddress.addr1}<br />\n' +
                '            <#if record.billingaddress.addr2?has_content>${record.billingaddress.addr2}<br /></#if>\n' +
                '            ${record.billingaddress.city}, ${record.billingaddress.state} ${record.billingaddress.zip}<br />\n' +
                '            ${record.billingaddress.country}\n' +
                '        </td>\n' +
                '        <td style="width: 50%; vertical-align: top;">\n' +
                '            <strong>Ship To:</strong><br />\n' +
                '            ${record.shippingaddress.addressee}<br />\n' +
                '            ${record.shippingaddress.addr1}<br />\n' +
                '            <#if record.shippingaddress.addr2?has_content>${record.shippingaddress.addr2}<br /></#if>\n' +
                '            ${record.shippingaddress.city}, ${record.shippingaddress.state} ${record.shippingaddress.zip}<br />\n' +
                '            ${record.shippingaddress.country}\n' +
                '        </td>\n' +
                '    </tr>\n' +
                '</table>'
        },
        {
            name: 'Page Header/Footer',
            code:
                '<style>\n' +
                '@page {\n' +
                '    size: letter;\n' +
                '    margin: 0.75in 0.5in;\n' +
                '    @top-center {\n' +
                '        content: "Header Text";\n' +
                '        font-size: 8pt;\n' +
                '        color: #666;\n' +
                '    }\n' +
                '    @bottom-right {\n' +
                '        content: "Page " counter(page) " of " counter(pages);\n' +
                '        font-size: 8pt;\n' +
                '        color: #666;\n' +
                '    }\n' +
                '}\n' +
                '</style>'
        },
        {
            name: 'Subtotal / Total Row',
            code:
                '<tr style="border-top: 2px solid #000;">\n' +
                '    <td colspan="3"></td>\n' +
                '    <td style="padding: 4px; text-align: right; font-weight: bold;">Subtotal:</td>\n' +
                '    <td style="padding: 4px; text-align: right;">${record.subtotal}</td>\n' +
                '</tr>\n' +
                '<tr>\n' +
                '    <td colspan="3"></td>\n' +
                '    <td style="padding: 4px; text-align: right;">Tax:</td>\n' +
                '    <td style="padding: 4px; text-align: right;">${record.taxtotal}</td>\n' +
                '</tr>\n' +
                '<tr style="border-top: 1px solid #000;">\n' +
                '    <td colspan="3"></td>\n' +
                '    <td style="padding: 4px; text-align: right; font-weight: bold; font-size: 12pt;">Total:</td>\n' +
                '    <td style="padding: 4px; text-align: right; font-weight: bold; font-size: 12pt;">${record.total}</td>\n' +
                '</tr>'
        }
    ];

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {HTMLTextAreaElement|null} */
    var _textarea = null;

    /** @type {HTMLElement|null} */
    var _root = null;

    /** @type {string|null} Currently open panel: 'reference' | 'snippets' | null */
    var _activePanel = null;

    // ────────────────────────────────────────────────────────────────
    // Textarea Detection
    // ────────────────────────────────────────────────────────────────

    /**
     * Attempt to find the template textarea on the page. NS uses various
     * IDs depending on the template record type.
     *
     * @returns {HTMLTextAreaElement|null}
     */
    function _findTextarea() {
        // Direct ID matches
        var candidates = [
            'template',
            'custrecord_template',
            'content',
            'custrecord_content'
        ];

        for (var i = 0; i < candidates.length; i++) {
            var el = document.getElementById(candidates[i]);
            if (el && el.tagName === 'TEXTAREA') return el;
        }

        // Broader search: any textarea whose ID or name contains 'template'
        var allTextareas = document.querySelectorAll('textarea');
        for (var j = 0; j < allTextareas.length; j++) {
            var ta = allTextareas[j];
            var idOrName = (ta.id + ' ' + ta.name).toLowerCase();
            if (idOrName.indexOf('template') !== -1 || idOrName.indexOf('content') !== -1) {
                return ta;
            }
        }

        // Last resort: look for a large textarea (likely the template editor)
        for (var k = 0; k < allTextareas.length; k++) {
            if (allTextareas[k].offsetHeight > 200 || allTextareas[k].rows > 10) {
                return allTextareas[k];
            }
        }

        return null;
    }

    // ────────────────────────────────────────────────────────────────
    // Textarea Insertion
    // ────────────────────────────────────────────────────────────────

    /**
     * Insert text at the current cursor position in the textarea. If no
     * selection exists, appends at the end.
     *
     * @param {string} text - The text to insert.
     */
    function _insertAtCursor(text) {
        if (!_textarea) return;

        _textarea.focus();

        var start = _textarea.selectionStart;
        var end = _textarea.selectionEnd;
        var before = _textarea.value.substring(0, start);
        var after = _textarea.value.substring(end);

        _textarea.value = before + text + after;

        // Place cursor after inserted text
        var newPos = start + text.length;
        _textarea.selectionStart = newPos;
        _textarea.selectionEnd = newPos;

        // Trigger change events so NS picks up the modification
        _textarea.dispatchEvent(new Event('input', { bubbles: true }));
        _textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ────────────────────────────────────────────────────────────────
    // XML Formatting
    // ────────────────────────────────────────────────────────────────

    /**
     * Simple XML/HTML pretty-printer. Adds indentation to nested elements.
     * Preserves FreeMarker directives and inline text content.
     *
     * @param {string} xml - The raw XML/HTML string.
     * @returns {string} Formatted string.
     */
    function _formatXml(xml) {
        // Normalize line endings
        var str = xml.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // Remove existing formatting (collapse multiple whitespace between tags)
        str = str.replace(/>\s+</g, '><');

        // Insert newlines between tags
        str = str.replace(/></g, '>\n<');

        var lines = str.split('\n');
        var indent = 0;
        var formatted = [];
        var tab = '    '; // 4-space indent

        // Tags that decrease indent before the line
        var closingPattern = /^<\/\w/;
        // Self-closing tags
        var selfClosingPattern = /\/>$/;
        // Tags that increase indent after the line
        var openingPattern = /^<\w[^>]*[^\/]>$/;
        // FreeMarker closing
        var fmClosingPattern = /^<\/#/;
        // FreeMarker opening (not self-closing)
        var fmOpeningPattern = /^<#(?!assign|--)(list|if|macro|function|switch)/;
        // Void HTML elements that don't need closing
        var voidElements = /^<(br|hr|img|input|meta|link|pbr|barcode)\b/i;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            // Decrease indent for closing tags
            if (closingPattern.test(line) || fmClosingPattern.test(line)) {
                indent = Math.max(0, indent - 1);
            }

            // Add formatted line
            var prefix = '';
            for (var j = 0; j < indent; j++) prefix += tab;
            formatted.push(prefix + line);

            // Increase indent for opening tags (not self-closing, not void)
            if (
                (openingPattern.test(line) || fmOpeningPattern.test(line)) &&
                !selfClosingPattern.test(line) &&
                !voidElements.test(line) &&
                !closingPattern.test(line) &&
                !fmClosingPattern.test(line)
            ) {
                indent++;
            }
        }

        return formatted.join('\n');
    }

    // ────────────────────────────────────────────────────────────────
    // UI Construction
    // ────────────────────────────────────────────────────────────────

    /**
     * Build the floating toolbar and attach it to the DOM.
     */
    function _buildToolbar() {
        if (document.getElementById(ROOT_ID)) return;

        _root = document.createElement('div');
        _root.id = ROOT_ID;
        _root.className = CLS;

        // ── Toolbar Bar ──
        var toolbar = document.createElement('div');
        toolbar.className = CLS + '__toolbar';

        // Logo / label
        var label = document.createElement('span');
        label.className = CLS + '__label';
        label.textContent = 'PDF Tools';

        // Tag Reference button
        var btnRef = _createButton('Tag Reference', 'reference', function () {
            _togglePanel('reference');
        });

        // Insert Snippet button
        var btnSnip = _createButton('Insert Snippet', 'snippets', function () {
            _togglePanel('snippets');
        });

        // Format XML button
        var btnFmt = _createButton('Format XML', 'format', function () {
            _handleFormat();
        });

        toolbar.appendChild(label);
        toolbar.appendChild(btnRef);
        toolbar.appendChild(btnSnip);
        toolbar.appendChild(btnFmt);
        _root.appendChild(toolbar);

        // ── Panels (hidden by default) ──
        _root.appendChild(_buildReferencePanel());
        _root.appendChild(_buildSnippetPanel());

        document.body.appendChild(_root);

        // Close panels on outside click
        document.addEventListener('mousedown', function (e) {
            if (_activePanel && _root && !_root.contains(e.target)) {
                _closeAllPanels();
            }
        });
    }

    /**
     * Create a toolbar button.
     */
    function _createButton(text, cls, onClick) {
        var btn = document.createElement('button');
        btn.className = CLS + '__btn ' + CLS + '__btn--' + cls;
        btn.textContent = text;
        btn.type = 'button';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    /**
     * Build the Tag Reference panel.
     */
    function _buildReferencePanel() {
        var panel = document.createElement('div');
        panel.className = CLS + '__panel ' + CLS + '__panel--reference';
        panel.id = CLS + '-panel-reference';

        // Header
        var header = document.createElement('div');
        header.className = CLS + '__panel-header';

        var title = document.createElement('span');
        title.className = CLS + '__panel-title';
        title.textContent = 'Tag Reference';

        var closeBtn = document.createElement('button');
        closeBtn.className = CLS + '__panel-close';
        closeBtn.type = 'button';
        closeBtn.innerHTML = '&#x2715;';
        closeBtn.addEventListener('click', function () { _closeAllPanels(); });

        header.appendChild(title);
        header.appendChild(closeBtn);
        panel.appendChild(header);

        // Body
        var body = document.createElement('div');
        body.className = CLS + '__panel-body';

        for (var c = 0; c < TAG_CATEGORIES.length; c++) {
            var cat = TAG_CATEGORIES[c];

            var section = document.createElement('div');
            section.className = CLS + '__section';

            var sectionTitle = document.createElement('div');
            sectionTitle.className = CLS + '__section-title';
            sectionTitle.textContent = cat.name;
            section.appendChild(sectionTitle);

            for (var t = 0; t < cat.tags.length; t++) {
                var tag = cat.tags[t];
                var row = document.createElement('div');
                row.className = CLS + '__tag-row';
                row.title = 'Click to insert: ' + tag.syntax;

                var tagCode = document.createElement('code');
                tagCode.className = CLS + '__tag-code';
                tagCode.textContent = tag.syntax;

                var tagDesc = document.createElement('span');
                tagDesc.className = CLS + '__tag-desc';
                tagDesc.textContent = tag.desc;

                row.appendChild(tagCode);
                row.appendChild(tagDesc);

                // Click to insert
                (function (syntax) {
                    row.addEventListener('click', function () {
                        _insertAtCursor(syntax);
                        _showToast('Inserted: ' + syntax.substring(0, 30) + (syntax.length > 30 ? '...' : ''));
                    });
                })(tag.syntax);

                section.appendChild(row);
            }

            body.appendChild(section);
        }

        panel.appendChild(body);
        return panel;
    }

    /**
     * Build the Insert Snippet panel.
     */
    function _buildSnippetPanel() {
        var panel = document.createElement('div');
        panel.className = CLS + '__panel ' + CLS + '__panel--snippets';
        panel.id = CLS + '-panel-snippets';

        // Header
        var header = document.createElement('div');
        header.className = CLS + '__panel-header';

        var title = document.createElement('span');
        title.className = CLS + '__panel-title';
        title.textContent = 'Insert Snippet';

        var closeBtn = document.createElement('button');
        closeBtn.className = CLS + '__panel-close';
        closeBtn.type = 'button';
        closeBtn.innerHTML = '&#x2715;';
        closeBtn.addEventListener('click', function () { _closeAllPanels(); });

        header.appendChild(title);
        header.appendChild(closeBtn);
        panel.appendChild(header);

        // Body
        var body = document.createElement('div');
        body.className = CLS + '__panel-body';

        for (var s = 0; s < SNIPPETS.length; s++) {
            var snippet = SNIPPETS[s];
            var row = document.createElement('div');
            row.className = CLS + '__snippet-row';

            var name = document.createElement('div');
            name.className = CLS + '__snippet-name';
            name.textContent = snippet.name;

            var preview = document.createElement('code');
            preview.className = CLS + '__snippet-preview';
            // Show first line as preview
            var firstLine = snippet.code.split('\n')[0];
            preview.textContent = firstLine.length > 50 ? firstLine.substring(0, 50) + '...' : firstLine;

            row.appendChild(name);
            row.appendChild(preview);

            // Click to insert
            (function (snip) {
                row.addEventListener('click', function () {
                    _insertAtCursor(snip.code);
                    _showToast('Inserted: ' + snip.name);
                    _closeAllPanels();
                });
            })(snippet);

            body.appendChild(row);
        }

        panel.appendChild(body);
        return panel;
    }

    // ────────────────────────────────────────────────────────────────
    // Panel Toggle
    // ────────────────────────────────────────────────────────────────

    function _togglePanel(panelName) {
        if (_activePanel === panelName) {
            _closeAllPanels();
            return;
        }
        _closeAllPanels();
        _activePanel = panelName;

        var panel = document.getElementById(CLS + '-panel-' + panelName);
        if (panel) {
            panel.classList.add(CLS + '__panel--open');
        }

        // Mark the corresponding button as active
        var btn = _root.querySelector('.' + CLS + '__btn--' + panelName);
        if (btn) btn.classList.add(CLS + '__btn--active');
    }

    function _closeAllPanels() {
        _activePanel = null;
        var panels = _root.querySelectorAll('.' + CLS + '__panel');
        for (var i = 0; i < panels.length; i++) {
            panels[i].classList.remove(CLS + '__panel--open');
        }
        var btns = _root.querySelectorAll('.' + CLS + '__btn--active');
        for (var j = 0; j < btns.length; j++) {
            btns[j].classList.remove(CLS + '__btn--active');
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Format Handler
    // ────────────────────────────────────────────────────────────────

    function _handleFormat() {
        if (!_textarea) {
            _showToast('No template editor found', true);
            return;
        }

        var original = _textarea.value;
        if (!original.trim()) {
            _showToast('Template is empty', true);
            return;
        }

        try {
            var formatted = _formatXml(original);
            _textarea.value = formatted;
            _textarea.dispatchEvent(new Event('input', { bubbles: true }));
            _textarea.dispatchEvent(new Event('change', { bubbles: true }));
            _showToast('Template formatted');
        } catch (err) {
            _showToast('Format error: ' + err.message, true);
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Toast Notification
    // ────────────────────────────────────────────────────────────────

    /**
     * Show a brief toast notification near the toolbar.
     *
     * @param {string} message
     * @param {boolean} [isError=false]
     */
    function _showToast(message, isError) {
        // Remove existing toast
        var existing = document.querySelector('.' + CLS + '__toast');
        if (existing) existing.remove();

        var toast = document.createElement('div');
        toast.className = CLS + '__toast' + (isError ? ' ' + CLS + '__toast--error' : '');
        toast.textContent = message;
        document.body.appendChild(toast);

        // Animate in
        requestAnimationFrame(function () {
            toast.classList.add(CLS + '__toast--visible');
        });

        // Auto-dismiss
        setTimeout(function () {
            toast.classList.remove(CLS + '__toast--visible');
            setTimeout(function () {
                if (toast.parentNode) toast.remove();
            }, 300);
        }, 2500);
    }

    // ────────────────────────────────────────────────────────────────
    // Initialization
    // ────────────────────────────────────────────────────────────────

    /**
     * Main init: find textarea, build toolbar. Uses MutationObserver
     * as a fallback if the textarea isn't available immediately.
     */
    function _init() {
        _textarea = _findTextarea();

        if (_textarea) {
            _buildToolbar();
            return;
        }

        // Textarea not found yet — watch for it
        var observer = new MutationObserver(function (mutations) {
            _textarea = _findTextarea();
            if (_textarea) {
                observer.disconnect();
                _buildToolbar();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Safety timeout
        setTimeout(function () {
            observer.disconnect();
            if (!_textarea) {
                _textarea = _findTextarea();
                if (_textarea) {
                    _buildToolbar();
                }
                // If still not found, silently give up — this might not be
                // a template edit page after all.
            }
        }, OBSERVER_TIMEOUT);
    }

    // Kick off after a brief delay to let the NS page settle.
    setTimeout(_init, INIT_DELAY);

})();

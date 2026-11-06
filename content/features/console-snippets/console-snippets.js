/**
 * console-snippets.js
 * NetSuite TactaSuite - Console Snippets (Content Script)
 *
 * @author Blane Maher
 *
 * Floating panel listing known-good browser-console commands for whatever
 * record you are sitting on, with the internal id already filled in. Copy
 * only by design - you paste into DevTools yourself, so nothing writes to a
 * record because of a stray click in the panel.
 *
 * Record type comes from N/currentRecord via TactaNSBridge (see
 * console-snippets-client.js) and falls back to URL parsing.
 *
 * Activation: popup/Features list dispatches 'tacta:featureActivated' with
 * featureId 'console-snippets'. The snippet catalogue lives in
 * console-snippets-data.js and is injected ahead of this file.
 */
(function () {
    'use strict';

    if (window.__tactaConsoleSnippetsLoaded) return;
    window.__tactaConsoleSnippetsLoaded = true;

    var FEATURE_ID = 'console-snippets';
    var SC = 'tacta-snip'; // CSS scope prefix

    var ID_PLACEHOLDER = '<INSERT INTERNAL ID HERE>';
    var TYPE_PLACEHOLDER = '<RECORD TYPE>';

    /** Badge text per snippet kind. */
    var KIND_LABELS = {
        read:   'READ',
        write:  'WRITE',
        form:   'FORM',
        query:  'SUITEQL',
        danger: 'DESTRUCTIVE'
    };

    var _panelInstance = null;

    /* ── Context resolution ──────────────────────────────────────── */

    /**
     * Derives the record type from the URL when the page world cannot be
     * reached. URL stems like 'salesord' are mapped to their SuiteScript ids.
     * @returns {string|null}
     */
    function recordTypeFromUrl() {
        if (!window.TactaNS) return null;

        var raw = window.TactaNS.getRecordType();
        if (!raw) return null;

        var aliases = (window.TactaSnippetLibrary && window.TactaSnippetLibrary.URL_TYPE_ALIASES) || {};
        if (Object.prototype.hasOwnProperty.call(aliases, raw)) {
            return aliases[raw];
        }
        return raw;
    }

    /**
     * Asks the page world for record context, then fills any gaps from the URL.
     * @returns {Promise<Object>} Always resolves.
     */
    function resolveContext() {
        var req;
        try {
            req = window.TactaNSBridge.request('getSnippetContext', null, { timeout: 6000 });
        } catch (e) {
            req = Promise.reject(e);
        }

        return req.catch(function () {
            return {};
        }).then(function (ctx) {
            ctx = ctx || {};

            var recordType = ctx.recordType || recordTypeFromUrl();
            var recordId = ctx.recordId ||
                (window.TactaNS ? window.TactaNS.getRecordId() : null);

            var isProduction;
            if (ctx.envType) {
                isProduction = String(ctx.envType).toUpperCase() === 'PRODUCTION';
            } else {
                isProduction = window.TactaNS ? window.TactaNS.isProductionAccount() : false;
            }

            return {
                recordType: recordType || null,
                recordId: recordId || null,
                typeToken: recordType || TYPE_PLACEHOLDER,
                idToken: recordId || ID_PLACEHOLDER,
                accountId: ctx.accountId || (window.TactaNS ? window.TactaNS.getAccountId() : null),
                isProduction: isProduction
            };
        });
    }

    /* ── Rendering ───────────────────────────────────────────────── */

    /**
     * Builds one collapsible snippet card.
     * @param {Object} snippet - Entry from the catalogue.
     * @param {Object} ctx - Resolved page context.
     * @returns {HTMLElement}
     */
    function buildCard(snippet, ctx) {
        var el = window.TactaDOM.createElement;

        var code;
        try {
            code = snippet.code(ctx);
        } catch (e) {
            code = '// Could not build this snippet: ' + (e.message || e);
        }

        var badge = el('span', {
            className: SC + '-badge ' + SC + '-badge--' + snippet.kind,
            textContent: KIND_LABELS[snippet.kind] || snippet.kind
        });

        var copyBtn = el('button', {
            className: 'tacta-btn tacta-btn-sm ' + SC + '-copy',
            textContent: 'Copy',
            title: 'Copy to clipboard, then paste into the DevTools console'
        });

        copyBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            window.TactaDOM.copyToClipboard(code).then(function (ok) {
                if (!window.TactaDOM.showToast) return;
                if (ok) {
                    window.TactaDOM.showToast('Copied - paste it into the console', 'success', 2000);
                } else {
                    window.TactaDOM.showToast('Copy failed; snippet logged to console', 'warning', 3000);
                    console.log(code);
                }
            });
        });

        var caret = el('span', { className: SC + '-caret', textContent: '›' });

        var head = el('div', { className: SC + '-head' }, [
            caret,
            el('div', { className: SC + '-head-text' }, [
                el('div', { className: SC + '-title-row' }, [
                    el('span', { className: SC + '-title', textContent: snippet.title }),
                    badge
                ]),
                el('div', { className: SC + '-desc', textContent: snippet.description })
            ]),
            copyBtn
        ]);

        var pre = el('pre', { className: SC + '-code' }, [
            el('code', { textContent: code })
        ]);

        var card = el('div', { className: SC + '-card' }, [head, pre]);

        head.addEventListener('click', function () {
            var open = card.classList.toggle(SC + '-open');
            caret.textContent = open ? '˅' : '›';
        });

        // Keep the snippet text searchable without re-running code() per keystroke.
        card.dataset.search = (snippet.title + ' ' + snippet.description + ' ' +
            snippet.id + ' ' + code).toLowerCase();

        return card;
    }

    /**
     * Builds a titled group of cards.
     * @param {string} title
     * @param {Object[]} snippets
     * @param {Object} ctx
     * @param {boolean} [collapsed] - Start with the group body hidden.
     * @returns {HTMLElement|null}
     */
    function buildSection(title, snippets, ctx, collapsed) {
        if (!snippets.length) return null;

        var el = window.TactaDOM.createElement;

        var count = el('span', { className: SC + '-count', textContent: String(snippets.length) });
        var header = el('div', { className: SC + '-section-head' }, [
            el('span', { textContent: title }),
            count
        ]);

        var bodyEl = el('div', { className: SC + '-section-body' });
        snippets.forEach(function (s) {
            bodyEl.appendChild(buildCard(s, ctx));
        });

        var section = el('div', { className: SC + '-section' }, [header, bodyEl]);

        if (collapsed) {
            section.classList.add(SC + '-section--collapsed');
        }

        header.addEventListener('click', function () {
            section.classList.toggle(SC + '-section--collapsed');
        });

        return section;
    }

    /**
     * Renders the whole panel body for a resolved context.
     * @param {HTMLElement} body - Panel body element.
     * @param {Object} ctx
     */
    function render(body, ctx) {
        var el = window.TactaDOM.createElement;
        var lib = window.TactaSnippetLibrary;

        body.innerHTML = '';

        if (!lib) {
            body.appendChild(el('div', {
                className: SC + '-error',
                textContent: 'Snippet library failed to load. Reload the page and try again.'
            }));
            return;
        }

        // ── Production warning ───────────────────────────────────
        if (ctx.isProduction) {
            body.appendChild(el('div', { className: SC + '-prod' }, [
                el('strong', { textContent: 'PRODUCTION' }),
                el('span', { textContent: ' - these commands write to live data.' })
            ]));
        }

        // ── Context strip ────────────────────────────────────────
        var contextRow;
        if (ctx.recordType) {
            contextRow = el('div', { className: SC + '-ctx' }, [
                el('span', { className: SC + '-ctx-type', textContent: ctx.recordType }),
                el('span', {
                    className: SC + '-ctx-id',
                    textContent: ctx.recordId ? 'id ' + ctx.recordId : 'unsaved - no internal id'
                })
            ]);
        } else {
            contextRow = el('div', { className: SC + '-ctx' }, [
                el('span', {
                    className: SC + '-ctx-none',
                    textContent: 'No record detected - showing general snippets'
                })
            ]);
        }
        body.appendChild(contextRow);

        // ── Hint ────────────────────────────────────────────────
        body.appendChild(el('div', {
            className: SC + '-hint',
            textContent: 'Copy a snippet, then paste it into the DevTools console (F12). ' +
                'Internal ids are already filled in where known.'
        }));

        // ── Search ──────────────────────────────────────────────
        var search = el('input', {
            className: 'tacta-input ' + SC + '-search',
            type: 'text',
            placeholder: 'Filter snippets...'
        });
        body.appendChild(search);

        // ── Sections ────────────────────────────────────────────
        var groups = lib.partition(ctx.recordType);
        var listWrap = el('div', { className: SC + '-list' });

        var specificTitle = ctx.recordType
            ? 'For ' + ctx.recordType
            : 'For this record type';

        var sections = [
            buildSection(specificTitle, groups.specific, ctx, false),
            buildSection('Any record', groups.general, ctx, false),
            buildSection('Other record types', groups.other, ctx, true)
        ];

        sections.forEach(function (s) {
            if (s) listWrap.appendChild(s);
        });

        if (!groups.specific.length && ctx.recordType) {
            listWrap.insertBefore(el('div', {
                className: SC + '-empty',
                textContent: 'No snippets specific to ' + ctx.recordType + ' yet.'
            }), listWrap.firstChild);
        }

        body.appendChild(listWrap);

        // ── Filtering ───────────────────────────────────────────
        search.addEventListener('input', function () {
            var term = search.value.trim().toLowerCase();

            listWrap.querySelectorAll('.' + SC + '-section').forEach(function (section) {
                var visible = 0;

                section.querySelectorAll('.' + SC + '-card').forEach(function (card) {
                    var hit = !term || (card.dataset.search || '').indexOf(term) >= 0;
                    card.style.display = hit ? '' : 'none';
                    if (hit) visible++;
                });

                section.style.display = visible ? '' : 'none';

                // A search should reach into the collapsed "other types" group.
                if (term) {
                    section.classList.remove(SC + '-section--collapsed');
                }
                var countEl = section.querySelector('.' + SC + '-count');
                if (countEl) countEl.textContent = String(visible);
            });
        });
    }

    /* ── Panel lifecycle ─────────────────────────────────────────── */

    function openPanel() {
        if (!window.TactaDOM) {
            console.error('[Tacta Console Snippets] TactaDOM not available.');
            return;
        }

        var el = window.TactaDOM.createElement;

        if (window.TactaDOM.injectStylesheet) {
            try {
                var cssUrl = chrome.runtime.getURL('content/features/console-snippets/console-snippets.css');
                window.TactaDOM.injectStylesheet(cssUrl).catch(function () {});
            } catch (e) { /* ignore */ }
        }

        _panelInstance = window.TactaDOM.createPanel({
            title: 'Console Snippets',
            width: 460,
            height: 600,
            position: { top: '60px', right: '16px' },
            resizable: true,
            draggable: true,
            onClose: function () {
                _panelInstance = null;
            }
        });

        var panel = _panelInstance.panel;
        panel.classList.add(SC);

        var body = _panelInstance.body;
        body.style.overflowY = 'auto';

        var loadingEl = el('div', { className: SC + '-loading' }, [
            el('div', { className: 'tacta-spinner' }),
            el('span', { className: SC + '-loading-txt', textContent: 'Detecting record…' })
        ]);
        body.appendChild(loadingEl);

        resolveContext().then(function (ctx) {
            if (!_panelInstance) return; // closed while resolving
            render(body, ctx);
        }).catch(function (err) {
            if (!_panelInstance) return;
            body.innerHTML = '';
            body.appendChild(el('div', {
                className: SC + '-error',
                textContent: 'Error: ' + (err && err.message ? err.message : String(err))
            }));
        });
    }

    function closePanel() {
        if (_panelInstance) {
            _panelInstance.close();
            _panelInstance = null;
        }
    }

    /* ── Activation ──────────────────────────────────────────────── */

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

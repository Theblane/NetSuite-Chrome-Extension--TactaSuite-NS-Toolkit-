/**
 * search-url-builder.js
 * NetSuite TactaSuite - Search URL Builder (Content Script)
 *
 * @author Blane Maher
 *
 * On saved search pages (edit or results), extracts the search ID and
 * generates shareable output snippets: a direct results URL, an edit
 * URL, and a SuiteScript 2.1 load/run snippet — each with a one-click
 * copy button.
 *
 * Activation: popup dispatches 'tacta:featureActivated' with featureId
 * 'search-url-builder'. No MAIN-world injection needed.
 */
(function () {
    'use strict';

    if (window.__tactaSearchUrlBuilderLoaded) return;
    window.__tactaSearchUrlBuilderLoaded = true;

    var FEATURE_ID = 'search-url-builder';
    var SC = 'tacta-sub';

    var _panelInstance = null;

    // ── URL / page data extraction ────────────────────────────────

    function getSearchId() {
        var url = window.location.href;
        // searchresults.nl?searchid=X  (results page)
        var m1 = url.match(/[?&]searchid=(\d+)/);
        if (m1) return m1[1];
        // search.nl?id=X  (edit page) or searchresults.nl?id=X
        var m2 = url.match(/[?&]id=(\d+)/);
        if (m2) return m2[1];
        return null;
    }

    // Try to read the script ID (customsearch_xxx) from the DOM edit form
    function getScriptId() {
        // NS edit page exposes the scriptid in a hidden/visible field
        var candidates = [
            document.getElementById('scriptid'),
            document.querySelector('[name="scriptid"]'),
            document.querySelector('[id="internalid"]')
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (!candidates[i]) continue;
            var val = candidates[i].value || candidates[i].textContent || '';
            if (/^customsearch/i.test(val.trim())) return val.trim().toLowerCase();
        }
        // Fall back: scan the whole page title area
        var titleEl = document.querySelector('.uir-page-title-secondline, #spn_cg_pagetitle');
        if (titleEl) {
            var m = titleEl.textContent.match(/customsearch[\w_]+/i);
            if (m) return m[0].toLowerCase();
        }
        return null;
    }

    function getSearchName() {
        var sel = [
            '.uir-page-title-secondline',
            'h1.uir-page-title',
            '#spn_cg_pagetitle'
        ].join(', ');
        var el = document.querySelector(sel);
        if (el) {
            var text = el.textContent.trim().split(/[|\n\r]/)[0].trim();
            return text || null;
        }
        return null;
    }

    // ── Snippet generators ────────────────────────────────────────

    function buildSnippets(searchId, scriptId, origin) {
        // Direct link to view results
        var resultsUrl = origin + '/app/common/search/searchresults.nl?searchid=' + searchId + '&viewtype=LIST';

        // Edit page (same for both search.nl and searchresults.nl)
        var editUrl = origin + '/app/common/search/search.nl?id=' + searchId;

        // SuiteScript 2.1 console snippet using internal ID or script ID
        var idRef = scriptId || searchId;
        var idComment = scriptId ? '// script ID' : '// internal ID';
        var ssSnippet = [
            "require(['N/search'], (search) => {",
            "    const s = search.load({ id: '" + idRef + "' }); " + idComment,
            "    const pagedData = s.runPaged({ pageSize: 1000 });",
            "    pagedData.pageRanges.forEach((range) => {",
            "        pagedData.fetch({ index: range.index }).data.forEach((result) => {",
            "            // result.getValue({ name: 'fieldid' })",
            "            // result.getText({ name: 'selectfieldid' })",
            "        });",
            "    });",
            "});"
        ].join('\n');

        // SuiteQL equivalent note
        var suiteqlSnippet = [
            '-- To run this search via SuiteQL Runner, use the built-in',
            '-- SuiteScript Exporter (auto-injects on the search edit page)',
            '-- to generate a full N/search TypeScript scaffold.',
            '',
            '-- Or run ad-hoc SuiteQL in the SuiteQL Runner panel (Ctrl+Shift+S).'
        ].join('\n');

        return {
            resultsUrl: resultsUrl,
            editUrl: editUrl,
            ssSnippet: ssSnippet,
            suiteqlSnippet: suiteqlSnippet
        };
    }

    // ── Panel helpers ─────────────────────────────────────────────

    function makeCard(el, title, content, note) {
        var card = el('div', { className: SC + '-card' });
        card.appendChild(el('div', { className: SC + '-card-title', textContent: title }));

        var pre = el('pre', { className: SC + '-code', textContent: content });
        card.appendChild(pre);

        var footer = el('div', { className: SC + '-card-footer' });

        if (note) {
            footer.appendChild(el('span', { className: SC + '-card-note', textContent: note }));
        }

        var copyBtn = el('button', {
            className: 'tacta-btn tacta-btn-sm ' + SC + '-copy-btn',
            textContent: 'Copy'
        });
        copyBtn.addEventListener('click', function () {
            var orig = copyBtn.textContent;
            if (window.TactaDOM && window.TactaDOM.copyToClipboard) {
                window.TactaDOM.copyToClipboard(content).then(function (ok) {
                    if (ok) {
                        copyBtn.textContent = 'Copied!';
                        setTimeout(function () { copyBtn.textContent = orig; }, 1500);
                    }
                });
            }
        });
        footer.appendChild(copyBtn);
        card.appendChild(footer);

        return card;
    }

    // ── Open panel ────────────────────────────────────────────────

    function openPanel() {
        if (!window.TactaDOM) {
            console.error('[Tacta Search URL Builder] TactaDOM not available.');
            return;
        }

        var el = window.TactaDOM.createElement;

        if (window.TactaDOM.injectStylesheet) {
            try {
                window.TactaDOM.injectStylesheet(
                    chrome.runtime.getURL('content/features/search-url-builder/search-url-builder.css')
                ).catch(function () {});
            } catch (e) { /* ignore */ }
        }

        _panelInstance = window.TactaDOM.createPanel({
            title: 'Search URL Builder',
            width: 480,
            height: 560,
            position: { top: '60px', right: '16px' },
            resizable: true,
            draggable: true,
            onClose: function () { _panelInstance = null; }
        });

        _panelInstance.panel.classList.add(SC);
        var body = _panelInstance.body;
        body.style.overflowY = 'auto';

        var searchId  = getSearchId();
        var scriptId  = getScriptId();
        var searchName = getSearchName();
        var origin    = window.location.origin;

        if (!searchId) {
            body.appendChild(el('div', {
                className: SC + '-error',
                textContent: 'No saved search ID found. Navigate to a saved search page first.'
            }));
            return;
        }

        var snippets = buildSnippets(searchId, scriptId, origin);

        // ── Header info ──────────────────────────────────────────
        var infoEl = el('div', { className: SC + '-info' });
        if (searchName) {
            infoEl.appendChild(el('div', { className: SC + '-info-name', textContent: searchName }));
        }
        var metaRow = el('div', { className: SC + '-meta' });
        metaRow.appendChild(el('span', { className: SC + '-meta-pill', textContent: 'ID: ' + searchId }));
        if (scriptId) {
            metaRow.appendChild(el('span', { className: SC + '-meta-pill ' + SC + '-meta-pill--script', textContent: scriptId }));
        }
        infoEl.appendChild(metaRow);
        body.appendChild(infoEl);

        // ── Output cards ─────────────────────────────────────────
        body.appendChild(makeCard(el,
            'Results URL',
            snippets.resultsUrl,
            'Opens the search in List view — sharable with other users'
        ));

        body.appendChild(makeCard(el,
            'Edit URL',
            snippets.editUrl,
            'Opens the search definition — bookmark to return directly'
        ));

        body.appendChild(makeCard(el,
            'SuiteScript 2.1',
            snippets.ssSnippet,
            scriptId ? 'Uses script ID (stable across environments)' : 'Uses internal ID (sandbox ID may differ in production)'
        ));

        body.appendChild(makeCard(el,
            'SuiteQL / Exporter tip',
            snippets.suiteqlSnippet,
            null
        ));
    }

    function closePanel() {
        if (_panelInstance) {
            _panelInstance.close();
            _panelInstance = null;
        }
    }

    // ── Activation ───────────────────────────────────────────────

    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === FEATURE_ID) {
            if (_panelInstance) closePanel();
            else openPanel();
        }
    });

})();

/**
 * NetSuite TactaSuite - Send feedback form
 *
 * @author Blane Maher
 *
 * A small in-extension form (bug / idea / question) that composes an email to
 * the author. It deliberately makes NO network call of its own: on submit it
 * opens the user's mail program with a prefilled message (mailto:), or, when
 * no feedback address is configured, a prefilled GitHub issue. Either way the
 * user sees exactly what is sent before it leaves their machine, which keeps
 * the privacy promise in PRIVACY.md intact.
 *
 * Usage (popup, options, onboarding):
 *   <script src="../shared/author-links.js"></script>
 *   <script src="../shared/feedback.js"></script>
 *   window.TactaFeedback.open();
 *
 * The address lives in shared/author-links.js (AUTHOR.feedbackEmail) so it is
 * set in one place.
 */
(function () {
  'use strict';

  if (window.TactaFeedback) return;

  var MAX_BODY = 1800; // keep mailto URLs well under client limits
  var TYPES = [
    { id: 'bug', label: 'Something is broken' },
    { id: 'idea', label: 'I have an idea' },
    { id: 'question', label: 'I have a question' }
  ];

  function author() {
    return (window.TactaAuthor && window.TactaAuthor.AUTHOR) || {};
  }

  function repoUrl() {
    var links = (author().links || []).filter(function (l) { return l.id === 'github'; });
    return (links[0] && links[0].url) || 'https://github.com/Theblane/TactaSuiteNSToolkit';
  }

  function manifest() {
    try { return chrome.runtime.getManifest(); } catch (_) { return { name: 'TactaSuite NS Toolkit', version: '?' }; }
  }

  function browserLine() {
    var m = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
    var os = /Windows/.test(navigator.userAgent) ? 'Windows' : /Mac/.test(navigator.userAgent) ? 'macOS' : /Linux/.test(navigator.userAgent) ? 'Linux' : 'unknown OS';
    return 'Chrome ' + (m ? m[1] : '?') + ' on ' + os;
  }

  /** Active tab URL if it is a NetSuite page, else ''. */
  function currentPage() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
          var t = tabs && tabs[0];
          var url = (t && t.url) || '';
          resolve(/^https:\/\/[^/]*\.(netsuite|oracle)\.com\//i.test(url) ? url : '');
        });
      } catch (_) { resolve(''); }
    });
  }

  /** Names of features currently switched on. */
  function enabledFeatures() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(['featureStates', 'tacta_user_type'], function (res) {
          var states = (res && res.featureStates) || {};
          var on = Object.keys(states).filter(function (k) { return states[k]; }).sort();
          resolve({ on: on, userType: (res && res.tacta_user_type) || '' });
        });
      } catch (_) { resolve({ on: [], userType: '' }); }
    });
  }

  function envOf(url) {
    if (!url) return '';
    if (/-sb\d+\.|sandbox/i.test(url)) return 'sandbox';
    if (/-rp\./i.test(url)) return 'release preview';
    return 'production';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildMessage(state) {
    var m = manifest();
    var typeLabel = (TYPES.filter(function (t) { return t.id === state.type; })[0] || TYPES[0]).label;
    var subject = '[' + m.name + ' v' + m.version + '] ' + typeLabel + (state.title ? ': ' + state.title : '');

    var lines = [];
    lines.push('Type: ' + typeLabel);
    if (state.title) lines.push('Summary: ' + state.title);
    lines.push('');
    lines.push(state.details || '(no details given)');
    lines.push('');
    if (state.includePage && state.pageUrl) {
      lines.push('NetSuite page (' + envOf(state.pageUrl) + '): ' + state.pageUrl);
    }
    if (state.includeTech) {
      lines.push('Extension: ' + m.name + ' v' + m.version);
      lines.push('Browser: ' + browserLine());
      if (state.userType) lines.push('User type: ' + state.userType);
      if (state.features && state.features.length) lines.push('Features on: ' + state.features.join(', '));
    }
    if (state.replyTo) lines.push('Reply to: ' + state.replyTo);

    var body = lines.join('\n');
    if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY - 20) + '\n[trimmed]';
    return { subject: subject, body: body };
  }

  function targetUrl(msg) {
    var email = (author().feedbackEmail || '').trim();
    if (email) {
      return { kind: 'mail', url: 'mailto:' + encodeURIComponent(email) + '?subject=' + encodeURIComponent(msg.subject) + '&body=' + encodeURIComponent(msg.body) };
    }
    return { kind: 'github', url: repoUrl().replace(/\/$/, '') + '/issues/new?title=' + encodeURIComponent(msg.subject) + '&body=' + encodeURIComponent(msg.body) };
  }

  function openTarget(t) {
    // The service worker opens the tab (and tidies up the blank mailto: tab)
    // because the popup is destroyed the moment a new tab takes focus.
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ action: 'openFeedbackTarget', url: t.url, kind: t.kind }, function (res) {
          if (!chrome.runtime.lastError && res && res.success) { resolve(true); return; }
          fallback();
        });
      } catch (_) { fallback(); }

      function fallback() {
        try {
          chrome.tabs.create({ url: t.url }, function () { resolve(true); });
        } catch (_) {
          try { window.open(t.url, '_blank'); resolve(true); } catch (e) { resolve(false); }
        }
      }
    });
  }

  /* ── UI ─────────────────────────────────────────────────────────── */

  function injectStyles() {
    if (document.getElementById('tacta-fb-styles')) return;
    var style = document.createElement('style');
    style.id = 'tacta-fb-styles';
    style.textContent = [
      '.tacta-fb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:flex-start;justify-content:flex-start;padding:16px;overflow:auto}',
      '.tacta-fb{background:var(--tacta-surface,#fff);color:var(--tacta-text,#1a1a1a);border:1px solid var(--tacta-border,#d0d5dd);border-radius:10px;width:100%;max-width:520px;padding:16px 18px;box-shadow:0 12px 40px rgba(0,0,0,.25);font-size:13px;line-height:1.5;text-align:left}',
      '.tacta-fb h3{margin:0 0 4px;font-size:16px}',
      '.tacta-fb-sub{margin:0 0 12px;color:var(--tacta-text-muted,#667085);font-size:12px}',
      '.tacta-fb-row{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}',
      '.tacta-fb-row label{font-weight:600;font-size:12.5px}',
      '.tacta-fb input[type=text],.tacta-fb input[type=email],.tacta-fb textarea,.tacta-fb select{width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid var(--tacta-border,#d0d5dd);border-radius:6px;background:var(--tacta-surface,#fff);color:var(--tacta-text,#1a1a1a);font:inherit}',
      '.tacta-fb textarea{min-height:84px;resize:vertical}',
      '.tacta-fb-check{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;margin-bottom:6px}',
      '.tacta-fb-check input{margin-top:3px}',
      '.tacta-fb-check span{flex:1}',
      '.tacta-fb-url{display:block;color:var(--tacta-text-muted,#667085);font-size:11px;word-break:break-all}',
      '.tacta-fb-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}',
      '.tacta-fb-btn{padding:6px 11px;border-radius:6px;border:1px solid var(--tacta-border,#d0d5dd);background:var(--tacta-surface-2,#f2f4f7);color:var(--tacta-text,#1a1a1a);cursor:pointer;font:inherit;font-weight:600}',
      '.tacta-fb-btn-primary{background:var(--tacta-accent,#76c043);border-color:var(--tacta-accent,#76c043);color:#fff}',
      '.tacta-fb-btn:disabled{opacity:.5;cursor:default}',
      '.tacta-fb-note{margin:8px 0 0;font-size:11.5px;color:var(--tacta-text-muted,#667085)}',
      '.tacta-fb-err{color:#c0392b;font-size:12px;margin-top:4px}'
    ].join('');
    document.head.appendChild(style);
  }

  var openOverlay = null;

  function close() {
    if (openOverlay && openOverlay.parentNode) openOverlay.parentNode.removeChild(openOverlay);
    openOverlay = null;
  }

  /**
   * Open the feedback form.
   * @param {Object} [opts]
   * @param {'bug'|'idea'|'question'} [opts.type]  preselected type
   * @param {string} [opts.context]                 free text appended to details (e.g. feature name)
   */
  function open(opts) {
    opts = opts || {};
    injectStyles();
    close();

    var email = (author().feedbackEmail || '').trim();
    var overlay = el('div', 'tacta-fb-overlay');
    var box = el('div', 'tacta-fb');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'tactaFbTitle');

    var h = el('h3', null, 'Send feedback');
    h.id = 'tactaFbTitle';
    box.appendChild(h);
    box.appendChild(el('p', 'tacta-fb-sub', email
      ? 'This opens your email program with the message filled in. Nothing is sent until you press Send there.'
      : 'This opens a new GitHub issue with the message filled in. Nothing is sent until you submit it there.'));

    // Type
    var rowType = el('div', 'tacta-fb-row');
    var lblType = el('label', null, 'What kind of feedback?');
    lblType.htmlFor = 'tactaFbType';
    var selType = el('select');
    selType.id = 'tactaFbType';
    TYPES.forEach(function (t) {
      var o = el('option', null, t.label);
      o.value = t.id;
      if (t.id === (opts.type || 'bug')) o.selected = true;
      selType.appendChild(o);
    });
    rowType.appendChild(lblType); rowType.appendChild(selType); box.appendChild(rowType);

    // Title
    var rowTitle = el('div', 'tacta-fb-row');
    var lblTitle = el('label', null, 'One-line summary');
    lblTitle.htmlFor = 'tactaFbTitleIn';
    var inTitle = el('input'); inTitle.type = 'text'; inTitle.id = 'tactaFbTitleIn'; inTitle.maxLength = 120;
    inTitle.placeholder = 'e.g. Results tab adds a blank row on saved searches';
    rowTitle.appendChild(lblTitle); rowTitle.appendChild(inTitle); box.appendChild(rowTitle);

    // Details
    var rowDet = el('div', 'tacta-fb-row');
    var lblDet = el('label', null, 'What happened? What did you expect?');
    lblDet.htmlFor = 'tactaFbDetails';
    var taDet = el('textarea'); taDet.id = 'tactaFbDetails';
    taDet.placeholder = 'Steps you took, what you saw, and what you expected to see.';
    if (opts.context) taDet.value = opts.context + '\n\n';
    rowDet.appendChild(lblDet); rowDet.appendChild(taDet); box.appendChild(rowDet);

    // Include page
    var chkPage = el('label', 'tacta-fb-check');
    var inPage = el('input'); inPage.type = 'checkbox'; inPage.checked = true;
    var spPage = el('span', null, 'Include the address of the NetSuite page I have open');
    var urlLine = el('small', 'tacta-fb-url', 'Looking up the current tab…');
    spPage.appendChild(urlLine);
    chkPage.appendChild(inPage); chkPage.appendChild(spPage); box.appendChild(chkPage);

    // Include tech
    var chkTech = el('label', 'tacta-fb-check');
    var inTech = el('input'); inTech.type = 'checkbox'; inTech.checked = true;
    var m = manifest();
    chkTech.appendChild(inTech);
    chkTech.appendChild(el('span', null, 'Include technical details (' + m.name + ' v' + m.version + ', ' + browserLine() + ', which features are on)'));
    box.appendChild(chkTech);

    // Reply-to
    var rowMail = el('div', 'tacta-fb-row');
    var lblMail = el('label', null, 'Your email, if you want a reply (optional)');
    lblMail.htmlFor = 'tactaFbReply';
    var inMail = el('input'); inMail.type = 'email'; inMail.id = 'tactaFbReply'; inMail.placeholder = 'you@example.com';
    rowMail.appendChild(lblMail); rowMail.appendChild(inMail); box.appendChild(rowMail);

    var err = el('div', 'tacta-fb-err', '');
    box.appendChild(err);

    // Actions
    var actions = el('div', 'tacta-fb-actions');
    var btnSend = el('button', 'tacta-fb-btn tacta-fb-btn-primary', email ? 'Open in my email' : 'Open GitHub issue');
    btnSend.type = 'button';
    var btnCopy = el('button', 'tacta-fb-btn', 'Copy message');
    btnCopy.type = 'button';
    var btnCancel = el('button', 'tacta-fb-btn', 'Cancel');
    btnCancel.type = 'button';
    actions.appendChild(btnSend); actions.appendChild(btnCopy); actions.appendChild(btnCancel);
    box.appendChild(actions);
    box.appendChild(el('p', 'tacta-fb-note', email
      ? 'Goes to ' + email + '. No email program? Use Copy message and paste it into any mail you like.'
      : 'Needs a free GitHub account. No account? Use Copy message and email it to the author from the About section.'));

    overlay.appendChild(box);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    btnCancel.addEventListener('click', close);

    document.body.appendChild(overlay);
    openOverlay = overlay;
    inTitle.focus();

    var pageUrl = '';
    var featureInfo = { on: [], userType: '' };
    currentPage().then(function (u) {
      pageUrl = u;
      if (u) { urlLine.textContent = u; }
      else { urlLine.textContent = 'No NetSuite tab is active, nothing to include.'; inPage.checked = false; inPage.disabled = true; }
    });
    enabledFeatures().then(function (f) { featureInfo = f; });

    function collect() {
      return {
        type: selType.value,
        title: inTitle.value.trim(),
        details: taDet.value.trim(),
        includePage: inPage.checked,
        pageUrl: pageUrl,
        includeTech: inTech.checked,
        features: featureInfo.on,
        userType: featureInfo.userType,
        replyTo: inMail.value.trim()
      };
    }

    function validate(state) {
      if (!state.title && !state.details) { err.textContent = 'Please write a summary or some details first.'; return false; }
      err.textContent = '';
      return true;
    }

    btnSend.addEventListener('click', function () {
      var state = collect();
      if (!validate(state)) return;
      var msg = buildMessage(state);
      btnSend.disabled = true;
      openTarget(targetUrl(msg)).then(function () { close(); });
    });

    btnCopy.addEventListener('click', function () {
      var state = collect();
      if (!validate(state)) return;
      var msg = buildMessage(state);
      var text = 'Subject: ' + msg.subject + '\n\n' + msg.body;
      navigator.clipboard.writeText(text).then(function () {
        btnCopy.textContent = 'Copied';
        setTimeout(function () { btnCopy.textContent = 'Copy message'; }, 1800);
      }, function () { err.textContent = 'Could not copy. Select the text and copy it by hand.'; });
    });
  }

  /** Attach the form to any element: `data-tacta-feedback` buttons open it. */
  function bind(root) {
    (root || document).querySelectorAll('[data-tacta-feedback]').forEach(function (b) {
      if (b.__tactaFb) return;
      b.__tactaFb = true;
      b.addEventListener('click', function (e) {
        e.preventDefault();
        open({ type: b.getAttribute('data-tacta-feedback') || undefined });
      });
    });
  }

  window.TactaFeedback = { open: open, close: close, bind: bind, buildMessage: buildMessage, targetUrl: targetUrl };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { bind(); });
  else bind();
})();

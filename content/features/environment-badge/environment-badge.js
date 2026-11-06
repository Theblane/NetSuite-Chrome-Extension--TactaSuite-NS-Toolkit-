/**
 * environment-badge.js
 * NetSuite TactaSuite - Environment Badge (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Shows a compact pill next to the NetSuite logo (or at the start of the
 * header) that names the environment and account, e.g. "SB1 - 4485744",
 * and prefixes the browser tab title with "[SB1] " / "[PROD] " / "[RP] ".
 *
 * Environment is parsed from location.hostname:
 *   4485744.app.netsuite.com          -> PROD
 *   4485744-sb1.app.netsuite.com      -> SB1
 *   4485744-sandbox.app.netsuite.com  -> SB1 (legacy naming)
 *   4485744-rp.app.netsuite.com       -> RP  (release preview)
 *   system.netsuite.com / system.sandbox.netsuite.com -> account id from
 *   TactaNS.getAccountId() (compid param / cookie)
 *
 * Colors follow account-color when the user has customised it
 * (tacta_ac_color_prod / tacta_ac_color_sandbox / tacta_ac_color_sandbox_n).
 *
 * Settings (chrome.storage.local):
 *   tacta_env_badge_show_account_id  boolean, default true
 *   tacta_env_badge_title_prefix     boolean, default true
 *
 * Title prefixing cooperates with better-page-titles: a MutationObserver on
 * <title> re-applies the prefix whenever another script rewrites the title,
 * but never double-prefixes.
 *
 * @fileoverview Environment Badge content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaEnvironmentBadgeLoaded) return;
    window.__tactaEnvironmentBadgeLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} DOM ID for the pill element */
    var PILL_ID = 'tacta-env-badge';

    /** @type {string} CSS class scope */
    var SC = 'tacta-env-badge';

    /** @type {RegExp} Matches an existing environment prefix in document.title */
    var TITLE_PREFIX_RE = /^\[(PROD|SB\d+|RP|SANDBOX)\]\s+/i;

    /** @type {number} Max title re-applies per window, to rule out observer loops */
    var TITLE_APPLY_LIMIT = 25;

    /** @type {number} Window (ms) for the re-apply limit */
    var TITLE_APPLY_WINDOW_MS = 10000;

    /**
     * Default colors per environment kind. Overridden from account-color
     * storage keys when present.
     * @type {Object<string, string>}
     */
    var COLORS = {
        prod: '#ff4444',
        sandbox: '#76c043',
        sandboxN: '#76c043',
        rp: '#f0a020'
    };

    /** Settings loaded from storage, with defaults */
    var _settings = {
        showAccountId: true,
        titlePrefix: true
    };

    /** @type {Object|null} Parsed environment info */
    var _env = null;

    /** @type {string} Resolved pill color */
    var _color = COLORS.sandbox;

    /** @type {MutationObserver|null} */
    var _titleObserver = null;

    /** @type {boolean} Re-entrancy guard while we set document.title */
    var _settingTitle = false;

    /** @type {number[]} Timestamps of recent title applies */
    var _applyStamps = [];

    // ────────────────────────────────────────────────────────────────
    // Environment parsing
    // ────────────────────────────────────────────────────────────────

    /**
     * Parse hostname into { kind, label, accountId, sbNumber }.
     *   kind:  'prod' | 'sandbox' | 'rp'
     *   label: 'PROD' | 'SB1'..'SBn' | 'RP'
     * @param {string} hostname
     * @returns {{ kind: string, label: string, accountId: string|null, sbNumber: number }}
     */
    function parseEnvironment(hostname) {
        var host = (hostname || '').toLowerCase();
        var result = { kind: 'prod', label: 'PROD', accountId: null, sbNumber: 0 };

        // Primary pattern: 4485744.app / 4485744-sb1.app / 4485744-sandbox2.app / 4485744-2.app
        var m = host.match(/^(\d+)(?:-(?:sandbox|sb)?(\d+))?\./i);
        if (m) {
            result.accountId = m[1];
            if (m[2]) {
                result.kind = 'sandbox';
                result.sbNumber = parseInt(m[2], 10) || 1;
                result.label = 'SB' + result.sbNumber;
            }
            return result;
        }

        // Letter-prefixed account ids (tstdrv123456) and suffixes without a
        // number: -sandbox (legacy SB1) and -rp (release preview)
        var m2 = host.match(/^([a-z]*\d+)(?:-(sandbox|sb|rp)(\d*))?\./i);
        if (m2) {
            result.accountId = m2[1];
            var suffix = (m2[2] || '').toLowerCase();
            if (suffix === 'rp') {
                result.kind = 'rp';
                result.label = 'RP';
            } else if (suffix === 'sandbox' || suffix === 'sb') {
                result.kind = 'sandbox';
                result.sbNumber = parseInt(m2[3], 10) || 1;
                result.label = 'SB' + result.sbNumber;
            }
            return result;
        }

        // system.netsuite.com / system.sandbox.netsuite.com: the account is not
        // in the host, so ask TactaNS (compid param, cookie).
        if (window.TactaNS && typeof window.TactaNS.getAccountId === 'function') {
            try {
                var acct = window.TactaNS.getAccountId();
                if (acct) {
                    result.accountId = String(acct);
                    // compid may itself carry the sandbox marker: 4485744_SB1
                    var sb = result.accountId.match(/^(\w+?)[_-]sb(\d+)$/i);
                    if (sb) {
                        result.accountId = sb[1];
                        result.kind = 'sandbox';
                        result.sbNumber = parseInt(sb[2], 10) || 1;
                        result.label = 'SB' + result.sbNumber;
                        return result;
                    }
                }
            } catch (_) { /* ignore */ }
        }

        if (/\.sandbox\./i.test(host) || /^system\.sandbox/i.test(host)) {
            result.kind = 'sandbox';
            result.sbNumber = 1;
            result.label = 'SB1';
        } else if (/-rp\./i.test(host) || /\.rp\./i.test(host)) {
            result.kind = 'rp';
            result.label = 'RP';
        }
        return result;
    }

    // ────────────────────────────────────────────────────────────────
    // Storage
    // ────────────────────────────────────────────────────────────────

    /**
     * Load settings and account-color overrides from chrome.storage.local.
     * @returns {Promise<void>}
     */
    function loadStorage() {
        return new Promise(function (resolve) {
            try {
                chrome.storage.local.get([
                    'tacta_env_badge_show_account_id',
                    'tacta_env_badge_title_prefix',
                    'tacta_ac_color_prod',
                    'tacta_ac_color_sandbox',
                    'tacta_ac_color_sandbox_n'
                ], function (data) {
                    data = data || {};
                    _settings.showAccountId = data.tacta_env_badge_show_account_id !== false;
                    _settings.titlePrefix = data.tacta_env_badge_title_prefix !== false;
                    if (data.tacta_ac_color_prod) COLORS.prod = data.tacta_ac_color_prod;
                    if (data.tacta_ac_color_sandbox) COLORS.sandbox = data.tacta_ac_color_sandbox;
                    if (data.tacta_ac_color_sandbox_n) COLORS.sandboxN = data.tacta_ac_color_sandbox_n;
                    resolve();
                });
            } catch (_) {
                resolve();
            }
        });
    }

    /**
     * Resolve the pill color for the parsed environment.
     * @param {Object} env
     * @returns {string}
     */
    function resolveColor(env) {
        if (env.kind === 'prod') return COLORS.prod;
        if (env.kind === 'rp') return COLORS.rp;
        if (env.sbNumber > 1) return COLORS.sandboxN;
        return COLORS.sandbox;
    }

    // ────────────────────────────────────────────────────────────────
    // Pill
    // ────────────────────────────────────────────────────────────────

    /**
     * Find a stable header anchor. Returns { parent, before } for insertion,
     * or null when no header is present (caller uses the fixed fallback).
     * @returns {{ parent: HTMLElement, before: Node|null }|null}
     */
    /**
     * Copy text to the clipboard using TactaDOM when available.
     * @param {string} text
     */
    function copyText(text) {
        var done = function () {
            if (window.TactaDOM && window.TactaDOM.showToast) {
                window.TactaDOM.showToast('Copied ' + text, 'success', 1500);
            }
        };
        if (window.TactaDOM && window.TactaDOM.copyToClipboard) {
            window.TactaDOM.copyToClipboard(text).then(done);
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(function () {});
        }
    }

    /**
     * Build the pill element.
     * @returns {HTMLElement}
     */
    function buildPill() {
        var pill = document.createElement('span');
        pill.id = PILL_ID;
        pill.className = SC + ' ' + SC + '--' + _env.kind;
        pill.style.setProperty('--tacta-env-color', _color);

        var label = document.createElement('span');
        label.className = SC + '-label';
        label.textContent = _env.label;
        pill.appendChild(label);

        if (_settings.showAccountId && _env.accountId) {
            var sep = document.createElement('span');
            sep.className = SC + '-sep';
            sep.textContent = ' - ';
            pill.appendChild(sep);

            var acct = document.createElement('span');
            acct.className = SC + '-account';
            acct.textContent = _env.accountId;
            pill.appendChild(acct);
        }

        var full = _env.kind === 'prod' ? 'Production'
            : _env.kind === 'rp' ? 'Release Preview'
            : 'Sandbox ' + _env.sbNumber;
        pill.title = full + (_env.accountId ? ' - account ' + _env.accountId : '') + ' (click to copy account id)';

        pill.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            copyText(_env.accountId || _env.label);
        });

        return pill;
    }

    /**
     * Mount the pill as a fixed top-left overlay (never inside the NetSuite header flow).
     */
    function mountPill() {
        if (document.getElementById(PILL_ID)) return;
        // Always a fixed overlay. Inserting into #div__header pushed NetSuite's
        // own header content down by the pill height: NetSuite sizes the header
        // once at load, so the blue menu bar ended up clipped over the record.
        var pill = buildPill();
        pill.classList.add(SC + '--fixed');
        (document.body || document.documentElement).appendChild(pill);
        // Account Color used to float its own PRODUCTION / SANDBOX label in the
        // same corner. This pill replaces it; Account Color keeps the color bar.
        window.__tactaEnvBadgeActive = true;
        var legacy = document.getElementById('tacta-account-color-badge');
        if (legacy && legacy.parentNode) legacy.parentNode.removeChild(legacy);
    }

    /**
     * NetSuite re-renders the header on some pages; re-mount if the pill
     * was removed. Retries for 10 seconds, then stops.
     */
    function watchPill() {
        var tries = 0;
        var timer = setInterval(function () {
            tries++;
            if (!document.getElementById(PILL_ID)) mountPill();
            if (tries >= 10) clearInterval(timer);
        }, 1000);
    }

    // ────────────────────────────────────────────────────────────────
    // Title prefix
    // ────────────────────────────────────────────────────────────────

    /**
     * Apply "[SB1] " to document.title. Idempotent: an existing matching
     * prefix is left alone, a stale one (different env) is replaced.
     */
    function applyTitlePrefix() {
        if (!_settings.titlePrefix || !_env) return;
        var current = document.title || '';
        var prefix = '[' + _env.label + '] ';
        if (TITLE_PREFIX_RE.test(current)) {
            if (current.indexOf(prefix) === 0) return;
            current = current.replace(TITLE_PREFIX_RE, '');
        }

        // Rate limit to rule out ping-pong with other title scripts
        var now = Date.now();
        _applyStamps = _applyStamps.filter(function (t) { return now - t < TITLE_APPLY_WINDOW_MS; });
        if (_applyStamps.length >= TITLE_APPLY_LIMIT) return;
        _applyStamps.push(now);

        _settingTitle = true;
        document.title = prefix + current;
        _settingTitle = false;
    }

    /**
     * Observe <title> so the prefix survives rewrites by NetSuite or
     * better-page-titles.
     */
    function observeTitle() {
        var titleEl = document.querySelector('title');
        if (!titleEl) {
            titleEl = document.createElement('title');
            (document.head || document.documentElement).appendChild(titleEl);
        }
        if (_titleObserver) _titleObserver.disconnect();
        var debounce = 0;
        _titleObserver = new MutationObserver(function () {
            if (_settingTitle) return;
            clearTimeout(debounce);
            debounce = setTimeout(applyTitlePrefix, 150);
        });
        _titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }

    /**
     * Remove the prefix and stop observing (when the setting is turned off).
     */
    function clearTitlePrefix() {
        if (_titleObserver) _titleObserver.disconnect();
        _titleObserver = null;
        _settingTitle = true;
        document.title = (document.title || '').replace(TITLE_PREFIX_RE, '');
        _settingTitle = false;
    }

    // ────────────────────────────────────────────────────────────────
    // Settings changes
    // ────────────────────────────────────────────────────────────────

    function onStorageChanged(changes, area) {
        if (area !== 'local') return;
        var rebuild = false;

        if (changes.tacta_env_badge_show_account_id) {
            _settings.showAccountId = changes.tacta_env_badge_show_account_id.newValue !== false;
            rebuild = true;
        }
        if (changes.tacta_env_badge_title_prefix) {
            _settings.titlePrefix = changes.tacta_env_badge_title_prefix.newValue !== false;
            if (_settings.titlePrefix) {
                applyTitlePrefix();
                observeTitle();
            } else {
                clearTitlePrefix();
            }
        }
        if (changes.tacta_ac_color_prod || changes.tacta_ac_color_sandbox || changes.tacta_ac_color_sandbox_n) {
            rebuild = true;
        }

        if (rebuild) {
            loadStorage().then(function () {
                _color = resolveColor(_env);
                var old = document.getElementById(PILL_ID);
                if (old && old.parentNode) old.parentNode.removeChild(old);
                mountPill();
            });
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Init
    // ────────────────────────────────────────────────────────────────

    function init() {
        _env = parseEnvironment(window.location.hostname);
        _color = resolveColor(_env);

        mountPill();
        watchPill();

        if (_settings.titlePrefix) {
            applyTitlePrefix();
            observeTitle();
        }

        try {
            chrome.storage.onChanged.addListener(onStorageChanged);
        } catch (_) { /* storage events unavailable */ }
    }

    loadStorage().then(function () {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init, { once: true });
        } else {
            init();
        }
    });
})();

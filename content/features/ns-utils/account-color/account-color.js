/**
 * account-color.js
 * NetSuite TactaSuite - Account Color (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Adds a colored top border bar and environment badge to NetSuite pages
 * to visually distinguish Production from Sandbox environments.
 *
 * Runs automatically on all NetSuite pages (no popup activation needed).
 * Uses TactaNS.isProductionAccount() and TactaNS.getEnvironmentLabel()
 * from shared/ns-utils.js for environment detection.
 *
 * Environment colors:
 *   - Production: red (#ff4444) + "PRODUCTION" label
 *   - Sandbox:    green (#76c043) + "SANDBOX" label
 *   - Sandbox 2+: blue (#4488ff) + "SANDBOX N" label
 *
 * Dismissible per session via sessionStorage.
 *
 * @fileoverview Account Color content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaAccountColorLoaded) return;
    window.__tactaAccountColorLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} CSS class scope for this feature */
    var SCOPE_CLASS = 'tacta-account-color';

    /** @type {string} sessionStorage key for dismissed state */
    var DISMISSED_KEY = 'tacta_account_color_dismissed';

    /** @type {string} ID of the top border bar element */
    var BAR_ID = 'tacta-account-color-bar';

    /** @type {string} ID of the environment badge element */
    var BADGE_ID = 'tacta-account-color-badge';

    /**
     * Environment configuration map.
     * @type {Object<string, { color: string, className: string }>}
     */
    var ENV_CONFIG = {
        'Production': {
            color: '#ff4444',
            className: 'tacta-ac-production'
        },
        'Sandbox': {
            color: '#76c043',
            className: 'tacta-ac-sandbox'
        }
    };

    /** @type {string} Default color for Sandbox 2+ */
    var SANDBOX_N_COLOR = '#4488ff';

    /** @type {string} Default className for Sandbox 2+ */
    var SANDBOX_N_CLASS = 'tacta-ac-sandbox-n';

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {HTMLElement|null} */
    var _barElement = null;

    /** @type {HTMLElement|null} */
    var _badgeElement = null;

    // ────────────────────────────────────────────────────────────────
    // Environment detection
    // ────────────────────────────────────────────────────────────────

    /**
     * Detects the current environment and returns its configuration.
     * @returns {{ label: string, color: string, className: string }}
     */
    function _getEnvironment() {
        var label = 'Production';
        var color = ENV_CONFIG['Production'].color;
        var className = ENV_CONFIG['Production'].className;

        // Use TactaNS if available (loaded as content script dependency)
        if (typeof TactaNS !== 'undefined') {
            label = TactaNS.getEnvironmentLabel();
            var isProd = TactaNS.isProductionAccount();

            if (isProd) {
                color = ENV_CONFIG['Production'].color;
                className = ENV_CONFIG['Production'].className;
            } else if (label === 'Sandbox') {
                color = ENV_CONFIG['Sandbox'].color;
                className = ENV_CONFIG['Sandbox'].className;
            } else {
                // Sandbox 2, 3, etc.
                color = SANDBOX_N_COLOR;
                className = SANDBOX_N_CLASS;
            }
        } else {
            // Fallback: URL-based detection
            var href = window.location.href;
            if (/[-.]sb\d*\./i.test(href) || /\.sandbox\./i.test(href) || /system\.sandbox/i.test(href)) {
                var sbMatch = href.match(/[-.]sb(\d+)/i);
                if (sbMatch) {
                    var num = parseInt(sbMatch[1], 10);
                    if (num === 1) {
                        label = 'Sandbox';
                        color = ENV_CONFIG['Sandbox'].color;
                        className = ENV_CONFIG['Sandbox'].className;
                    } else {
                        label = 'Sandbox ' + num;
                        color = SANDBOX_N_COLOR;
                        className = SANDBOX_N_CLASS;
                    }
                } else {
                    label = 'Sandbox';
                    color = ENV_CONFIG['Sandbox'].color;
                    className = ENV_CONFIG['Sandbox'].className;
                }
            }
        }

        return {
            label: label,
            color: color,
            className: className
        };
    }

    // ────────────────────────────────────────────────────────────────
    // Session persistence
    // ────────────────────────────────────────────────────────────────

    /**
     * Checks if the user has dismissed the badge for this session.
     * @returns {boolean}
     */
    function _isDismissed() {
        try {
            return sessionStorage.getItem(DISMISSED_KEY) === 'true';
        } catch (_) {
            return false;
        }
    }

    /**
     * Marks the badge as dismissed for this session.
     */
    function _setDismissed() {
        try {
            sessionStorage.setItem(DISMISSED_KEY, 'true');
        } catch (_) { /* sessionStorage unavailable */ }
    }

    // ────────────────────────────────────────────────────────────────
    // UI Construction
    // ────────────────────────────────────────────────────────────────

    /**
     * Injects the account color bar and environment badge into the page.
     */
    function _render() {
        // Don't render if dismissed
        if (_isDismissed()) return;

        // Don't double-render
        if (document.getElementById(BAR_ID)) return;

        var env = _getEnvironment();

        // Inject CSS
        _injectCSS();

        // Create top border bar
        _barElement = document.createElement('div');
        _barElement.id = BAR_ID;
        _barElement.className = SCOPE_CLASS + ' tacta-ac-bar ' + env.className;
        _barElement.style.backgroundColor = env.color;
        document.body.appendChild(_barElement);

        // Push page content down to compensate for the fixed bar
        document.body.style.borderTop = '3px solid ' + env.color;

        // The Environment Badge feature shows the label (with account id) in
        // the same corner; when it is active this feature only draws the bar.
        if (window.__tactaEnvBadgeActive || document.getElementById('tacta-env-badge')) {
            requestAnimationFrame(function () {
                if (_barElement) _barElement.classList.add('tacta-ac-visible');
            });
            return;
        }

        // Create environment badge
        _badgeElement = document.createElement('div');
        _badgeElement.id = BADGE_ID;
        _badgeElement.className = SCOPE_CLASS + ' tacta-ac-badge ' + env.className;

        var badgeLabel = document.createElement('span');
        badgeLabel.className = 'tacta-ac-badge-label';
        badgeLabel.textContent = env.label;

        var dismissBtn = document.createElement('button');
        dismissBtn.className = 'tacta-ac-badge-dismiss';
        dismissBtn.title = 'Dismiss for this session';
        dismissBtn.innerHTML = '&#10005;';
        dismissBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _dismiss();
        });

        _badgeElement.appendChild(badgeLabel);
        _badgeElement.appendChild(dismissBtn);
        document.body.appendChild(_badgeElement);

        // Animate in
        requestAnimationFrame(function () {
            if (_badgeElement) _badgeElement.classList.add('tacta-ac-visible');
            if (_barElement) _barElement.classList.add('tacta-ac-visible');
        });
    }

    /**
     * Dismisses the account color indicators for the current session.
     */
    function _dismiss() {
        _setDismissed();

        if (_badgeElement) {
            _badgeElement.classList.remove('tacta-ac-visible');
            _badgeElement.classList.add('tacta-ac-hiding');
        }

        if (_barElement) {
            _barElement.classList.remove('tacta-ac-visible');
            _barElement.classList.add('tacta-ac-hiding');
        }

        // Remove border from body
        document.body.style.borderTop = '';

        // Remove elements after transition
        setTimeout(function () {
            if (_barElement && _barElement.parentNode) {
                _barElement.parentNode.removeChild(_barElement);
                _barElement = null;
            }
            if (_badgeElement && _badgeElement.parentNode) {
                _badgeElement.parentNode.removeChild(_badgeElement);
                _badgeElement = null;
            }
        }, 350);
    }

    /**
     * Injects the feature CSS if not already present.
     */
    function _injectCSS() {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
            var url = chrome.runtime.getURL('content/features/ns-utils/account-color/account-color.css');
            if (document.querySelector('link[href="' + url + '"]')) return;
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = url;
            (document.head || document.documentElement).appendChild(link);
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Custom color loading
    // ────────────────────────────────────────────────────────────────

    /**
     * Loads user-configured colors from chrome.storage.local.
     * Set via the Options page (Account Color Settings section).
     */
    function _loadCustomColors() {
        return new Promise(function (resolve) {
            try {
                chrome.storage.local.get([
                    'tacta_ac_color_prod',
                    'tacta_ac_color_sandbox',
                    'tacta_ac_color_sandbox_n'
                ], function (data) {
                    if (data.tacta_ac_color_prod) {
                        ENV_CONFIG['Production'].color = data.tacta_ac_color_prod;
                    }
                    if (data.tacta_ac_color_sandbox) {
                        ENV_CONFIG['Sandbox'].color = data.tacta_ac_color_sandbox;
                    }
                    if (data.tacta_ac_color_sandbox_n) {
                        SANDBOX_N_COLOR = data.tacta_ac_color_sandbox_n;
                    }
                    resolve();
                });
            } catch (_) {
                resolve();
            }
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Initialization
    // ────────────────────────────────────────────────────────────────

    /**
     * Initializes the feature when the DOM is ready.
     */
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', _render, { once: true });
        } else {
            _render();
        }
    }

    /**
     * Listen for feature activation events dispatched by the router.
     * Although this is an auto-trigger feature, the router still dispatches
     * the activation event after injecting the script.
     */
    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === 'account-color') {
            _render();
        }
    });

    // Load custom colors from storage, then initialize
    _loadCustomColors().then(init);

})();

/**
 * portlet-refresher.js
 * NetSuite TactaSuite - Portlet Refresher (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Adds an "Auto-refresh: Off" control to the dashboard heading panel on
 * /app/center/card.nl. When set to 1/2/5/10/15 minutes it clicks every
 * portlet refresh icon on schedule, but only while the tab is visible.
 * A tab that was hidden past its due time refreshes as soon as it becomes
 * visible again. The control shows the last refresh time.
 *
 * Setting (chrome.storage.local):
 *   tacta_portlet_refresh_minutes  number, default 0 (off)
 *
 * @fileoverview Portlet Refresher content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaPortletRefresherLoaded) return;
    window.__tactaPortletRefresherLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} DOM ID of the control */
    var CONTROL_ID = 'tacta-portlet-refresher';

    /** @type {string} CSS class scope */
    var SC = 'tacta-pr';

    /** @type {string} Storage key */
    var STORAGE_KEY = 'tacta_portlet_refresh_minutes';

    /** @type {number[]} Interval options in minutes (0 = off) */
    var OPTIONS = [0, 1, 2, 5, 10, 15];

    /** @type {string} Selector for the native portlet refresh icons */
    var REFRESH_SELECTOR = '.ns-portlet-icon-refresh[data-action="refresh"]';

    /** @type {number} Scheduler tick (ms); the real cadence comes from the setting */
    var TICK_MS = 15000;

    /** @type {number} Current setting in minutes */
    var _minutes = 0;

    /** @type {number} Epoch ms of the last refresh we triggered */
    var _lastRefresh = 0;

    /** @type {number} Timer handle */
    var _timer = 0;

    /** @type {HTMLElement|null} */
    var _control = null;

    // ────────────────────────────────────────────────────────────────
    // Storage
    // ────────────────────────────────────────────────────────────────

    function loadSetting() {
        return new Promise(function (resolve) {
            try {
                chrome.storage.local.get([STORAGE_KEY], function (data) {
                    var v = data && data[STORAGE_KEY];
                    _minutes = OPTIONS.indexOf(Number(v)) >= 0 ? Number(v) : 0;
                    resolve();
                });
            } catch (_) {
                resolve();
            }
        });
    }

    function saveSetting(minutes) {
        try {
            var obj = {};
            obj[STORAGE_KEY] = minutes;
            chrome.storage.local.set(obj);
        } catch (_) { /* ignore */ }
    }

    // ────────────────────────────────────────────────────────────────
    // Refresh logic
    // ────────────────────────────────────────────────────────────────

    function isDashboard() {
        return /\/app\/center\/card\.nl/i.test(window.location.pathname);
    }

    /**
     * Click every portlet refresh icon. Returns how many were clicked.
     * @returns {number}
     */
    function refreshAll() {
        var icons = document.querySelectorAll(REFRESH_SELECTOR);
        for (var i = 0; i < icons.length; i++) {
            try {
                icons[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            } catch (_) { /* ignore a single bad icon */ }
        }
        _lastRefresh = Date.now();
        updateControl();
        return icons.length;
    }

    function isDue() {
        if (_minutes <= 0) return false;
        return Date.now() - _lastRefresh >= _minutes * 60000;
    }

    function tick() {
        if (_minutes <= 0) return;
        if (document.visibilityState !== 'visible') return;
        if (isDue()) refreshAll();
    }

    function startScheduler() {
        stopScheduler();
        if (_minutes <= 0) return;
        // Count from "now" so a freshly loaded dashboard is not refreshed twice
        _lastRefresh = _lastRefresh || Date.now();
        _timer = setInterval(tick, TICK_MS);
    }

    function stopScheduler() {
        if (_timer) clearInterval(_timer);
        _timer = 0;
    }

    function setMinutes(minutes, persist) {
        _minutes = OPTIONS.indexOf(minutes) >= 0 ? minutes : 0;
        if (persist) saveSetting(_minutes);
        startScheduler();
        updateControl();
    }

    // ────────────────────────────────────────────────────────────────
    // UI
    // ────────────────────────────────────────────────────────────────

    function formatTime(ms) {
        if (!ms) return '';
        var d = new Date(ms);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function optionLabel(m) {
        if (m === 0) return 'Off';
        return m + ' min';
    }

    function updateControl() {
        if (!_control) return;
        var btn = _control.querySelector('.' + SC + '-btn');
        var last = _control.querySelector('.' + SC + '-last');
        if (btn) {
            btn.textContent = 'Auto-refresh: ' + optionLabel(_minutes) + ' ▾';
            btn.title = _minutes > 0
                ? 'Refreshing all portlets every ' + _minutes + ' minute' + (_minutes === 1 ? '' : 's') + ' while this tab is visible'
                : 'Portlet auto-refresh is off';
        }
        if (last) {
            last.textContent = _lastRefresh && _minutes > 0 ? 'Last: ' + formatTime(_lastRefresh) : '';
        }
        _control.classList.toggle(SC + '--active', _minutes > 0);
        var items = _control.querySelectorAll('.' + SC + '-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle(SC + '-item--selected', Number(items[i].getAttribute('data-min')) === _minutes);
        }
    }

    function buildControl() {
        var wrap = document.createElement('div');
        wrap.id = CONTROL_ID;
        wrap.className = SC;

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = SC + '-btn';
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.setAttribute('aria-expanded', 'false');
        wrap.appendChild(btn);

        var last = document.createElement('span');
        last.className = SC + '-last';
        wrap.appendChild(last);

        var now = document.createElement('button');
        now.type = 'button';
        now.className = SC + '-now';
        now.textContent = 'Refresh now';
        now.title = 'Refresh all portlets immediately';
        wrap.appendChild(now);

        var menu = document.createElement('div');
        menu.className = SC + '-menu';
        menu.setAttribute('role', 'listbox');
        menu.hidden = true;
        OPTIONS.forEach(function (m) {
            var item = document.createElement('button');
            item.type = 'button';
            item.className = SC + '-item';
            item.setAttribute('role', 'option');
            item.setAttribute('data-min', String(m));
            item.textContent = m === 0 ? 'Off' : 'Every ' + m + ' minute' + (m === 1 ? '' : 's');
            item.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                closeMenu();
                setMinutes(m, true);
            });
            menu.appendChild(item);
        });
        wrap.appendChild(menu);

        function openMenu() {
            menu.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
            document.addEventListener('click', onDocClick, true);
            document.addEventListener('keydown', onKey, true);
        }
        function closeMenu() {
            menu.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
            document.removeEventListener('click', onDocClick, true);
            document.removeEventListener('keydown', onKey, true);
        }
        function onDocClick(e) {
            if (!wrap.contains(e.target)) closeMenu();
        }
        function onKey(e) {
            if (e.key === 'Escape') closeMenu();
        }

        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (menu.hidden) openMenu(); else closeMenu();
        });

        now.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var n = refreshAll();
            if (window.TactaDOM && window.TactaDOM.showToast) {
                window.TactaDOM.showToast('Refreshed ' + n + ' portlet' + (n === 1 ? '' : 's'), 'success', 1500);
            }
        });

        return wrap;
    }

    function mountControl() {
        if (document.getElementById(CONTROL_ID)) return;
        _control = buildControl();
        var heading = document.getElementById('ns-dashboard-heading-panel');
        if (heading) {
            heading.appendChild(_control);
            _control.classList.add(SC + '--inline');
        } else {
            _control.classList.add(SC + '--fixed');
            document.body.appendChild(_control);
        }
        updateControl();
    }

    // ────────────────────────────────────────────────────────────────
    // Init
    // ────────────────────────────────────────────────────────────────

    function init() {
        if (!isDashboard()) return;

        mountControl();
        startScheduler();

        // Hidden past due? Refresh on return.
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') tick();
        });

        // Keep in sync with other tabs / the options page
        try {
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== 'local' || !changes[STORAGE_KEY]) return;
                var v = Number(changes[STORAGE_KEY].newValue);
                if (v !== _minutes) setMinutes(OPTIONS.indexOf(v) >= 0 ? v : 0, false);
            });
        } catch (_) { /* ignore */ }

        // The heading panel can render after DOMContentLoaded; retry briefly.
        var tries = 0;
        var t = setInterval(function () {
            tries++;
            var heading = document.getElementById('ns-dashboard-heading-panel');
            if (heading && _control && !heading.contains(_control)) {
                _control.classList.remove(SC + '--fixed');
                _control.classList.add(SC + '--inline');
                heading.appendChild(_control);
            }
            if ((heading && _control && heading.contains(_control)) || tries >= 10) clearInterval(t);
        }, 1000);
    }

    loadSetting().then(function () {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init, { once: true });
        } else {
            init();
        }
    });
})();

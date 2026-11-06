/**
 * popup.js
 * NetSuite TactaSuite — Popup Controller
 *
 * @author Blane Maher
 *
 * Manages the extension popup: environment detection, quick actions,
 * feature toggles, meeting mode, active-feature display and the gear
 * settings panel (user type User / Developer / Custom, theme, settings
 * export, links to the walkthrough and the full settings page).
 *
 * Communicates with the background service-worker via chrome.runtime
 * messages using the established { action, ... } protocol.
 *
 * Pure vanilla JS — no frameworks.
 */

(() => {
    'use strict';

    /* ── Constants ─────────────────────────────────────────────────── */

    const GROUP_ORDER = ['developer', 'search', 'record', 'layout', 'misc'];

    /** Labels for display (groups are stored lowercase in the registry) */
    const GROUP_LABELS = {
        developer: 'Developer',
        search:    'Search',
        record:    'Record',
        layout:    'Layout',
        misc:      'Misc',
    };

    /** User type presets and the Custom state (shared/user-types.js). */
    const UT = window.TactaUserTypes;

    /** Quick-action button IDs — must stay in sync with popup.html */
    const QUICK_ACTIONS = [
        'field-explorer', 'record-object', 'script-explorer', 'suiteql-runner',
        'screenshot-studio', 'csv-template-generator', 'audit-trail', 'search-url-builder',
        'script-content-search',
    ];

    const STORAGE_KEY_GROUPS = 'tacta_group_collapsed';
    const STORAGE_KEY_USER_TYPE = UT.STORAGE_KEY;

    /** Hint shown under the user type segment for each state. */
    const USER_TYPE_HINTS = {
        user:      'User is the default. Developer turns on every tool. Changing any toggle switches you to Custom.',
        developer: 'Every tool is on. Changing any toggle switches you to Custom; User resets to the basics.',
        custom:    'Your toggles differ from both presets. Pick User or Developer to reset them, or Export settings to keep this setup.',
    };



    /* ── DOM References ───────────────────────────────────────────── */

    const $envDot         = document.getElementById('envDot');
    const $envLabel       = document.getElementById('envLabel');
    const $meetingToggle  = document.getElementById('meetingToggle');
    const $quickActions   = document.getElementById('quickActions');
    const $activeCount    = document.getElementById('activeCount');
    const $activeFeatures = document.getElementById('activeFeatures');
    const $featureGroups  = document.getElementById('featureGroups');
    const $optionsLink    = document.getElementById('optionsLink');
    const $settingsToggle = document.getElementById('settingsToggle');
    const $settingsPanel  = document.getElementById('settingsPanel');
    const $userTypeSeg    = document.getElementById('userTypeSegment');
    const $userTypeHint   = document.getElementById('userTypeHint');
    const $themeSeg       = document.getElementById('themeSegment');
    const $accentColor    = document.getElementById('accentColor');
    const $closeOutside   = document.getElementById('closeOnClickOutside');
    const $runWalkthrough = document.getElementById('runWalkthroughLink');
    const $exportBtn      = document.getElementById('exportSettingsBtn');
    const $allSettingsBtn = document.getElementById('allSettingsBtn');


    /* ── State ────────────────────────────────────────────────────── */

    let features        = [];     // Full feature registry from background
    let featureStates   = {};     // { featureId: boolean }
    let groupCollapsed  = {};     // { groupName: boolean }
    let meetingMode     = false;
    let userType        = UT.DEFAULT_TYPE; // 'user' | 'developer' | 'custom'
    let themeSettings   = null;   // { scheme, accent } from TactaThemeManager
    let currentTabId    = null;
    let currentTabUrl   = '';


    /* ── Background Messaging ─────────────────────────────────────── */

    /**
     * Send a message to the background service-worker and return the response.
     * @param {Object} payload - Must include `action`.
     * @returns {Promise<*>}
     */
    function sendMessage(payload) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(payload, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else if (response?.error) {
                    reject(new Error(response.error));
                } else {
                    resolve(response);
                }
            });
        });
    }


    /* ── Initialisation ───────────────────────────────────────────── */

    async function init() {
        // Version comes from the manifest so the badge can never drift from it.
        document.querySelectorAll('.tacta-version').forEach((el) => { el.textContent = 'v' + chrome.runtime.getManifest().version; });
        await loadState();
        detectEnvironment();
        renderFeatureGroups();
        renderActiveFeatures();
        updateQuickActions();
        updateLaunchButtons();
        bindEvents();
        updateMeetingModeUI();
        await loadSettingsPanel();
        renderAuthor();
        await loadUpdateNotice();
    }

    /* ── Update notice ─────────────────────────────────────────────── */

    async function loadUpdateNotice() {
        const $notice = document.getElementById('updateNotice');
        if (!$notice) return;
        let notice = null;
        try {
            const data = await chrome.storage.local.get('tacta_update_notice');
            notice = data.tacta_update_notice || null;
        } catch (_) { /* ignore */ }
        if (!notice || !notice.to) return;
        const $text = document.getElementById('updateNoticeText');
        if ($text) $text.textContent = 'Updated to v' + notice.to + '. New features are off until you turn them on.';
        $notice.removeAttribute('hidden');
        const dismiss = () => { chrome.storage.local.remove('tacta_update_notice'); $notice.setAttribute('hidden', ''); };
        const $tour = document.getElementById('updateNoticeTour');
        const $dismiss = document.getElementById('updateNoticeDismiss');
        if ($tour) {
            $tour.addEventListener('click', () => {
                dismiss();
                sendMessage({ action: 'openOnboarding', step: 'features' }).then(() => window.close()).catch(() => {
                    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html?step=features') });
                });
            });
        }
        if ($dismiss) $dismiss.addEventListener('click', dismiss);
    }

    /** Author name and support links in the footer (shared/author-links.js). */
    function renderAuthor() {
        const mount = document.getElementById('authorMount');
        if (!mount || !window.TactaAuthor) return;
        window.TactaAuthor.render(mount, { variant: 'compact', prefix: 'by' });
    }

    async function loadState() {
        // Feature states from background (via storage-manager)
        try {
            featureStates = await sendMessage({ action: 'getFeatureStates' }) || {};
        } catch {
            // If background isn't ready, read storage directly
            const data = await chrome.storage.local.get('featureStates');
            featureStates = data.featureStates || {};
        }

        // Meeting mode
        try {
            meetingMode = await sendMessage({ action: 'getMeetingMode' });
        } catch {
            const data = await chrome.storage.local.get('meetingMode');
            meetingMode = data.meetingMode === true;
        }

        // Feature registry from background service worker
        try {
            features = await sendMessage({ action: 'getFeatures' }) || [];
        } catch {
            features = [];
        }

        // Merge defaults for any features not yet in storage
        for (const f of features) {
            if (!(f.id in featureStates)) {
                featureStates[f.id] = f.defaultEnabled;
            }
        }

        // Group collapse state (stored locally, not shared with background)
        const groupData = await chrome.storage.local.get(STORAGE_KEY_GROUPS);
        groupCollapsed = groupData[STORAGE_KEY_GROUPS] || {};

        // User type. The retired 'admin' preset reads back as Custom.
        const utData = await chrome.storage.local.get(STORAGE_KEY_USER_TYPE);
        userType = UT.normalize(utData[STORAGE_KEY_USER_TYPE]);
    }

    /* ── Environment Detection ────────────────────────────────────── */

    async function detectEnvironment() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) return;

            currentTabId  = tab.id;
            currentTabUrl = tab.url || '';

            const isNetSuite = /netsuite\.com/i.test(currentTabUrl);

            if (!isNetSuite) {
                $envDot.className  = 'tacta-env-dot';
                $envLabel.textContent = 'Not NetSuite';
                return;
            }

            const isSandbox = /sb\d/i.test(currentTabUrl) || /sandbox/i.test(currentTabUrl);

            if (isSandbox) {
                $envDot.className  = 'tacta-env-dot sandbox';
                $envLabel.textContent = 'Sandbox';
            } else {
                $envDot.className  = 'tacta-env-dot production';
                $envLabel.textContent = 'Production';
            }
        } catch {
            $envDot.className  = 'tacta-env-dot';
            $envLabel.textContent = 'Unknown';
        }
    }


    /* ── Feature Launching ───────────────────────────────────────── */

    /**
     * Inject and activate a feature in the current tab. Shared by the Quick
     * Action buttons and the per-row Open buttons in the Features list.
     * @param {string} featureId
     */
    function launchFeature(featureId) {
        const feat  = features.find(f => f.id === featureId);
        const label = feat ? feat.label : featureId;

        if (meetingMode) {
            showPopupError('Meeting mode is enabled — toggle it off to use features.');
            return;
        }
        if (!currentTabId) {
            showPopupError('No active tab detected.');
            return;
        }
        if (featureStates[featureId] !== true) {
            showPopupError('"' + label + '" is disabled. Enable it below or pick a different user type in Settings.');
            return;
        }

        sendMessage({
            action:    'executeFeature',
            featureId: featureId,
            tabId:     currentTabId,
        }).then(() => {
            window.close();
        }).catch((err) => {
            console.error('[Popup] Launch failed:', err);
            showPopupError('Could not open "' + label + '": ' + (err && err.message ? err.message : String(err)));
        });
    }

    function showPopupError(message) {
        var existing = document.querySelector('.tacta-popup-error');
        if (existing) existing.remove();
        var bar = document.createElement('div');
        bar.className = 'tacta-popup-error';
        bar.textContent = message;
        bar.style.cssText = 'position:fixed;left:8px;right:8px;bottom:36px;padding:8px 10px;' +
            'background:var(--tacta-error-bg);color:var(--tacta-error);border:1px solid var(--tacta-error);border-radius:4px;' +
            'font-size:11px;z-index:9999;box-shadow:var(--tacta-shadow-md);';
        document.body.appendChild(bar);
        setTimeout(function () { if (bar.parentNode) bar.remove(); }, 4000);
    }


    /* ── Active Features ──────────────────────────────────────────── */

    function renderActiveFeatures() {
        const enabledFeatures = features.filter(f => featureStates[f.id]);

        $activeCount.textContent = enabledFeatures.length;

        if (enabledFeatures.length === 0) {
            $activeFeatures.innerHTML = '<p class="tacta-empty-state">No features enabled</p>';
            return;
        }

        // Show only auto-triggered features as "active on this page"
        const autoFeatures = enabledFeatures.filter(f => f.trigger === 'auto');

        if (autoFeatures.length === 0) {
            $activeFeatures.innerHTML = '<p class="tacta-empty-state">No auto-features active</p>';
            $activeCount.textContent = '0';
            return;
        }

        $activeCount.textContent = autoFeatures.length;
        $activeFeatures.innerHTML = autoFeatures
            .map(f => `
                <div class="tacta-active-item">
                    <span class="tacta-active-dot"></span>
                    <span>${f.label}</span>
                </div>`)
            .join('');
    }

    function updateQuickActions() {
        if (!$quickActions) return;
        $quickActions.querySelectorAll('.tacta-action-btn[data-action]').forEach((btn) => {
            const enabled = featureStates[btn.dataset.action] === true;
            btn.disabled = meetingMode || !enabled;
            btn.classList.toggle('disabled', meetingMode || !enabled);
        });
    }

    /** Keep the per-row Open buttons in step with toggle and meeting-mode state. */
    function updateLaunchButtons() {
        if (!$featureGroups) return;
        $featureGroups.querySelectorAll('.tacta-feature-launch[data-launch-id]').forEach((btn) => {
            const enabled = featureStates[btn.dataset.launchId] === true;
            btn.disabled = meetingMode || !enabled;
            btn.classList.toggle('disabled', meetingMode || !enabled);
        });
    }


    /* ── Feature Groups & Toggles ─────────────────────────────────── */

    function renderFeatureGroups() {
        $featureGroups.innerHTML = '';

        for (const group of GROUP_ORDER) {
            const groupFeatures = features.filter(f => f.group === group);
            if (groupFeatures.length === 0) continue;

            const isCollapsed = groupCollapsed[group] === true;

            const groupEl = document.createElement('div');
            groupEl.className = 'tacta-feature-group';

            // Header
            const header = document.createElement('div');
            header.className = `tacta-group-header${isCollapsed ? '' : ' expanded'}`;
            header.innerHTML = `
                <div class="tacta-group-header-left">
                    <svg class="tacta-group-arrow" viewBox="0 0 16 16" fill="none">
                        <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5"
                              stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span class="tacta-group-name">${GROUP_LABELS[group] || group}</span>
                    <span class="tacta-group-count">(${groupFeatures.length})</span>
                </div>`;

            // Body
            const body = document.createElement('div');
            body.className = `tacta-group-body${isCollapsed ? '' : ' expanded'}`;

            const items = document.createElement('div');
            items.className = 'tacta-group-items';

            for (const feat of groupFeatures) {
                const row = document.createElement('div');
                row.className = 'tacta-feature-row';

                // Features that only run when asked (trigger: 'popup') get an
                // Open button — otherwise there is no way to launch them.
                const launchBtn = feat.trigger === 'popup'
                    ? `<button class="tacta-feature-launch" data-launch-id="${feat.id}"
                               title="Open ${feat.label} on the current page">Open</button>`
                    : '';

                row.innerHTML = `
                    <div class="tacta-feature-info">
                        <span class="tacta-feature-name">${feat.label}</span>
                        <span class="tacta-feature-desc">${feat.description}</span>
                    </div>
                    <div class="tacta-feature-actions">
                        ${launchBtn}
                        <label class="tacta-toggle">
                            <input type="checkbox" data-feature-id="${feat.id}"
                                   ${featureStates[feat.id] ? 'checked' : ''}>
                            <span class="tacta-toggle-track"></span>
                        </label>
                    </div>`;
                items.appendChild(row);
            }

            body.appendChild(items);
            header.addEventListener('click', () => toggleGroup(group, header, body));
            groupEl.appendChild(header);
            groupEl.appendChild(body);
            $featureGroups.appendChild(groupEl);
        }
    }

    function toggleGroup(group, headerEl, bodyEl) {
        const expanding = !bodyEl.classList.contains('expanded');
        bodyEl.classList.toggle('expanded', expanding);
        headerEl.classList.toggle('expanded', expanding);

        groupCollapsed[group] = !expanding;
        chrome.storage.local.set({ [STORAGE_KEY_GROUPS]: groupCollapsed });
    }


    /* ── Feature Toggle Handler ───────────────────────────────────── */

    function handleFeatureToggle(featureId, enabled) {
        featureStates[featureId] = enabled;

        // Persist via background service-worker
        sendMessage({
            action:    'setFeatureState',
            featureId,
            enabled,
        }).catch((err) => {
            console.error('[Popup] Failed to save feature state:', err);
            // Fall back to direct storage write
            chrome.storage.local.get('featureStates', (data) => {
                const states = data.featureStates || {};
                states[featureId] = enabled;
                chrome.storage.local.set({ featureStates: states });
            });
        });

        renderActiveFeatures();
        updateQuickActions();
        updateLaunchButtons();
        syncUserTypeFromStates();
    }

    /**
     * After a toggle: the user type becomes Custom unless the toggles happen to
     * match a preset exactly again, in which case that preset is shown.
     */
    function syncUserTypeFromStates() {
        const derived = UT.typeForStates(features, featureStates);
        if (derived === userType) return;
        userType = derived;
        chrome.storage.local.set({ [STORAGE_KEY_USER_TYPE]: userType });
        renderUserTypeSegment();
    }


    /* ── Meeting Mode ─────────────────────────────────────────────── */

    function toggleMeetingMode() {
        meetingMode = !meetingMode;
        updateMeetingModeUI();

        sendMessage({
            action:  'setMeetingMode',
            enabled: meetingMode,
        }).catch((err) => {
            console.error('[Popup] Failed to set meeting mode:', err);
            chrome.storage.local.set({ meetingMode });
        });
    }

    function updateMeetingModeUI() {
        document.body.classList.toggle('meeting-mode', meetingMode);
        $meetingToggle.classList.toggle('active', meetingMode);
        updateQuickActions();
        updateLaunchButtons();
    }


    /* ── Options Link ─────────────────────────────────────────────── */

    function openOptions(e) {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
    }


    /* ── Event Binding ────────────────────────────────────────────── */

    function bindEvents() {
        // Quick action buttons
        $quickActions.addEventListener('click', (e) => {
            const btn = e.target.closest('.tacta-action-btn');
            if (!btn) return;
            launchFeature(btn.dataset.action);
        });

        // Feature toggles (delegated)
        $featureGroups.addEventListener('change', (e) => {
            if (e.target.matches('input[data-feature-id]')) {
                handleFeatureToggle(e.target.dataset.featureId, e.target.checked);
            }
        });

        // Per-row Open buttons (delegated)
        $featureGroups.addEventListener('click', (e) => {
            const btn = e.target.closest('.tacta-feature-launch');
            if (!btn) return;
            e.stopPropagation();
            launchFeature(btn.dataset.launchId);
        });

        // Meeting mode
        $meetingToggle.addEventListener('click', toggleMeetingMode);

        // Gear settings panel
        if ($settingsToggle) $settingsToggle.addEventListener('click', toggleSettingsPanel);
        if ($userTypeSeg) {
            $userTypeSeg.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-user-type]');
                if (!btn || btn.disabled || !UT.isPreset(btn.dataset.userType)) return;
                // Re-clicking the active preset still resets stray toggles.
                applyUserTypePreset(btn.dataset.userType);
                renderUserTypeSegment();
            });
        }
        if ($themeSeg) {
            $themeSeg.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-scheme]');
                if (!btn) return;
                saveTheme({ scheme: btn.dataset.scheme });
            });
        }
        if ($accentColor) {
            $accentColor.addEventListener('input', () => {
                if (window.TactaThemeManager) window.TactaThemeManager.apply({ ...(themeSettings || {}), accent: $accentColor.value });
            });
            $accentColor.addEventListener('change', () => saveTheme({ accent: $accentColor.value }));
        }
        if ($closeOutside) {
            $closeOutside.addEventListener('change', () => {
                chrome.storage.local.set({ tacta_close_on_click_outside: $closeOutside.checked });
            });
        }
        if ($runWalkthrough) {
            $runWalkthrough.addEventListener('click', (e) => {
                e.preventDefault();
                sendMessage({ action: 'openOnboarding' }).then(() => window.close()).catch(() => {
                    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
                });
            });
        }
        if ($exportBtn) $exportBtn.addEventListener('click', exportSettings);
        if ($allSettingsBtn) $allSettingsBtn.addEventListener('click', openOptions);

        // Options
        $optionsLink.addEventListener('click', openOptions);

        // Listen for tab activation changes to refresh environment display
        chrome.tabs.onActivated.addListener(async (activeInfo) => {
            currentTabId = activeInfo.tabId;
            try {
                const tab = await chrome.tabs.get(activeInfo.tabId);
                currentTabUrl = tab.url || '';
            } catch {
                currentTabUrl = '';
            }
            detectEnvironment();
            renderActiveFeatures();
        });
    }


    /* ── Export settings ───────────────────────────────────────────── */

    /**
     * Download the current configuration (toggles, theme, preferences) as JSON
     * so it can be backed up or handed to a colleague, who imports it from
     * All settings. Bridge token and onboarding progress never travel.
     */
    async function exportSettings() {
        if (!window.TactaSettingsExport) return;
        try {
            const name = await window.TactaSettingsExport.exportSettings();
            showPopupNotice('Saved ' + name);
        } catch (err) {
            console.error('[Popup] Export failed:', err);
            showPopupError('Could not export settings: ' + (err && err.message ? err.message : String(err)));
        }
    }

    function showPopupNotice(message) {
        var existing = document.querySelector('.tacta-popup-error');
        if (existing) existing.remove();
        var bar = document.createElement('div');
        bar.className = 'tacta-popup-error';
        bar.textContent = message;
        bar.style.cssText = 'position:fixed;left:8px;right:8px;bottom:36px;padding:8px 10px;' +
            'background:var(--tacta-bg-elevated);color:var(--tacta-text);border:1px solid var(--tacta-accent);border-radius:4px;' +
            'font-size:11px;z-index:9999;box-shadow:var(--tacta-shadow-md);';
        document.body.appendChild(bar);
        setTimeout(function () { if (bar.parentNode) bar.remove(); }, 3000);
    }


    /* ── User Type Presets ─────────────────────────────────────────── */

    /**
     * Applies a user type preset: sets every feature toggle to the registry
     * audience default for the selected type, persists the choice, re-renders.
     * @param {string} type - 'user' | 'developer'
     */
    async function applyUserTypePreset(type) {
        if (!UT.isPreset(type)) return;

        userType = type;
        const preset = UT.presetFor(features, type);

        // Apply preset to local state
        for (const [featureId, enabled] of Object.entries(preset)) {
            featureStates[featureId] = enabled;
        }

        // Persist all feature state changes in a single batched message
        // instead of sending one message per feature (Fix #9)
        sendMessage({ action: 'setFeatureStates', states: featureStates }).catch((err) => {
            console.error('[Popup] Failed to batch-save feature states:', err);
            // Fall back to direct storage write
            chrome.storage.local.set({ featureStates });
        });

        // Persist user type selection
        chrome.storage.local.set({ [STORAGE_KEY_USER_TYPE]: type });

        // Re-render
        renderFeatureGroups();
        renderActiveFeatures();
        updateQuickActions();
        updateLaunchButtons();
    }


    /* ── Gear settings panel ──────────────────────────────────────── */

    async function loadSettingsPanel() {
        renderUserTypeSegment();
        if (window.TactaThemeManager) {
            try {
                themeSettings = await window.TactaThemeManager.load();
            } catch (_) {
                themeSettings = window.TactaThemeManager.DEFAULT_SETTINGS;
            }
            renderThemeSegment();
        }
        try {
            const data = await chrome.storage.local.get('tacta_close_on_click_outside');
            if ($closeOutside) $closeOutside.checked = data.tacta_close_on_click_outside === true;
        } catch (_) { /* ignore */ }
    }

    function toggleSettingsPanel() {
        if (!$settingsPanel) return;
        const open = $settingsPanel.hasAttribute('hidden');
        if (open) $settingsPanel.removeAttribute('hidden'); else $settingsPanel.setAttribute('hidden', '');
        $settingsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        $settingsToggle.classList.toggle('active', open);
    }

    function renderUserTypeSegment() {
        if (!$userTypeSeg) return;
        $userTypeSeg.querySelectorAll('[data-user-type]').forEach((btn) => {
            const on = btn.dataset.userType === userType;
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        if ($userTypeHint) $userTypeHint.textContent = USER_TYPE_HINTS[userType] || USER_TYPE_HINTS[UT.DEFAULT_TYPE];
    }

    function renderThemeSegment() {
        if (!themeSettings) return;
        if ($themeSeg) {
            $themeSeg.querySelectorAll('[data-scheme]').forEach((btn) => {
                const on = btn.dataset.scheme === themeSettings.scheme;
                btn.classList.toggle('active', on);
                btn.setAttribute('aria-checked', on ? 'true' : 'false');
            });
        }
        if ($accentColor) $accentColor.value = themeSettings.accent;
    }

    async function saveTheme(partial) {
        if (!window.TactaThemeManager) return;
        themeSettings = await window.TactaThemeManager.save({ ...(themeSettings || {}), ...partial });
        renderThemeSegment();
    }


    /* ── Launch ────────────────────────────────────────────────────── */

    document.addEventListener('DOMContentLoaded', init);
})();

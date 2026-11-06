/**
 * onboarding.js
 * NetSuite TactaSuite - Onboarding Walkthrough Controller
 *
 * @author Blane Maher
 *
 * Multi-step first-run walkthrough. Re-runnable at any time. Every "Next"
 * persists progress so closing the tab mid-way loses nothing.
 *
 * Steps: Welcome -> Who are you? -> Feature pages (by group, max 5 per page)
 *        -> Appearance -> You're set
 *
 * Storage keys written (chrome.storage.local):
 *   tacta_user_type            'user' | 'developer' | 'custom' (shared/user-types.js)
 *   featureStates              { [featureId]: boolean } (normally via background)
 *   tacta_theme_settings       via TactaThemeManager.save
 *   tacta_onboarding_progress  { step: string, updatedAt: number }
 *   tacta_onboarding_completed true
 *   tacta_onboarding_version   manifest version string
 *
 * Messages sent to the service worker:
 *   getFeatures, getFeatureStates, setFeatureState, setFeatureStates
 *
 * Deep links: ?step=features | ?step=ai | ?step=welcome | ?step=usertype
 *             | ?step=appearance | ?step=done
 *
 * Vanilla JS, no frameworks, CSP-safe. All registry text is inserted with
 * textContent so nothing from the registry is ever parsed as HTML.
 */

(() => {
    'use strict';

    /* Constants */

    const GROUP_ORDER = ['developer', 'search', 'record', 'layout', 'misc'];

    const GROUP_LABELS = {
        developer: 'Developer',
        search:    'Search',
        record:    'Record',
        layout:    'Layout',
        misc:      'Misc',
        ai:        'AI'
    };

    const FEATURES_PER_PAGE = 5;

    /** Preset user types (shared/user-types.js). Custom is a derived state. */
    const UT = window.TactaUserTypes;
    const USER_TYPES = UT.PRESET_TYPES;

    const USER_TYPE_CARDS = [
        {
            id: 'user',
            icon: 'U',
            title: 'User',
            tagline: 'I use NetSuite day to day.',
            bullets: [
                'Productivity helpers: exports, pinned headers, better tab titles',
                'Transaction tree and audit trail on records',
                'Developer tools stay off until you want them'
            ]
        },
        {
            id: 'developer',
            icon: 'D',
            title: 'Developer',
            tagline: 'I configure the account or write SuiteScript and SuiteQL.',
            bullets: [
                'Every toolkit feature enabled',
                'Field Explorer, SuiteQL Runner, Script Explorer, console tools',
                'Field help with IDs, workflow colors, account color coding'
            ]
        }
    ];

    const TRIGGER_BADGES = {
        auto:        'Runs automatically',
        popup:       'Open from the toolkit menu',
        contextmenu: 'Right-click menu'
    };

    const SCHEME_OPTIONS = [
        { id: 'light',    label: 'Light' },
        { id: 'dark',     label: 'Dark' },
        { id: 'contrast', label: 'High Contrast' }
    ];

    const DEFAULT_ACCENT = '#76c043';
    const DEFAULT_SCHEME = 'light';

    const KEY_USER_TYPE  = 'tacta_user_type';
    const KEY_PROGRESS   = 'tacta_onboarding_progress';
    const KEY_COMPLETED  = 'tacta_onboarding_completed';
    const KEY_VERSION    = 'tacta_onboarding_version';
    const KEY_FEATURES   = 'featureStates';
    const KEY_THEME      = 'tacta_theme_settings';


    /* DOM references */

    const $extName         = document.getElementById('obExtName');
    const $version         = document.getElementById('obVersion');
    const $progressCounter = document.getElementById('obProgressCounter');
    const $progressLabel   = document.getElementById('obProgressLabel');
    const $progressBar     = document.getElementById('obProgressBar');
    const $progressFill    = document.getElementById('obProgressFill');
    const $milestones      = document.getElementById('obMilestones');
    const $step            = document.getElementById('obStep');
    const $backBtn         = document.getElementById('obBackBtn');
    const $nextBtn         = document.getElementById('obNextBtn');
    const $skipBtn         = document.getElementById('obSkipBtn');
    const $toast           = document.getElementById('obToast');


    /* State */

    let manifest       = { name: 'NetSuite TactaSuite', version: '' };
    let features       = [];
    let featureStates  = {};
    let userType       = null;      // null until the user picks one
    let steps          = [];        // built in buildSteps()
    let stepIndex      = 0;
    let themeDraft     = { scheme: DEFAULT_SCHEME, accent: DEFAULT_ACCENT };
    let themeStored    = null;      // what is actually saved, or null
    let toastTimer     = null;


    /* Messaging */

    function sendMessage(payload) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(payload, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else if (response && response.error) {
                        reject(new Error(response.error));
                    } else {
                        resolve(response);
                    }
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    function storageGet(keys) {
        return chrome.storage.local.get(keys).catch(() => ({}));
    }

    function storageSet(obj) {
        return chrome.storage.local.set(obj).catch((err) => {
            console.error('[Onboarding] storage.set failed:', err);
        });
    }


    /* DOM helpers (textContent only - never innerHTML with data) */

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function clear(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function showToast(message, isError) {
        if (!$toast) return;
        $toast.textContent = message;
        $toast.classList.toggle('is-error', isError === true);
        $toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { $toast.hidden = true; }, 3500);
    }


    /* Registry contract helpers (defensive) */

    /**
     * Audience for a feature. Falls back per the contract when `audience`
     * is missing: defaultEnabled true -> everyone, false -> developer only.
     */
    function audienceFor(feature) {
        // An explicit empty audience means "off for everyone"; only a missing
        // audience falls back to the defaultEnabled rule.
        if (Array.isArray(feature.audience)) {
            return feature.audience.filter((a) => USER_TYPES.includes(a));
        }
        return feature.defaultEnabled ? USER_TYPES.slice() : ['developer'];
    }

    function seededStatesFor(type) {
        const states = {};
        for (const f of features) {
            states[f.id] = audienceFor(f).includes(type);
        }
        return states;
    }

    function userTypeLabel(type) {
        if (type === UT.CUSTOM) return 'Custom';
        const card = USER_TYPE_CARDS.find((c) => c.id === type);
        return card ? card.title : 'Not selected';
    }

    function enabledCount() {
        return features.filter((f) => featureStates[f.id] === true).length;
    }


    /* Step model */

    function buildSteps() {
        const list = [];
        list.push({ id: 'welcome',  milestone: 'Welcome',    label: 'Welcome',      render: renderWelcome });
        list.push({ id: 'usertype', milestone: 'Role',       label: 'Who are you?', render: renderUserType });

        for (const group of GROUP_ORDER) {
            const groupFeatures = features.filter((f) => f.group === group);
            if (!groupFeatures.length) continue;
            const pageCount = Math.ceil(groupFeatures.length / FEATURES_PER_PAGE);
            for (let p = 0; p < pageCount; p++) {
                const slice = groupFeatures.slice(p * FEATURES_PER_PAGE, (p + 1) * FEATURES_PER_PAGE);
                const baseLabel = GROUP_LABELS[group] || group;
                const label = pageCount > 1 ? baseLabel + ' (' + (p + 1) + ' of ' + pageCount + ')' : baseLabel;
                list.push({
                    id: 'features-' + group + '-' + (p + 1),
                    milestone: 'Features',
                    label: label,
                    group: group,
                    features: slice,
                    render: renderFeaturePage
                });
            }
        }

        list.push({ id: 'appearance', milestone: 'Appearance', label: 'Appearance',   render: renderAppearance });
        list.push({ id: 'done',       milestone: 'Done',       label: "You're set",   render: renderDone });
        steps = list;
    }

    function indexForStepId(id) {
        if (!id) return -1;
        if (id === 'features') return steps.findIndex((s) => s.id.indexOf('features-') === 0);
        const exact = steps.findIndex((s) => s.id === id);
        if (exact >= 0) return exact;
        // A stale feature page id (registry changed): land on the first feature page
        if (id.indexOf('features-') === 0) return steps.findIndex((s) => s.id.indexOf('features-') === 0);
        return -1;
    }

    function currentStep() {
        return steps[stepIndex];
    }


    /* Persistence */

    function saveProgress() {
        const step = currentStep();
        if (!step) return Promise.resolve();
        return storageSet({ [KEY_PROGRESS]: { step: step.id, updatedAt: Date.now() } });
    }

    function markCompleted() {
        return storageSet({
            [KEY_COMPLETED]: true,
            [KEY_VERSION]: manifest.version || ''
        });
    }

    async function persistUserType(type, reseed) {
        userType = type;
        await storageSet({ [KEY_USER_TYPE]: type });
        if (!reseed) return;

        const states = seededStatesFor(type);
        featureStates = Object.assign({}, featureStates, states);
        try {
            await sendMessage({ action: 'setFeatureStates', states: states });
        } catch (err) {
            console.warn('[Onboarding] setFeatureStates via background failed, writing storage directly:', err);
            const data = await storageGet(KEY_FEATURES);
            const merged = Object.assign({}, data[KEY_FEATURES] || {}, states);
            await storageSet({ [KEY_FEATURES]: merged });
        }
    }

    async function persistFeatureState(featureId, enabled) {
        featureStates[featureId] = enabled;
        try {
            await sendMessage({ action: 'setFeatureState', featureId: featureId, enabled: enabled });
        } catch (err) {
            console.warn('[Onboarding] setFeatureState via background failed, writing storage directly:', err);
            const data = await storageGet(KEY_FEATURES);
            const merged = Object.assign({}, data[KEY_FEATURES] || {});
            merged[featureId] = enabled;
            await storageSet({ [KEY_FEATURES]: merged });
        }
        // Toggles that leave a preset make the user type Custom (and matching
        // one again restores it), same rule as the popup and settings page.
        const derived = UT.typeForStates(features, featureStates);
        if (derived !== userType) {
            userType = derived;
            await storageSet({ [KEY_USER_TYPE]: derived });
        }
    }

    async function persistTheme() {
        if (!window.TactaThemeManager) return;
        try {
            themeStored = await window.TactaThemeManager.save(themeDraft);
        } catch (err) {
            console.error('[Onboarding] Theme save failed:', err);
            showToast('Could not save the theme. You can set it later in Settings.', true);
        }
    }


    /* Rendering: shared */

    function renderHeader(title, desc) {
        $step.appendChild(el('h1', 'tacta-ob-step-title', title));
        if (desc) $step.appendChild(el('p', 'tacta-ob-step-desc', desc));
    }

    function renderProgress() {
        const total = steps.length;
        const step = currentStep();
        const pct = total > 1 ? Math.round((stepIndex / (total - 1)) * 100) : 100;

        $progressCounter.textContent = 'Step ' + (stepIndex + 1) + ' of ' + total;
        $progressLabel.textContent = step ? step.label : '';
        $progressFill.style.width = pct + '%';
        $progressBar.setAttribute('aria-valuenow', String(pct));

        // Milestones collapse the many feature pages into one marker
        clear($milestones);
        const seen = [];
        for (const s of steps) {
            if (!seen.includes(s.milestone)) seen.push(s.milestone);
        }
        const currentMilestone = step ? step.milestone : '';
        const currentMilestoneIdx = seen.indexOf(currentMilestone);
        seen.forEach((name, i) => {
            const li = el('li', 'tacta-ob-milestone', name);
            if (i < currentMilestoneIdx) li.classList.add('is-done');
            if (i === currentMilestoneIdx) li.classList.add('is-current');
            $milestones.appendChild(li);
        });
    }

    function renderNav() {
        const isFirst = stepIndex === 0;
        const isLast  = stepIndex === steps.length - 1;
        const step    = currentStep();

        $backBtn.hidden = isFirst;
        $skipBtn.hidden = isLast;
        $nextBtn.hidden = isLast;
        $nextBtn.textContent = stepIndex === steps.length - 2 ? 'Finish' : 'Next';
        $nextBtn.disabled = step && step.id === 'usertype' && !userType;
    }

    function renderStep() {
        clear($step);
        const step = currentStep();
        if (step && typeof step.render === 'function') step.render(step);
        renderProgress();
        renderNav();
        window.scrollTo({ top: 0, behavior: 'auto' });
    }


    /* Rendering: Welcome */

    function renderWelcome() {
        $step.appendChild(el('div', 'tacta-ob-welcome-mark', 'T'));
        renderHeader(
            'Welcome to ' + manifest.name,
            'This short walkthrough picks the right set of tools for how you use NetSuite, ' +
            'lets you fine-tune each feature, and sets the look of the toolkit. ' +
            'Everything here can be changed later in Settings.'
        );
        const list = el('ul', 'tacta-ob-welcome-list');
        list.appendChild(el('li', null, 'Version ' + (manifest.version || 'unknown')));
        list.appendChild(el('li', null, features.length + ' features available in this build'));
        list.appendChild(el('li', null, 'Your choices save as you go - close this tab any time and pick up where you left off'));
        $step.appendChild(list);
    }


    /* Rendering: Who are you? */

    function renderUserType() {
        renderHeader(
            'Who are you?',
            'Pick the role that fits best. This sets a sensible starting point for which features are on. ' +
            'You can still flip any individual feature on the next pages.'
        );

        const grid = el('div', 'tacta-ob-cards');
        grid.setAttribute('role', 'radiogroup');
        grid.setAttribute('aria-label', 'User type');

        for (const card of USER_TYPE_CARDS) {
            const btn = el('button', 'tacta-ob-card');
            btn.type = 'button';
            btn.dataset.userType = card.id;
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-pressed', userType === card.id ? 'true' : 'false');
            btn.setAttribute('aria-checked', userType === card.id ? 'true' : 'false');

            btn.appendChild(el('span', 'tacta-ob-card-icon', card.icon));
            btn.appendChild(el('span', 'tacta-ob-card-title', card.title));
            btn.appendChild(el('span', 'tacta-ob-card-tagline', card.tagline));

            const ul = el('ul', 'tacta-ob-card-bullets');
            card.bullets.forEach((b) => ul.appendChild(el('li', null, b)));
            btn.appendChild(ul);

            btn.appendChild(el('span', 'tacta-ob-card-check', 'Selected'));
            btn.addEventListener('click', () => onUserTypeSelected(card.id));
            grid.appendChild(btn);
        }
        $step.appendChild(grid);

        if (userType) {
            const note = el('p', 'tacta-ob-note',
                'You already chose "' + userTypeLabel(userType) + '". Your existing feature toggles are kept. ' +
                'Choosing a different role resets the toggles to that role\'s defaults.');
            note.style.marginTop = '16px';
            $step.appendChild(note);
        }
    }

    async function onUserTypeSelected(type) {
        if (!USER_TYPES.includes(type)) return;
        const changed = type !== userType;
        $step.querySelectorAll('.tacta-ob-card').forEach((c) => {
            const on = c.dataset.userType === type;
            c.setAttribute('aria-pressed', on ? 'true' : 'false');
            c.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        // Preserve toggles when re-selecting the stored type; reseed only on change
        await persistUserType(type, changed);
        if (changed) showToast('Features set up for ' + userTypeLabel(type) + '.');
        renderNav();
    }


    /* Rendering: Feature pages */

    function renderFeaturePage(step) {
        const groupName = GROUP_LABELS[step.group] || step.group;
        renderHeader(
            groupName + ' features',
            'Turn each tool on or off. Changes save instantly and apply the next time you load a NetSuite page.'
        );

        const list = el('div', 'tacta-ob-feature-list');
        for (const feat of step.features) {
            list.appendChild(buildFeatureCard(feat));
        }
        $step.appendChild(list);
    }

    function buildFeatureCard(feat) {
        const card = el('div', 'tacta-ob-feature-card');

        const left = el('div', 'tacta-ob-feature-left');
        const top = el('div', 'tacta-ob-feature-top');
        top.appendChild(el('span', 'tacta-ob-feature-name', feat.label || feat.id));

        const trigger = TRIGGER_BADGES[feat.trigger] ? feat.trigger : null;
        if (trigger) {
            top.appendChild(el('span', 'tacta-ob-badge tacta-ob-badge-' + trigger, TRIGGER_BADGES[trigger]));
        }
        left.appendChild(top);

        if (feat.description) left.appendChild(el('p', 'tacta-ob-feature-desc', feat.description));

        const ob = feat.onboarding && typeof feat.onboarding === 'object' ? feat.onboarding : null;
        if (ob && ob.summary) left.appendChild(el('p', 'tacta-ob-feature-summary', ob.summary));
        if (ob && ob.where)   left.appendChild(el('p', 'tacta-ob-feature-where', ob.where));

        card.appendChild(left);

        const toggle = el('label', 'tacta-ob-toggle');
        toggle.title = (featureStates[feat.id] ? 'Disable ' : 'Enable ') + (feat.label || feat.id);
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = featureStates[feat.id] === true;
        input.dataset.featureId = feat.id;
        input.setAttribute('aria-label', 'Enable ' + (feat.label || feat.id));
        input.addEventListener('change', () => {
            toggle.title = (input.checked ? 'Disable ' : 'Enable ') + (feat.label || feat.id);
            persistFeatureState(feat.id, input.checked);
        });
        toggle.appendChild(input);
        toggle.appendChild(el('span', 'tacta-ob-toggle-track'));
        card.appendChild(toggle);

        return card;
    }


    /* Rendering: Appearance */

    function renderAppearance() {
        renderHeader(
            'Appearance',
            'Choose how the toolkit popup, settings page, and the panels it adds to NetSuite look. ' +
            'The preview below updates live; the choice is saved when you click Next.'
        );

        const form = el('div', 'tacta-ob-form');

        // Scheme row
        const schemeRow = el('div', 'tacta-ob-form-row');
        const schemeInfo = el('div', 'tacta-ob-form-info');
        schemeInfo.appendChild(el('span', 'tacta-ob-form-label', 'Color scheme'));
        schemeInfo.appendChild(el('span', 'tacta-ob-form-hint', 'Base surface, text, and border colors.'));
        schemeRow.appendChild(schemeInfo);

        const radios = el('div', 'tacta-ob-radio-group');
        radios.setAttribute('role', 'radiogroup');
        for (const opt of SCHEME_OPTIONS) {
            const label = el('label', 'tacta-ob-radio');
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'obScheme';
            input.value = opt.id;
            input.checked = themeDraft.scheme === opt.id;
            if (input.checked) label.classList.add('is-checked');
            input.addEventListener('change', () => {
                if (!input.checked) return;
                radios.querySelectorAll('.tacta-ob-radio').forEach((r) => r.classList.remove('is-checked'));
                label.classList.add('is-checked');
                themeDraft.scheme = opt.id;
                previewTheme();
            });
            label.appendChild(input);
            label.appendChild(el('span', null, opt.label));
            radios.appendChild(label);
        }
        schemeRow.appendChild(radios);
        form.appendChild(schemeRow);

        // Accent row
        const accentRow = el('div', 'tacta-ob-form-row');
        const accentInfo = el('div', 'tacta-ob-form-info');
        accentInfo.appendChild(el('span', 'tacta-ob-form-label', 'Accent color'));
        accentInfo.appendChild(el('span', 'tacta-ob-form-hint', 'Buttons, toggles, highlights, and focus rings.'));
        accentRow.appendChild(accentInfo);

        const colorWrap = el('div', 'tacta-ob-color-wrap');
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'tacta-ob-color-input';
        colorInput.value = themeDraft.accent;
        colorInput.setAttribute('aria-label', 'Accent color');
        const colorValue = el('span', 'tacta-ob-color-value', themeDraft.accent);
        colorInput.addEventListener('input', () => {
            themeDraft.accent = colorInput.value;
            colorValue.textContent = colorInput.value;
            previewTheme();
        });
        const resetBtn = el('button', 'tacta-ob-btn tacta-ob-btn-link', 'Reset');
        resetBtn.type = 'button';
        resetBtn.addEventListener('click', () => {
            themeDraft.accent = DEFAULT_ACCENT;
            colorInput.value = DEFAULT_ACCENT;
            colorValue.textContent = DEFAULT_ACCENT;
            previewTheme();
        });
        colorWrap.appendChild(colorInput);
        colorWrap.appendChild(colorValue);
        colorWrap.appendChild(resetBtn);
        accentRow.appendChild(colorWrap);
        form.appendChild(accentRow);

        $step.appendChild(form);

        // Live preview strip
        const preview = el('div', 'tacta-ob-preview');
        preview.appendChild(el('span', 'tacta-ob-preview-title', 'Preview'));
        const pBtn = el('button', 'tacta-ob-btn tacta-ob-btn-primary', 'Primary button');
        pBtn.type = 'button';
        const sBtn = el('button', 'tacta-ob-btn tacta-ob-btn-secondary', 'Secondary');
        sBtn.type = 'button';
        const pToggle = el('label', 'tacta-ob-toggle');
        const pInput = document.createElement('input');
        pInput.type = 'checkbox';
        pInput.checked = true;
        pInput.setAttribute('aria-label', 'Preview toggle');
        pToggle.appendChild(pInput);
        pToggle.appendChild(el('span', 'tacta-ob-toggle-track'));
        preview.appendChild(pBtn);
        preview.appendChild(sBtn);
        preview.appendChild(pToggle);
        preview.appendChild(el('span', 'tacta-ob-badge tacta-ob-badge-auto', 'Runs automatically'));
        $step.appendChild(preview);
    }

    function previewTheme() {
        if (window.TactaThemeManager) window.TactaThemeManager.apply(themeDraft);
    }

    function revertThemePreview() {
        if (!window.TactaThemeManager) return;
        window.TactaThemeManager.apply(themeStored || { scheme: DEFAULT_SCHEME, accent: DEFAULT_ACCENT });
    }


    /* Rendering: You're set */

    function renderDone() {
        renderHeader(
            "You're set",
            'The toolkit is configured. Open any NetSuite page and look for the TactaSuite icon in the toolbar.'
        );

        const grid = el('div', 'tacta-ob-summary');

        const t1 = el('div', 'tacta-ob-summary-tile');
        t1.appendChild(el('div', 'tacta-ob-summary-label', 'Role'));
        t1.appendChild(el('div', 'tacta-ob-summary-value', userTypeLabel(userType)));
        t1.appendChild(el('div', 'tacta-ob-summary-sub', 'Change any time from the popup'));
        grid.appendChild(t1);

        const t2 = el('div', 'tacta-ob-summary-tile');
        t2.appendChild(el('div', 'tacta-ob-summary-label', 'Features enabled'));
        t2.appendChild(el('div', 'tacta-ob-summary-value', enabledCount() + ' of ' + features.length));
        t2.appendChild(el('div', 'tacta-ob-summary-sub', 'Fine-tune in Settings'));
        grid.appendChild(t2);

        const t3 = el('div', 'tacta-ob-summary-tile');
        t3.appendChild(el('div', 'tacta-ob-summary-label', 'Theme'));
        const theme = themeStored || { scheme: 'Default', accent: '' };
        const schemeOpt = SCHEME_OPTIONS.find((s) => s.id === theme.scheme);
        t3.appendChild(el('div', 'tacta-ob-summary-value', schemeOpt ? schemeOpt.label : 'Default'));
        t3.appendChild(el('div', 'tacta-ob-summary-sub', theme.accent ? 'Accent ' + theme.accent : 'Not customized'));
        grid.appendChild(t3);

        $step.appendChild(grid);

        const actions = el('div', 'tacta-ob-actions');
        const settingsBtn = el('button', 'tacta-ob-btn tacta-ob-btn-primary', 'Open Settings');
        settingsBtn.type = 'button';
        settingsBtn.addEventListener('click', () => {
            if (chrome.runtime && chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
        });
        const closeBtn = el('button', 'tacta-ob-btn tacta-ob-btn-secondary', 'Close');
        closeBtn.type = 'button';
        closeBtn.addEventListener('click', () => {
            window.close();
            // Tabs the user navigated to manually cannot be closed by script
            setTimeout(() => showToast('You can close this tab now.'), 150);
        });
        const againBtn = el('button', 'tacta-ob-btn tacta-ob-btn-link', 'Start over');
        againBtn.type = 'button';
        againBtn.addEventListener('click', () => goTo(0));
        actions.appendChild(settingsBtn);
        actions.appendChild(closeBtn);
        actions.appendChild(againBtn);
        $step.appendChild(actions);

        // Who made this, with source and support links (shared/author-links.js)
        if (window.TactaAuthor) {
            const credit = el('div', 'tacta-ob-credit');
            window.TactaAuthor.render(credit, { variant: 'full', prefix: 'Made by' });
            $step.appendChild(credit);
        }
    }


    /* Navigation */

    async function leaveStep(step, direction) {
        if (!step) return;
        if (step.id === 'appearance') {
            if (direction === 'forward') await persistTheme();
            else revertThemePreview();
        }
    }

    async function enterStep(step) {
        if (!step) return;
        if (step.id === 'appearance') {
            // Draft starts from whatever is saved, or Light + default accent
            themeDraft = Object.assign(
                { scheme: DEFAULT_SCHEME, accent: DEFAULT_ACCENT },
                themeStored || {}
            );
            previewTheme();
        }
        if (step.id === 'done') await markCompleted();
    }

    async function goTo(index, direction) {
        if (index < 0 || index >= steps.length) return;
        const from = currentStep();
        await leaveStep(from, direction || (index > stepIndex ? 'forward' : 'back'));
        stepIndex = index;
        await enterStep(currentStep());
        renderStep();
        await saveProgress();
    }

    function onNext() {
        if ($nextBtn.disabled) return;
        goTo(stepIndex + 1, 'forward');
    }

    function onBack() {
        goTo(stepIndex - 1, 'back');
    }

    function onSkip() {
        goTo(steps.length - 1, 'skip');
    }

    function bindEvents() {
        $nextBtn.addEventListener('click', onNext);
        $backBtn.addEventListener('click', onBack);
        $skipBtn.addEventListener('click', onSkip);

        document.addEventListener('keydown', (e) => {
            const tag = e.target && e.target.tagName;
            const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
            if (typing) return;
            if (e.key === 'ArrowRight' && !$nextBtn.hidden && !$nextBtn.disabled) onNext();
            if (e.key === 'ArrowLeft' && !$backBtn.hidden) onBack();
        });
    }


    /* Data loading */

    async function loadManifest() {
        try {
            const m = chrome.runtime.getManifest();
            manifest = { name: m.name || manifest.name, version: m.version || '' };
        } catch (_) { /* keep defaults */ }
        if ($extName) $extName.textContent = manifest.name;
        if ($version) $version.textContent = manifest.version ? 'v' + manifest.version : '';
        document.title = manifest.name + ' - Welcome';
    }

    async function loadFeatures() {
        try {
            const list = await sendMessage({ action: 'getFeatures' });
            features = Array.isArray(list) ? list.filter((f) => f && f.id) : [];
        } catch (err) {
            console.error('[Onboarding] getFeatures failed:', err);
            features = [];
        }

        try {
            featureStates = (await sendMessage({ action: 'getFeatureStates' })) || {};
        } catch (_) {
            const data = await storageGet(KEY_FEATURES);
            featureStates = data[KEY_FEATURES] || {};
        }
        if (typeof featureStates !== 'object' || featureStates === null) featureStates = {};

        // Fill gaps for features not yet in storage (same rule as the popup)
        for (const f of features) {
            if (!(f.id in featureStates)) featureStates[f.id] = f.defaultEnabled === true;
        }
    }

    async function loadPrefs() {
        const data = await storageGet([KEY_USER_TYPE, KEY_PROGRESS, KEY_COMPLETED, KEY_THEME]);
        // A stored preset or Custom counts as "already chose"; the retired
        // 'admin' preset reads back as Custom. Nothing stored = not chosen yet.
        const storedType = data[KEY_USER_TYPE];
        userType = storedType ? UT.normalize(storedType) : null;
        themeStored = data[KEY_THEME] && typeof data[KEY_THEME] === 'object' ? data[KEY_THEME] : null;
        return data;
    }

    async function applyInitialTheme() {
        if (!window.TactaThemeManager) return;
        // The manager auto-applies its own default (dark) when nothing is stored.
        // This page defaults to Light until the user saves a choice.
        try { await window.TactaThemeManager.load(); } catch (_) { /* ignore */ }
        if (!themeStored) {
            window.TactaThemeManager.apply({ scheme: DEFAULT_SCHEME, accent: DEFAULT_ACCENT });
        }
    }

    function resolveStartIndex(prefs) {
        const params = new URLSearchParams(window.location.search);
        const requested = params.get('step');
        if (requested) {
            const idx = indexForStepId(requested.toLowerCase());
            if (idx >= 0) return idx;
        }
        const completed = prefs[KEY_COMPLETED] === true;
        const progress = prefs[KEY_PROGRESS];
        if (!completed && progress && progress.step) {
            const idx = indexForStepId(progress.step);
            if (idx > 0 && idx < steps.length - 1) return idx;
        }
        return 0;
    }


    /* Init */

    async function init() {
        bindEvents();
        await loadManifest();
        const prefs = await loadPrefs();
        await applyInitialTheme();
        await loadFeatures();
        buildSteps();

        stepIndex = resolveStartIndex(prefs);
        await enterStep(currentStep());
        renderStep();
        await saveProgress();

        if (!features.length) {
            showToast('Could not load the feature list from the extension. Reload this page to try again.', true);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();

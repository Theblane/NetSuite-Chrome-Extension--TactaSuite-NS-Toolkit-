/**
 * user-types.js
 * NetSuite TactaSuite - User type presets
 *
 * @author Blane Maher
 *
 * Single source of truth for the "I am a ..." choice shared by the popup, the
 * settings page, the setup walkthrough and the service worker.
 *
 *   user       Default. Productivity helpers on, developer tools off.
 *   developer  Every tool whose registry `audience` includes 'developer'.
 *   custom     Set automatically when the feature toggles no longer match a
 *              preset. Never selectable directly; picking User or Developer
 *              resets the toggles and leaves Custom.
 *
 * Presets are derived from each feature's registry `audience`, so the pages
 * can never disagree. Stored under chrome.storage.local 'tacta_user_type'.
 *
 * Classic script (popup/options/onboarding) and side-effect ES import
 * (service worker): both end up with globalThis.TactaUserTypes.
 */
(function (root) {
    'use strict';

    var STORAGE_KEY  = 'tacta_user_type';
    var DEFAULT_TYPE = 'user';
    var CUSTOM       = 'custom';
    var PRESET_TYPES = ['user', 'developer'];

    var LABELS = { user: 'User', developer: 'Developer', custom: 'Custom' };

    /** True for a type that has a preset (User or Developer). */
    function isPreset(type) {
        return PRESET_TYPES.indexOf(type) !== -1;
    }

    /**
     * Coerce whatever is in storage to a known type. The retired 'admin'
     * preset becomes Custom (its toggles match neither remaining preset);
     * anything unknown or missing is the default.
     */
    function normalize(stored) {
        if (isPreset(stored)) return stored;
        if (stored === CUSTOM || stored === 'admin') return CUSTOM;
        return DEFAULT_TYPE;
    }

    /**
     * Whether a feature is on for a preset type. An explicit audience array is
     * authoritative (empty = off for everyone); a missing audience falls back
     * to defaultEnabled for every type.
     */
    function enabledFor(feature, type) {
        if (Array.isArray(feature.audience)) return feature.audience.indexOf(type) !== -1;
        return feature.defaultEnabled === true;
    }

    /** { [featureId]: boolean } for a preset type. */
    function presetFor(features, type) {
        var preset = {};
        for (var i = 0; i < features.length; i++) {
            preset[features[i].id] = enabledFor(features[i], type);
        }
        return preset;
    }

    /** True when every registry feature's state equals the preset. */
    function matchesPreset(features, states, type) {
        states = states || {};
        for (var i = 0; i < features.length; i++) {
            var f = features[i];
            if ((states[f.id] === true) !== enabledFor(f, type)) return false;
        }
        return true;
    }

    /** The preset the states match exactly, else Custom. */
    function typeForStates(features, states) {
        for (var i = 0; i < PRESET_TYPES.length; i++) {
            if (matchesPreset(features, states, PRESET_TYPES[i])) return PRESET_TYPES[i];
        }
        return CUSTOM;
    }

    function label(type) {
        return LABELS[type] || LABELS[DEFAULT_TYPE];
    }

    root.TactaUserTypes = {
        STORAGE_KEY: STORAGE_KEY,
        DEFAULT_TYPE: DEFAULT_TYPE,
        CUSTOM: CUSTOM,
        PRESET_TYPES: PRESET_TYPES.slice(),
        ALL_TYPES: PRESET_TYPES.concat([CUSTOM]),
        isPreset: isPreset,
        normalize: normalize,
        enabledFor: enabledFor,
        presetFor: presetFor,
        matchesPreset: matchesPreset,
        typeForStates: typeForStates,
        label: label
    };
})(typeof globalThis !== 'undefined' ? globalThis : self);

/**
 * settings-export.js
 * NetSuite TactaSuite - Settings export
 *
 * @author Blane Maher
 *
 * Builds the portable settings JSON used by the popup's "Export settings"
 * button and the settings page's Export / Import pair. One module so the two
 * can never produce different shapes.
 *
 * Payload: { _meta, featureStates, themeSettings, meetingMode, preferences }
 * where preferences holds every 'tacta_*' key except the ones in EXCLUDE.
 */
(function (root) {
    'use strict';

    /**
     * Storage keys that never travel in an export: the bridge settings hold the
     * pairing token (a secret) plus machine-specific paths, legacy AI settings
     * held an API key, and onboarding progress and update notices are per
     * install. Theme travels as its own top-level field, not as a preference.
     */
    var EXCLUDE = /^(tacta_bridge_settings|tacta_ai_settings|tacta_onboarding_|tacta_update_notice)/;
    var THEME_KEY = 'tacta_theme_settings';
    var USER_TYPE_KEY = 'tacta_user_type';

    function isPreferenceKey(key) {
        return key.indexOf('tacta_') === 0 && !EXCLUDE.test(key) && key !== THEME_KEY;
    }

    /** Read storage and assemble the export payload. */
    function buildPayload() {
        return chrome.storage.local.get(null).then(function (all) {
            var preferences = {};
            Object.keys(all).forEach(function (key) {
                if (isPreferenceKey(key)) preferences[key] = all[key];
            });
            return {
                _meta: {
                    extension:  'TactaSuite NS Toolkit',
                    version:    chrome.runtime.getManifest().version,
                    userType:   all[USER_TYPE_KEY] || 'user',
                    exportedAt: new Date().toISOString()
                },
                featureStates: all.featureStates || {},
                themeSettings: all[THEME_KEY] || null,
                meetingMode: all.meetingMode === true,
                // Saved SuiteQL queries and history, user type, quick search
                // types, account colors, environment badge preferences, etc.
                preferences: preferences
            };
        });
    }

    function defaultFilename(payload) {
        var type = (payload && payload._meta && payload._meta.userType) || 'user';
        var day = new Date().toISOString().slice(0, 10);
        return 'tactasuite-ns-toolkit-settings-' + type + '-' + day + '.json';
    }

    /** Trigger a browser download of the payload as pretty-printed JSON. */
    function download(payload, filename) {
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a');
        a.href = url;
        a.download = filename || defaultFilename(payload);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoke after the click has been handed to the download manager.
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        return a.download;
    }

    /** Build and download in one step. Resolves with the filename. */
    function exportSettings() {
        return buildPayload().then(function (payload) { return download(payload); });
    }

    root.TactaSettingsExport = {
        EXCLUDE: EXCLUDE,
        isPreferenceKey: isPreferenceKey,
        buildPayload: buildPayload,
        defaultFilename: defaultFilename,
        download: download,
        exportSettings: exportSettings
    };
})(typeof globalThis !== 'undefined' ? globalThis : self);

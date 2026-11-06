/**
 * storage-utils.js
 * NetSuite TactaSuite - Chrome Storage Wrapper
 *
 * @author Blane Maher
 *
 * Provides a Promise-based abstraction over chrome.storage.local for
 * managing feature states, user settings, and meeting mode. All keys
 * are namespaced with 'tacta_' to prevent collisions.
 *
 * Exposes: window.TactaStorage
 *
 * @fileoverview Chrome storage utilities for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /**
     * Storage key for the unified feature states object.
     * This MUST match the key used by popup.js, options.js, and
     * background/modules/storage-manager.js so all contexts share
     * the same { featureId: boolean } map.
     */
    var FEATURE_STATES_KEY = 'featureStates';

    /** @type {string} Prefix for all setting keys */
    var SETTING_PREFIX = 'tacta_setting_';

    /**
     * Key for meeting mode flag.
     * Must match storage-manager.js ('meetingMode'), NOT the old
     * 'tacta_meeting_mode' key which was never read by the popup/background.
     */
    var MEETING_MODE_KEY = 'meetingMode';

    // ────────────────────────────────────────────────────────────────
    // Internal helpers
    // ────────────────────────────────────────────────────────────────

    /**
     * Returns the chrome.storage.local API, or throws if unavailable.
     * @returns {chrome.storage.LocalStorageArea}
     * @throws {Error} If chrome.storage is not available.
     */
    function _storage() {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            return chrome.storage.local;
        }
        throw new Error('TactaStorage: chrome.storage.local is not available. ' +
            'Ensure this script runs in a Chrome extension context.');
    }

    /**
     * Reads one or more keys from chrome.storage.local.
     * @param {string|string[]|Object} keys - Key(s) to retrieve, or an object
     *   with keys and their default values.
     * @returns {Promise<Object>} Resolved with the stored key-value pairs.
     */
    function _get(keys) {
        return new Promise(function (resolve, reject) {
            _storage().get(keys, function (result) {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(result);
                }
            });
        });
    }

    /**
     * Writes one or more key-value pairs to chrome.storage.local.
     * @param {Object} items - Key-value pairs to store.
     * @returns {Promise<void>}
     */
    function _set(items) {
        return new Promise(function (resolve, reject) {
            _storage().set(items, function () {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Retrieves all keys from chrome.storage.local.
     * @returns {Promise<Object>} All stored key-value pairs.
     */
    function _getAll() {
        return new Promise(function (resolve, reject) {
            _storage().get(null, function (result) {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(result);
                }
            });
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Public API
    // ────────────────────────────────────────────────────────────────

    /**
     * Retrieves the enabled/disabled state of a feature.
     * Reads from the unified 'featureStates' object shared with popup,
     * options, and the background service worker.
     *
     * @param {string} featureId - Unique feature identifier (e.g., 'script-finder').
     * @returns {Promise<boolean>} True if the feature is enabled, false otherwise.
     */
    function getFeatureState(featureId) {
        return _get(FEATURE_STATES_KEY).then(function (result) {
            var states = result[FEATURE_STATES_KEY] || {};
            return !!states[featureId];
        });
    }

    /**
     * Sets the enabled/disabled state of a feature.
     * Updates the unified 'featureStates' object (read-modify-write).
     *
     * @param {string} featureId - Unique feature identifier.
     * @param {boolean} enabled - Whether the feature should be enabled.
     * @returns {Promise<void>}
     */
    function setFeatureState(featureId, enabled) {
        return _get(FEATURE_STATES_KEY).then(function (result) {
            var states = result[FEATURE_STATES_KEY] || {};
            states[featureId] = !!enabled;
            var items = {};
            items[FEATURE_STATES_KEY] = states;
            return _set(items);
        });
    }

    /**
     * Returns the enabled/disabled state of all features as a plain object.
     * Keys are the bare feature IDs.
     *
     * @returns {Promise<Object<string, boolean>>} Map of featureId -> enabled.
     */
    function getAllFeatureStates() {
        return _get(FEATURE_STATES_KEY).then(function (result) {
            return result[FEATURE_STATES_KEY] || {};
        });
    }

    /**
     * Retrieves a user setting value.
     *
     * @param {string} key - Setting key (e.g., 'panel-position').
     * @param {*} [defaultValue=null] - Value to return if the key is not set.
     * @returns {Promise<*>} The stored value or defaultValue.
     */
    function getSetting(key, defaultValue) {
        if (defaultValue === undefined) defaultValue = null;
        var storageKey = SETTING_PREFIX + key;
        var query = {};
        query[storageKey] = defaultValue;
        return _get(query).then(function (result) {
            return result[storageKey];
        });
    }

    /**
     * Stores a user setting value.
     *
     * @param {string} key - Setting key.
     * @param {*} value - Value to store (must be JSON-serializable).
     * @returns {Promise<void>}
     */
    function setSetting(key, value) {
        var items = {};
        items[SETTING_PREFIX + key] = value;
        return _set(items);
    }

    /**
     * Checks whether "meeting mode" is active. Meeting mode hides or
     * minimizes all toolkit UI so the screen is clean for presentations.
     *
     * @returns {Promise<boolean>} True if meeting mode is enabled.
     */
    function isMeetingMode() {
        var query = {};
        query[MEETING_MODE_KEY] = false;
        return _get(query).then(function (result) {
            return !!result[MEETING_MODE_KEY];
        });
    }

    /**
     * Enables or disables meeting mode.
     *
     * @param {boolean} enabled - Whether to activate meeting mode.
     * @returns {Promise<void>}
     */
    function setMeetingMode(enabled) {
        var items = {};
        items[MEETING_MODE_KEY] = !!enabled;
        return _set(items);
    }

    // ────────────────────────────────────────────────────────────────
    // Expose
    // ────────────────────────────────────────────────────────────────

    /** @namespace TactaStorage */
    var TactaStorage = {
        getFeatureState: getFeatureState,
        setFeatureState: setFeatureState,
        getAllFeatureStates: getAllFeatureStates,
        getSetting: getSetting,
        setSetting: setSetting,
        isMeetingMode: isMeetingMode,
        setMeetingMode: setMeetingMode
    };

    if (typeof window !== 'undefined') {
        window.TactaStorage = TactaStorage;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = TactaStorage;
    }
})();

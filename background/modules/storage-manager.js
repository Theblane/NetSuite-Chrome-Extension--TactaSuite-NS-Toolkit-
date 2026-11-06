/**
 * NetSuite TactaSuite — Storage Manager
 *
 * @author Blane Maher
 *
 * Thin abstraction over chrome.storage.local for persisting feature toggle
 * states and global settings like meeting mode. All reads/writes are async
 * and return Promises.
 *
 * Storage layout:
 *   featureStates  -> { [featureId]: boolean }
 *   meetingMode    -> boolean
 */

const STORAGE_KEYS = {
  FEATURE_STATES: 'featureStates',
  MEETING_MODE: 'meetingMode'
};

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Populate default feature states on first install. Any features that already
 * have a stored value are left untouched so user preferences survive updates.
 *
 * @param {Array<Object>} features - The full FEATURES array from the registry.
 * @returns {Promise<void>}
 */
export async function initDefaults(features) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.FEATURE_STATES);
  const existing = stored[STORAGE_KEYS.FEATURE_STATES] || {};

  const merged = { ...existing };
  let changed = false;

  for (const feature of features) {
    if (!(feature.id in merged)) {
      merged[feature.id] = feature.defaultEnabled;
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ [STORAGE_KEYS.FEATURE_STATES]: merged });
  }

  // Ensure meeting mode has a default value
  const meetingData = await chrome.storage.local.get(STORAGE_KEYS.MEETING_MODE);
  if (meetingData[STORAGE_KEYS.MEETING_MODE] === undefined) {
    await chrome.storage.local.set({ [STORAGE_KEYS.MEETING_MODE]: false });
  }
}

// ---------------------------------------------------------------------------
// Feature states
// ---------------------------------------------------------------------------

/**
 * Retrieve the current enabled/disabled state for every feature.
 *
 * @returns {Promise<Object>} Map of featureId -> boolean.
 */
export async function getFeatureStates() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.FEATURE_STATES);
  return data[STORAGE_KEYS.FEATURE_STATES] || {};
}

/**
 * Toggle a single feature on or off.
 *
 * @param {string}  featureId - The unique feature identifier.
 * @param {boolean} enabled   - Whether the feature should be active.
 * @returns {Promise<void>}
 */
export async function setFeatureState(featureId, enabled) {
  const states = await getFeatureStates();
  states[featureId] = enabled;
  await chrome.storage.local.set({ [STORAGE_KEYS.FEATURE_STATES]: states });
}

/**
 * Batch-update multiple feature states at once. Used by preset application
 * to avoid sending N individual messages (Fix #9).
 *
 * @param {Object<string, boolean>} newStates - Full or partial map of featureId -> boolean.
 * @returns {Promise<void>}
 */
export async function setFeatureStates(newStates) {
  const current = await getFeatureStates();
  const merged = { ...current, ...newStates };
  await chrome.storage.local.set({ [STORAGE_KEYS.FEATURE_STATES]: merged });
}

// ---------------------------------------------------------------------------
// Meeting mode
// ---------------------------------------------------------------------------

/**
 * Check whether meeting mode is currently active.
 * When meeting mode is on, all auto-triggered features are suppressed so the
 * NetSuite UI looks stock during screen shares.
 *
 * @returns {Promise<boolean>}
 */
export async function getMeetingMode() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.MEETING_MODE);
  return data[STORAGE_KEYS.MEETING_MODE] === true;
}

/**
 * Enable or disable meeting mode.
 *
 * @param {boolean} enabled - true to suppress features, false to resume.
 * @returns {Promise<void>}
 */
export async function setMeetingMode(enabled) {
  await chrome.storage.local.set({ [STORAGE_KEYS.MEETING_MODE]: !!enabled });
}

/**
 * NetSuite TactaSuite - Theme Manager
 *
 * @author Blane Maher
 *
 * Applies user-selected toolkit theme variables in extension pages and
 * injected NetSuite UI. Stored values live in chrome.storage.local.
 */
(function () {
  'use strict';

  if (window.TactaThemeManager) return;

  var STORAGE_KEY = 'tacta_theme_settings';
  var DEFAULT_SETTINGS = {
    scheme: 'light',
    accent: '#76c043'
  };
  var watching = false;

  var SCHEMES = {
    dark: {
      '--tacta-bg': '#1a1a1a',
      '--tacta-bg-elevated': '#222222',
      '--tacta-bg-hover': '#2a2a2a',
      '--tacta-bg-active': '#333333',
      '--tacta-bg-overlay': 'rgba(0, 0, 0, 0.65)',
      '--tacta-text': '#ffffff',
      '--tacta-text-secondary': '#cccccc',
      '--tacta-text-muted': '#888888',
      '--tacta-text-inverse': '#1a1a1a',
      '--tacta-border': '#333333',
      '--tacta-border-light': '#444444'
    },
    light: {
      '--tacta-bg': '#f7f8fa',
      '--tacta-bg-elevated': '#ffffff',
      '--tacta-bg-hover': '#eef1f4',
      '--tacta-bg-active': '#e4e8ed',
      '--tacta-bg-overlay': 'rgba(15, 23, 42, 0.35)',
      '--tacta-text': '#17202a',
      '--tacta-text-secondary': '#3d4854',
      '--tacta-text-muted': '#66717d',
      '--tacta-text-inverse': '#ffffff',
      '--tacta-border': '#d7dde4',
      '--tacta-border-light': '#c3ccd6'
    },
    contrast: {
      '--tacta-bg': '#050505',
      '--tacta-bg-elevated': '#111111',
      '--tacta-bg-hover': '#1f1f1f',
      '--tacta-bg-active': '#2c2c2c',
      '--tacta-bg-overlay': 'rgba(0, 0, 0, 0.78)',
      '--tacta-text': '#ffffff',
      '--tacta-text-secondary': '#f0f0f0',
      '--tacta-text-muted': '#c7c7c7',
      '--tacta-text-inverse': '#000000',
      '--tacta-border': '#666666',
      '--tacta-border-light': '#888888'
    }
  };

  function hexToRgb(hex) {
    var normalized = String(hex || '').replace('#', '').trim();
    if (normalized.length === 3) {
      normalized = normalized.split('').map(function (c) { return c + c; }).join('');
    }
    if (!/^[0-9a-f]{6}$/i.test(normalized)) return { r: 118, g: 192, b: 67 };
    var n = parseInt(normalized, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function clamp(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  function adjust(hex, amount) {
    var rgb = hexToRgb(hex);
    return '#' + [rgb.r, rgb.g, rgb.b].map(function (channel) {
      var adjusted = amount >= 0
        ? channel + (255 - channel) * amount
        : channel * (1 + amount);
      return clamp(adjusted).toString(16).padStart(2, '0');
    }).join('');
  }

  function getChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local
      ? chrome.storage.local
      : null;
  }

  function normalize(settings) {
    var merged = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    if (!SCHEMES[merged.scheme]) merged.scheme = DEFAULT_SETTINGS.scheme;
    if (!/^#[0-9a-f]{6}$/i.test(merged.accent || '')) merged.accent = DEFAULT_SETTINGS.accent;
    return merged;
  }

  function apply(settings) {
    var normalized = normalize(settings);
    var root = document.documentElement;
    // XML documents (NetSuite record view with xml=T) have no CSSStyleDeclaration.
    if (!root || !root.style || typeof root.style.setProperty !== 'function') return normalized;
    var schemeVars = SCHEMES[normalized.scheme];
    var rgb = hexToRgb(normalized.accent);

    root.dataset.tactaTheme = normalized.scheme;

    Object.keys(schemeVars).forEach(function (key) {
      root.style.setProperty(key, schemeVars[key]);
    });

    root.style.setProperty('--tacta-accent', normalized.accent);
    root.style.setProperty('--tacta-accent-hover', adjust(normalized.accent, 0.14));
    root.style.setProperty('--tacta-accent-active', adjust(normalized.accent, -0.14));
    root.style.setProperty('--tacta-accent-muted', 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', 0.15)');
    root.style.setProperty('--tacta-border-focus', normalized.accent);
    root.style.setProperty('--tacta-success', normalized.accent);
    root.style.setProperty('--tacta-success-bg', 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', 0.12)');
    root.style.setProperty('--tacta-shadow-glow', '0 0 12px rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', 0.3)');

    return normalized;
  }

  function load() {
    var storage = getChromeStorage();
    if (!storage) return Promise.resolve(apply(DEFAULT_SETTINGS));
    return storage.get(STORAGE_KEY).then(function (data) {
      return apply(data[STORAGE_KEY]);
    }).catch(function () {
      return apply(DEFAULT_SETTINGS);
    });
  }

  function save(settings) {
    var normalized = apply(settings);
    var storage = getChromeStorage();
    if (!storage) return Promise.resolve(normalized);
    var payload = {};
    payload[STORAGE_KEY] = normalized;
    return storage.set(payload).then(function () {
      return normalized;
    });
  }

  function watch() {
    if (watching) return;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
    watching = true;
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes[STORAGE_KEY]) {
        apply(changes[STORAGE_KEY].newValue);
      }
    });
  }

  window.TactaThemeManager = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    SCHEMES: SCHEMES,
    apply: apply,
    load: load,
    save: save,
    watch: watch,
    init: function () {
      watch();
      return load();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      window.TactaThemeManager.init();
    }, { once: true });
  } else {
    window.TactaThemeManager.init();
  }
})();

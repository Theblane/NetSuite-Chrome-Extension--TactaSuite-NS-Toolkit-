/**
 * NetSuite TactaSuite - URL Feature Loader
 *
 * @author Blane Maher
 *
 * Supplemental URL-based loader for NetSuite pages where page detection can be
 * too broad. It still uses the background registry for feature file paths.
 */
(function () {
  'use strict';

  // NetSuite also serves XML views (record URL + xml=T) under /app/*. Those
  // documents have no HTML elements, so nothing here can run safely.
  // Chrome wraps XML in an HTML pretty-printer, so check the content type too.
  if (!(document.documentElement instanceof HTMLElement)) return;
  if (document.contentType && !/html/i.test(document.contentType)) return;
  if (window.__tactaFeatureLoaderRan) return;
  window.__tactaFeatureLoaderRan = true;
  window.__tactaActivatedFeatures = window.__tactaActivatedFeatures || new Set();

  var PAGE_FEATURES = [
    {
      test: /\/app\/common\/search\/search\.nl/i,
      // saved-search-export is NOT listed here: search.nl is the search
      // editor, and the export toolbar belongs on searchresults.nl only.
      features: ['field-finder', 'quick-search-creation', 'suitescript-exporter']
    },
    {
      test: /\/app\//i,
      features: ['quick-search-creation', 'environment-badge', 'instant-ui']
    },
    {
      test: /\/app\/common\/search\/searchresults\.nl/i,
      features: ['saved-search-export', 'fixed-headers']
    },
    {
      test: /\/app\/accounting\/transactions\//i,
      features: ['transaction-tree', 'transaction-trail', 'field-help', 'script-analyzer', 'fixed-headers']
    },
    {
      test: /\/app\/common\/scripting\/script\.nl/i,
      features: ['script-analyzer', 'console-tools']
    },
    {
      test: /\/app\/common\/workflow\/setup\//i,
      features: ['workflow-colors', 'field-finder', 'console-tools']
    },
    {
      test: /\/app\/common\/dataset\//i,
      features: ['suitescript-exporter', 'dataset-to-suiteql']
    },
    {
      test: /\/app\/common\/workbook\//i,
      features: ['suitescript-exporter', 'dataset-to-suiteql']
    },
    {
      test: /\/app\/center\/card\.nl/i,
      features: ['portlet-refresher']
    }
  ];

  function sendMessage(payload) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(payload, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  function isFeatureEnabled(feature, featureStates) {
    return Object.prototype.hasOwnProperty.call(featureStates, feature.id)
      ? featureStates[feature.id] === true
      : feature.defaultEnabled === true;
  }

  async function loadContext() {
    var features = [];
    var featureStates = {};
    var meetingMode = false;

    try {
      features = await sendMessage({ action: 'getFeatures' }) || [];
    } catch (_) {}

    try {
      featureStates = await sendMessage({ action: 'getFeatureStates' }) || {};
    } catch (_) {
      var data = await chrome.storage.local.get('featureStates');
      featureStates = data.featureStates || {};
    }

    try {
      meetingMode = await sendMessage({ action: 'getMeetingMode' });
    } catch (_) {
      var modeData = await chrome.storage.local.get('meetingMode');
      meetingMode = modeData.meetingMode === true;
    }

    return { features: features, featureStates: featureStates, meetingMode: meetingMode === true };
  }

  async function activateFeature(feature) {
    if (window.__tactaActivatedFeatures.has(feature.id)) return;
    // Reserve the id before awaiting so router.js cannot inject the same
    // feature concurrently (both loaders run on many pages).
    window.__tactaActivatedFeatures.add(feature.id);
    try {
      await injectFeature(feature);
    } catch (err) {
      window.__tactaActivatedFeatures.delete(feature.id);
      throw err;
    }
    window.dispatchEvent(new CustomEvent('tacta:featureActivated', {
      detail: { featureId: feature.id }
    }));
  }

  async function injectFeature(feature) {
    // Inject CSS.
    // Logic: If the CSS file is meant to style the NetSuite page itself,
    // it MUST go into the document head. If it's for toolkit UI, it goes into Shadow Root.
    if (feature.contentStyles && feature.contentStyles.length > 0) {
      var globalStyles = [
        'account-color.css',
        'workflow-colors.css',
        'fixed-headers.css',
        'better-page-titles.css',
        'field-finder.css',
        'saved-search-export.css',
        'quick-search-creation.css',
        'suitescript-exporter.css',
        'transaction-tree.css',
        'field-help.css',
        'pdf-tools.css',
        'csv-viewer.css',
        'split-view.css',
        'script-content-search.css',
        'environment-badge.css',
        'transaction-trail.css',
        'dataset-to-suiteql.css',
        'portlet-refresher.css',
        'instant-ui.css',
        'script-analyzer.css'
      ];
      var shadowCss = [];
      var headCss = [];

      for (var i = 0; i < feature.contentStyles.length; i++) {
        var path = feature.contentStyles[i];
        var fileName = path.split('/').pop();
        if (globalStyles.indexOf(fileName) !== -1) {
          headCss.push(path);
        } else {
          shadowCss.push(path);
        }
      }

      // Inject into Shadow Root via TactaDOM
      if (shadowCss.length > 0 && window.TactaDOM && typeof window.TactaDOM.injectStylesheet === 'function') {
        for (var j = 0; j < shadowCss.length; j++) {
          await window.TactaDOM.injectStylesheet(chrome.runtime.getURL(shadowCss[j]));
        }
      }

      // Inject into Main Document via Background
      if (headCss.length > 0) {
        await sendMessage({
          action: 'injectFeatureFiles',
          featureId: feature.id,
          css: headCss,
          js: [],
          injectScripts: []
        });
      }
    }

    await sendMessage({
      action: 'injectFeatureFiles',
      featureId: feature.id,
      css: [], // Don't inject into main doc anymore
      js: feature.contentScripts || [],
      injectScripts: feature.injectScripts || []
    });
  }

  async function run() {
    var eligible = new Set();
    PAGE_FEATURES.forEach(function (mapping) {
      if (mapping.test.test(window.location.href)) {
        mapping.features.forEach(function (id) { eligible.add(id); });
      }
    });

    if (eligible.size === 0) return;

    var context = await loadContext();
    if (context.meetingMode) return;

    // Honour the registry's pageTypes exactly like router.js does. The URL
    // patterns above are deliberately broad (search.nl covers both the editor
    // and some list views), so without this a feature restricted to
    // search-results could land on the search editor. That is how Saved
    // Search Export ended up injecting its toolbar inside the Criteria /
    // Results machine on the Saved Search edit page and tripping NetSuite's
    // "Field not found" alert on every Results subtab click.
    var pageType = null;
    if (window.TactaPageDetector) {
      try {
        var info = window.__tactaPageInfo || window.TactaPageDetector.detect();
        pageType = info && info.type;
      } catch (_) { pageType = null; }
    }

    var toInject = context.features.filter(function (feature) {
      if (!eligible.has(feature.id) || !isFeatureEnabled(feature, context.featureStates)) return false;
      if (pageType && Array.isArray(feature.pageTypes) && feature.pageTypes.length) {
        return feature.pageTypes.indexOf(pageType) !== -1;
      }
      return true;
    });

    var results = await Promise.allSettled(toInject.map(function (feature) {
      return activateFeature(feature);
    }));

    results.forEach(function (result, idx) {
      if (result.status === 'rejected') {
        console.warn('[Tacta FeatureLoader] Failed to load "' + toInject[idx].id + '":', result.reason);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();

/**
 * NetSuite TactaSuite - Content Script Router
 *
 * @author Blane Maher
 *
 * Runtime router for auto and on-demand feature activation. Feature metadata
 * comes from the background registry so file paths and page rules do not drift
 * between popup/options/background/content code.
 */
(function () {
  'use strict';

  // NetSuite also serves XML views (record URL + xml=T) under /app/*. Those
  // documents have no HTML elements, so nothing here can run safely.
  // Chrome wraps XML in an HTML pretty-printer, so check the content type too.
  if (!(document.documentElement instanceof HTMLElement)) return;
  if (document.contentType && !/html/i.test(document.contentType)) return;
  if (window.__tactaRouterLoaded) return;
  window.__tactaRouterLoaded = true;
  window.__tactaActivatedFeatures = window.__tactaActivatedFeatures || new Set();

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

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  async function getFeatureContext() {
    var features = [];
    var featureStates = {};
    var meetingMode = false;

    try {
      features = await sendMessage({ action: 'getFeatures' }) || [];
    } catch (_) {
      features = [];
    }

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

  function isFeatureEnabled(feature, featureStates) {
    return Object.prototype.hasOwnProperty.call(featureStates, feature.id)
      ? featureStates[feature.id] === true
      : feature.defaultEnabled === true;
  }

  async function activateFeature(feature, data) {
    if (!feature || !feature.id) return;
    if (window.__tactaActivatedFeatures.has(feature.id)) {
      window.dispatchEvent(new CustomEvent('tacta:featureActivated', {
        detail: { featureId: feature.id, data: data }
      }));
      return;
    }
    // Reserve the id BEFORE awaiting anything. feature-loader.js runs at the
    // same time on some pages; without this both loaders pass the has() check,
    // inject the same files twice and fire featureActivated twice.
    window.__tactaActivatedFeatures.add(feature.id);
    try {
      await injectFeature(feature);
    } catch (err) {
      window.__tactaActivatedFeatures.delete(feature.id);
      throw err;
    }
    window.dispatchEvent(new CustomEvent('tacta:featureActivated', {
      detail: { featureId: feature.id, data: data }
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
      css: [],
      js: feature.contentScripts || [],
      injectScripts: feature.injectScripts || []
    });
  }

  onReady(async function () {
    var context = await getFeatureContext();
    if (context.meetingMode) return;

    if (window.TactaThemeManager) {
      window.TactaThemeManager.init();
    }

    if (!window.TactaPageDetector) return;
    var pageInfo = window.TactaPageDetector.detect();
    window.__tactaPageInfo = pageInfo;

    var autoFeatures = context.features.filter(function (feature) {
      return feature.trigger === 'auto' &&
        isFeatureEnabled(feature, context.featureStates) &&
        Array.isArray(feature.pageTypes) &&
        feature.pageTypes.indexOf(pageInfo.type) !== -1;
    });

    var results = await Promise.allSettled(autoFeatures.map(function (feature) {
      return activateFeature(feature).catch(function (err) {
        throw new Error(feature.id + ': ' + (err.message || err));
      });
    }));

    results.forEach(function (result, idx) {
      if (result.status === 'rejected') {
        console.warn('[Tacta Toolkit] Failed to load feature "' + autoFeatures[idx].id + '":', result.reason);
      }
    });
  });

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message.action === 'activateFeature' && message.featureId) {
      getFeatureContext()
        .then(function (context) {
          if (context.meetingMode) throw new Error('Meeting mode is enabled.');
          var feature = context.features.find(function (f) { return f.id === message.featureId; });
          if (!feature) throw new Error('Unknown feature: ' + message.featureId);
          if (!isFeatureEnabled(feature, context.featureStates)) {
            throw new Error('Feature is disabled: ' + message.featureId);
          }
          return activateFeature(feature, message.data);
        })
        .then(function () { sendResponse({ success: true }); })
        .catch(function (err) { sendResponse({ error: err.message }); });
      return true;
    }

    if (message.action === 'getPageInfo') {
      sendResponse(window.__tactaPageInfo || null);
      return false;
    }
  });
})();

/**
 * console-tools.js
 * Extension-world bootstrap for the NetSuite console helper surface.
 */
(function () {
  'use strict';

  if (window.__tactaConsoleToolsLoaded) return;
  window.__tactaConsoleToolsLoaded = true;

  function announce() {
    if (window.TactaDOM && window.TactaDOM.showToast) {
      window.TactaDOM.showToast('Console helpers available as window.TactaNSKit', 'info', 2500);
    }
  }

  window.addEventListener('tacta:consoleToolsReady', announce, { once: true });

  // Relay TactaNSKit.open(featureId) from the page world to the extension.
  // The service worker injects the feature and dispatches its activation.
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== window || !data || data.source !== 'tacta-nskit' || data.type !== 'openFeature') return;
    var featureId = String(data.featureId || '');
    if (!/^[a-z0-9-]+$/.test(featureId)) return;
    try {
      chrome.runtime.sendMessage({ action: 'executeFeature', featureId: featureId }, function (response) {
        var err = chrome.runtime.lastError ? chrome.runtime.lastError.message : (response && response.error);
        if (err && window.TactaDOM && window.TactaDOM.showToast) {
          window.TactaDOM.showToast('Could not open ' + featureId + ': ' + err, 'error', 4000);
        }
      });
    } catch (e) {
      console.warn('[Tacta Toolkit] open(' + featureId + ') failed:', e);
    }
  });
})();

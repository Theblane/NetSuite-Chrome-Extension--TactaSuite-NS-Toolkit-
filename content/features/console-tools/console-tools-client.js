/**
 * console-tools-client.js
 * Page-world helpers exposed as window.TactaNSKit for NetSuite developers.
 */
(function () {
  'use strict';

  if (window.TactaNSKit) return;

  function getCurrentRecord() {
    return new Promise(function (resolve, reject) {
      if (typeof require !== 'function') {
        reject(new Error('NetSuite require() is not available on this page.'));
        return;
      }
      require(['N/currentRecord'], function (currentRecord) {
        try {
          resolve(currentRecord.get());
        } catch (e) {
          reject(e);
        }
      }, function (err) {
        reject(new Error('Could not load N/currentRecord: ' + (err && err.message ? err.message : err)));
      });
    });
  }

  function setDomField(fieldId, value) {
    var el = document.getElementById(fieldId) ||
      document.querySelector('[name="' + cssEscape(fieldId) + '"]') ||
      document.getElementById(fieldId + '_formattedValue');

    if (!el) return false;

    if (el.type === 'checkbox') {
      el.checked = value === true || value === 'T' || value === 'true' || value === 1;
    } else {
      el.value = value == null ? '' : String(value);
    }

    ['input', 'change', 'blur'].forEach(function (type) {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    });
    return true;
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function normalizeCheckbox(value) {
    return value === true || value === 'T' || value === 'true' || value === 1 ? true : false;
  }

  function updateField(fieldId, value, options) {
    options = options || {};
    return getCurrentRecord().then(function (rec) {
      try {
        rec.setValue({
          fieldId: fieldId,
          value: value,
          ignoreFieldChange: options.ignoreFieldChange === true ? true : false
        });
        return { ok: true, method: 'currentRecord', fieldId: fieldId, value: value };
      } catch (e) {
        if (setDomField(fieldId, value)) {
          return { ok: true, method: 'dom', fieldId: fieldId, value: value, warning: e.message || String(e) };
        }
        throw e;
      }
    }).catch(function (e) {
      if (setDomField(fieldId, value)) {
        return { ok: true, method: 'dom', fieldId: fieldId, value: value, warning: e.message || String(e) };
      }
      throw e;
    });
  }

  function updateExternalId(value, options) {
    return updateField('externalid', value, options);
  }

  function updateOverwriteSalesTax(value, options) {
    return updateField('overwritesalestax', normalizeCheckbox(value), options);
  }

  function getFieldValue(fieldId) {
    return getCurrentRecord().then(function (rec) {
      return rec.getValue({ fieldId: fieldId });
    });
  }

  function getText(fieldId) {
    return getCurrentRecord().then(function (rec) {
      return rec.getText({ fieldId: fieldId });
    });
  }

  function listFields() {
    return getCurrentRecord().then(function (rec) {
      var ids = rec.getFields ? rec.getFields() : [];
      return ids.map(function (fieldId) {
        var value = null;
        var text = null;
        try { value = rec.getValue({ fieldId: fieldId }); } catch (_) {}
        try { text = rec.getText({ fieldId: fieldId }); } catch (_) {}
        return { fieldId: fieldId, value: value, text: text };
      });
    });
  }

  function snapshot() {
    return listFields().then(function (fields) {
      var data = {};
      fields.forEach(function (field) {
        data[field.fieldId] = field.value;
      });
      return data;
    });
  }

  function copySnapshot() {
    return snapshot().then(function (data) {
      var text = JSON.stringify(data, null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () {
          return { ok: true, fields: Object.keys(data).length };
        });
      }
      console.log(text);
      return { ok: false, fields: Object.keys(data).length, warning: 'Clipboard unavailable; logged snapshot.' };
    });
  }

  /**
   * Open a toolkit feature from the console, e.g.
   * TactaNSKit.open('screenshot-studio'). The request is relayed to the
   * extension by the console-tools content script.
   * @param {string} featureId
   */
  function open(featureId) {
    if (!featureId) { console.warn('[TactaNSKit] open(featureId) needs a feature id, e.g. "field-explorer".'); return; }
    window.postMessage({ source: 'tacta-nskit', type: 'openFeature', featureId: String(featureId) }, window.location.origin);
    return 'Opening ' + featureId + '...';
  }

  window.TactaNSKit = {
    open: open,
    getCurrentRecord: getCurrentRecord,
    updateField: updateField,
    setField: updateField,
    updateExternalId: updateExternalId,
    updateOverwriteSalesTax: updateOverwriteSalesTax,
    getFieldValue: getFieldValue,
    getText: getText,
    listFields: listFields,
    snapshot: snapshot,
    copySnapshot: copySnapshot,
    examples: {
      externalId: "await TactaNSKit.updateExternalId('ABC-123')",
      overwriteSalesTax: "await TactaNSKit.updateOverwriteSalesTax(true)",
      anyField: "await TactaNSKit.updateField('memo', 'Updated from console')",
      inspect: "console.table(await TactaNSKit.listFields())",
      open: "TactaNSKit.open('field-explorer')  // any toolkit feature id"
    }
  };

  console.info('[TactaNSKit] Console helpers ready:', window.TactaNSKit.examples);
  window.dispatchEvent(new CustomEvent('tacta:consoleToolsReady'));
})();

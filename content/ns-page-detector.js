/**
 * NetSuite TactaSuite — NetSuite Page Detector
 *
 * @author Blane Maher
 *
 * IIFE that exposes window.TactaPageDetector with a single detect() method.
 * Analyzes the current URL and page DOM to classify the NetSuite page into a
 * known type and extract contextual metadata (record type, record ID, etc.).
 *
 * Page types:
 *   record-view, record-edit, search-edit, search-results, search-list,
 *   script-record, suitelet, dashboard, list, setup, pdf-template,
 *   csv-import, file-cabinet, workflow, dataset, workbook, other
 */
(function () {
  'use strict';

  // Avoid double-init if the script is injected more than once.
  if (window.TactaPageDetector) return;

  // ---------------------------------------------------------------------------
  // URL pattern matchers (order matters — first match wins)
  // ---------------------------------------------------------------------------

  const URL_RULES = [
    // Workflow
    { pattern: /\/app\/common\/workflow\/setup\//i,        type: 'workflow' },

    // Script record
    { pattern: /\/app\/common\/scripting\/script\.nl/i,    type: 'script-record' },

    // Dataset / Workbook (Analytics)
    { pattern: /\/app\/common\/dataset\//i,                type: 'dataset' },
    { pattern: /\/app\/common\/workbook\//i,               type: 'workbook' },

    // PDF / HTML templates
    { pattern: /\/app\/common\/scripting\/scripttemplate\.nl/i, type: 'pdf-template' },
    { pattern: /\/app\/common\/custom\/custhtml\.nl/i,          type: 'pdf-template' },

    // CSV Import
    { pattern: /\/app\/setup\/assistants\/nsimport\//i,    type: 'csv-import' },

    // File Cabinet
    { pattern: /\/app\/common\/media\//i,                  type: 'file-cabinet' },

    // Search pages
    { pattern: /\/app\/common\/search\/searchresults\.nl/i,        type: 'search-results' },
    { pattern: /\/app\/common\/search\/search\.nl.*&e=T/i,         type: 'search-edit' },
    { pattern: /\/app\/common\/search\/search\.nl/i,               type: 'search-edit' },
    { pattern: /\/app\/common\/search\/searchlist\.nl/i,           type: 'search-list' },
    { pattern: /\/app\/common\/search\//i,                         type: 'search-list' },

    // Setup pages
    { pattern: /\/app\/setup\//i,                          type: 'setup' },

    // Dashboard
    { pattern: /\/app\/center\/card\.nl/i,                 type: 'dashboard' },

    // Suitelet
    { pattern: /\/app\/site\/hosting\/scriptlet\.nl/i,     type: 'suitelet' },

    // Specific list pages (must come before broad transaction/entity rules)
    { pattern: /\/app\/accounting\/transactions\/transactionlist\.nl/i, type: 'list' },
    { pattern: /\/app\/common\/entity\/.*list\.nl/i,       type: 'list' },

    // Transaction / record pages — these are broad, so they go near the end
    { pattern: /\/app\/accounting\/transactions\//i,       type: '_transaction' },
    { pattern: /\/app\/common\/custom\/custrecordentry\.nl/i, type: '_record' },

    // Generic entity/record pages
    { pattern: /\/app\/common\/entity\//i,                 type: '_record' },
    { pattern: /list\.nl/i,                                type: 'list' }
  ];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse a URL query string into a plain object.
   */
  function parseQuery(url) {
    const params = {};
    const qs = url.split('?')[1];
    if (!qs) return params;
    qs.split('&').forEach((pair) => {
      const [key, val] = pair.split('=');
      params[decodeURIComponent(key).toLowerCase()] = decodeURIComponent(val || '');
    });
    return params;
  }

  /**
   * Attempt to read the record type from the page. Checks the URL, then falls
   * back to well-known DOM elements populated by NetSuite.
   */
  function detectRecordType(params) {
    // URL param: rectype, recordtype, compid-style encoded rectype
    if (params.rectype)     return params.rectype;
    if (params.recordtype)  return params.recordtype;
    if (params.type)        return params.type;

    // DOM: hidden input sometimes present on record pages
    const hiddenInput = document.querySelector('input[name="type"], input[name="baserecordtype"]');
    if (hiddenInput?.value) return hiddenInput.value;

    return null;
  }

  /**
   * Determine whether the page is in edit mode.
   */
  function detectEditMode(params) {
    // Explicit edit param
    if (params.e === 't' || params.e === 'T') return true;

    // New record
    if (!params.id && params.rectype) return true;

    // DOM: the main form's action often contains /e/
    const mainForm = document.getElementById('main_form');
    if (mainForm?.action && /[?&]e=T/i.test(mainForm.action)) return true;

    return false;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  window.TactaPageDetector = {
    /**
     * Analyze the current page and return a structured descriptor.
     *
     * @returns {{
     *   type: string,
     *   recordType: string|null,
     *   recordId: string|null,
     *   isEdit: boolean,
     *   searchId: string|null
     * }}
     */
    detect() {
      const url    = window.location.href;
      const params = parseQuery(url);

      // Run through the URL rules to get an initial type.
      let type = 'other';
      for (const rule of URL_RULES) {
        if (rule.pattern.test(url)) {
          type = rule.type;
          break;
        }
      }

      const isEdit     = detectEditMode(params);
      const recordType = detectRecordType(params);
      const recordId   = params.id || null;
      const searchId   = params.searchid || params.id || null;

      // Refine internal-only types
      if (type === '_transaction' || type === '_record') {
        type = isEdit ? 'record-edit' : 'record-view';
      }

      return {
        type,
        recordType,
        recordId,
        isEdit,
        searchId: (type.startsWith('search') ? searchId : null)
      };
    }
  };
})();

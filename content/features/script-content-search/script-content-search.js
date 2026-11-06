/**
 * script-content-search.js
 * Searches SuiteScript source files in the File Cabinet for a string.
 */
(function () {
  'use strict';

  if (window.__tactaScriptContentSearchLoaded) return;
  window.__tactaScriptContentSearchLoaded = true;

  var FEATURE_ID = 'script-content-search';
  var ROOT_ID = 'tacta-script-content-search';
  var _files = null;
  var _currentAbort = 0;

  function sendMessage(payload) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(payload, function (response) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (response && response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  }

  function executeSuiteQL(query) {
    return sendMessage({ action: 'executeSuiteQL', query: query });
  }

  function fetchFiles() {
    if (_files) return Promise.resolve(_files);
    var sql = [
      "SELECT id, name, url, filetype, folder, documentsize",
      "FROM file",
      "WHERE (LOWER(name) LIKE '%.js' OR LOWER(name) LIKE '%.ts' OR LOWER(name) LIKE '%.ss' OR LOWER(name) LIKE '%.json')",
      "ORDER BY name"
    ].join(' ');
    return executeSuiteQL(sql).then(function (result) {
      _files = (result.rows || []).map(function (row) {
        return {
          id: row.id,
          name: row.name,
          url: row.url,
          filetype: row.filetype,
          folder: row.folder,
          size: Number(row.documentsize || 0)
        };
      });
      return _files;
    });
  }

  function fetchText(file) {
    if (!file.url) return Promise.reject(new Error('File has no URL.'));
    var url = file.url.charAt(0) === '/' ? location.origin + file.url : file.url;
    return fetch(url, { credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text();
    });
  }

  function analyzeSource(source) {
    var modules = [];
    var records = [];
    var fields = [];
    var files = [];
    var moduleMatch;
    var moduleRegex = /(?:define|require)\s*\(\s*\[([\s\S]*?)\]/g;
    while ((moduleMatch = moduleRegex.exec(source))) {
      moduleMatch[1].replace(/['"]([^'"]+)['"]/g, function (_, mod) {
        if (modules.indexOf(mod) < 0) modules.push(mod);
      });
    }
    source.replace(/record\.Type\.([A-Z0-9_]+)|type\s*:\s*['"]([a-z0-9_]+)['"]/gi, function (_, a, b) {
      var value = a || b;
      if (value && records.indexOf(value) < 0) records.push(value);
    });
    source.replace(/fieldId\s*:\s*['"]([^'"]+)['"]|getValue\s*\(\s*['"]([^'"]+)['"]|setValue\s*\(\s*['"]([^'"]+)['"]/g, function (_, a, b, c) {
      var value = a || b || c;
      if (value && fields.indexOf(value) < 0) fields.push(value);
    });
    source.replace(/file\.load\s*\(\s*(?:\{[\s\S]*?id\s*:\s*)?['"]?([^'"\}\),\s]+)['"]?/g, function (_, value) {
      if (value && files.indexOf(value) < 0) files.push(value);
    });
    return { modules: modules, records: records, fields: fields, files: files };
  }

  function matchSnippet(source, term) {
    var idx = source.toLowerCase().indexOf(term.toLowerCase());
    if (idx < 0) return '';
    var start = Math.max(0, idx - 90);
    var end = Math.min(source.length, idx + term.length + 140);
    return source.slice(start, end).replace(/\s+/g, ' ').trim();
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      if (key === 'className') node.className = attrs[key];
      else if (key === 'textContent') node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function renderResults(host, results) {
    host.textContent = '';
    if (!results.length) {
      host.appendChild(el('div', { className: 'tacta-scs-empty', textContent: 'No matching files found.' }));
      return;
    }
    results.forEach(function (result) {
      var details = result.analysis;
      var item = el('div', { className: 'tacta-scs-result' }, [
        el('div', { className: 'tacta-scs-title', textContent: result.file.name + ' #' + result.file.id }),
        el('div', { className: 'tacta-scs-path', textContent: result.file.url || '' }),
        el('pre', { textContent: result.snippet }),
        el('div', { className: 'tacta-scs-meta', textContent: [
          'Modules: ' + (details.modules.join(', ') || '-'),
          'Records: ' + (details.records.join(', ') || '-'),
          'Fields: ' + (details.fields.slice(0, 20).join(', ') || '-'),
          'Files: ' + (details.files.join(', ') || '-')
        ].join(' | ') })
      ]);
      if (result.file.url) {
        var link = el('a', { href: result.file.url.charAt(0) === '/' ? location.origin + result.file.url : result.file.url, target: '_blank', textContent: 'Open file' });
        item.appendChild(link);
      }
      host.appendChild(item);
    });
  }

  function search(term, status, host) {
    var runId = ++_currentAbort;
    var maxFiles = 250;
    status.textContent = 'Loading File Cabinet script files...';
    host.textContent = '';
    return fetchFiles().then(function (files) {
      var candidates = files.filter(function (file) {
        if (!term) return false;
        return (file.name || '').toLowerCase().indexOf(term.toLowerCase()) >= 0 || file.size <= 500000;
      }).slice(0, maxFiles);
      var results = [];
      var chain = Promise.resolve();
      candidates.forEach(function (file, idx) {
        chain = chain.then(function () {
          if (runId !== _currentAbort) return null;
          status.textContent = 'Searching ' + (idx + 1) + ' of ' + candidates.length + ' files...';
          return fetchText(file).then(function (source) {
            if (source.toLowerCase().indexOf(term.toLowerCase()) >= 0 || file.name.toLowerCase().indexOf(term.toLowerCase()) >= 0) {
              results.push({
                file: file,
                snippet: matchSnippet(source, term) || '(matched by file name)',
                analysis: analyzeSource(source)
              });
              renderResults(host, results);
            }
          }).catch(function () {});
        });
      });
      return chain.then(function () {
        if (runId === _currentAbort) status.textContent = 'Searched ' + candidates.length + ' files. Found ' + results.length + '.';
      });
    }).catch(function (e) {
      status.textContent = 'Search failed: ' + (e.message || String(e));
    });
  }

  function openPanel() {
    var existing = document.getElementById(ROOT_ID);
    if (existing) {
      existing.remove();
      return;
    }
    var root = el('div', { id: ROOT_ID, className: 'tacta-scs tacta-toolkit' }, [
      el('div', { className: 'tacta-scs-head' }, [
        el('strong', { textContent: 'Script Content Search' }),
        el('button', { type: 'button', textContent: 'x', 'data-close': '1' })
      ]),
      el('div', { className: 'tacta-scs-search' }, [
        el('input', { type: 'text', placeholder: 'Search source text, file name, module, field ID...' }),
        el('button', { type: 'button', textContent: 'Search' })
      ]),
      el('div', { className: 'tacta-scs-status', textContent: 'Enter a string to search SuiteScript files.' }),
      el('div', { className: 'tacta-scs-results' })
    ]);
    var input = root.querySelector('input');
    var button = root.querySelector('.tacta-scs-search button');
    var status = root.querySelector('.tacta-scs-status');
    var results = root.querySelector('.tacta-scs-results');
    root.querySelector('[data-close]').addEventListener('click', function () { root.remove(); });
    button.addEventListener('click', function () {
      var term = input.value.trim();
      if (term.length < 2) {
        status.textContent = 'Enter at least 2 characters.';
        return;
      }
      search(term, status, results);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') button.click();
    });
    document.body.appendChild(root);
    input.focus();
  }

  chrome.runtime.onMessage.addListener(function (message) {
    if (message && message.action === 'activateFeature' && message.featureId === FEATURE_ID) {
      openPanel();
    }
  });

  window.addEventListener('tacta:featureActivated', function (e) {
    if (e.detail && e.detail.featureId === FEATURE_ID) openPanel();
  });
})();

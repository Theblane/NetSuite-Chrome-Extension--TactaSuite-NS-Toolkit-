/**
 * saved-search-export-client.js
 * Page-world saved search exporter with access to NetSuite N/search.
 */
(function () {
    'use strict';

    if (window.__tactaSavedSearchExportClientLoaded) return;
    window.__tactaSavedSearchExportClientLoaded = true;

    function emit(detail) {
        window.dispatchEvent(new CustomEvent('tacta:sse:allExportEvent', { detail: detail }));
    }

    function getValue(result, column) {
        var text = '';
        var value = '';
        try { text = result.getText(column); } catch (_) {}
        try { value = result.getValue(column); } catch (_) {}
        if (Array.isArray(text)) return text.join(', ');
        if (text !== null && text !== undefined && text !== '') return String(text);
        if (Array.isArray(value)) return value.join(', ');
        return value === null || value === undefined ? '' : String(value);
    }

    function getColumnLabel(column, index) {
        return column.label || column.name || ('Column ' + (index + 1));
    }

    function getSuiteScriptLoader() {
        if (typeof require === 'function') return require;
        if (typeof window.require === 'function') return window.require;
        if (typeof window.requirejs === 'function') return window.requirejs;
        return null;
    }

    function waitForSearchApi(callback, attemptsLeft) {
        var loader = getSuiteScriptLoader();
        if (loader || typeof window.nlapiLoadSearch === 'function') {
            callback();
            return;
        }

        if (attemptsLeft <= 0) {
            callback();
            return;
        }

        setTimeout(function () {
            waitForSearchApi(callback, attemptsLeft - 1);
        }, 250);
    }

    function exportAllSavedSearch(requestId, searchId, pageSize) {
        if (!searchId) {
            emit({ requestId: requestId, type: 'error', message: 'No saved search ID was found in the page URL.' });
            return;
        }

        waitForSearchApi(function () {
            var loader = getSuiteScriptLoader();
            if (loader) {
                exportAllWithSearchModule(requestId, searchId, pageSize, loader);
                return;
            }

            if (typeof window.nlapiLoadSearch === 'function') {
                exportAllWithNlapi(requestId, searchId, pageSize);
                return;
            }

            emit({
                requestId: requestId,
                type: 'error',
                message: 'Neither SuiteScript 2.x require() nor nlapiLoadSearch() is available on this page. Open the saved search edit/results page after NetSuite finishes loading, then try again.'
            });
        }, 16);
    }

    function exportAllWithSearchModule(requestId, searchId, pageSize, loader) {
        loader(['N/search'], function (search) {
            try {
                var loadedSearch = search.load({ id: searchId });
                var columns = loadedSearch.columns || [];
                var headers = columns.map(getColumnLabel);
                var paged = loadedSearch.runPaged({ pageSize: pageSize || 1000 });
                var totalPages = paged.pageRanges.length;
                var totalRows = paged.count || 0;

                emit({
                    requestId: requestId,
                    type: 'start',
                    headers: headers,
                    totalRows: totalRows,
                    totalPages: totalPages
                });

                for (var p = 0; p < totalPages; p++) {
                    var pageRange = paged.pageRanges[p];
                    var page = paged.fetch({ index: pageRange.index });
                    var rows = [];

                    page.data.forEach(function (result) {
                        rows.push(columns.map(function (column) {
                            return getValue(result, column);
                        }));
                    });

                    emit({
                        requestId: requestId,
                        type: 'chunk',
                        page: p + 1,
                        totalPages: totalPages,
                        rows: rows
                    });

                    emit({
                        requestId: requestId,
                        type: 'progress',
                        page: p + 1,
                        totalPages: totalPages,
                        exportedRows: Math.min((p + 1) * (pageSize || 1000), totalRows),
                        totalRows: totalRows
                    });
                }

                emit({
                    requestId: requestId,
                    type: 'complete',
                    totalRows: totalRows,
                    totalPages: totalPages
                });
            } catch (e) {
                emit({ requestId: requestId, type: 'error', message: e && e.message ? e.message : String(e) });
            }
        }, function (err) {
            emit({
                requestId: requestId,
                type: 'error',
                message: 'Could not load N/search: ' + (err && err.message ? err.message : String(err))
            });
        });
    }

    function exportAllWithNlapi(requestId, searchId, pageSize) {
        try {
            var loadedSearch = window.nlapiLoadSearch(null, searchId);
            var columns = loadedSearch.getColumns ? loadedSearch.getColumns() : [];
            var headers = columns.map(function (column, index) {
                try {
                    return column.getLabel() || column.getName() || ('Column ' + (index + 1));
                } catch (_) {
                    return 'Column ' + (index + 1);
                }
            });
            var resultSet = loadedSearch.runSearch();
            var chunkSize = Math.min(pageSize || 1000, 1000);
            var start = 0;
            var page = 0;
            var totalRows = 0;

            emit({
                requestId: requestId,
                type: 'start',
                headers: headers,
                totalRows: 0,
                totalPages: 0
            });

            while (true) {
                var results = resultSet.getResults(start, start + chunkSize) || [];
                if (!results.length) break;
                page++;
                totalRows += results.length;

                emit({
                    requestId: requestId,
                    type: 'chunk',
                    page: page,
                    totalPages: '?',
                    rows: results.map(function (result) {
                        return columns.map(function (column) {
                            var text = '';
                            var value = '';
                            try { text = result.getText(column); } catch (_) {}
                            try { value = result.getValue(column); } catch (_) {}
                            return text || value || '';
                        });
                    })
                });

                emit({
                    requestId: requestId,
                    type: 'progress',
                    page: page,
                    totalPages: '?',
                    exportedRows: totalRows,
                    totalRows: totalRows
                });

                if (results.length < chunkSize) break;
                start += chunkSize;
            }

            emit({
                requestId: requestId,
                type: 'complete',
                totalRows: totalRows,
                totalPages: page
            });
        } catch (e) {
            emit({ requestId: requestId, type: 'error', message: e && e.message ? e.message : String(e) });
        }
    }

    window.addEventListener('tacta:sse:exportAllRequest', function (event) {
        var detail = event.detail || {};
        exportAllSavedSearch(detail.requestId, detail.searchId, detail.pageSize);
    });
})();

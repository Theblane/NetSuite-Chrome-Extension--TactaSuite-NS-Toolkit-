/**
 * suiteql-runner-client.js
 * NetSuite TactaSuite - SuiteQL Runner Page-World Script
 *
 * @author Blane Maher
 *
 * Runs in the MAIN world (page context) with access to NetSuite's
 * require() and native APIs. Provides schema discovery and search
 * utilities for the SuiteQL Runner feature.
 *
 * Injected by the service worker via chrome.scripting.executeScript
 * with world: 'MAIN'.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaSuiteQLClientLoaded) return;
    window.__tactaSuiteQLClientLoaded = true;

    // ────────────────────────────────────────────────────────────
    // Schema Discovery
    // ────────────────────────────────────────────────────────────

    /**
     * Discover available record types and common tables.
     * Posts results back to the extension world via CustomEvent.
     */
    function discoverSchema() {
        var schema = {
            recordTypes: [],
            commonTables: [
                // Core record tables
                'transaction', 'transactionline', 'transactionaccountingline',
                'customer', 'vendor', 'employee', 'partner', 'contact', 'entity',
                'item', 'inventoryitem', 'noninventoryitem', 'serviceitem', 'kititem',
                'assemblyitem', 'lotNumberedInventoryItem', 'serializedInventoryItem',
                // Financial
                'account', 'accountingperiod', 'subsidiary', 'department', 'location', 'classification',
                // Other common
                'file', 'folder', 'note', 'message', 'phonecall', 'task', 'event',
                'campaign', 'opportunity', 'estimate', 'salesorder', 'invoice',
                'creditmemo', 'returnauthorization', 'purchaseorder', 'vendorbill',
                'journalentry', 'inventoryadjustment', 'transferorder',
                'customrecord', 'bin', 'binnumber', 'inventorycount',
                // Script/workflow
                'script', 'scriptdeployment', 'scriptlog', 'workflow', 'workflowstate',
                // Pricing
                'pricelevel', 'pricing',
                // Addresses
                'address', 'addressbook'
            ]
        };

        // Try to get custom record types if N/search is available
        if (typeof require === 'function') {
            try {
                require(['N/query'], function (queryModule) {
                    try {
                        // Get custom record types from the account
                        var result = queryModule.runSuiteQL({
                            query: "SELECT scriptid, name FROM customrecordtype ORDER BY name"
                        });
                        var rows = result.asMappedResults();
                        for (var i = 0; i < rows.length; i++) {
                            schema.recordTypes.push({
                                id: rows[i].scriptid,
                                name: rows[i].name
                            });
                            schema.commonTables.push(rows[i].scriptid);
                        }
                    } catch (e) {
                        // Custom record query failed — not critical
                    }

                    // Dispatch schema back to extension world
                    window.dispatchEvent(new CustomEvent('tacta:schemaDiscovered', {
                        detail: schema
                    }));
                }, function () {
                    // N/query not available — still send what we have
                    window.dispatchEvent(new CustomEvent('tacta:schemaDiscovered', {
                        detail: schema
                    }));
                });
            } catch (e) {
                window.dispatchEvent(new CustomEvent('tacta:schemaDiscovered', {
                    detail: schema
                }));
            }
        } else {
            window.dispatchEvent(new CustomEvent('tacta:schemaDiscovered', {
                detail: schema
            }));
        }
    }

    // ────────────────────────────────────────────────────────────
    // Table Column Discovery
    // ────────────────────────────────────────────────────────────

    /**
     * Get columns for a specific table using SuiteQL analytics.
     */
    function discoverTableColumns(tableName) {
        if (typeof require !== 'function') {
            window.dispatchEvent(new CustomEvent('tacta:columnsDiscovered', {
                detail: { table: tableName, columns: [], error: 'require() not available' }
            }));
            return;
        }

        try {
            require(['N/query'], function (queryModule) {
                try {
                    // Use OA_COLUMNS to get column metadata
                    var result = queryModule.runSuiteQL({
                        query: "SELECT name, type FROM OA_COLUMNS WHERE table_name = '" +
                               tableName.replace(/'/g, "''") + "' ORDER BY name"
                    });
                    var rows = result.asMappedResults();
                    var columns = [];
                    for (var i = 0; i < rows.length; i++) {
                        columns.push({ name: rows[i].name, type: rows[i].type });
                    }
                    window.dispatchEvent(new CustomEvent('tacta:columnsDiscovered', {
                        detail: { table: tableName, columns: columns }
                    }));
                } catch (e) {
                    window.dispatchEvent(new CustomEvent('tacta:columnsDiscovered', {
                        detail: { table: tableName, columns: [], error: e.message || String(e) }
                    }));
                }
            });
        } catch (e) {
            window.dispatchEvent(new CustomEvent('tacta:columnsDiscovered', {
                detail: { table: tableName, columns: [], error: e.message || String(e) }
            }));
        }
    }

    // ────────────────────────────────────────────────────────────
    // Event Listeners
    // ────────────────────────────────────────────────────────────

    // Listen for schema discovery requests from the extension world
    window.addEventListener('tacta:discoverSchema', function () {
        discoverSchema();
    });

    // Listen for column discovery requests
    window.addEventListener('tacta:discoverColumns', function (e) {
        if (e.detail && e.detail.table) {
            discoverTableColumns(e.detail.table);
        }
    });

    // Auto-discover schema on load (async, non-blocking)
    // Small delay to let the page finish loading NS modules
    setTimeout(function () {
        discoverSchema();
    }, 2000);

})();

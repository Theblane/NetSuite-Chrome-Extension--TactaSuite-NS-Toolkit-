/**
 * nav-search-pages.js
 * NetSuite TactaSuite — Navigation Search Page Data
 *
 * @author Blane Maher
 *
 * Exports an array of common NetSuite pages used by the Navigation Search
 * feature. Each entry includes a human-readable title, the relative URL path,
 * a category for badge display, and keyword tokens for fuzzy matching.
 *
 * Categories: Transaction, Record, List, Setup, Report, Script, Center, Search
 *
 * @fileoverview Static page data for the Navigation Search feature.
 */
(function () {
    'use strict';

    /**
     * @typedef {Object} NavSearchPage
     * @property {string} title    - Human-readable page title.
     * @property {string} path     - Relative NetSuite URL path.
     * @property {string} category - Category label for badge display.
     * @property {string[]} keywords - Additional search tokens beyond the title.
     */

    /** @type {NavSearchPage[]} */
    var NAV_SEARCH_PAGES = [

        // ── Transactions ──────────────────────────────────────────────

        { title: 'Sales Orders',            path: '/app/accounting/transactions/salesord.nl',     category: 'Transaction', keywords: ['sales', 'order', 'SO', 'transaction'] },
        { title: 'New Sales Order',         path: '/app/accounting/transactions/salesord.nl?e=T', category: 'Transaction', keywords: ['create', 'new', 'sales', 'order', 'SO'] },
        { title: 'Invoices',                path: '/app/accounting/transactions/custinvc.nl',     category: 'Transaction', keywords: ['invoice', 'INV', 'billing', 'AR'] },
        { title: 'New Invoice',             path: '/app/accounting/transactions/custinvc.nl?e=T', category: 'Transaction', keywords: ['create', 'new', 'invoice'] },
        { title: 'Purchase Orders',         path: '/app/accounting/transactions/purchord.nl',     category: 'Transaction', keywords: ['purchase', 'order', 'PO', 'procurement'] },
        { title: 'New Purchase Order',      path: '/app/accounting/transactions/purchord.nl?e=T', category: 'Transaction', keywords: ['create', 'new', 'purchase', 'order'] },
        { title: 'Item Fulfillments',       path: '/app/accounting/transactions/itemship.nl',     category: 'Transaction', keywords: ['fulfillment', 'shipping', 'IF', 'ship'] },
        { title: 'Item Receipts',           path: '/app/accounting/transactions/itemrcpt.nl',     category: 'Transaction', keywords: ['receipt', 'receiving', 'IR'] },
        { title: 'Vendor Bills',            path: '/app/accounting/transactions/vendbill.nl',     category: 'Transaction', keywords: ['vendor', 'bill', 'AP', 'payable'] },
        { title: 'Vendor Payments',         path: '/app/accounting/transactions/vendpymt.nl',     category: 'Transaction', keywords: ['vendor', 'payment', 'AP', 'pay'] },
        { title: 'Customer Payments',       path: '/app/accounting/transactions/custpymt.nl',     category: 'Transaction', keywords: ['customer', 'payment', 'AR', 'receive'] },
        { title: 'Credit Memos',            path: '/app/accounting/transactions/custcred.nl',     category: 'Transaction', keywords: ['credit', 'memo', 'refund', 'CM'] },
        { title: 'Estimates / Quotes',      path: '/app/accounting/transactions/estimate.nl',     category: 'Transaction', keywords: ['estimate', 'quote', 'proposal'] },
        { title: 'Return Authorizations',   path: '/app/accounting/transactions/rtnauth.nl',     category: 'Transaction', keywords: ['return', 'RMA', 'authorization'] },
        { title: 'Transfer Orders',         path: '/app/accounting/transactions/trnfrord.nl',    category: 'Transaction', keywords: ['transfer', 'order', 'TO', 'warehouse'] },
        { title: 'Journal Entries',         path: '/app/accounting/transactions/journal.nl',     category: 'Transaction', keywords: ['journal', 'entry', 'JE', 'GL'] },
        { title: 'Cash Sales',              path: '/app/accounting/transactions/cashsale.nl',    category: 'Transaction', keywords: ['cash', 'sale', 'POS'] },
        { title: 'Work Orders',             path: '/app/accounting/transactions/workord.nl',     category: 'Transaction', keywords: ['work', 'order', 'WO', 'manufacturing'] },
        { title: 'Inventory Adjustments',   path: '/app/accounting/transactions/invadjst.nl',    category: 'Transaction', keywords: ['inventory', 'adjustment', 'stock'] },
        { title: 'Inventory Transfers',     path: '/app/accounting/transactions/invtrnfr.nl',    category: 'Transaction', keywords: ['inventory', 'transfer', 'warehouse', 'move'] },
        { title: 'Deposits',                path: '/app/accounting/transactions/deposit.nl',     category: 'Transaction', keywords: ['deposit', 'bank'] },
        { title: 'Expense Reports',         path: '/app/accounting/transactions/exprept.nl',     category: 'Transaction', keywords: ['expense', 'report', 'reimbursement'] },

        // ── Records / Entities ────────────────────────────────────────

        { title: 'Customers',               path: '/app/common/entity/custjob.nl',               category: 'Record', keywords: ['customer', 'client', 'entity', 'account'] },
        { title: 'New Customer',             path: '/app/common/entity/custjob.nl?e=T',           category: 'Record', keywords: ['create', 'new', 'customer'] },
        { title: 'Vendors',                  path: '/app/common/entity/vendor.nl',                category: 'Record', keywords: ['vendor', 'supplier', 'entity'] },
        { title: 'Employees',               path: '/app/common/entity/employee.nl',               category: 'Record', keywords: ['employee', 'staff', 'user', 'HR'] },
        { title: 'Contacts',                path: '/app/common/entity/contact.nl',                category: 'Record', keywords: ['contact', 'person'] },
        { title: 'Partners',                path: '/app/common/entity/partner.nl',                category: 'Record', keywords: ['partner', 'channel'] },
        { title: 'Items',                   path: '/app/common/item/itemlist.nl',                 category: 'Record', keywords: ['item', 'product', 'SKU', 'inventory'] },
        { title: 'Inventory Items',         path: '/app/common/item/item.nl?itemtype=InvtPart',   category: 'Record', keywords: ['inventory', 'item', 'stock', 'product'] },
        { title: 'Non-Inventory Items',     path: '/app/common/item/item.nl?itemtype=NonInvtPart', category: 'Record', keywords: ['non-inventory', 'item'] },
        { title: 'Service Items',           path: '/app/common/item/item.nl?itemtype=Service',    category: 'Record', keywords: ['service', 'item'] },
        { title: 'Assembly Items',          path: '/app/common/item/item.nl?itemtype=Assembly',   category: 'Record', keywords: ['assembly', 'BOM', 'kit'] },
        { title: 'Custom Records',          path: '/app/common/custom/custrecordlist.nl',         category: 'Record', keywords: ['custom', 'record', 'type'] },
        { title: 'Subsidiaries',            path: '/app/common/otherlists/subsidiarytype.nl',     category: 'Record', keywords: ['subsidiary', 'company', 'entity'] },
        { title: 'Locations',               path: '/app/common/otherlists/locationtype.nl',       category: 'Record', keywords: ['location', 'warehouse', 'store'] },
        { title: 'Departments',             path: '/app/common/otherlists/departmenttype.nl',     category: 'Record', keywords: ['department', 'division'] },
        { title: 'Classes',                 path: '/app/common/otherlists/classtype.nl',          category: 'Record', keywords: ['class', 'classification', 'segment'] },

        // ── Lists / Search ────────────────────────────────────────────

        { title: 'Saved Searches',          path: '/app/common/search/searchlist.nl',             category: 'Search', keywords: ['saved', 'search', 'list'] },
        { title: 'New Saved Search',        path: '/app/common/search/search.nl?cu=T&e=T',       category: 'Search', keywords: ['create', 'new', 'search'] },
        { title: 'Transaction Search',      path: '/app/common/search/search.nl?searchtype=Transaction&e=T', category: 'Search', keywords: ['transaction', 'search'] },
        { title: 'Customer Search',         path: '/app/common/search/search.nl?searchtype=Customer&e=T', category: 'Search', keywords: ['customer', 'search'] },
        { title: 'Item Search',             path: '/app/common/search/search.nl?searchtype=Item&e=T', category: 'Search', keywords: ['item', 'search'] },
        { title: 'Employee Search',         path: '/app/common/search/search.nl?searchtype=Employee&e=T', category: 'Search', keywords: ['employee', 'search'] },
        { title: 'Global Search',           path: '/app/common/search/ubersearchresults.nl',      category: 'Search', keywords: ['global', 'search', 'uber'] },

        // ── Setup ─────────────────────────────────────────────────────

        { title: 'Company Information',     path: '/app/setup/company.nl',                        category: 'Setup', keywords: ['company', 'info', 'settings'] },
        { title: 'Enable Features',         path: '/app/setup/options.nl',                        category: 'Setup', keywords: ['features', 'enable', 'SuiteCloud', 'options'] },
        { title: 'Accounting Preferences',  path: '/app/setup/acctpreferences.nl',                category: 'Setup', keywords: ['accounting', 'preferences', 'settings'] },
        { title: 'Users / Roles',           path: '/app/setup/listuser.nl',                       category: 'Setup', keywords: ['user', 'role', 'access', 'permission'] },
        { title: 'Manage Roles',            path: '/app/setup/rolelist.nl',                       category: 'Setup', keywords: ['role', 'permission', 'access'] },
        { title: 'Custom Fields',           path: '/app/common/custom/customfieldlist.nl',        category: 'Setup', keywords: ['custom', 'field', 'body', 'entity', 'item'] },
        { title: 'Custom Forms',            path: '/app/common/custom/custforms.nl',              category: 'Setup', keywords: ['custom', 'form', 'entry', 'transaction'] },
        { title: 'Custom Lists',            path: '/app/common/custom/customlists.nl',            category: 'Setup', keywords: ['custom', 'list', 'dropdown'] },
        { title: 'Custom Record Types',     path: '/app/common/custom/custrecordlist.nl',         category: 'Setup', keywords: ['custom', 'record', 'type', 'definition'] },
        { title: 'SuiteCloud Config',       path: '/app/common/scripting/scriptconfiglist.nl',    category: 'Setup', keywords: ['SuiteCloud', 'config', 'configuration'] },
        { title: 'Accounting Periods',      path: '/app/setup/period/fiscalperiods.nl',           category: 'Setup', keywords: ['period', 'fiscal', 'year', 'close'] },
        { title: 'Tax Schedules',           path: '/app/setup/taxschedules.nl',                   category: 'Setup', keywords: ['tax', 'schedule', 'rate'] },
        { title: 'Payment Methods',         path: '/app/setup/paymentmethods.nl',                 category: 'Setup', keywords: ['payment', 'method', 'credit card'] },
        { title: 'Currencies',              path: '/app/common/multicurrency/currencylist.nl',    category: 'Setup', keywords: ['currency', 'exchange', 'rate', 'multi'] },
        { title: 'Import CSV Records',      path: '/app/setup/assistants/nsimport/simpleimport.nl', category: 'Setup', keywords: ['import', 'CSV', 'upload', 'data'] },

        // ── Scripts ───────────────────────────────────────────────────

        { title: 'Scripts',                 path: '/app/common/scripting/scriptlist.nl',           category: 'Script', keywords: ['script', 'SuiteScript', 'code'] },
        { title: 'Script Deployments',      path: '/app/common/scripting/scriptdeploymentlist.nl', category: 'Script', keywords: ['deployment', 'script', 'deploy'] },
        { title: 'Script Log',              path: '/app/common/scripting/scriptexecutionlog.nl',   category: 'Script', keywords: ['log', 'execution', 'debug', 'error'] },
        { title: 'Script Debugger',         path: '/app/common/scripting/scriptdebugger.nl',      category: 'Script', keywords: ['debugger', 'debug', 'breakpoint'] },
        { title: 'Scheduled Scripts Status', path: '/app/common/scripting/scriptstatus.nl',       category: 'Script', keywords: ['scheduled', 'status', 'queue', 'running'] },
        { title: 'Map/Reduce Script Status', path: '/app/common/scripting/mapreducescriptstatus.nl', category: 'Script', keywords: ['map', 'reduce', 'MR', 'status'] },
        { title: 'SuiteScript Records Catalog', path: '/app/help/helpcenter.nl?fid=chapter_N3170093.html', category: 'Script', keywords: ['records', 'catalog', 'browser', 'API'] },
        { title: 'Workflows',              path: '/app/common/workflow/setup/workflowlist.nl',    category: 'Script', keywords: ['workflow', 'automation', 'state'] },

        // ── Reports ───────────────────────────────────────────────────

        { title: 'Financial Reports',       path: '/app/reporting/reportrunner.nl?accttype=Income', category: 'Report', keywords: ['financial', 'report', 'income', 'P&L'] },
        { title: 'Balance Sheet',           path: '/app/reporting/reportrunner.nl?reporttype=BALANCE_SHEET', category: 'Report', keywords: ['balance', 'sheet', 'assets', 'liabilities'] },
        { title: 'Income Statement',        path: '/app/reporting/reportrunner.nl?reporttype=INCOME_STATEMENT', category: 'Report', keywords: ['income', 'statement', 'P&L', 'profit', 'loss'] },
        { title: 'Trial Balance',           path: '/app/reporting/reportrunner.nl?reporttype=TRIAL_BALANCE', category: 'Report', keywords: ['trial', 'balance', 'GL'] },
        { title: 'A/R Aging',              path: '/app/reporting/reportrunner.nl?reporttype=AR_AGING', category: 'Report', keywords: ['AR', 'aging', 'receivable', 'overdue'] },
        { title: 'A/P Aging',              path: '/app/reporting/reportrunner.nl?reporttype=AP_AGING', category: 'Report', keywords: ['AP', 'aging', 'payable', 'overdue'] },
        { title: 'Inventory Valuation',     path: '/app/reporting/reportrunner.nl?reporttype=INVENTORY_VALUATION', category: 'Report', keywords: ['inventory', 'valuation', 'stock', 'cost'] },
        { title: 'Sales by Customer',       path: '/app/reporting/reportrunner.nl?reporttype=SALES_BY_CUSTOMER', category: 'Report', keywords: ['sales', 'customer', 'revenue'] },
        { title: 'Sales by Item',           path: '/app/reporting/reportrunner.nl?reporttype=SALES_BY_ITEM', category: 'Report', keywords: ['sales', 'item', 'product', 'revenue'] },

        // ── Centers / Dashboard ───────────────────────────────────────

        { title: 'Home Dashboard',          path: '/app/center/card.nl',                          category: 'Center', keywords: ['home', 'dashboard', 'portal'] },
        { title: 'Activities',              path: '/app/crm/calendar/calendar.nl',                category: 'Center', keywords: ['activities', 'calendar', 'events', 'tasks'] },
        { title: 'Reminders',               path: '/app/center/enhancedreminders.nl',              category: 'Center', keywords: ['reminders', 'alerts', 'notifications'] },
        { title: 'File Cabinet',            path: '/app/common/media/mediaitemfolders.nl',        category: 'Center', keywords: ['file', 'cabinet', 'upload', 'media', 'documents'] },
        { title: 'SuiteBundler',            path: '/app/bundler/bundlelist.nl',                   category: 'Center', keywords: ['bundle', 'install', 'package', 'SDF'] },
        { title: 'SuiteAnalytics Workbook', path: '/app/common/workbook/workbooklist.nl',         category: 'Center', keywords: ['analytics', 'workbook', 'dataset', 'pivot'] }
    ];

    // Expose globally for use by nav-search.js.
    window.__tactaNavSearchPages = NAV_SEARCH_PAGES;
})();

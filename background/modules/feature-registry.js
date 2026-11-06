/**
 * NetSuite TactaSuite — Feature Registry
 *
 * @author Blane Maher
 *
 * Single source of truth for every feature the toolkit ships. Each entry
 * describes the feature's metadata, which page types it applies to, how it
 * is triggered, and the scripts/styles it needs injected.
 *
 * Feature shape:
 * {
 *   id:             string        Unique kebab-case identifier.
 *   label:          string        Human-readable name shown in popup / options.
 *   group:          string        One of: developer, search, record, layout, misc.
 *   description:    string        One-line tooltip / options page description.
 *   defaultEnabled: boolean       Initial toggle state on fresh install.
 *   pageTypes:      string[]      Page types from ns-page-detector where this
 *                                 feature is relevant.
 *   trigger:        string        'auto' — injected automatically on matching pages.
 *                                 'popup' — activated on demand via the popup.
 *                                 'contextmenu' — activated from a context menu item.
 *   contentScripts: string[]      Extension-world scripts to inject.
 *   contentStyles:  string[]      CSS files to inject.
 *   injectScripts:  string[]      Page-world (MAIN) scripts for accessing NS globals.
 *   audience:       string[]      Which user types get this feature ON by default:
 *                                 'user' and/or 'developer'. Drives the User and
 *                                 Developer presets in the popup, settings page
 *                                 and walkthrough (shared/user-types.js).
 *                                 Empty = off for all.
 *   onboarding:     Object        { summary, where } - plain-language copy for
 *                                 the setup walkthrough.
 * }
 */

export const FEATURES = [
  // ── Developer ─────────────────────────────────────────────────────────────
  {
    id: 'field-explorer',
    label: 'Field Explorer',
    group: 'developer',
    description: 'Inspect every field on the current record - IDs, types, values, sublist columns, and per-field change history.',
    defaultEnabled: true,
    audience: ['developer'],
    onboarding: {
      summary: 'Every field on the record you are viewing, with its internal id, type, current value and whether it is hidden.',
      where: 'Toolkit menu on any record page.'
    },
    pageTypes: ['record-view', 'record-edit'],
    trigger: 'popup',
    contentScripts: ['content/features/field-explorer/field-explorer.js'],
    contentStyles: ['content/features/field-explorer/field-explorer.css'],
    injectScripts: ['content/features/field-explorer/field-explorer-client.js']
  },
  {
    id: 'script-analyzer',
    label: 'Script Analyzer',
    group: 'developer',
    description: 'Analyze deployed scripts on the current record — entry points, usage, governance.',
    defaultEnabled: true,
    audience: ['developer'],
    onboarding: {
      summary: 'Shows which scripts fire on the record you are on, with entry points and governance hints.',
      where: 'Automatically on record and script pages.'
    },
    pageTypes: ['script-record', 'record-view', 'record-edit'],
    trigger: 'auto',
    contentScripts: ['content/features/script-analyzer/script-analyzer.js'],
    contentStyles: ['content/features/script-analyzer/script-analyzer.css'],
    injectScripts: []
  },
  {
    id: 'script-explorer',
    label: 'Script Explorer',
    group: 'developer',
    description: 'Browse all scripts and deployments in the account from a slide-out panel.',
    defaultEnabled: false,
    audience: ['developer'],
    onboarding: {
      summary: 'Browse every script and deployment in the account from a slide-out panel.',
      where: 'Toolkit menu.'
    },
    pageTypes: ['script-record', 'suitelet', 'dashboard', 'other'],
    trigger: 'popup',
    contentScripts: ['content/features/script-explorer/script-explorer.js'],
    contentStyles: ['content/features/script-explorer/script-explorer.css'],
    injectScripts: []
  },
  {
    id: 'script-content-search',
    label: 'Script Content Search',
    group: 'developer',
    description: 'Search SuiteScript files by source text and inspect module, record, field, and file references.',
    defaultEnabled: false,
    audience: ['developer'],
    onboarding: {
      summary: 'Full-text search across SuiteScript source files in the File Cabinet.',
      where: 'Toolkit menu.'
    },
    pageTypes: ['script-record', 'file-cabinet', 'suitelet', 'dashboard', 'other'],
    trigger: 'popup',
    contentScripts: ['content/features/script-content-search/script-content-search.js'],
    contentStyles: ['content/features/script-content-search/script-content-search.css'],
    injectScripts: []
  },
  {
    id: 'console-tools',
    label: 'Console Tools',
    group: 'developer',
    description: 'Adds window.TactaNSKit console helpers for quick current-record updates and inspection.',
    defaultEnabled: true,
    audience: ['developer'],
    onboarding: {
      summary: 'Adds window.TactaNSKit helpers to the DevTools console for quick record inspection and edits.',
      where: 'Automatically on record, search and script pages.'
    },
    pageTypes: ['record-view', 'record-edit', 'search-edit', 'script-record', 'suitelet', 'workflow', 'other'],
    trigger: 'auto',
    contentScripts: ['content/features/console-tools/console-tools.js'],
    contentStyles: [],
    injectScripts: ['content/features/console-tools/console-tools-client.js']
  },
  {
    id: 'console-snippets',
    label: 'Console Snippets',
    group: 'developer',
    description: 'Known-good console commands for the record you are on, with the internal ID pre-filled. Copy, paste into DevTools.',
    defaultEnabled: false,
    audience: ['developer'],
    onboarding: {
      summary: 'Known-good console commands for the record you are on, ids pre-filled, ready to paste.',
      where: 'Toolkit menu.'
    },
    pageTypes: ['record-view', 'record-edit', 'list', 'script-record', 'suitelet',
                'file-cabinet', 'dashboard', 'setup', 'other'],
    trigger: 'popup',
    contentScripts: ['content/features/console-snippets/console-snippets-data.js',
                     'content/features/console-snippets/console-snippets.js'],
    contentStyles: ['content/features/console-snippets/console-snippets.css'],
    injectScripts: ['content/features/console-snippets/console-snippets-client.js']
  },
  {
    id: 'record-object',
    label: 'Record Object Viewer',
    group: 'developer',
    description: 'View the raw nlapiGetFieldValue / currentRecord object as JSON.',
    defaultEnabled: false,
    audience: ['developer'],
    onboarding: {
      summary: 'The raw record object as JSON, body fields and sublists included.',
      where: 'Toolkit menu on record pages.'
    },
    pageTypes: ['record-view', 'record-edit'],
    trigger: 'popup',
    contentScripts: ['content/features/record-object/record-object.js'],
    contentStyles: ['content/features/record-object/record-object.css'],
    injectScripts: []
  },
  {
    id: 'suiteql-runner',
    label: 'SuiteQL Runner',
    group: 'developer',
    description: 'Run SuiteQL queries against NetSuite - editor, history, named saved queries, sortable results, CSV and JSON export.',
    defaultEnabled: true,
    audience: ['developer'],
    onboarding: {
      summary: 'Write and run SuiteQL against this account with history, saved queries and CSV or JSON export.',
      where: 'Toolkit menu on any NetSuite page.'
    },
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list',
                'script-record', 'suitelet', 'dashboard', 'list', 'setup', 'other'],
    trigger: 'popup',
    contentScripts: ['content/features/suiteql-runner/suiteql-runner.js'],
    contentStyles: ['content/features/suiteql-runner/suiteql-runner.css'],
    injectScripts: ['content/features/suiteql-runner/suiteql-runner-client.js']
  },

  // ── Search ────────────────────────────────────────────────────────────────
  {
    id: 'suitescript-exporter',
    label: 'SuiteScript Exporter',
    group: 'search',
    description: 'Export saved search, dataset, and workbook pages to SuiteScript 2.x TypeScript scaffolds.',
    defaultEnabled: true,
    audience: ['developer'],
    onboarding: {
      summary: 'Turns a saved search, dataset or workbook into a SuiteScript 2.x scaffold.',
      where: 'Automatically on search, dataset and workbook editors.'
    },
    pageTypes: ['search-edit', 'dataset', 'workbook'],
    trigger: 'auto',
    contentScripts: ['content/features/suitescript-exporter/suitescript-exporter.js'],
    contentStyles: ['content/features/suitescript-exporter/suitescript-exporter.css'],
    injectScripts: []
  },
  {
    id: 'saved-search-export',
    label: 'Saved Search Export',
    group: 'search',
    description: 'One-click CSV/JSON export from saved search results pages.',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'One-click CSV or JSON download of saved search results.',
      where: 'Automatically on search results pages.'
    },
    pageTypes: ['search-results', 'search-list'],
    trigger: 'auto',
    contentScripts: ['content/features/saved-search-export/saved-search-export.js'],
    contentStyles: ['content/features/saved-search-export/saved-search-export.css'],
    injectScripts: ['content/features/saved-search-export/saved-search-export-client.js']
  },
  {
    id: 'field-finder',
    label: 'Field Finder',
    group: 'search',
    description: 'Quick-filter search columns and criteria fields by ID or label.',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'Type to filter the long field pickers when building searches and workflows.',
      where: 'Automatically on search and workflow editors.'
    },
    pageTypes: ['search-edit', 'workflow'],
    trigger: 'auto',
    contentScripts: ['content/features/field-finder/field-finder.js'],
    contentStyles: ['content/features/field-finder/field-finder.css'],
    injectScripts: ['content/features/field-finder/field-finder-client.js']
  },
  {
    id: 'quick-search-creation',
    label: 'Quick Search Creation',
    group: 'search',
    description: 'Shortcut buttons to create common saved searches from templates.',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'Shortcut buttons that start a new saved search of a chosen type.',
      where: 'Automatically on most pages.'
    },
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list',
                'script-record', 'suitelet', 'dashboard', 'list', 'setup', 'other'],
    trigger: 'auto',
    contentScripts: ['content/features/quick-search-creation/quick-search-creation.js'],
    contentStyles: ['content/features/quick-search-creation/quick-search-creation.css'],
    injectScripts: []
  },

  // ── Record ────────────────────────────────────────────────────────────────
  {
    id: 'field-help',
    label: 'Field Help Tooltips',
    group: 'record',
    description: 'Enhanced field help popups - field ID, value, select options, set-value, and field change history.',
    defaultEnabled: true,
    audience: ['developer'],
    onboarding: {
      summary: 'Richer field help popups: id, type, value, select options, history and set-value.',
      where: 'Automatically when you click a field label.'
    },
    pageTypes: ['record-view', 'record-edit', 'search-edit', 'search-results', 'search-list',
                'script-record', 'suitelet', 'dashboard', 'list', 'setup', 'other'],
    trigger: 'auto',
    contentScripts: ['content/features/field-help/field-help.js'],
    contentStyles: ['content/features/field-help/field-help.css'],
    injectScripts: ['content/features/field-help/field-help-client.js']
  },
  {
    id: 'transaction-tree',
    label: 'Transaction Tree',
    group: 'record',
    description: 'Visualize the full transaction chain (SO > IF > INV) as an interactive tree.',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'The whole chain of related transactions as an interactive tree.',
      where: 'Automatically on transaction pages.'
    },
    pageTypes: ['record-view', 'record-edit'],
    trigger: 'auto',
    contentScripts: ['content/features/transaction-tree/transaction-tree.js'],
    contentStyles: ['content/features/transaction-tree/transaction-tree.css'],
    injectScripts: []
  },

  // ── Layout ────────────────────────────────────────────────────────────────
  {
    id: 'split-view',
    label: 'Split View',
    group: 'layout',
    description: 'Open the current page in a side-by-side split pane.',
    defaultEnabled: false,
    audience: [],
    onboarding: {
      summary: 'Open the current page side by side with another NetSuite page.',
      where: 'Right-click menu.'
    },
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'list', 'other'],
    trigger: 'contextmenu',
    contentScripts: ['content/features/split-view/split-view.js'],
    contentStyles: ['content/features/split-view/split-view.css'],
    injectScripts: []
  },
  {
    id: 'fixed-headers',
    label: 'Fixed Headers',
    group: 'layout',
    description: 'Pin sublist headers so they stay visible when scrolling long line lists.',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'Keeps sublist column headers visible while you scroll long line lists.',
      where: 'Automatically on records and lists.'
    },
    pageTypes: ['record-view', 'record-edit', 'search-results', 'list'],
    trigger: 'auto',
    contentScripts: ['content/features/fixed-headers/fixed-headers.js'],
    contentStyles: ['content/features/fixed-headers/fixed-headers.css'],
    injectScripts: []
  },

  // ── Misc ──────────────────────────────────────────────────────────────────
  {
    id: 'account-color',
    label: 'Account Color',
    group: 'misc',
    description: 'Color-code the NetSuite header bar per account (production vs. sandbox).',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'Colors the NetSuite header per environment so production and sandbox never look alike.',
      where: 'Automatically on every page.'
    },
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list',
                'script-record', 'suitelet', 'dashboard', 'list', 'setup', 'other'],
    trigger: 'auto',
    contentScripts: ['content/features/ns-utils/account-color/account-color.js'],
    contentStyles: ['content/features/ns-utils/account-color/account-color.css'],
    injectScripts: []
  },
  {
    id: 'nav-search',
    label: 'Navigation Search',
    group: 'misc',
    description: 'Keyboard-driven fuzzy search across NetSuite pages (Ctrl+Shift+K); paste a script, field or record id, or script:/search:/bundle:N, to open it.',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'Press Ctrl+Shift+K and type to jump to any menu item, or paste a script or record id to open it.',
      where: 'Automatically on every page.'
    },
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list',
                'script-record', 'suitelet', 'dashboard', 'list', 'setup', 'other'],
    trigger: 'auto',
    contentScripts: [
      'content/features/ns-utils/nav-search/nav-search-pages.js',
      'content/features/ns-utils/nav-search/nav-search.js'
    ],
    contentStyles: ['content/features/ns-utils/nav-search/nav-search.css'],
    injectScripts: []
  },
  {
    id: 'pdf-tools',
    label: 'PDF Template Tools',
    group: 'misc',
    description: 'Live preview and syntax helpers for Advanced PDF/HTML templates.',
    defaultEnabled: false,
    audience: ['developer'],
    onboarding: {
      summary: 'Live preview and syntax helpers for Advanced PDF/HTML templates.',
      where: 'Automatically on template editors.'
    },
    pageTypes: ['pdf-template'],
    trigger: 'auto',
    contentScripts: ['content/features/pdf-tools/pdf-tools.js'],
    contentStyles: ['content/features/pdf-tools/pdf-tools.css'],
    injectScripts: []
  },
  {
    id: 'csv-viewer',
    label: 'CSV Import Viewer',
    group: 'misc',
    description: 'Preview CSV import files in a formatted table before submitting.',
    defaultEnabled: false,
    audience: ['developer'],
    onboarding: {
      summary: 'Preview a CSV import file as a table before you submit it.',
      where: 'Automatically on the CSV import assistant.'
    },
    pageTypes: ['csv-import'],
    trigger: 'auto',
    contentScripts: ['content/features/csv-viewer/csv-viewer.js'],
    contentStyles: ['content/features/csv-viewer/csv-viewer.css'],
    injectScripts: []
  },
  {
    id: 'workflow-colors',
    label: 'Workflow Colors',
    group: 'misc',
    description: 'Color-code workflow states and transitions for easier visual parsing.',
    defaultEnabled: true,
    audience: ['developer'],
    onboarding: {
      summary: 'Color-codes workflow states and transitions.',
      where: 'Automatically in the workflow editor.'
    },
    pageTypes: ['workflow'],
    trigger: 'auto',
    contentScripts: ['content/features/workflow-colors/workflow-colors.js'],
    contentStyles: ['content/features/workflow-colors/workflow-colors.css'],
    injectScripts: []
  },
  {
    id: 'better-page-titles',
    label: 'Better Page Titles',
    group: 'misc',
    description: 'Rewrite browser tab titles to include record type and name for easier tab-switching.',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'Browser tab titles that say what record you have open.',
      where: 'Automatically on every page.'
    },
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list',
                'script-record', 'suitelet', 'dashboard', 'list', 'setup', 'other'],
    trigger: 'auto',
    contentScripts: ['content/features/better-page-titles/better-page-titles.js'],
    contentStyles: [],
    injectScripts: []
  },
  {
    id: 'csv-template-generator',
    label: 'CSV Template Generator',
    group: 'misc',
    description: 'Generate a CSV import/export template from the current NetSuite record — all fields, mandatory only, with values, or a manual selection.',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'Builds a CSV import template from the record you are viewing.',
      where: 'Toolkit menu on record pages.'
    },
    pageTypes: ['record-view', 'record-edit'],
    trigger: 'popup',
    contentScripts: ['content/features/csv-template-generator/csv-template-generator.js'],
    contentStyles: ['content/features/csv-template-generator/csv-template-generator.css'],
    injectScripts: ['content/features/csv-template-generator/csv-template-generator-client.js']
  },

  // ── Record ────────────────────────────────────────────────────────────────
  {
    id: 'audit-trail',
    label: 'Audit Trail',
    group: 'record',
    description: 'View the full system notes / change history for the current record — sortable, filterable, and exportable.',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'The full change history of the record, sortable, filterable and exportable.',
      where: 'Toolkit menu on record pages.'
    },
    pageTypes: ['record-view', 'record-edit'],
    trigger: 'popup',
    contentScripts: ['content/features/audit-trail/audit-trail.js'],
    contentStyles: ['content/features/audit-trail/audit-trail.css'],
    injectScripts: []
  },

  // ── Search ────────────────────────────────────────────────────────────────
  {
    id: 'search-url-builder',
    label: 'Search URL Builder',
    group: 'search',
    description: 'Generate shareable results URLs, edit links, and SuiteScript 2.1 snippets for the current saved search.',
    defaultEnabled: true,
    audience: ['developer'],
    onboarding: {
      summary: 'Shareable result links, edit links and SuiteScript snippets for a saved search.',
      where: 'Toolkit menu on search pages.'
    },
    pageTypes: ['search-results', 'search-edit', 'search-list'],
    trigger: 'popup',
    contentScripts: ['content/features/search-url-builder/search-url-builder.js'],
    contentStyles: ['content/features/search-url-builder/search-url-builder.css'],
    injectScripts: []
  },

  // ── Added 2026-10-21 (Phase 1) ─────────────────────────────────────────────
  {
    id: 'environment-badge',
    label: 'Environment Badge',
    group: 'misc',
    description: 'Header pill naming the environment and account (SB1 - 4485744) plus a [SB1] / [PROD] tab title prefix.',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'Never mistake sandbox for production again.',
      where: 'Pill beside the NetSuite logo; click it to copy the account id.'
    },
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list', 'script-record', 'suitelet',
                'dashboard', 'list', 'setup', 'pdf-template', 'csv-import', 'file-cabinet', 'workflow', 'dataset', 'workbook', 'other'],
    trigger: 'auto',
    contentScripts: ['content/features/environment-badge/environment-badge.js'],
    contentStyles: ['content/features/environment-badge/environment-badge.css'],
    injectScripts: []
  },
  {
    id: 'transaction-trail',
    label: 'Transaction Trail',
    group: 'record',
    description: 'Breadcrumb chips under the title showing the document chain through this transaction (EST > SO > IF > INV).',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'Jump up or down the transaction chain in one click.',
      where: 'Strip directly under the page title on transaction pages.'
    },
    pageTypes: ['record-view', 'record-edit'],
    trigger: 'auto',
    contentScripts: ['content/features/transaction-trail/transaction-trail.js'],
    contentStyles: ['content/features/transaction-trail/transaction-trail.css'],
    injectScripts: []
  },
  {
    id: 'dataset-to-suiteql',
    label: 'Dataset to SuiteQL',
    group: 'search',
    description: 'Get SuiteQL button on dataset and workbook pages that returns the N/query toSuiteQL() output.',
    defaultEnabled: true,
    audience: ['developer'],
    onboarding: {
      summary: 'Turn any dataset into runnable SuiteQL.',
      where: 'Get SuiteQL button next to the page title on Analytics pages.'
    },
    pageTypes: ['dataset', 'workbook'],
    trigger: 'auto',
    contentScripts: ['content/features/dataset-to-suiteql/dataset-to-suiteql.js'],
    contentStyles: ['content/features/dataset-to-suiteql/dataset-to-suiteql.css'],
    injectScripts: ['content/features/dataset-to-suiteql/dataset-to-suiteql-client.js']
  },
  {
    id: 'portlet-refresher',
    label: 'Portlet Refresher',
    group: 'misc',
    description: 'Auto-refresh every dashboard portlet on a 1 to 15 minute schedule while the tab is visible.',
    defaultEnabled: false,
    audience: [],
    onboarding: {
      summary: 'Keep dashboard KPIs current without reloading.',
      where: 'Auto-refresh control in the dashboard heading panel.'
    },
    pageTypes: ['dashboard'],
    trigger: 'auto',
    contentScripts: ['content/features/portlet-refresher/portlet-refresher.js'],
    contentStyles: ['content/features/portlet-refresher/portlet-refresher.css'],
    injectScripts: []
  },
  {
    id: 'instant-ui',
    label: 'Instant UI',
    group: 'layout',
    description: 'Remove NetSuite fade-ins and other transitions so the interface responds immediately. Loading wheels keep their normal speed.',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'Snappier NetSuite with no fade-ins.',
      where: 'Applies on every page once enabled.'
    },
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list', 'script-record', 'suitelet',
                'dashboard', 'list', 'setup', 'pdf-template', 'csv-import', 'file-cabinet', 'workflow', 'dataset', 'workbook', 'other'],
    trigger: 'auto',
    contentScripts: ['content/features/instant-ui/instant-ui.js'],
    contentStyles: ['content/features/instant-ui/instant-ui.css'],
    injectScripts: []
  },
  {
    id: 'screenshot-studio',
    label: 'Screenshot Studio',
    group: 'misc',
    description: 'Visible, full-page or record-area screenshots with one-click privacy masks for emails, phones, tax ids, card numbers and amounts.',
    defaultEnabled: true,
    audience: ['user', 'developer'],
    onboarding: {
      summary: 'Share a NetSuite screen without leaking customer data.',
      where: 'Toolkit menu on any NetSuite page.'
    },
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list', 'script-record', 'suitelet',
                'dashboard', 'list', 'setup', 'pdf-template', 'csv-import', 'file-cabinet', 'workflow', 'dataset', 'workbook', 'other'],
    trigger: 'popup',
    contentScripts: ['content/features/screenshot-studio/screenshot-studio.js'],
    contentStyles: ['content/features/screenshot-studio/screenshot-studio.css'],
    injectScripts: []
  }
];

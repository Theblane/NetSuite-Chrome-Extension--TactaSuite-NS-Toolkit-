# Competitive review of NetSuite Chrome extensions (2026-10-21)

Source copies live beside this project in `..\<extension id>\<version>\`. Six NetSuite extensions
were newly copied from the local Chrome profile and reviewed against the current TactaSuite feature
registry (25 features). Reports were produced by parallel code-reading agents; file paths cite the
copied source.

| Extension | Id | Version | Posture |
|---|---|---|---|
| SuiteAdvanced for NetSuite | `eambkjlkacecjilgcdmicbpnhkfhdiee` | 31.2.1 | Paid (ExtPay), minified, remote script loader |
| NetSuite Full Tools | `fgldkomofdfcmkccjgalihlollndjmcc` | 7.2.3 | Free, 117 toggles, optional LLM providers |
| Netsuite for Consultants | `aflobjbeciepmhknodbffejfaifplcbf` | 1.23.0 | Free, unminified, dormant paid backend |
| NetSuite Transaction Developer Toolkit | `gmdjmoaioakhdagebjnpnhfljiecmpej` | 1.7.7 | Free, unminified, hobby-grade |
| NetSuite Query Tool (goVirtualOffice) | `adfidpigmjbgddddnnhbiolnmfhfjjmm` | 2.0.1 | Free, popup IDE. Duplicate of `..\2.0.1_0` |
| NetSuite Portlet Refresher | `lfkblodbhmjgnbblmdbipdcggaaihbjc` | 2025.02 | Free, injects upsell banner |

## Cross-cutting themes

Every one of the five developer-oriented extensions beats our `suiteql-runner`, and three of them
converge on the same two record-page ideas: "what scripts run on this record" and
"field history from `systemnote`". Those are the highest-leverage gaps.

### 1. SuiteQL runner upgrades (seen in all five)
- Table and column autocomplete from the Records Catalog endpoint
  `/app/recordscatalog/rcendpoint.nl?action=getRecordTypes` and
  `action=getRecordTypeDetail&data={scriptId,detailType:'SS_ANAL'}` (Query Tool
  `libs/sql_schema_lib.js:44,354`; Consultants `content.js:3252+`). Cache per account. **M**
- Schema browser: fields plus joins with cardinality from the same detail payload. **M**
- Named saved queries, multiple editor tabs persisted to `chrome.storage.local`. **S**
- `${var}` parameters with enum inference, `_color/_bg/_html` pseudo-columns, clickable `type:id`
  cells, AbortController cancel (SuiteAdvanced `nlapi.js`, `suiteql.css`). **S-M**
- JSON and XLSX export, Copy-as-SuiteScript (TDT `content.js:11686,12712`). **S**
- Dual transport: REST `/services/rest/query/v1/suiteql` with `Prefer: transient` and concurrency 4,
  falling back to page-world `N/query` (Full Tools `_shared/nsft_suiteql_transport.js`). **M**
- Hidden same-origin iframe of `/app/center/userprefs.nl` to obtain a `require` runtime on pages
  that have none, recreated to reset governance (Consultants `content.js:5125`). **M**

### 2. Record page: scripts and logs
- **Record Scripts**: fetch `/app/common/scripting/scriptedrecord.nl?id=<RECORDTYPE>` and parse the
  `tr.uir-machine-headerrow` tables for UE / Client / Workflow deployments (TDT `content.js:8530`;
  Consultants `record.create` schema pass + Scripts & Workflows; Full Tools `nlapiSearchRecord`). **M**
- **Record Logs Viewer**: SuiteQL on `scriptNote` joined to `ScriptDeployment`, filtered to the
  scripts attached to the current record, shown in a side panel (Full Tools `record_logs_viewer/`). **M**
- **Scripted Record page** per-deployment execution status incl. "Maxed", missing entry points
  (SuiteAdvanced `netsuite.js`). **M**

### 3. Field popup extras (extend `field-help` / `field-explorer`)
- Field history: `SELECT ... FROM systemnote WHERE recordid = ? AND field = ?` (Full Tools
  `set_field_values/`). **S**
- "Open Setup" link: map id prefix to `/app/common/custom/{body,column,entity,item}custfield.nl`
  (TDT `content.js:17809+`). **S**
- Right-click Field Actions: toggle editable / mandatory, set value with type coercion, list options
  (Consultants `field-ops.js`). We already have set-value; the toggles are new. **M**
- Show IDs for sublist columns via `window.machines[x].dataManager.fields` (SuiteAdvanced func 10). **S**

### 4. Script operations
- Execute Scheduled / Map-Reduce from the deployment page: click
  `NLMultiButton_doAction("submitexecute")` in a hidden iframe, then poll
  `scheduledscriptinstance` (Full Tools `script_execute/`; SuiteAdvanced). **M**
- Script Manager: snapshot `isdeployed/status/loglevel`, mass update via `record.submitFields` on
  `scriptdeployment`, rollback from snapshot (Consultants `script-manager.js`). **M**
- Runtime Heatmap over 4 weeks of execution data (SuiteAdvanced). **M**
- Server log search across scripts: N/search on `scriptexecutionlog` with `contains` (Consultants
  `sw:451`). **S-M**
- Script Analysis for 2028.2 SS1 retirement: SuiteQL `script` + `file`, header scan for
  `@NApiVersion`, bundle attribution by folder (Consultants `analysis/script-analysis.js`). **M**

### 5. Environment awareness (extend `account-color` / `better-page-titles`)
- PROD / SB1-5 pill from hostname regex `^(\d+)(?:-(?:sandbox|sb)?(\d+))?\.`, `[SB1]` title prefix,
  role-menu grouping (TDT `content.js:15962`). **S**
- Sandbox refresh date in the logo via `loginaudit` SuiteQL, env favicons, Release Preview banner
  (SuiteAdvanced). **S**
- Tabs grouped by account with `tabGroups`, env badge on the toolbar icon, session-return after
  re-login (Full Tools). **S-M**

### 6. Navigation and finding things (extend `nav-search`)
- Global-search prefixes: `customscript_x` resolves to its record via per-prefix SuiteQL,
  `search:123`, `bundle:123`, `path:` (SuiteAdvanced). **S**
- Customization Finder: one SuiteQL fan-out over `script`, `workflow`, `customfield`,
  `savedsearch`, `file`, `customrecordtype` (Full Tools; Consultants Finder). **M**
- Go to Record by `tranid` (Full Tools). **S**
- Command palette with recents and pins (TDT, Full Tools). **S**

### 7. Transactions (extend `transaction-tree`)
- Transaction Trail breadcrumb chips at the top of the page (PO -> Bill -> Payment), hover preview
  (TDT `content.js:7426`). Reuse our existing tree data. **S**
- Single `CONNECT BY` query over `nexttransactionlink` for the related tree (SuiteAdvanced func 25).
- Line/column internal id badges on sublist headers with click-to-copy (TDT `content.js:17752`). **S**

### 8. Small page helpers
- Portlet refresher: dispatch `click` on `.ns-portlet-icon-refresh[data-action="refresh"]` on a
  timer from a content script on `/app/center/card*` (Portlet Refresher `background.js:1-20`). **S**
- Live View auto-refresh for lists / exec logs: fetch `?ifrmcntnr=T` and swap `table#div__body`
  (SuiteAdvanced). **S**
- Dataset -> SuiteQL: page-world `N/query.load(id).toSuiteQL()` on workbook/dataset pages
  (SuiteAdvanced func 35). **S**
- Batch search filters: MAIN-world wrap of `doServerSort` / `appendFormDataToURL` to defer reloads
  (Full Tools `search_filters_batch_page.js`). **S**
- Bulk Summary Type on saved search results (SuiteAdvanced, Full Tools). **S**
- Search Fields Finder overlay on the giant field `<select>` pickers (Full Tools). **S**
- Enable Features / Set Preferences / Company Info CSV export (SuiteAdvanced). **S**
- Formula `{field}` autocomplete with joins (SuiteAdvanced via Tribute.js, Full Tools). **M**

### 9. Larger items, hold for now
- File Cabinet drag-drop upload, zip download via `CompressionStream`, row quick actions
  (SuiteAdvanced, Full Tools). **L**
- Form Customization reorder / bulk edit through `window[list+"_machine"].moveline` (Consultants). **M-L**
- Batch Delete via `record.delete.promise` in a reloadable iframe (Consultants). **L**, destructive.
- Full SuiteScript console REPL with `new Function` and write confirmation (Full Tools). **M**,
  conflicts with our no-eval posture for the Web Store.
- PDF template live preview / FreeMarker autocomplete (Full Tools). **M**
- Screenshot Studio with stitched full-page capture and privacy masks, tab recording (TDT). **M**
- Dark mode / theming of NetSuite itself (SuiteAdvanced, Full Tools). **L**

## Things NOT to copy
- SuiteAdvanced auto-executes JS/CSS from File Cabinet folder `SuiteScripts/SuiteAdvanced` and loads
  a query library from S3: supply-chain exposure. Also posts user email to a Google Apps Script.
- Portlet Refresher injects an upsell banner and a PayPal tracking pixel.
- Full Tools ships LLM tools (`update_record`, `run_suitescript`) that let a model mutate data.
- Several rely on undocumented endpoints (`nlapijsonhandler.nl`, `PlatformClientScriptHandler.nl`,
  `NLNavMenuData.nl`); treat `rcendpoint.nl` as the one worth the brittleness.
- TDT executes NetSuite inline `onclick` strings with `new Function` and hard-codes a customer's
  `custbody5` ids.

## Suggested first batch for TactaSuite (all S, no new permissions)
1. Environment pill + `[SBn]` title prefix (fold into `account-color` / `better-page-titles`).
2. Field history row in the Field Explorer card (one `systemnote` query).
3. Transaction Trail chips (reuse `transaction-tree` data).
4. Dataset -> SuiteQL button on dataset / workbook pages.
5. `customscript_*` / `customrecord_*` id lookup in `nav-search`.
6. Saved queries + JSON export in `suiteql-runner`.
7. Portlet refresher toggle.

Second batch (M): Records Catalog autocomplete + schema browser for SuiteQL, Record Scripts panel,
Record Logs Viewer, Execute Scheduled / Map-Reduce with progress, Customization Finder.

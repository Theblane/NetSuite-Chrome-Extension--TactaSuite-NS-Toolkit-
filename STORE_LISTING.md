# Chrome Web Store Submission Notes

Reference material for submitting **NetSuite TactaSuite** to the Chrome Web Store. Everything below is copy-paste-ready for the CWS developer dashboard, except the image assets, which still need to be captured by hand (see the Screenshots Checklist).

**Publisher:** Blane Maher (use the Blane Maher–owned developer account)
**Category suggestion:** Developer Tools (or Productivity if Developer Tools isn't available for the listing region)
**Visibility:** Unlisted is recommended unless you specifically want this discoverable in CWS search.

---

## Single Purpose Description

> NetSuite developer and administrator productivity tools - adds field inspection, search export, script analysis, and other in-page utilities to NetSuite pages so admins and developers can work faster.

Single-purpose statements that mention "and 30+ productivity tools" or read like a feature dump have a higher chance of CWS rejection. Lead with the *purpose*; let the listing description enumerate features.

---

## Short Description (max 132 chars)

> NetSuite admin and developer toolkit: field explorer, SuiteQL runner, screenshots with privacy masks.

(101 characters.)

---

## Detailed Description

> **NetSuite TactaSuite** is a unified Chrome extension that adds developer and admin productivity tools to NetSuite (`*.netsuite.com`). It replaces a dozen single-purpose extensions with one curated, themeable toolkit.
>
> **Getting started**
> Installing opens nothing extra. The toolkit starts on the User preset; open the popup's gear menu to switch to Developer, run the optional setup walkthrough, or export your settings to share with your team. Change any toggle and the preset shows as Custom.
>
> **Developer features**
> • Field Explorer - inspect every field on a record: IDs, types, values, sublist columns, change history.
> • SuiteQL Runner - run SuiteQL queries with a built-in editor, history, saved queries, sortable results, CSV and JSON export.
> • Script Analyzer - see deployed scripts on the current record with entry points, usage, and governance.
> • Script Explorer - browse all scripts and deployments in your account.
> • Script Content Search - search SuiteScript files by source text; inspect module, record, field, and file references.
> • Console Tools - `window.TactaNSKit` helpers for current-record updates and inspection.
> • Record Object Viewer - view the raw `nlapiGetFieldValue` / `currentRecord` object as JSON.
>
> **Search features**
> • SuiteScript Exporter - export saved search, dataset, and workbook pages to SuiteScript 2.x TypeScript scaffolds.
> • Saved Search Export - one-click CSV/JSON download from visible saved search results.
> • Field Finder - quick-filter search columns and criteria fields by ID or label.
> • Quick Search Creation - shortcut buttons for common saved-search templates.
>
> **Record features**
> • Field Help Tooltips - enhanced field popups (field ID, value, select options, change history).
> • Transaction Tree - visualize SO → IF → INV chains as an interactive tree.
> • Transaction Trail - breadcrumb chips of the related-transaction chain at the top of every transaction.
> • Audit Trail - the record's full system-notes history, sortable and exportable.
>
> **Layout features**
> • Split View - open the current page side-by-side with itself.
> • Fixed Headers - keep sublist headers pinned when scrolling.
> • Instant UI - remove NetSuite's fade-ins and transitions so the interface responds immediately.
>
> **Misc features**
> • Account Color and Environment Badge - color-code the header and label every tab PROD, SB1, SB2 so environments never look alike.
> • Screenshot Studio - visible, full-page or record-area captures with one-click privacy masks for emails, phone numbers, tax ids, card numbers and amounts.
> • Navigation Search - keyboard-driven fuzzy search across menu items (Ctrl+Shift+K); paste a script or record id to open it.
> • Portlet auto-refresh, Dataset to SuiteQL, CSV Template Generator, Search URL Builder, PDF Template Tools, CSV Import Viewer, Workflow Colors, Better Page Titles.
>
> **Beta feature: Claude Desktop Bridge (off by default)**
> An off-by-default feature lets a desktop MCP client you run (such as Claude Desktop) query your live NetSuite session through the extension, using your signed-in browser tab. No NetSuite setup, no OAuth, no role switch. It connects only to a small companion program on your own computer over `127.0.0.1`, is read-only by default, and never contacts the developer or any third party. Leave it off and the extension makes no network calls at all.
>
> **Privacy first**
> No analytics. No data collection. No calls to the developer. All settings live in `chrome.storage.local` on your machine. By default the extension makes no outbound network calls; the only connection it can make is the optional local bridge above, to `127.0.0.1` on your own computer. See PRIVACY.md in the project source for details.
>
> **Modes**
> A built-in "Meeting Mode" toggle suppresses every visual modification at once so the UI looks stock during screen shares.
>
> Open-source under the MIT License. Author: Blane Maher.

---

## Permission Justifications

Paste each into the matching field on the CWS **Privacy practices** tab.

### `storage`

> Stores feature toggle states, theme, color, panel layout, and SuiteQL query history in `chrome.storage.local` so the user's preferences persist across page loads and browser restarts. No data is transmitted off-device.

### `activeTab`

> Reads the current tab's URL only when the user clicks the extension action, so the popup can detect whether the active NetSuite page is production or sandbox and which page type (record, search, script, dashboard) is loaded. No tab content is exfiltrated.

### `scripting`

> Injects feature content scripts and CSS into the active NetSuite tab on demand - for example, when the user opens the Field Explorer or SuiteQL Runner from the popup. Without `scripting`, popup-triggered features cannot reach the page DOM. Scripts run only on `*.netsuite.com` tabs.

### `declarativeContent`

> Used to display the extension action icon **only on `*.netsuite.com` pages**, so the icon is hidden on every other site. This reduces visual noise and signals to the user that the extension does not act outside NetSuite.

### `contextMenus`

> Adds a right-click menu item ("Open in Split View") that appears only on `*.netsuite.com` pages. The menu lets users open the current page or a link in a side-by-side split pane without leaving NetSuite.

### `alarms`

> Runs a periodic reconnect check (once per minute) for the Claude Desktop Bridge beta feature, so that if the local companion is started after the service worker went idle, the extension reconnects to it. Used for nothing else. If the bridge is left disabled, the alarm simply does nothing.

### Host permission: `https://*.netsuite.com/*`

> NetSuite assigns each customer account a unique subdomain - for example `1234567.app.netsuite.com`, `1234567-sb1.app.netsuite.com`, `system.netsuite.com`. Because the user's account ID is variable and unknown at install time, the extension must use a wildcard host permission to function across the user's production account, sandbox accounts, and the shared system subdomain. The extension declares host access for `https://*.netsuite.com/*` and `https://*.oracle.com/*` only.

### Optional host permission: `http://127.0.0.1/*`

> Not granted at install time. Requested only if the user enables the Claude Desktop Bridge beta feature, and used only to connect to a companion program on the user's own machine over loopback (`127.0.0.1`). The extension never connects to any remote `http://` origin; this permission exists solely for the local, user-initiated bridge.

---

## Remote Code Declaration

CWS asks whether the extension uses remote code (eval, remote scripts, etc.). Answer: **No**.

> All code shipped with this extension runs from local files included in the package. There is no `eval()`, no `new Function()`, no remote script loading, and no remotely hosted modules. The extension never downloads or executes code. The optional Claude Desktop bridge connects only to a loopback companion on the user's own machine and does not fetch or run any remote code. (The companion program under `companion/` runs separately under the user's own Node.js runtime; the extension does not load or execute it.)

---

## Data Use Declarations (Privacy Practices tab)

For each item below, check **"I do not collect this"** unless noted otherwise.

| Category | Selection | Notes |
|---|---|---|
| Personally identifiable information | Not collected | The extension stores no PII. |
| Health information | Not collected | |
| Financial / payment information | Not collected | Extension reads NetSuite pages locally, but does not transmit. |
| Authentication information | Not collected | No login flow. |
| Personal communications | Not collected | |
| Location | Not collected | |
| Web history | Not collected | The extension's content scripts run only on `*.netsuite.com` - no other browsing data is read. |
| User activity | Not collected | No clickstream or interaction logging is captured or sent. |
| Website content | Not collected | DOM is read inside NetSuite pages purely to render features locally. Nothing is uploaded to any remote server. If the user enables the Claude Desktop Bridge beta feature, NetSuite query/record data is passed to a companion on the user's own machine (loopback `127.0.0.1`) and on to the user's own MCP client; it is not transmitted off-device by the extension. |

Also affirm:
- ☑ I do not sell or transfer user data to third parties.
- ☑ I do not use or transfer user data for purposes unrelated to the item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** `https://github.com/Theblane/TactaSuiteNSToolkit/blob/main/PRIVACY.md` (once the repo is pushed and public). CWS requires a reachable URL, so push before submitting.

---

## Screenshots Checklist

CWS requires at least **one** screenshot, allows up to **five**, and the dashboard expects **1280×800** PNG (preferred) or 640×400. Capture all five for a polished listing.

For each shot: open the extension in Chrome on a real NetSuite sandbox page, take a full-window screenshot, then crop or pad to 1280×800. Do **not** include any production data, customer names, or internal IDs - use a sandbox with anonymized records.

| # | Filename suggestion | What to capture | Framing notes |
|---|---|---|---|
| 1 | `screenshot-1-popup.png` | The extension popup open on a NetSuite record page. | Show the popup at default size with a few features visible in the list. Pick a recognizable NetSuite page (e.g., Sales Order) for context. Make sure the environment dot (sandbox/production) is visible. |
| 2 | `screenshot-2-field-explorer.png` | Field Explorer panel open on a Sales Order or Customer record. | The panel should be docked or floating with at least 10 fields visible - show field ID, type, value columns. |
| 3 | `screenshot-3-suiteql-runner.png` | SuiteQL Runner with a sample query and results rendered. | Use a benign query like `SELECT id, tranid, trandate FROM transaction WHERE rownum <= 10`. Show the results table and the "Export CSV" button. |
| 4 | `screenshot-4-saved-search-export.png` | A NetSuite saved search results page with the export toolbar visible. | Capture the CSV / JSON / Copy buttons injected above the results table. Use a sandbox saved search. |
| 5 | `screenshot-5-options.png` | The full-page Options screen. | Show the feature toggles section and at least one settings section (Theme or Quick Search). Title bar should say "NetSuite TactaSuite - Settings". |

**Format & safety**
- File type: PNG, 24-bit (or JPG if file size matters).
- Crop precisely to 1280×800. Avoid the browser chrome unless it's relevant; bordering with the extension's dark theme background is fine if you want padding.
- Redact account IDs, customer names, internal item codes - anything proprietary.
- Avoid showing other extensions' icons in the toolbar.

Save the final files inside the project under `store-assets/screenshots/` so they're versioned alongside the listing.

---

## Promo Tiles

CWS accepts three promo tile sizes. **Small** is the only required-ish one; the others improve discoverability if you eventually move from Unlisted to Public.

| Tile | Dimensions | Required? | Purpose |
|---|---|---|---|
| Small promo tile | **440 × 280** | Strongly recommended | Shown on the store category cards. Make this one first. |
| Marquee promo tile | 1400 × 560 | Optional | Used by the CWS editors when a listing is featured. Worth having. |
| Large promo tile | 920 × 680 | Deprecated, ignore | CWS no longer surfaces this. |

**Design direction**
- Background: solid `#1a1a1a` (the TactaSuite dark tone) or a subtle gradient toward `#222222`.
- Primary accent: `#76c043` (the TactaSuite green) - use sparingly: logo mark, headline underline, a single highlight.
- Logo mark: a green `#76c043` rounded square containing a bold white **T**, sized about 88px tall on the 440×280 tile. The popup header uses the same mark - match its proportions.
- Headline copy (440×280): **NetSuite TactaSuite** on one line, white, semibold, ~28px.
- Sub-copy (440×280): "NetSuite developer & admin productivity, all in one." white at 60% opacity, ~14px.
- Optional: a faint outline of a NetSuite page or a stylized SQL/JSON snippet behind the text, kept at low opacity so the headline stays legible.
- No customer or company names, no NetSuite logo, no Chrome logo.

Save the final files as:
- `store-assets/promo/promo-small-440x280.png`
- `store-assets/promo/promo-marquee-1400x560.png`

---

## Listing Icon (128×128)

You already have `icons/icon128.png` in the extension. CWS will pull it from `manifest.json` automatically - no separate upload needed. If you want a different icon for the store listing, upload it on the **Store listing** tab; otherwise leave it as-is.

---

## Pre-submission Checklist

- [ ] Publishing under the Blane Maher–owned developer account (not a personal Google account).
- [ ] Version in `manifest.json` matches the version you intend to submit (currently `1.7.0`).
- [ ] Zip the **`TactaSuiteNSToolkit/`** folder contents at the root (do not nest inside another folder when zipping). Test the zip by unpacking it and loading it via `Load unpacked` before uploading.
- [ ] `PRIVACY.md` is hosted at a public URL.
- [ ] Five 1280×800 screenshots saved under `store-assets/screenshots/`.
- [ ] 440×280 small promo tile saved under `store-assets/promo/`.
- [ ] Permission justifications above pasted into the **Privacy practices** tab.
- [ ] Data use declarations completed (all "Not collected" plus the three "do not" affirmations).
- [ ] Single-purpose statement set on the **Store listing** tab.
- [ ] Distribution set to **Unlisted** unless you specifically want public discovery.
- [ ] LICENSE, README.md, PRIVACY.md present in the project root (already done).

---

## Post-submission

- First review typically takes a few days. Re-submissions are usually faster.
- Bump `version` in `manifest.json` for every resubmit - CWS treats each version as a separate review.
- If CWS asks for clarification on a permission, point them to this file's **Permission Justifications** section.

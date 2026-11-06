# Privacy Policy - NetSuite TactaSuite

**Author:** Blane Maher
**Last updated:** 2026-10-22

## Summary

NetSuite TactaSuite ("the extension") does not collect, transmit, or sell any user data, and never contacts any server controlled by the developer. All settings and state are stored locally on your device. There are no analytics, no telemetry, and no AI feature inside the extension.

By default the extension makes no outbound network calls of any kind. It includes one **beta, off-by-default** feature - the Claude Desktop Bridge - that, only when you explicitly enable it, opens a connection to a companion program running on your own computer over the loopback address `127.0.0.1`. See "Optional: Claude Desktop bridge" below. Even then, nothing is sent to the developer or to any third-party server by the extension.

## What the extension stores

The extension stores the following information **locally** in `chrome.storage.local`. This data never leaves your device.

| Stored item | Purpose |
|---|---|
| Feature toggle states (on/off per feature) | Remember which features you have enabled. |
| User type preset (`user`, `developer` or `custom`) | Apply the matching default feature set; `custom` marks hand-tuned toggles. |
| Onboarding progress and completion flag | Resume or re-run the setup walkthrough. |
| Meeting Mode flag | Suppress visual modifications during screen shares. |
| Panel position and size for the SuiteQL Runner | Restore window state across page loads. |
| SuiteQL query history and saved queries | Recall recent and named queries in the SuiteQL Runner. |
| Portlet auto-refresh interval, environment badge preferences | Remember small per-feature preferences. |
| Quick Search type selections | Remember which search types you have enabled in the Quick Search toolbar. |
| Theme settings (color scheme, accent color) | Apply your chosen visual theme. |
| Account Color settings (production / sandbox colors) | Color-code the NetSuite header per environment. |
| Generic UI state (group collapse, "close on click outside") | Remember UI preferences. |

## What the extension reads from NetSuite

The extension's content scripts run only on `*.netsuite.com` pages, and only to render the features documented in the [README](./README.md). It reads:

- The current page URL (to detect production vs. sandbox and which page type is loaded).
- DOM content of the current NetSuite page (to inspect fields, sublist rows, search results, etc., for the features you have enabled).
- NetSuite's own JavaScript APIs (`require`, `nlapi*`, `currentRecord`) where applicable, for features such as Field Explorer, Record Object Viewer, SuiteQL Runner, and Saved Search Export.

Unless you enable the Claude Desktop Bridge beta feature (below), this information is processed entirely inside your browser and never transmitted anywhere.

## Beta feature: Claude Desktop Bridge (off by default)

The extension includes a beta feature, **off by default**, that lets a desktop MCP client you run (such as Claude Desktop) query your live NetSuite session through the extension. You can see and control it under **Options -> Claude Desktop Bridge**. A **Sandbox only** switch (off by default) restricts it to sandbox tabs.

How it works and what it means for your data:

- The feature does nothing until you turn it on. Turning it on requires you to generate a pairing token and approve an optional permission for `http://127.0.0.1/*` (loopback).
- When enabled, the extension connects **outbound to your own computer only**, over the loopback address `127.0.0.1`, to a companion program that you install and that your MCP client launches. This connection never leaves your machine and never reaches the developer or any third-party server.
- Access is **read-only by default**: only `SELECT` / `WITH` SuiteQL queries are allowed. SuiteQL cannot modify records, and no write tools exist in this beta. The "Allow write actions" toggle (off by default) is reserved for future tools and carries an explicit warning.
- Through the bridge, your MCP client can request NetSuite data (query results, the current page, the current record's fields). That data is returned to the MCP client **you chose to run**. Any onward transmission (for example, your MCP client sending a result to its own model provider) is performed by that client, not by this extension, and is governed by that client's own privacy terms. The extension itself sends nothing beyond your loopback companion.
- The connection is secured by binding to `127.0.0.1` only, a shared pairing token, and an extension-origin check.

If you never enable this feature, the extension behaves exactly as described elsewhere in this document and makes no outbound network calls.

## Send feedback form

The popup and Options page include a **Send feedback** form. It does not transmit anything itself: when you submit it, it opens your own email program (or a GitHub issue page) with the message filled in, and nothing is sent until you press Send there. You can see and edit the full message first. Including the current NetSuite page address and technical details (extension version, browser version, which features are on) is optional and controlled by checkboxes on the form.

## What the extension does NOT do

- It does **not** make any network requests to the extension developer, ever.
- It does **not** make any network requests to third-party analytics, telemetry, error-tracking, or advertising services.
- It does **not** send your data to any server on the internet. The only outbound connection it can make is to a companion on your own computer (`127.0.0.1`), and only if you enable the Claude Desktop Bridge beta feature.
- It does **not** collect personally identifiable information.
- It does **not** collect, share, or sell browsing history, NetSuite data, or any other user content.
- It does **not** modify or transmit NetSuite records on its own initiative - every NetSuite write (e.g., saved search creation, field updates from Field Explorer) is initiated by an explicit user action.

## Network access

The extension's `manifest.json` requests host access for `https://*.netsuite.com/*` and `https://*.oracle.com/*`. NetSuite uses per-account subdomains (for example `1234567.app.netsuite.com`), so the wildcard is required for the extension to function.

The manifest declares one **optional** host permission, `http://127.0.0.1/*`, which is not granted at install time. It is requested only if you choose to enable the Claude Desktop bridge, and it allows the extension to reach the companion program on your own machine. Apart from that optional loopback connection, the extension makes no outbound network calls to any origin; everything else it does happens inside the NetSuite page in your browser.

## Permissions

See [README.md](./README.md#permissions) for the full list of Chrome permissions and what each is used for.

## Data export and deletion

All extension data lives in `chrome.storage.local`. You can:

- **Export** your settings via the **Export** button on the options page (downloads a JSON file).
- **Reset to defaults** via the options page (clears feature toggle preferences).
- **Remove everything** by uninstalling the extension from `chrome://extensions`. Chrome clears all associated `chrome.storage.local` data automatically on uninstall.

## Changes

If this policy changes in a future version, the updated text will be published in this file and the **Last updated** date will be revised.

## Contact

For questions or concerns about privacy, open an issue on the project's source repository.

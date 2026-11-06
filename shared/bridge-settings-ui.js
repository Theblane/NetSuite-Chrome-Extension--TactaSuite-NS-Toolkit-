/**
 * NetSuite TactaSuite - Claude Desktop Bridge settings UI (beta feature)
 *
 * @author Blane Maher
 *
 * Self-contained settings card. Renders into #bridgeCard (options page) if
 * present. Talks to the service worker via chrome.runtime messages:
 *   getBridgeSettings / setBridgeSettings / generateBridgeToken / getBridgeStatus
 *
 * The companion itself (companion/tacta-bridge.mjs) is installed and launched
 * by the user's Claude Desktop app; this card walks a non-technical user
 * through that setup, produces the config block and the pairing token, and
 * holds the on/off switch plus the safety settings.
 *
 * Card order (deliberate): setup steps first, then the switch and settings,
 * then "test it yourself", troubleshooting and questions.
 */
(function () {
  'use strict';

  const CARD_ID = 'bridgeCard';
  const LOOPBACK_ORIGIN = 'http://127.0.0.1/*';
  const SERVER_KEY = 'netsuite-tactasuite';
  // Companion is distributed with the source, not inside the installed
  // extension (the browser cannot drop a file on disk or run Node). Users
  // download the single zero-dependency file from the public repo. The
  // releases/latest/download URL serves the asset with an attachment header,
  // so it downloads directly rather than opening in a browser tab.
  const COMPANION_DL_URL = 'https://github.com/Theblane/TactaSuiteNSToolkit/releases/latest/download/tacta-bridge.mjs';
  const COMPANION_VIEW_URL = 'https://github.com/Theblane/TactaSuiteNSToolkit/blob/main/companion/tacta-bridge.mjs';
  const NODE_DL_URL = 'https://nodejs.org/en/download';

  function send(action, extra) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, ...(extra || {}) }, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function statusBadge(status) {
    const map = {
      connected: ['Connected', 'ok'],
      connecting: ['Connecting…', 'warn'],
      reconnecting: ['Waiting for the companion…', 'warn'],
      stopped: ['Off', 'off'],
      error: ['Not connected', 'err']
    };
    const [label, kind] = map[status.state] || ['Unknown', 'off'];
    return '<span class="tacta-br-badge tacta-br-badge-' + kind + '">' + esc(label) + '</span>';
  }

  /* ── Config snippet ──────────────────────────────────────────────── */

  function serverEntry(settings, extId) {
    const nodeCmd = (settings.nodePath || '').trim() || 'node';
    const companion = (settings.companionPath || '').trim() || 'C:\\Users\\YOURNAME\\TactaSuite\\tacta-bridge.mjs';
    return {
      command: nodeCmd,
      args: [companion],
      env: {
        TACTA_BRIDGE_TOKEN: settings.token || 'GENERATE A TOKEN FIRST',
        TACTA_BRIDGE_PORT: String(settings.port || 8787),
        TACTA_BRIDGE_EXT_ID: extId || ''
      }
    };
  }

  /** Whole-file version: for an empty config file. */
  function fullSnippet(settings, extId) {
    return JSON.stringify({ mcpServers: { [SERVER_KEY]: serverEntry(settings, extId) } }, null, 2);
  }

  /** Inner version: just the one server, to paste inside an existing "mcpServers". */
  function innerSnippet(settings, extId) {
    const text = JSON.stringify({ [SERVER_KEY]: serverEntry(settings, extId) }, null, 2);
    // Strip the outer braces so the user pastes only the entry.
    return text.split('\n').slice(1, -1).map((l) => l.replace(/^  /, '')).join('\n');
  }

  /* ── Account lock + write permission section ─────────────────────── */

  function accountLockSection(settings, accountsIn) {
    const accounts = (accountsIn || []).slice();
    const lockedId = settings.lockedAccountId || '';
    const lockedLabel = settings.lockedAccountLabel || lockedId;
    const multi = !!settings.multiAccount;

    // Keep the locked account visible even if it has no open tab right now.
    if (lockedId && !accounts.some((a) => a.key === lockedId)) {
      accounts.unshift({ key: lockedId, label: lockedLabel + ' (no open tab)', env: '', tabs: 0 });
    }

    const placeholder = accounts.length ? 'Select an account' : 'No active NetSuite instances found';
    const options =
      '<option value="">' + esc(placeholder) + '</option>' +
      accounts.map((a) =>
        '<option value="' + esc(a.key) + '"' + (a.key === lockedId ? ' selected' : '') + '>' +
          esc(a.label) + (a.tabs ? ' (' + a.tabs + ' tab' + (a.tabs === 1 ? '' : 's') + ')' : '') +
        '</option>'
      ).join('');

    const writesDisabled = multi || !lockedId;

    return (
      '<div class="tacta-br-row">' +
        '<span class="tacta-br-label">Select eligible NetSuite Account</span>' +
        '<span class="tacta-br-hint">Select the account you\'d like active. Claude only acts on this account, and the choice stays after you close the tab until you refresh this list and pick another.</span>' +
        '<div class="tacta-br-inline">' +
          '<select id="brLockAccount" class="tacta-br-input"' + (multi ? ' disabled' : '') + '>' + options + '</select>' +
          '<button type="button" class="tacta-opt-btn tacta-opt-btn-secondary" id="brRefreshAccounts">Refresh list</button>' +
        '</div>' +
      '</div>' +

      '<div class="tacta-br-row tacta-br-row-toggle">' +
        '<div>' +
          '<span class="tacta-br-label">Keep tool active across multiple accounts</span>' +
          '<span class="tacta-br-hint">When on, Claude can use any open NetSuite tab instead of a single locked account. Writes are forced off in this mode.</span>' +
        '</div>' +
        '<label class="tacta-toggle">' +
          '<input type="checkbox" id="brMultiAccount"' + (multi ? ' checked' : '') + '>' +
          '<span class="tacta-toggle-track"></span>' +
        '</label>' +
      '</div>' +

      '<div class="tacta-br-row tacta-br-row-toggle">' +
        '<div>' +
          '<span class="tacta-br-label">Allow writes' + (lockedId && !multi ? ' (' + esc(lockedLabel) + ')' : '') + '</span>' +
          '<span class="tacta-br-hint">Off = read only. When on, Claude can create and update records in the locked account only. Lock onto one account (multi-account off) to enable this.</span>' +
          '<span class="tacta-br-warn"><strong>WARNING: if you turn this on, you accept that any change Claude makes in this NetSuite account is your responsibility. ' +
            'This is a beta feature driven by AI. The author is not responsible for any data changes, errors, or losses that result. Use at your own risk.</strong></span>' +
        '</div>' +
        '<label class="tacta-toggle">' +
          '<input type="checkbox" id="brAllowWrites"' + (settings.allowWrites && !writesDisabled ? ' checked' : '') + (writesDisabled ? ' disabled' : '') + '>' +
          '<span class="tacta-toggle-track"></span>' +
        '</label>' +
      '</div>'
    );
  }

  /* ── Render ──────────────────────────────────────────────────────── */

  function render(container, data) {
    const { settings, status, extensionId } = data;
    const token = settings.token || '';
    const port = settings.port || 8787;
    const companionShown = (settings.companionPath || '').trim() || 'C:\\Users\\YOURNAME\\TactaSuite\\tacta-bridge.mjs';
    const nodeShown = (settings.nodePath || '').trim() || 'node';

    // Preserve the setup block's open/closed state across re-renders. A settings
    // change rebuilds this whole card, so without this the box would snap back
    // to its default every time a toggle fires. First render: start collapsed.
    const prevSetup = container.querySelector('#brSetup');
    const setupWasOpen = prevSetup ? prevSetup.open : false;

    container.innerHTML =

      /* ── 1. Setup ─────────────────────────────────────────────── */
      '<details class="tacta-br-setup" id="brSetup">' +
        '<summary>Step-by-step setup (do this once)</summary>' +

        '<p class="tacta-br-p">You need two things on your computer: <strong>Node.js</strong> (a free program that runs the companion) ' +
          'and the <strong>companion file</strong> itself. Then you tell Claude Desktop where they are. ' +
          'Plan on about 10 minutes.</p>' +

        '<ol class="tacta-br-steps">' +

          /* Step 1: Node */
          '<li><strong>Check for Node.js, or install it.</strong>' +
            '<div class="tacta-br-sub">' +
              '<p>Open <strong>Command Prompt</strong> (press the Windows key, type <code>cmd</code>, press Enter) and run:</p>' +
              '<pre class="tacta-br-cmd">where node</pre>' +
              '<p>If it prints a path such as <code>C:\\Program Files\\nodejs\\node.exe</code>, Node is installed and you can skip to step 2. ' +
                'If it says <em>INFO: Could not find files</em>, install Node:</p>' +
              '<p><strong>You can install programs on this PC (you get the admin prompt and can approve it):</strong></p>' +
              '<pre class="tacta-br-cmd">winget install OpenJS.NodeJS.LTS</pre>' +
              '<p><strong>You are not an administrator:</strong> use the standalone .zip, which needs no installer and no admin rights.</p>' +
              '<ol class="tacta-br-substeps">' +
                '<li>Go to <a href="' + NODE_DL_URL + '" target="_blank" rel="noreferrer">nodejs.org/en/download</a>. Make sure <strong>Windows</strong> is selected, then download the <strong>Standalone Binary (.zip)</strong>, 64-bit. Do <strong>not</strong> download the .msi installer.</li>' +
                '<li>Right-click the downloaded .zip, choose <strong>Extract All</strong>, and extract to a folder you own, for example <code>C:\\Users\\YOURNAME\\Documents\\nodejs</code>. ' +
                  'Open that folder and find <code>node.exe</code>. It may be one level down, in a folder named like <code>node-v26.13.0-win-x64</code>. Copy the address of the folder that contains <code>node.exe</code> from the address bar.</li>' +
                '<li>Add that folder to your own PATH (no admin needed): press <strong>Windows key + R</strong>, type <code>rundll32 sysdm.cpl,EditEnvironmentVariables</code> and press Enter. ' +
                  'In the top section, <em>User variables</em>, click <strong>Path</strong>, then <strong>Edit</strong>, then <strong>New</strong>, paste the folder address, and click <strong>OK</strong> on every window.</li>' +
                '<li>Open a <strong>new</strong> Command Prompt and run <code>node -v</code>. It should print a version number such as <code>v26.13.0</code>.</li>' +
              '</ol>' +
              '<p class="tacta-br-hint">If <code>node -v</code> still says not recognized, the PATH entry points to the wrong folder; it must be the folder that contains <code>node.exe</code>. ' +
                'You can also skip PATH entirely and paste the full path to <code>node.exe</code> in step 3 below. Either way, fully quit and reopen Claude Desktop afterwards so it sees the change.</p>' +
            '</div>' +
          '</li>' +

          /* Step 2: companion */
          '<li><strong>Download the companion file.</strong>' +
            '<div class="tacta-br-sub">' +
              '<div class="tacta-br-download">' +
                '<a class="tacta-opt-btn tacta-opt-btn-primary" id="brDownload" href="' + esc(COMPANION_DL_URL) + '" download="tacta-bridge.mjs" target="_blank" rel="noreferrer">Download tacta-bridge.mjs</a>' +
                '<span class="tacta-br-hint">One small file, nothing to install. You can <a href="' + esc(COMPANION_VIEW_URL) + '" target="_blank" rel="noreferrer">read its source on GitHub</a>.</span>' +
              '</div>' +
              '<p>Move it out of Downloads into a folder that will not change, for example <code>C:\\Users\\YOURNAME\\TactaSuite\\</code>. ' +
                'Then copy its full path: hold <strong>Shift</strong>, right-click the file, choose <em>Copy as path</em>.</p>' +
            '</div>' +
          '</li>' +

          /* Step 3: paths + token */
          '<li><strong>Tell this page where both files are, then create your pairing token.</strong>' +
            '<div class="tacta-br-sub">' +
              '<p>Paste the two paths below. The config block in step 5 is built from them with the slashes formatted correctly for you.</p>' +
              '<div class="tacta-br-row">' +
                '<label class="tacta-br-label" for="brNodePath">Where is node.exe? (leave as <code>node</code> if <code>where node</code> printed a path)</label>' +
                '<input type="text" id="brNodePath" class="tacta-br-input tacta-br-mono" value="' + esc(settings.nodePath || '') + '" placeholder="node   or   C:\\Users\\YOURNAME\\nodejs\\node.exe">' +
              '</div>' +
              '<div class="tacta-br-row">' +
                '<label class="tacta-br-label" for="brCompanionPath">Where did you save tacta-bridge.mjs?</label>' +
                '<input type="text" id="brCompanionPath" class="tacta-br-input tacta-br-mono" value="' + esc(settings.companionPath || '') + '" placeholder="C:\\Users\\YOURNAME\\TactaSuite\\tacta-bridge.mjs">' +
              '</div>' +
              '<p>The pairing token is a password that only this extension and your companion know. Click <strong>Generate</strong> in the settings below, ' +
                'then click <strong>Allow local connection</strong> and accept the Chrome prompt. Keep the token private.</p>' +
            '</div>' +
          '</li>' +

          /* Step 4: open the Claude config */
          '<li><strong>Open the Claude Desktop config file.</strong>' +
            '<div class="tacta-br-sub">' +
              '<ol class="tacta-br-substeps">' +
                '<li>Open <strong>Claude Desktop</strong>. Click the menu button (three lines) in the top-left corner.</li>' +
                '<li>Choose <strong>Developer</strong>, then <strong>Open App Config File</strong>. The file <code>claude_desktop_config.json</code> opens in your text editor, or its folder opens with the file selected.</li>' +
                '<li>No <strong>Developer</strong> entry in the menu? Choose <strong>Help</strong>, then <strong>Enable Developer Mode</strong>, and look again. ' +
                  'Older versions instead use <strong>File</strong>, <strong>Settings</strong>, the <strong>Developer</strong> tab, then the <strong>Edit Config</strong> button.</li>' +
                '<li>If only the folder opened, right-click the file, choose <strong>Open with</strong>, then <strong>Notepad</strong>.</li>' +
              '</ol>' +
              '<p class="tacta-br-hint">If nothing opens, press Windows key + R, paste <code>%APPDATA%\\Claude</code> and press Enter, and open <code>claude_desktop_config.json</code> from there. ' +
                'On a Mac the file is at <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>.</p>' +
            '</div>' +
          '</li>' +

          /* Step 5: paste */
          '<li><strong>Add the bridge to that file.</strong>' +
            '<div class="tacta-br-sub">' +
              '<p>Look at what is already in the file and pick the matching case:</p>' +

              '<p class="tacta-br-case"><strong>A. The file is empty, or only contains <code>{}</code>.</strong> Delete everything and paste this whole block:</p>' +
              '<div class="tacta-br-snippet-head"><span>Whole file</span>' +
                '<button type="button" class="tacta-opt-btn tacta-opt-btn-secondary" id="brCopyFull">Copy</button></div>' +
              '<pre class="tacta-br-snippet" id="brSnippetFull">' + esc(fullSnippet(settings, extensionId)) + '</pre>' +

              '<p class="tacta-br-case"><strong>B. The file already has text but no <code>"mcpServers"</code> line.</strong> ' +
                'Find the <strong>last</strong> <code>}</code> at the very bottom. Just above it, add a comma to the end of the previous line, press Enter, and paste this:</p>' +
              '<pre class="tacta-br-snippet">' + esc('"mcpServers": {\n' + innerSnippet(settings, extensionId).split('\n').map((l) => '  ' + l).join('\n') + '\n}') + '</pre>' +

              '<p class="tacta-br-case"><strong>C. The file already has <code>"mcpServers": {</code> with other servers inside.</strong> ' +
                'Find the last server entry inside <code>mcpServers</code>. Add a comma after its closing <code>}</code>, press Enter, and paste only this entry:</p>' +
              '<div class="tacta-br-snippet-head"><span>One server entry</span>' +
                '<button type="button" class="tacta-opt-btn tacta-opt-btn-secondary" id="brCopyInner">Copy</button></div>' +
              '<pre class="tacta-br-snippet" id="brSnippetInner">' + esc(innerSnippet(settings, extensionId)) + '</pre>' +

              '<p><strong>Check the two paths.</strong> <code>"command"</code> is <code>' + esc(nodeShown) + '</code> and the file path is ' +
                '<code>' + esc(companionShown) + '</code>. In this file every backslash is written twice (<code>\\\\</code>). ' +
                'That is correct, do not remove them. If <code>node -v</code> is not recognized in a new Command Prompt, <code>"command"</code> must be the full path to <code>node.exe</code>, not just <code>node</code>.</p>' +
              '<p class="tacta-br-hint">Common mistakes: a missing comma between entries, or an extra comma after the last entry. ' +
                'Claude Desktop will refuse to start the bridge if the file is not valid. Save the file when done.</p>' +
            '</div>' +
          '</li>' +

          /* Step 6: restart */
          '<li><strong>Restart Claude Desktop and switch the bridge on.</strong>' +
            '<div class="tacta-br-sub">' +
              '<p>Closing the window is not enough. Right-click the Claude icon in the system tray (bottom-right, near the clock, maybe under the <code>^</code> arrow) and choose <strong>Quit</strong>. Open Claude Desktop again.</p>' +
              '<p>Open a NetSuite tab in Chrome and sign in. Come back here and switch on <strong>Bridge is on</strong> below. ' +
                'Within a few seconds the status shows <strong>Connected</strong>. In Claude Desktop, click the <strong>+</strong> (Add files, connectors, and more) in the chat box, then <strong>Connectors</strong>: <code>netsuite-tactasuite</code> is listed there. Ask Claude something like "what NetSuite page do I have open?" to try it.</p>' +
            '</div>' +
          '</li>' +
        '</ol>' +
      '</details>' +

      /* ── 2. Switch + settings ─────────────────────────────────── */
      '<div class="tacta-br-head">' +
        '<label class="tacta-br-enable">' +
          '<input type="checkbox" id="brEnabled"' + (settings.enabled ? ' checked' : '') + '>' +
          '<span>Bridge is on</span>' +
        '</label>' +
        statusBadge(status) +
      '</div>' +
      (status.lastError && settings.enabled
        ? '<p class="tacta-br-error">' + esc(status.lastError) + '</p>' : '') +
      '<p class="tacta-br-hint">Switch this off at any time to stop Claude from reaching NetSuite. Quitting Claude Desktop also stops it.</p>' +

      '<div class="tacta-br-grid">' +
        '<div class="tacta-br-row">' +
          '<label class="tacta-br-label" for="brToken">Pairing token</label>' +
          '<div class="tacta-br-inline">' +
            '<input type="text" id="brToken" class="tacta-br-input tacta-br-mono" readonly value="' + esc(token) + '" placeholder="No token yet. Click Generate.">' +
            '<button type="button" class="tacta-opt-btn tacta-opt-btn-secondary" id="brGen">Generate</button>' +
            '<button type="button" class="tacta-opt-btn tacta-opt-btn-secondary" id="brCopyToken">Copy</button>' +
          '</div>' +
          '<span class="tacta-br-hint">A password shared between this extension and your companion. If you generate a new one, update the Claude config and restart Claude Desktop.</span>' +
        '</div>' +

        '<div class="tacta-br-row">' +
          '<label class="tacta-br-label" for="brPort">Local port</label>' +
          '<input type="number" id="brPort" class="tacta-br-input tacta-br-port" min="1024" max="65535" value="' + esc(port) + '">' +
          '<span class="tacta-br-hint">Leave at 8787 unless another program uses it. Must match <code>TACTA_BRIDGE_PORT</code> in the Claude config.</span>' +
        '</div>' +

        accountLockSection(settings, data.accounts || []) +
      '</div>' +

      '<div class="tacta-br-actions">' +
        '<button type="button" class="tacta-opt-btn tacta-opt-btn-secondary" id="brGrant">Allow local connection</button>' +
        '<button type="button" class="tacta-opt-btn tacta-opt-btn-secondary" id="brRefresh">Reconnect now</button>' +
      '</div>' +
      '<p class="tacta-br-hint">Extension ID: <span class="tacta-br-mono">' + esc(extensionId) + '</span></p>' +

      /* ── 3. Test + troubleshooting ────────────────────────────── */
      '<details class="tacta-br-setup">' +
        '<summary>Not connecting? Test it yourself and fix common problems</summary>' +

        '<p class="tacta-br-p"><strong>Run the companion by hand.</strong> This proves Node and the file work, separately from Claude Desktop.</p>' +
        '<ol class="tacta-br-steps">' +
          '<li>Fully quit Claude Desktop: right-click its icon in the system tray and choose <strong>Quit</strong>. Otherwise it is already holding port ' + esc(port) + '.</li>' +
          '<li>Open Command Prompt and run these lines one at a time (your real token and paths are filled in):' +
            '<pre class="tacta-br-cmd">set TACTA_BRIDGE_TOKEN=' + esc(token || 'YOUR_TOKEN') + '\n' +
              'set TACTA_BRIDGE_PORT=' + esc(port) + '\n' +
              esc(nodeShown === 'node' ? 'node' : '"' + nodeShown + '"') + ' "' + esc(companionShown) + '"</pre></li>' +
          '<li>You should see:' +
            '<pre class="tacta-br-cmd">[tacta-bridge] tacta-bridge 1.1.0 ready (MCP on stdio).\n[tacta-bridge] loopback bridge listening on 127.0.0.1:' + esc(port) + ' (primary, waiting for extension)</pre>' +
            'Now switch on <strong>Bridge is on</strong> above. The status turns <strong>Connected</strong> and the window prints <code>extension paired</code>. ' +
            'Press <code>Ctrl</code> + <code>C</code> to stop it, then start Claude Desktop again.</li>' +
        '</ol>' +

        '<p class="tacta-br-p"><strong>If that test fails:</strong></p>' +
        '<ul class="tacta-br-list">' +
          '<li><em>\'node\' is not recognized</em>: Node is not on your PATH. Either add its folder to your user PATH (step 1 above) and fully restart Claude Desktop, or use the full path to <code>node.exe</code> in quotes instead of <code>node</code> here and in <code>"command"</code> in the Claude config.</li>' +
          '<li><em>Cannot find module</em>: the path to <code>tacta-bridge.mjs</code> is wrong. Shift + right-click the file and choose <em>Copy as path</em>.</li>' +
          '<li><em>could not listen on 127.0.0.1:' + esc(port) + '</em>: another program owns that port. Change <strong>Local port</strong> above and in the Claude config, then restart Claude Desktop.</li>' +
        '</ul>' +

        '<p class="tacta-br-p"><strong>If the test works but Claude Desktop does not connect:</strong></p>' +
        '<ul class="tacta-br-list">' +
          '<li>The config file has a typo. Paste the whole file into <a href="https://jsonlint.com" target="_blank" rel="noreferrer">jsonlint.com</a> to find it. Missing or extra commas are the usual cause.</li>' +
          '<li>The config was copied from another computer. The node path, the file path, the token and the extension ID are specific to your PC and your Chrome. Use the blocks above, they are built for this machine.</li>' +
          '<li>Claude Desktop was not fully quit. Quit from the system tray, then reopen.</li>' +
          '<li>Claude Desktop keeps a log of the bridge at <code>%APPDATA%\\Claude\\logs\\mcp-server-netsuite-tactasuite.log</code>. The last lines say what went wrong.</li>' +
        '</ul>' +

        '<p class="tacta-br-p"><strong>If Claude says the extension is not connected:</strong></p>' +
        '<ul class="tacta-br-list">' +
          '<li>Open a NetSuite tab and sign in. It must be a tab for the account you selected above, unless you turned on <strong>Keep tool active across multiple accounts</strong>.</li>' +
          '<li>Check that <strong>Bridge is on</strong> is switched on here and the status says Connected. The extension retries about once a minute; click <strong>Reconnect now</strong> to retry immediately.</li>' +
        '</ul>' +
      '</details>' +

      /* ── 4. FAQ ───────────────────────────────────────────────── */
      '<details class="tacta-br-setup">' +
        '<summary>Questions and answers</summary>' +
        '<dl class="tacta-br-faq">' +
          '<dt>What can Claude do with this?</dt>' +
          '<dd>By default, read only: run SuiteQL queries, describe the page you have open, list record fields, read scripts and File Cabinet files, and list open tabs. ' +
            'It can also create and update records, but <strong>only</strong> when you have locked onto a single account and turned on <strong>Allow writes</strong> for it.</dd>' +

          '<dt>Which NetSuite accounts can it reach?</dt>' +
          '<dd>Only the account you <strong>lock onto</strong> in the dropdown above. The lock persists after you close the tab and does not change until you refresh the list and pick a different account. ' +
            'If you turn on <strong>Keep tool active across multiple accounts</strong>, it can use any open NetSuite tab instead - but writes are forced off in that mode.</dd>' +

          '<dt>What permissions does it have in NetSuite?</dt>' +
          '<dd>Exactly yours. It runs inside your signed-in tab, with the role you are logged in as. It cannot see anything you cannot see.</dd>' +

          '<dt>When is it active?</dt>' +
          '<dd>Only when all three are true: <strong>Bridge is on</strong> here, Claude Desktop is running (it starts the companion), and a NetSuite tab is open.</dd>' +

          '<dt>How do I stop it?</dt>' +
          '<dd>Switch off <strong>Bridge is on</strong>. Quitting Claude Desktop also stops the companion. To remove it completely, delete the ' +
            '<code>netsuite-tactasuite</code> entry from the Claude config and delete the companion file.</dd>' +

          '<dt>Is it safe? Does my data leave my computer?</dt>' +
          '<dd>The companion only accepts connections from this computer, and only from this extension with your pairing token. The extension never sends anything to the author or any website. ' +
            'What Claude reads from NetSuite does become part of your Claude conversation, so it is covered by Anthropic\'s privacy terms, the same as anything else you paste into Claude. Do not use it with data you would not paste into a chat.</dd>' +

          '<dt>Does it work with ChatGPT or other AI apps?</dt>' +
          '<dd>Not with ChatGPT today. The ChatGPT desktop app cannot start a local program like this companion. ' +
            'Any app that can run a local "stdio" MCP server works with the same config block, for example Claude Code or Cursor. Only Claude Desktop is tested.</dd>' +

          '<dt>I have several Claude windows or use Cowork. Is that a problem?</dt>' +
          '<dd>No. Claude Desktop may start the companion more than once. The copies coordinate so only one talks to the extension; the others pass their requests through it.</dd>' +

          '<dt>Why does it need Node.js?</dt>' +
          '<dd>Chrome extensions cannot run a program on your PC or accept connections. The companion is that small program, and Node.js is what runs it. It has no other dependencies.</dd>' +
        '</dl>' +
      '</details>';

    const setupEl = container.querySelector('#brSetup');
    if (setupEl) setupEl.open = setupWasOpen;

    wire(container, data);
  }

  /* ── Events ──────────────────────────────────────────────────────── */

  function wire(container, data) {
    const $ = (id) => container.querySelector('#' + id);
    const toast = (msg) => flash(container, msg);

    async function persist(patch, opts) {
      const res = await send('setBridgeSettings', { settings: patch });
      if (!(opts && opts.quiet)) {
        const fresh = await send('getBridgeSettings');
        render(container, fresh);
      }
      return res;
    }

    $('brEnabled').addEventListener('change', async (e) => {
      const enable = e.target.checked;
      if (enable) {
        const current = data.settings;
        if (!current.token) { toast('Click Generate to create a pairing token first.'); e.target.checked = false; return; }
        const granted = await ensurePermission();
        if (!granted) { toast('Chrome did not allow the local connection.'); e.target.checked = false; return; }
      }
      await persist({ enabled: enable });
    });

    $('brGen').addEventListener('click', async () => {
      const { token } = await send('generateBridgeToken');
      await persist({ token });
      toast('New token created. Update the Claude config and restart Claude Desktop.');
    });

    $('brCopyToken').addEventListener('click', async () => {
      await navigator.clipboard.writeText($('brToken').value || '');
      toast('Token copied.');
    });

    $('brPort').addEventListener('change', async (e) => {
      const port = Math.max(1024, Math.min(65535, parseInt(e.target.value, 10) || 8787));
      await persist({ port });
    });

    const accounts = data.accounts || [];

    const lockSel = $('brLockAccount');
    if (lockSel) {
      lockSel.addEventListener('change', async (e) => {
        const key = e.target.value || null;
        const acct = accounts.find((a) => a.key === key);
        const label = key ? (acct ? acct.label : key) : '';
        // Locking onto an account turns multi-account off and resets writes, so
        // a newly selected account must be re-authorised before Claude writes.
        await persist({ lockedAccountId: key, lockedAccountLabel: label, multiAccount: false, allowWrites: false });
      });
    }

    const refreshAcc = $('brRefreshAccounts');
    if (refreshAcc) {
      refreshAcc.addEventListener('click', async () => {
        const fresh = await send('getBridgeSettings');
        render(container, fresh);
        toast('Account list refreshed.');
      });
    }

    $('brMultiAccount').addEventListener('change', async (e) => {
      // Multi-account mode cannot coexist with writes.
      if (e.target.checked) {
        await persist({ multiAccount: true, allowWrites: false });
      } else {
        await persist({ multiAccount: false });
      }
    });

    const allowW = $('brAllowWrites');
    if (allowW) {
      allowW.addEventListener('change', async (e) => {
        if (e.target.checked) {
          const label = data.settings.lockedAccountLabel || data.settings.lockedAccountId || 'the locked account';
          const sure = window.confirm(
            'Allow write actions on ' + label + '?\n\n' +
            'Claude will be able to create and update records in this NetSuite account. ' +
            'The author is not responsible for any resulting data changes, errors or losses.\n\n' +
            'Turn it on anyway?'
          );
          if (!sure) { e.target.checked = false; return; }
        }
        await persist({ allowWrites: e.target.checked });
      });
    }

    // Path inputs: save on change (so the snippets rebuild) but do not steal
    // focus while typing.
    const pathInput = (id, key) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', async () => {
        await persist({ [key]: el.value.trim() });
      });
    };
    pathInput('brNodePath', 'nodePath');
    pathInput('brCompanionPath', 'companionPath');

    $('brGrant').addEventListener('click', async () => {
      const granted = await ensurePermission();
      toast(granted ? 'Local connection allowed.' : 'Chrome did not allow the local connection.');
    });

    $('brRefresh').addEventListener('click', async () => {
      await send('restartBridge');
      const fresh = await send('getBridgeSettings');
      render(container, fresh);
    });

    const copyBtn = (btnId, preId, label) => {
      const btn = $(btnId);
      if (!btn) return;
      btn.addEventListener('click', async () => {
        await navigator.clipboard.writeText($(preId).textContent || '');
        toast(label + ' copied.');
      });
    };
    copyBtn('brCopyFull', 'brSnippetFull', 'Whole file');
    copyBtn('brCopyInner', 'brSnippetInner', 'Server entry');
  }

  function ensurePermission() {
    return new Promise((resolve) => {
      chrome.permissions.request({ origins: [LOOPBACK_ORIGIN] }, (granted) => {
        resolve(!!granted && !chrome.runtime.lastError);
      });
    });
  }

  let toastTimer = null;
  function flash(container, msg) {
    let el = container.querySelector('.tacta-br-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tacta-br-toast';
      container.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function injectStyles() {
    if (document.getElementById('tacta-br-styles')) return;
    const style = document.createElement('style');
    style.id = 'tacta-br-styles';
    style.textContent = [
      '.tacta-opt-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--tacta-surface-2,#eef1f4);color:var(--tacta-text-muted,#667085);vertical-align:middle;margin-left:6px}',
      '.tacta-opt-badge-beta{background:rgba(245,170,40,.18);color:#a86a00}',
      '.tacta-opt-bridge{display:flex;flex-direction:column;gap:14px;position:relative}',
      '.tacta-br-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.tacta-br-enable{display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer}',
      '.tacta-br-badge{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px}',
      '.tacta-br-badge-ok{background:rgba(118,192,67,.15);color:#3f8a1f}',
      '.tacta-br-badge-warn{background:rgba(245,170,40,.15);color:#a86a00}',
      '.tacta-br-badge-err{background:rgba(224,70,70,.13);color:#c0392b}',
      '.tacta-br-badge-off{background:var(--tacta-surface-2,#eef1f4);color:var(--tacta-text-muted,#667085)}',
      '.tacta-br-error{margin:0;font-size:13px;color:#c0392b}',
      '.tacta-br-warn{display:block;margin-top:6px;font-size:12px;color:#c0392b;line-height:1.5}',
      '.tacta-br-grid{display:flex;flex-direction:column;gap:14px}',
      '.tacta-br-row{display:flex;flex-direction:column;gap:6px}',
      '.tacta-br-row-toggle{flex-direction:row;align-items:center;justify-content:space-between;gap:16px}',
      '.tacta-br-row-toggle>div{display:flex;flex-direction:column;gap:4px}',
      '.tacta-br-label{font-weight:600;font-size:13px}',
      '.tacta-br-hint{font-size:12px;color:var(--tacta-text-muted,#667085)}',
      '.tacta-br-p{margin:10px 0 6px;font-size:13px;line-height:1.6}',
      '.tacta-br-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.tacta-br-input{flex:1;min-width:180px;padding:7px 10px;border:1px solid var(--tacta-border,#d0d5dd);border-radius:6px;background:var(--tacta-surface,#fff);color:var(--tacta-text,#1a1a1a)}',
      '.tacta-br-port{max-width:120px}',
      '.tacta-br-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}',
      '.tacta-br-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.tacta-br-setup{border:1px solid var(--tacta-border,#d0d5dd);border-radius:8px;padding:10px 14px;background:var(--tacta-surface-2,#f7f9fb)}',
      '.tacta-br-setup summary{cursor:pointer;font-weight:600}',
      '.tacta-br-setup code{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:var(--tacta-surface,#fff);border:1px solid var(--tacta-border,#d0d5dd);border-radius:4px;padding:0 4px}',
      '.tacta-br-download{display:flex;flex-direction:column;gap:6px;margin:8px 0;padding:12px;border:1px solid var(--tacta-border,#d0d5dd);border-radius:8px;background:var(--tacta-surface,#fff)}',
      '.tacta-br-download a.tacta-opt-btn{align-self:flex-start;text-decoration:none;display:inline-flex;align-items:center}',
      '.tacta-br-steps{margin:10px 0;padding-left:20px;font-size:13px;line-height:1.6}',
      '.tacta-br-steps>li{margin-bottom:14px}',
      '.tacta-br-steps>li>strong{font-size:13.5px}',
      '.tacta-br-sub{margin-top:4px}',
      '.tacta-br-sub p{margin:6px 0}',
      '.tacta-br-sub ul{margin:4px 0;padding-left:18px}',
      '.tacta-br-sub ul li{margin-bottom:6px}',
      '.tacta-br-substeps{margin:4px 0;padding-left:18px}',
      '.tacta-br-substeps li{margin-bottom:3px}',
      '.tacta-br-list{margin:4px 0 10px;padding-left:18px;font-size:13px;line-height:1.6}',
      '.tacta-br-case{margin-top:12px}',
      '.tacta-br-cmd{margin:6px 0;padding:8px 10px;border-radius:6px;background:var(--tacta-code-bg,#0f1115);color:var(--tacta-code-text,#e6e6e6);font-family:ui-monospace,Consolas,monospace;font-size:12px;overflow:auto;white-space:pre;user-select:all}',
      '.tacta-br-snippet-head{display:flex;align-items:center;justify-content:space-between;margin-top:8px;font-size:12px;font-weight:600}',
      '.tacta-br-snippet{margin:6px 0 0;padding:12px;border-radius:6px;background:var(--tacta-code-bg,#0f1115);color:var(--tacta-code-text,#e6e6e6);font-family:ui-monospace,Consolas,monospace;font-size:12px;overflow:auto;white-space:pre}',
      '.tacta-br-faq{margin:10px 0 4px;font-size:13px;line-height:1.6}',
      '.tacta-br-faq dt{font-weight:600;margin-top:10px}',
      '.tacta-br-faq dd{margin:2px 0 0 0}',
      '.tacta-br-toast{position:absolute;right:0;bottom:-8px;transform:translateY(100%);background:var(--tacta-text,#1a1a1a);color:#fff;padding:6px 12px;border-radius:6px;font-size:12px;opacity:0;transition:opacity .2s;pointer-events:none}',
      '.tacta-br-toast.show{opacity:1}'
    ].join('');
    document.head.appendChild(style);
  }

  async function init() {
    const container = document.getElementById(CARD_ID);
    if (!container) return;
    injectStyles();
    try {
      const data = await send('getBridgeSettings');
      render(container, data);
    } catch (e) {
      container.innerHTML = '<p class="tacta-br-error">Could not load bridge settings: ' + esc(e.message) + '</p>';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

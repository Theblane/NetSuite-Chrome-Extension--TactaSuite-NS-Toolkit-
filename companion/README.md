# Claude Desktop Bridge companion (beta feature)

`tacta-bridge.mjs` is a small helper program that lets the **Claude Desktop**
app read from the NetSuite account you already have open in Chrome, through
the TactaSuite NS Toolkit extension. You ask Claude a question in plain
English, and it looks up the answer in your NetSuite tab, as you, with your
role and permissions.

- **Nothing to set up in NetSuite.** No integration record, no token, no admin.
- **Read only.** Claude can look at data but cannot change it. SuiteQL, the
  query language it uses, cannot modify records.
- **Stays on your computer.** The companion and the extension only talk to each
  other on your own PC (`127.0.0.1`). Nothing is sent to the author or to any
  website. What Claude reads does become part of your Claude conversation.
- **Off until you switch it on**, and you can switch it off at any time.
- **Beta.** Expect rough edges. Read the questions at the end before using it
  with sensitive data.

## How it works

```
Claude Desktop  -->  tacta-bridge.mjs (companion)  -->  TactaSuite extension  -->  your NetSuite tab
```

Claude Desktop starts the companion when it opens and stops it when you quit.
The extension connects to the companion on your PC. When Claude needs
something from NetSuite, the request goes companion, extension, NetSuite tab,
and the answer comes back the same way.

## Setup (once, about 10 minutes)

The in-extension card has the same steps with your real paths and token
filled in: Chrome, extension icon, **All settings**, **Claude Desktop Bridge**.

### 1. Check for Node.js, or install it

Node.js is the free program that runs the companion.

Open **Command Prompt** (Windows key, type `cmd`, Enter) and run:

```
where node
```

If it prints a path such as `C:\Program Files\nodejs\node.exe`, you have Node
and can skip to step 2. If it prints `INFO: Could not find files`, install
Node.

**You can install programs on this PC** (you get the admin prompt and can
approve it):

```
winget install OpenJS.NodeJS.LTS
```

**You are not an administrator:** use the standalone .zip. It needs no
installer and no admin rights.

1. Go to <https://nodejs.org/en/download>. Make sure **Windows** is selected,
   then download the **Standalone Binary (.zip)**, 64-bit. Do **not** download
   the .msi installer.
2. Right-click the downloaded .zip, choose **Extract All**, and extract to a
   folder you own, for example `C:\Users\YOURNAME\Documents\nodejs`. Open that
   folder and find `node.exe`. It may be one level down, in a folder named
   like `node-v26.13.0-win-x64`. Copy the address of the folder that contains
   `node.exe` from the Explorer address bar.
3. Add that folder to your own PATH (no admin needed): press **Windows key +
   R**, type `rundll32 sysdm.cpl,EditEnvironmentVariables` and press Enter.
   In the top section, *User variables*, click **Path**, then **Edit**, then
   **New**, paste the folder address, and click **OK** on every window.
4. Open a **new** Command Prompt and run `node -v`. It should print a version
   number such as `v26.13.0`.

If `node -v` still says not recognized, the PATH entry points to the wrong
folder; it must be the folder that contains `node.exe`. You can also skip PATH
entirely and use the full path to `node.exe` as `"command"` in step 5. Either
way, fully quit and reopen Claude Desktop afterwards so it sees the change.

### 2. Download the companion file

Download
[`tacta-bridge.mjs`](https://github.com/Theblane/TactaSuiteNSToolkit/releases/latest/download/tacta-bridge.mjs)
(or use **Download tacta-bridge.mjs** in the extension card). It is one small
file with no dependencies; there is nothing to install.

Move it out of Downloads into a folder that will not change, for example
`C:\Users\YOURNAME\TactaSuite\`. Copy its full path: hold **Shift**,
right-click the file, choose **Copy as path**.

### 3. Create your pairing token in the extension

In Chrome open the extension's **All settings** page and scroll to **Claude
Desktop Bridge**.

1. Paste the two paths from steps 1 and 2 into the boxes in step 3 of the
   card. The config blocks below are built from them with the slashes
   formatted correctly.
2. Click **Generate** to create a pairing token. This is a password that only
   the extension and your companion know. Keep it private.
3. Click **Allow local connection** and accept the Chrome prompt.

### 4. Open the Claude Desktop config file

1. Open **Claude Desktop**. Click the menu button (three lines) in the
   top-left corner.
2. Choose **Developer**, then **Open App Config File**. The file
   `claude_desktop_config.json` opens in your text editor, or its folder opens
   with the file selected.
3. No **Developer** entry in the menu? Choose **Help**, then **Enable
   Developer Mode**, and look again. Older versions instead use **File**,
   **Settings**, the **Developer** tab, then the **Edit Config** button (this
   is the path in the official MCP quickstart).
4. If only the folder opened, right-click the file, **Open with**, **Notepad**.

If nothing opens, press Windows key + R, paste `%APPDATA%\Claude`, press
Enter, and open `claude_desktop_config.json` from there. On a Mac the file is
`~/Library/Application Support/Claude/claude_desktop_config.json`.

### 5. Add the bridge to that file

Look at what is already in the file and pick the matching case. The extension
card shows these blocks with your real token, extension ID and paths; copy
them from there.

**A. The file is empty, or only contains `{}`.** Delete everything and paste
the whole block:

```json
{
  "mcpServers": {
    "netsuite-tactasuite": {
      "command": "node",
      "args": ["C:\\Users\\YOURNAME\\TactaSuite\\tacta-bridge.mjs"],
      "env": {
        "TACTA_BRIDGE_TOKEN": "paste the token from the extension",
        "TACTA_BRIDGE_PORT": "8787",
        "TACTA_BRIDGE_EXT_ID": "paste the extension ID from the extension"
      }
    }
  }
}
```

**B. The file has text but no `"mcpServers"` line.** Find the last `}` at the
very bottom. Just above it, add a comma to the end of the previous line, press
Enter, and paste:

```json
  "mcpServers": {
    "netsuite-tactasuite": {
      "command": "node",
      "args": ["C:\\Users\\YOURNAME\\TactaSuite\\tacta-bridge.mjs"],
      "env": {
        "TACTA_BRIDGE_TOKEN": "paste the token from the extension",
        "TACTA_BRIDGE_PORT": "8787",
        "TACTA_BRIDGE_EXT_ID": "paste the extension ID from the extension"
      }
    }
  }
```

**C. The file already has `"mcpServers": {` with other servers inside.** Find
the last server entry inside `mcpServers`. Add a comma after its closing `}`,
press Enter, and paste only this entry:

```json
    "netsuite-tactasuite": {
      "command": "node",
      "args": ["C:\\Users\\YOURNAME\\TactaSuite\\tacta-bridge.mjs"],
      "env": {
        "TACTA_BRIDGE_TOKEN": "paste the token from the extension",
        "TACTA_BRIDGE_PORT": "8787",
        "TACTA_BRIDGE_EXT_ID": "paste the extension ID from the extension"
      }
    }
```

Then check the two paths:

- `"command"` is `node` **only if** `node -v` works in a new Command Prompt.
  Otherwise it must be the full path to `node.exe`, for example
  `"C:\\Users\\YOURNAME\\nodejs\\node.exe"`.
- `"args"` is the full path to `tacta-bridge.mjs`.
- In this file every backslash is written twice (`\\`). That is correct, do
  not remove them. Forward slashes also work: `C:/Users/YOURNAME/TactaSuite/tacta-bridge.mjs`.

Common mistakes: a missing comma between entries, or an extra comma after the
last entry. Claude Desktop refuses to start the bridge if the file is not
valid JSON. Paste the whole file into <https://jsonlint.com> if unsure. Save.

### 6. Restart Claude Desktop and switch the bridge on

Closing the window is not enough. Right-click the Claude icon in the system
tray (bottom-right, near the clock, maybe under the `^` arrow) and choose
**Quit**. Open Claude Desktop again.

Open a NetSuite tab in Chrome and sign in. In the extension card switch on
**Bridge is on**. Within a few seconds the status shows **Connected**. In
Claude Desktop click the **+** (Add files, connectors, and more) in the chat
box, then **Connectors**: `netsuite-tactasuite` is listed there. Ask Claude
"what NetSuite page do I have open?" to try it.

## Settings in the extension card

| Setting | What it does |
|---|---|
| **Bridge is on** | The master switch. Off means Claude cannot reach NetSuite at all. |
| **Pairing token** | The shared password. Generating a new one means updating the Claude config and restarting Claude Desktop. |
| **Local port** | Leave at 8787 unless another program uses it. Must match `TACTA_BRIDGE_PORT`. |
| **Sandbox only** | When on, Claude can only use sandbox tabs. Production tabs are ignored even if you are looking at one. |
| **Allow write actions** | Off by default. In this beta there are no tools that can change NetSuite data, so it does nothing yet. **If you turn it on, any change Claude makes in NetSuite is your responsibility. This is a beta feature driven by AI. The author is not responsible for any data changes, errors or losses. Use at your own risk.** |

## Not connecting? Test it yourself

This proves Node and the file work, separately from Claude Desktop.

1. Fully quit Claude Desktop (system tray, right-click, **Quit**). Otherwise it
   is already holding port 8787.
2. Open Command Prompt and run these lines one at a time, with your own token
   and paths:
   ```
   set TACTA_BRIDGE_TOKEN=your-token-from-the-extension
   set TACTA_BRIDGE_PORT=8787
   node "C:\Users\YOURNAME\TactaSuite\tacta-bridge.mjs"
   ```
3. You should see:
   ```
   [tacta-bridge] tacta-bridge 1.2.0 ready (MCP on stdio).
   [tacta-bridge] loopback bridge listening on 127.0.0.1:8787 (primary, waiting for extension)
   ```
   Switch on **Bridge is on** in the extension. The status turns **Connected**
   and the window prints `extension paired`. Press `Ctrl` + `C` to stop it,
   then start Claude Desktop again.

**If that test fails**

- `'node' is not recognized`: Node is not on your PATH. Either add its folder to your user PATH (step 1)
  and fully restart Claude Desktop, or use the full path to `node.exe` in
  quotes instead of `node` here and in `"command"` in the Claude config.
- `Cannot find module`: the path to `tacta-bridge.mjs` is wrong. Shift +
  right-click the file and choose **Copy as path**.
- `could not listen on 127.0.0.1:8787`: another program owns that port. Change
  **Local port** in the extension and `TACTA_BRIDGE_PORT` in the config, then
  restart Claude Desktop.

**If the test works but Claude Desktop does not connect**

- The config file has a typo. Missing or extra commas are the usual cause.
  Check it at <https://jsonlint.com>.
- The config was copied from another computer. The node path, the file path,
  the token and the extension ID are all specific to your PC and your Chrome.
  Use the blocks from your own extension card.
- Claude Desktop was not fully quit. Quit from the system tray, then reopen.
- Claude Desktop keeps a log of the bridge at
  `%APPDATA%\Claude\logs\mcp-server-netsuite-tactasuite.log`. The last lines
  say what went wrong.

**If Claude says the extension is not connected**

- Open a NetSuite tab and sign in. If **Sandbox only** is on, it must be a
  sandbox tab.
- Check that **Bridge is on** is switched on and the status says Connected.
  The extension retries about once a minute; **Reconnect now** retries at once.

## Questions and answers

**What can Claude do with this?**
Read only. It can run SuiteQL queries (a read-only query language that cannot
change records), describe the NetSuite page you have open, list the fields on
the record you are viewing, and list your open NetSuite tabs. It cannot edit,
create or delete anything in this beta.

**Which NetSuite accounts can it reach?**
Any NetSuite tab open in this Chrome profile where you are signed in,
production and sandbox alike. It uses the tab you are looking at, or the one
you used most recently. Turn on **Sandbox only** to block production, or close
your production tabs while you work with Claude.

**What permissions does it have in NetSuite?**
Exactly yours. It runs inside your signed-in tab with the role you are logged
in as. It cannot see anything you cannot see.

**When is it active?**
Only when all three are true: **Bridge is on** in the extension, Claude
Desktop is running (it starts the companion), and a NetSuite tab is open.

**How do I stop it?**
Switch off **Bridge is on**. Quitting Claude Desktop also stops the companion.
To remove it completely, delete the `netsuite-tactasuite` entry from the
Claude config and delete the companion file.

**Is it safe? Does my data leave my computer?**
The companion only accepts connections from this computer, and only from this
extension with your pairing token. The extension never sends anything to the
author or any website. What Claude reads from NetSuite does become part of
your Claude conversation, so it is covered by Anthropic's privacy terms, the
same as anything else you paste into Claude. Do not use it with data you would
not paste into a chat.

**Does it work with ChatGPT or other AI apps?**
Not with ChatGPT today. The ChatGPT desktop app cannot start a local program
like this companion. Any app that can run a local "stdio" MCP server works
with the same config block, for example Claude Code or Cursor. Only Claude
Desktop is tested.

**I have several Claude windows or use Cowork. Is that a problem?**
No. Claude Desktop may start the companion more than once (one copy per chat,
Cowork or Code surface). The first copy to own the port talks to the
extension; later copies pass their requests through it. If the first one
exits, another takes over. All copies must use the same token.

**Why does it need Node.js?**
Chrome extensions cannot run a program on your PC or accept connections. The
companion is that small program, and Node.js is what runs it.

## Technical reference

### Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `TACTA_BRIDGE_TOKEN` | yes | - | Shared pairing token; must match the extension. |
| `TACTA_BRIDGE_PORT` | no | `8787` | Loopback port; must match the extension. |
| `TACTA_BRIDGE_EXT_ID` | no | - | If set, only this Chrome extension id may connect. |

### Tools exposed to the MCP client

| Tool | What it does |
|------|--------------|
| `netsuite_run_suiteql` | Run a read-only SuiteQL (`SELECT` / `WITH`) query. Paginated to 200k rows. |
| `netsuite_get_current_page` | Describe the NetSuite page being viewed (URL, account, record type/id, mode). |
| `netsuite_get_current_record_fields` | List fields (id, label, type, value) of the record currently open. |
| `netsuite_list_tabs` | List the open NetSuite browser tabs the bridge may act on. |

### Security notes

- The WebSocket server binds `127.0.0.1` only (never `0.0.0.0`).
- Every connection must present the pairing token and a `chrome-extension://`
  origin. Set `TACTA_BRIDGE_EXT_ID` to pin a single extension id.
- Relay connections between companion copies carry the same token.
- Regenerate the token in the extension if it leaks, then update the config
  and restart Claude Desktop.
- The extension enforces read-only SuiteQL (`SELECT` / `WITH`, no DML
  keywords) unless **Allow write actions** is on. No write tools exist yet.

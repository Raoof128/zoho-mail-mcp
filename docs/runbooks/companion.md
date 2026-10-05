# macOS companion

The companion gives a local MCP client three tools: `list_roots`, `stage_file` and `save_attachment`. It is plain JavaScript run by Node (22.18 or later); there is no compiled helper, no code signing and no notarisation (spec D15). It moves files between named folders on the Mac and the Worker. It never sends mail itself.

## Install (one line)

The owner first opens `https://mail-mcp.sarabisfinerugs.com.au/accounts`, signs in with Zoho, and clicks **Register the companion client** once. Then, in Terminal:

```bash
curl -fsSL https://mail-mcp.sarabisfinerugs.com.au/install.sh | sh
```

What the line does, in order:

1. Checks this is a Mac. If Node 22.18 or later is missing, downloads the official Node.js 24.21.0 package from nodejs.org, checks its SHA-256 against the value pinned in the script and checks `pkgutil --check-signature` names `Developer ID Installer: Node.js Foundation (HX7739G8FX)`, then installs it (the Mac password is asked for).
2. Downloads `companion.tgz` and `companion.sha256` once each from the Worker, and stops unless the downloaded file's SHA-256 matches. The exact file that was checked is the file installed.
3. Creates `~/Downloads/Mail/To Send` and `~/Downloads/Mail/Received`, and installs into `~/Library/Application Support/zoho-mail-mcp/` (mode 700) with `npm install --prefix`, saving nothing else.
4. Writes `bin/companion` there: a two-line script that runs the absolute Node path on the installed bundle. Claude Desktop and launchd start programs with a minimal PATH, so nothing depends on PATH.
5. On a first install only: reads the companion's public client id from `/companion-client-id`, runs `companion init`, then `companion login`, which opens the browser for the Zoho sign-in and stores the staging credential in the login Keychain.
6. `companion install-agent`: a login item (`au.com.sarabisfinerugs.mail-mcp.companion`) that runs `companion recover` once at each login. Recovery clears expired snapshots and finishes or flags interrupted saves.
7. `companion configure-clients`: adds `zoho-mail` (the Worker, `https://HOST/mcp`) and `zoho-mail-companion` (`bin/companion serve`) to Claude Code at user scope and to Codex, skipping any already present and reporting a CLI that is not installed. Adds `zoho-mail-companion` to Claude Desktop's `claude_desktop_config.json`, keeping every other entry and writing a timestamped backup first. A Desktop settings file that does not parse is left untouched and reported.

Two steps stay manual because no file can do them: in Claude Desktop or claude.ai, **Settings, Connectors, Add custom connector**, paste `https://mail-mcp.sarabisfinerugs.com.au/mcp`; and in Codex, run `codex mcp login zoho-mail` once.

## Folders and the outbox rule

`init` configures these roots, which never sit inside one another (the companion refuses overlapping roots):

| Root          | Folder                      | Access |
| ------------- | --------------------------- | ------ |
| `outbox`      | `~/Downloads/Mail/To Send`  | read   |
| `attachments` | `~/Downloads/Mail/Received` | write  |
| `desktop`     | `~/Desktop` (if present)    | read   |
| `documents`   | `~/Documents` (if present)  | read   |

The Worker stages a file from the root named exactly `outbox` without asking. A file from any other root needs approval in the browser first (`+outside_outbox`). So the plain rule for the owner is: put files to send in **To Send**. There is no `downloads` root: it would contain both mail folders.

Saving never overwrites: a file that already exists at the destination is left alone, and the destination's parent folder must already exist.

## Results to know

- `state: published` with `acknowledged: false`: the file is saved locally and the Worker has not confirmed. Repeat the same save; it recovers the receipt and retries the confirmation.
- `publication_unknown`: the companion cannot prove what is at the destination. Do not delete or replace the destination to force a retry. Inspect it, then see `debt` below.
- `lock_busy`: another companion task held the lock for six minutes. Retry.

### The one weaker guarantee (D15)

The Swift helper opened files beneath a root atomically (`openat` with `O_RESOLVE_BENEATH`) and published with an exclusive atomic rename. Node has neither. The companion checks every folder between the root and the file is a real folder, opens the file with `O_NOFOLLOW`, publishes by hard link (which fails rather than replace an existing file), and afterwards re-checks the resolved parent. **verify-after-publish re-checks the parent; a rename race between the two checks is refused rather than detected atomically.** If the process dies between the link and removing the temporary name, recovery reports `publication_unknown` and the temporary file stays for inspection.

## Debt

```bash
"$HOME/Library/Application Support/zoho-mail-mcp/bin/companion" debt
```

Lists saves that still hold capacity and prints, for each, the exact command that clears it, or why it cannot be cleared safely. Only a `publication_unknown` receipt whose temporary file is provably gone can be released by the owner.

## Log out

```bash
"$HOME/Library/Application Support/zoho-mail-mcp/bin/companion" logout
```

Invalidates local use of the credential first, then asks the Worker to revoke it, and says whether revocation was confirmed.

## Update

Run the install line again. It replaces the installed bundle and wrapper and leaves the configuration, the Keychain item, the journal and the folders as they are.

## Uninstall

```bash
launchctl bootout "gui/$(id -u)/au.com.sarabisfinerugs.mail-mcp.companion"
rm ~/Library/LaunchAgents/au.com.sarabisfinerugs.mail-mcp.companion.plist
"$HOME/Library/Application Support/zoho-mail-mcp/bin/companion" logout
rm -r "$HOME/Library/Application Support/zoho-mail-mcp" ~/.config/zoho-mail-mcp
claude mcp remove --scope user zoho-mail; claude mcp remove --scope user zoho-mail-companion
codex mcp remove zoho-mail; codex mcp remove zoho-mail-companion
```

Then remove the `zoho-mail-companion` entry from `~/Library/Application Support/Claude/claude_desktop_config.json` and the custom connector in Claude's Settings. The two mail folders are the owner's files and are not removed.

## Private state and capacity

Configuration: `~/.config/zoho-mail-mcp/config.json` (mode 600, written once). State: `~/Library/Application Support/zoho-mail-mcp/` (mode 700): `journal.sqlite` (WAL, full fsync), `snapshots/`, `companion.lock`. The staging credential is a login Keychain item, service `au.com.sarabisfinerugs.mail-mcp.companion.oauth.v1`, written through `security -i` on stdin so it never appears in a process list, and read back after every write.

The companion reserves four snapshots or 100 MiB, one temporary save of 25 MiB, and at most 1,000 journal records or 16 MiB. Do not delete the lock file or edit the journal while a companion runs; removing the journal destroys idempotency protection.

## Verification boundary

`npm run verify` runs the companion suite: the Node native port (configuration, journal, Keychain epochs, safe files including symlinked folders, receipts and crash recovery, the process lock, startup cleanup), the CLI under a temporary HOME, the launchd plist through `plutil -lint`, the bundle and its SHA-256, the Desktop config merge, and `install.sh` under `sh -n` and shellcheck. The real Keychain test runs with `ZMC_KEYCHAIN_TESTS=1` against a `.test` service. Gate G20 (M7) runs the install line end to end against the deployed Worker in a scratch HOME.

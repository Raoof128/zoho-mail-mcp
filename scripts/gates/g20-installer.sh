#!/bin/sh
# Gate G20: the one-line installer, end to end, against the deployed Worker, in a scratch HOME.
# Usage: scripts/gates/g20-installer.sh [mail-mcp.sarabisfinerugs.com.au]
# Needs: the Worker deployed and the companion client registered on /accounts (init reads its id).
# claude, codex, curl and launchctl are recording stubs (curl passes through to /usr/bin/curl), so
# nothing touches this Mac's real Claude, Codex or launchd. ZMC_SKIP_LOGIN=1 skips only the
# interactive sign-in: a scratch HOME has no default Keychain. The live round covers sign-in.
set -eu
HOST="${1:-mail-mcp.sarabisfinerugs.com.au}"
OUT="$(cd "$(dirname "$0")" && pwd)/out"
mkdir -p "$OUT"
REPORT="$OUT/g20-$(date +%Y-%m-%d).txt"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
H="$SCRATCH/home"
STUBS="$SCRATCH/stubs"
LOGS="$SCRATCH/logs"
APP="$H/Library/Application Support/zoho-mail-mcp"
DESKTOP="$H/Library/Application Support/Claude/claude_desktop_config.json"
mkdir -p "$(dirname "$DESKTOP")" "$H/Documents" "$STUBS" "$LOGS"
: >"$REPORT"
result=0
note() { printf '%s\n' "$*" | tee -a "$REPORT"; }
# check NAME COMMAND...: runs the command and records PASS or FAIL.
check() {
  name="$1"
  shift
  if "$@"; then note "PASS  $name"; else
    note "FAIL  $name"
    result=1
  fi
}

# A hand-edited Desktop config: another server, another key, trailing whitespace (Review Focus 5).
printf '{\n  "mcpServers": {\n    "other": { "command": "x", "args": ["y"] }\n  },\n  "theme": "dark"\n}\n   \n' >"$DESKTOP"

for cli in claude codex; do
  cat >"$STUBS/$cli" <<STUB
#!/bin/sh
printf '%s\n' "\$*" >>"$LOGS/$cli.log"
if [ "\$1 \$2" = "mcp get" ]; then grep -qx "\$3" "$LOGS/$cli.registered" 2>/dev/null; exit \$?; fi
if [ "\$1 \$2" = "mcp add" ]; then
  for a in "\$@"; do case "\$a" in zoho-mail | zoho-mail-companion) printf '%s\n' "\$a" >>"$LOGS/$cli.registered"; break ;; esac; done
fi
exit 0
STUB
done
cat >"$STUBS/curl" <<STUB
#!/bin/sh
printf '%s\n' "\$*" >>"$LOGS/curl.log"
exec /usr/bin/curl "\$@"
STUB
cat >"$STUBS/launchctl" <<STUB
#!/bin/sh
printf '%s\n' "\$*" >>"$LOGS/launchctl.log"
exit 0
STUB
chmod 755 "$STUBS"/*

NODE_DIR="$(dirname "$(command -v node)")"
install_once() {
  env HOME="$H" PATH="$STUBS:$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin" ZMC_SKIP_LOGIN=1 \
    ZMC_LAUNCHCTL="$STUBS/launchctl" sh -c "curl -fsSL 'https://$HOST/install.sh' | sh" >>"$LOGS/install.out" 2>&1
}
# Content hashes of everything the installer owns, minus logs, caches and runtime state.
snapshot() {
  (cd "$H" && find . -type f ! -path './.npm/*' ! -path './Library/Logs/*' ! -name 'journal.sqlite*' \
    ! -name 'companion.lock*' ! -path '*/snapshots/*' -print0 | sort -z | xargs -0 shasum -a 256)
}

note "G20 installer gate against https://$HOST at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
check "first run exits 0" install_once
check "one download of companion.tgz" test "$(grep -c 'companion\.tgz' "$LOGS/curl.log")" = 1

/usr/bin/curl -fsSL "https://$HOST/companion.tgz" -o "$SCRATCH/ref.tgz"
/usr/bin/curl -fsSL "https://$HOST/companion.sha256" -o "$SCRATCH/ref.sha256"
check "published tarball matches its published checksum" \
  test "$(shasum -a 256 "$SCRATCH/ref.tgz" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$SCRATCH/ref.sha256")"
mkdir -p "$SCRATCH/ref" && tar -xzf "$SCRATCH/ref.tgz" -C "$SCRATCH/ref"
check "installed bundle is byte-identical to the hashed tarball" \
  cmp -s "$SCRATCH/ref/package/dist/companion.mjs" "$APP/node_modules/zoho-mail-mcp-companion/dist/companion.mjs"

desktop_kept() {
  python3 - "$DESKTOP" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
assert c["theme"] == "dark"
assert c["mcpServers"]["other"] == {"command": "x", "args": ["y"]}
assert c["mcpServers"]["zoho-mail-companion"]["args"] == ["serve"]
PY
}
backed_up() { ls "$DESKTOP".bak-* >/dev/null 2>&1; }
claude_ok() {
  grep -qx "mcp add --scope user --transport http zoho-mail https://$HOST/mcp" "$LOGS/claude.log" &&
    grep -q "^mcp add --scope user zoho-mail-companion -- .*/bin/companion serve$" "$LOGS/claude.log"
}
codex_ok() {
  grep -qx "mcp add zoho-mail --url https://$HOST/mcp" "$LOGS/codex.log" &&
    grep -q "^mcp add zoho-mail-companion -- .*/bin/companion serve$" "$LOGS/codex.log"
}
check "Desktop config kept its other entries and gained the companion" desktop_kept
check "Desktop config backed up before the change" backed_up
check "Claude Code: both servers at user scope" claude_ok
check "Codex: both servers" codex_ok
check "login agent bootstrapped (stub)" grep -q "^bootstrap gui/" "$LOGS/launchctl.log"

before="$(snapshot)"
check "second run exits 0" install_once
after="$(snapshot)"
check "second run changes nothing the installer owns" test "$before" = "$after"
[ "$before" = "$after" ] || printf '%s\n%s\n' "$before" "$after" | sort | uniq -u | tee -a "$REPORT"

note "--- installer output"
cat "$LOGS/install.out" >>"$REPORT"
note "G20 $([ "$result" = 0 ] && echo PASS || echo FAIL); evidence $REPORT"
exit "$result"

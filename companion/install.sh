#!/bin/sh
# zoho-mail-mcp companion installer for macOS. One download of each artefact, verified before use.
# Usage: curl -fsSL https://mail-mcp.sarabisfinerugs.com.au/install.sh | sh
# Running it again updates the companion and changes nothing else.
set -eu
HOST="mail-mcp.sarabisfinerugs.com.au"
APP="$HOME/Library/Application Support/zoho-mail-mcp"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say() { printf '%s\n' "$*"; }
fail() {
  say "Install stopped: $*"
  exit 1
}
[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS"

NODE_VERSION="24.21.0"
# From https://nodejs.org/dist/v24.21.0/SHASUMS256.txt on 2026-10-05, checked in addition to Apple's signature.
NODE_SHA256="9831a74b04c270a429bd5a240e37712c4fe229b02b032e18ff2e0702c17c20fd"
NODE_SIGNER="Developer ID Installer: Node.js Foundation (HX7739G8FX)"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  v="$(node -p 'process.versions.node')"
  major="${v%%.*}"
  rest="${v#*.}"
  minor="${rest%%.*}"
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; }
}
if ! node_ok; then
  say "Installing Node.js $NODE_VERSION (the official package from nodejs.org). Your Mac password may be asked for."
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION.pkg" -o "$TMP/node.pkg"
  [ "$(shasum -a 256 "$TMP/node.pkg" | cut -d' ' -f1)" = "$NODE_SHA256" ] ||
    fail "the Node.js package did not match its pinned checksum"
  pkgutil --check-signature "$TMP/node.pkg" | grep -qF "$NODE_SIGNER" ||
    fail "the Node.js package was not signed by the Node.js Foundation"
  sudo installer -pkg "$TMP/node.pkg" -target / >/dev/null
  PATH="/usr/local/bin:$PATH"
  export PATH
  node_ok || fail "Node.js did not install"
fi
NODE="$(command -v node)"
case "$APP$NODE" in
  *'"'* | *'$'* | *'`'* | *'\'*) fail "the home folder path has characters this installer cannot write safely" ;;
esac

say "Downloading the companion from https://$HOST"
curl -fsSL "https://$HOST/companion.tgz" -o "$TMP/companion.tgz"
curl -fsSL "https://$HOST/companion.sha256" -o "$TMP/companion.sha256"
expected="$(cut -d' ' -f1 "$TMP/companion.sha256")"
actual="$(shasum -a 256 "$TMP/companion.tgz" | cut -d' ' -f1)"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  fail "the companion download did not match its published checksum"
fi

mkdir -p "$APP/bin" "$HOME/Downloads/Mail/To Send" "$HOME/Downloads/Mail/Received"
chmod 700 "$APP"
say "Installing into $APP"
# --no-save: nothing records the temporary path, so a second run leaves the folder as it was.
npm install --prefix "$APP" "$TMP/companion.tgz" --no-save --no-package-lock --no-audit --no-fund --loglevel=error >/dev/null
ENTRY="$APP/node_modules/zoho-mail-mcp-companion/dist/companion.mjs"
[ -f "$ENTRY" ] || fail "the companion did not install"
# A written wrapper with an absolute node: Claude Desktop and launchd start programs with a minimal PATH.
printf '#!/bin/sh\nexec "%s" --no-warnings=ExperimentalWarning "%s" "$@"\n' "$NODE" "$ENTRY" >"$TMP/companion"
chmod 755 "$TMP/companion"
mv -f "$TMP/companion" "$APP/bin/companion"
COMPANION="$APP/bin/companion"

if [ ! -f "$HOME/.config/zoho-mail-mcp/config.json" ]; then
  CLIENT_ID="$(curl -fsSL "https://$HOST/companion-client-id" || true)"
  [ -n "$CLIENT_ID" ] || fail "the server has not registered the companion yet. Open https://$HOST/accounts, register it, then run this line again"
  "$COMPANION" init --server "https://$HOST" --client-id "$CLIENT_ID"
fi
# Outside the first-run block: a login that failed last time (browser closed, timeout) is retried now.
# ZMC_SKIP_LOGIN=1 is for gate G20 only: a scratch HOME has no default Keychain to sign in to.
if [ "${ZMC_SKIP_LOGIN:-}" != 1 ] && ! "$COMPANION" status >/dev/null 2>&1; then
  say "Opening your browser to approve the companion. Sign in with Zoho if asked."
  "$COMPANION" login
fi
"$COMPANION" install-agent
"$COMPANION" configure-clients --host "$HOST"
say "Done. Open Claude or Codex and ask for your inbox."
say "Files you want to send go in: $HOME/Downloads/Mail/To Send"
say "Codex: run   codex mcp login zoho-mail   the first time."

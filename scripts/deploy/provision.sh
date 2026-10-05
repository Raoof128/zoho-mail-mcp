#!/bin/sh
# Provisions and deploys the client's Worker (M7 Task 7.3). Idempotent: re-running reuses the D1 database,
# the KV namespace and the generated keys. Reads every value from .env; prints none of them.
# Usage: ENV_FILE=~/Desktop/Job_Projects/Haji/.env scripts/deploy/provision.sh
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY="$ROOT/scripts/deploy"
KV_TITLE="zoho-mail-mcp-oauth-kv"
CLOUDFLARE_API_TOKEN="$(node "$DEPLOY/env-get.ts" ZOHO_MCP_CF_TOKEN)"
CLOUDFLARE_ACCOUNT_ID="$(node "$DEPLOY/env-get.ts" CF_ACCOUNT_ID)"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
cd "$ROOT/worker"

npx wrangler d1 list --json | python3 -c 'import sys,json; sys.exit(0 if any(d["name"]=="zoho-mail-mcp" for d in json.load(sys.stdin)) else 1)' ||
  npx wrangler d1 create zoho-mail-mcp >/dev/null
DB_ID="$(npx wrangler d1 list --json | python3 -c 'import sys,json; print([d["uuid"] for d in json.load(sys.stdin) if d["name"]=="zoho-mail-mcp"][0])')"
kv_id() { npx wrangler kv namespace list | python3 -c "import sys,json; l=[n['id'] for n in json.load(sys.stdin) if n['title']=='$KV_TITLE']; print(l[0] if l else '')"; }
KV_ID="$(kv_id)"
if [ -z "$KV_ID" ]; then
  npx wrangler kv namespace create "$KV_TITLE" >/dev/null
  KV_ID="$(kv_id)"
fi
node "$DEPLOY/prod-config.ts" "$DB_ID" "$KV_ID" "$(git -C "$ROOT" rev-parse --short HEAD)"

(cd "$ROOT" && npm run build:companion >/dev/null)
npx wrangler d1 migrations apply zoho-mail-mcp --remote --config wrangler.prod.jsonc
npx wrangler deploy --config wrangler.prod.jsonc
# After the first deploy the script exists, so secret bulk never stops to ask; it creates a new version.
node "$DEPLOY/secrets.ts" --ensure-keys | npx wrangler secret bulk --config wrangler.prod.jsonc
npx wrangler d1 execute zoho-mail-mcp --remote --config wrangler.prod.jsonc \
  --command "INSERT OR IGNORE INTO recovery_installation VALUES(1,5,'prod-1','active')"
npx wrangler deployments list --config wrangler.prod.jsonc | head -8
printf 'healthz: '
curl -fsS "https://mail-mcp.sarabisfinerugs.com.au/healthz" || printf '(not reachable yet; the custom domain certificate can take a few minutes)'
printf '\n'

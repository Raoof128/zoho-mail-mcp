# M7: Provision, deploy, gates G13 to G20, live round, handover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The service runs in the client's Cloudflare account against the client's Zoho API client, every gate in spec section 8 has recorded evidence, the conformance probe's results are in the spec, and the client has a one-page handover.

**Architecture:** Raouf does this milestone by hand with the scripts below; the client never appears until the handover. Secrets live in `.env` (Haji repo, mode 600) and Worker secrets only. Every live step has a read-back check and is logged in the Haji `AGENT.md` and `CHANGELOG.md` under the Raouf protocol.

**Spec:** sections 2.3, 8, 9, 10; D4, D5, D16 (probe), D18.

**Master:** `2026-10-03-zoho-mail-mcp-00-master.md`.

## File map

| Path                                          | Responsibility                                                |
| --------------------------------------------- | ------------------------------------------------------------- |
| `scripts/deploy/mint-deploy-token.mjs`        | mints the scoped Cloudflare token from `CLOUDFLARE_API_TOKEN` |
| `scripts/deploy/provision.sh`                 | D1, KV, custom domain, secrets, first deploy                  |
| `scripts/gates/g13-cpu.mjs`                   | worst-case CPU runs and log scrape                            |
| `scripts/gates/g14-oauth.mjs`                 | MCP OAuth conformance probe                                   |
| `scripts/gates/g20-installer.sh`              | installer on a scratch `$HOME`                                |
| `docs/runbooks/deploy.md`, `docs/handover.md` | runbooks                                                      |

---

### Task 7.1: Zoho API client and `.env` entries (Raouf, in the client's console)

- [ ] **Step 1:** In the client's Zoho API console (`https://api-console.zoho.com.au`, signed in as the client's Zoho admin, the account that owns `info@sarabisfinerugs.com.au`): Add Client, **Server-based Applications**, name `Sarabi Mail MCP`, homepage `https://mail-mcp.sarabisfinerugs.com.au`, authorised redirect URIs `https://mail-mcp.sarabisfinerugs.com.au/zoho/callback` and `https://mail-mcp.sarabisfinerugs.com.au/zoho/login/callback`. Create.
- [ ] **Step 2:** Add to `~/Desktop/Job_Projects/Haji/.env` (mode 600): `ZOHO_MCP_CLIENT_ID=`, `ZOHO_MCP_CLIENT_SECRET=`. Never echo them.
- [ ] **Step 3:** Read-back: `curl -s -o /dev/null -w '%{http_code}' "https://accounts.zoho.com.au/oauth/v2/auth?response_type=code&client_id=$ZOHO_MCP_CLIENT_ID&scope=openid&redirect_uri=https://mail-mcp.sarabisfinerugs.com.au/zoho/callback"` prints `302` (a sign-in redirect, not an `invalid_client` page).
- [ ] **Step 4:** Log the step (AGENT.md and CHANGELOG.md, `Raouf:` entry).

---

### Task 7.2: Run the conformance probe and update the spec

- [ ] **Step 1:** Obtain a READ-scoped refresh token for the Sarabi mailbox: in the same console create a **Self Client**, generate a code with scope `ZohoMail.messages.READ,ZohoMail.messages.CREATE,ZohoMail.messages.UPDATE,ZohoMail.folders.READ,ZohoMail.tags.ALL,ZohoMail.accounts.READ` (10 minutes), exchange it once:

```bash
curl -s -X POST https://accounts.zoho.com.au/oauth/v2/token -d grant_type=authorization_code -d "client_id=$SELF_CLIENT_ID" -d "client_secret=$SELF_CLIENT_SECRET" -d "code=$CODE" -d redirect_uri=https://mail-mcp.sarabisfinerugs.com.au/zoho/callback | python3 -c 'import sys,json; d=json.load(sys.stdin); print("ok" if "refresh_token" in d else d)'
```

Store the refresh token as `ZOHO_PROBE_REFRESH_TOKEN` in `.env` (Self Client credentials as `ZOHO_SELF_CLIENT_ID`, `ZOHO_SELF_CLIENT_SECRET`). The Self Client is deleted after the probe.

- [ ] **Step 2:** `ENV_FILE=~/Desktop/Job_Projects/Haji/.env node scripts/probe/zoho-probe.mjs`, then at 30, 60 and 120 minutes a send-to-self attempt with the stored upload triple to measure the store lifetime (the probe prints the command).
- [ ] **Step 3:** Update spec section 4 with the measured facts (search syntax that worked, list and header field names, Archive folder presence, draft `attachments` acceptance, `moveMessage` on a draft, upload store lifetime, rate-limit headers, 429 shape, the DELETE refusal). Flip `DRAFT_ATTACHMENTS_SUPPORTED` in `tools/drafts.ts` if the probe showed Zoho stores them. If the upload store lifetime is under 30 minutes, lower `UPLOAD_HANDLE_TTL_MS` to 80 percent of it and record the DO-chunk fallback as the next task; otherwise close D16's open item.
- [ ] **Step 4:** Commit the spec change in the Haji repo; log.

---

### Task 7.3: Mint the deploy token and provision

**Files:**

- Create: `scripts/deploy/mint-deploy-token.mjs`, `scripts/deploy/provision.sh`

- [ ] **Step 1:** `scripts/deploy/mint-deploy-token.mjs`:

```js
#!/usr/bin/env node
// Mints a scoped deploy token on the client's Cloudflare account from the recorded minting token.
// Prints the token ONCE to stdout for .env; never logs it.
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(process.env.ENV_FILE ?? ".env", "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const minter = env.CLOUDFLARE_API_TOKEN,
  account = env.CF_ACCOUNT_ID,
  zone = env.CF_ZONE_SARABISFINERUGS_COM_AU;
if (!minter || !account || !zone)
  throw new Error("missing CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID or CF_ZONE_SARABISFINERUGS_COM_AU");
const cf = async (path, init) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${minter}`, "content-type": "application/json" },
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  return j.result;
};
const groups = await cf("/user/tokens/permission_groups");
const id = (name) => {
  const g = groups.find((x) => x.name === name);
  if (!g) throw new Error(`permission group not found: ${name}`);
  return { id: g.id };
};
const body = {
  name: `zoho-mail-mcp deploy ${new Date().toISOString().slice(0, 10)}`,
  policies: [
    {
      effect: "allow",
      resources: { [`com.cloudflare.api.account.${account}`]: "*" },
      permission_groups: [
        "Workers Scripts Write",
        "D1 Write",
        "Workers KV Storage Write",
        "Workers Tail Read",
        "Account Settings Read",
      ].map(id),
    },
    {
      effect: "allow",
      resources: { [`com.cloudflare.api.account.zone.${zone}`]: "*" },
      permission_groups: ["DNS Write", "Workers Routes Write", "Zone Read"].map(id),
    },
  ],
  condition: {},
};
const made = await cf("/user/tokens", { method: "POST", body: JSON.stringify(body) });
process.stdout.write(`ZOHO_MCP_CF_TOKEN=${made.value}\nZOHO_MCP_CF_TOKEN_ID=${made.id}\n`);
```

The exact permission group names are read back from `/user/tokens/permission_groups` at run time; if a name differs on the day, the script fails with the name it looked for and Raouf picks the matching one from the printed list. Durable Objects need no separate group (they ride on Workers Scripts Write).

- [ ] **Step 2:** `node scripts/deploy/mint-deploy-token.mjs >> ~/Desktop/Job_Projects/Haji/.env` then verify: `curl -s -H "Authorization: Bearer $ZOHO_MCP_CF_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["status"])'` prints `active`.

- [ ] **Step 3:** `scripts/deploy/provision.sh`:

```sh
#!/bin/sh
set -eu
: "${ZOHO_MCP_CF_TOKEN:?}" "${CF_ACCOUNT_ID:?}"
export CLOUDFLARE_API_TOKEN="$ZOHO_MCP_CF_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
cd "$(dirname "$0")/../worker"
npx wrangler d1 create zoho-mail-mcp 2>/dev/null || true
DB_ID="$(npx wrangler d1 list --json | python3 -c 'import sys,json; print([d["uuid"] for d in json.load(sys.stdin) if d["name"]=="zoho-mail-mcp"][0])')"
KV_ID="$(npx wrangler kv namespace list | python3 -c 'import sys,json; l=[n["id"] for n in json.load(sys.stdin) if n["title"].endswith("OAUTH_KV")]; print(l[0] if l else "")')"
[ -n "$KV_ID" ] || KV_ID="$(npx wrangler kv namespace create OAUTH_KV | sed -n 's/.*id = "\([a-f0-9]*\)".*/\1/p')"
python3 - "$DB_ID" "$KV_ID" <<'EOF'
import json,re,sys
p="wrangler.prod.jsonc"; s=open(p).read()
s=re.sub(r'"database_id": "[^"]*"', f'"database_id": "{sys.argv[1]}"', s)
s=re.sub(r'"kv_namespaces": \[\{ "binding": "OAUTH_KV", "id": "[^"]*" \}\]', f'"kv_namespaces": [{{ "binding": "OAUTH_KV", "id": "{sys.argv[2]}" }}]', s)
open(p,"w").write(s)
EOF
npx wrangler d1 migrations apply zoho-mail-mcp --remote --config wrangler.prod.jsonc
for s in ZOHO_CLIENT_ID ZOHO_CLIENT_SECRET TOKEN_KEKS TOKEN_KEK_CURRENT STATE_HMAC_KEY CSRF_HMAC_KEY OWNER_ZOHO_SUBS OWNER_EMAILS SLOTS ORG_DOMAINS; do
  printf '%s' "$(eval "printf '%s' \"\${ZMC_$s:?}\"")" | npx wrangler secret put "$s" --config wrangler.prod.jsonc
done
npm run build:companion
npx wrangler deploy --config wrangler.prod.jsonc
npx wrangler deployments list --config wrangler.prod.jsonc | head -5
```

Secrets are exported as `ZMC_*` from `.env` by the caller (`set -a; . .env; set +a; export ZMC_ZOHO_CLIENT_ID="$ZOHO_MCP_CLIENT_ID" ...`), keys generated with `openssl rand -base64 32`. `OWNER_ZOHO_SUBS` starts empty and `OWNER_EMAILS=info@sarabisfinerugs.com.au` so the bootstrap page shows the owner's `sub` on the first login; then `OWNER_ZOHO_SUBS` is set and the Worker redeployed. `SLOTS` is `{"sarabi":"info@sarabisfinerugs.com.au","rcp":"info@rugcleaningpro.com.au"}`, `ORG_DOMAINS` `sarabisfinerugs.com.au,sarabisfinerugs.com,rugcleaningpro.com.au`.

- [ ] **Step 4:** Custom domain: `wrangler.prod.jsonc` carries `"routes": [{ "pattern": "mail-mcp.sarabisfinerugs.com.au", "custom_domain": true }]`; Cloudflare creates the DNS record on deploy. Read-back: `dig +short mail-mcp.sarabisfinerugs.com.au` resolves; `curl -s https://mail-mcp.sarabisfinerugs.com.au/healthz` prints `{"status":"ready"}` after `recovery_installation` is seeded (`wrangler d1 execute zoho-mail-mcp --remote --command "INSERT OR REPLACE INTO recovery_installation VALUES(1,5,'prod-1','active')"`).

- [ ] **Step 5:** Register the companion client on `/accounts` (owner session), confirm `GET /companion-client-id` answers. Log everything.

---

### Task 7.4: Gates G13, G14, G20

**Files:**

- Create: `scripts/gates/g13-cpu.mjs`, `scripts/gates/g14-oauth.mjs`, `scripts/gates/g20-installer.sh`

- [ ] **Step 1: G13** `scripts/gates/g13-cpu.mjs`: with a staging credential (companion login on this Mac), stage a 25 MiB random file through the real companion (`companion stage` via an MCP stdio call using `test/mcp-client.ts` logic against the deployed host), seal and download it back, approve a 50-recipient internal send payload (to the two slot addresses repeated, which the policy allows) and cancel it, and make 200 `search_messages` calls in a loop under the bucket. Then `wrangler tail --format json --config wrangler.prod.jsonc` for the window and count events whose `outcome` is `exceededCpu`. Pass: 0. The script prints the counts per phase and writes `scripts/gates/out/g13-<date>.json`. Fail: enable Workers Paid on the account with the owner's approval (D18) and rerun.

- [ ] **Step 2: G14** `scripts/gates/g14-oauth.mjs`: fetch `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`, assert `authorization_servers`, `code_challenge_methods_supported` contains `S256` and not `plain`, call `/mcp` without a bearer and assert `WWW-Authenticate` carries `resource_metadata=`, register a client at `/register` while the registration window is open and assert 201, start an authorize with a wrong `resource` and assert `invalid_target`, exchange with a token for `/staging` and present it at `/mcp` asserting 401, present a token with a tampered signature asserting 401, and run `codex mcp login zoho-mail` and `claude mcp add --transport http` plus one `list_accounts` call from each client. Pass: every assertion true and both clients list the two slots. Output `scripts/gates/out/g14-<date>.json`.

- [ ] **Step 3: G20** `scripts/gates/g20-installer.sh`: `export HOME="$(mktemp -d)"`, seed a hand-edited `Library/Application Support/Claude/claude_desktop_config.json`, run `curl -fsSL https://mail-mcp.sarabisfinerugs.com.au/install.sh | sh` with `claude` and `codex` stubbed on `PATH` to record their argv, assert: one download of `companion.tgz` (count in a recording proxy or by `DEBUG=1` echo), the tarball installed is byte-identical to the one hashed, the Desktop config kept its other entries and gained one, both stub logs show the user-scope commands, a second run changes nothing (`diff -r` of `$HOME` before and after, ignoring logs). Output `scripts/gates/out/g20-<date>.txt`.

- [ ] **Step 4:** Commit the scripts and the `out/` files (they are the evidence; no secrets in them).

---

### Task 7.5: Live round (G15 to G19 on the deployment) and the real client

- [ ] **Step 1:** Owner login with Zoho (the client's admin), bootstrap `OWNER_ZOHO_SUBS`, redeploy, login again.
- [ ] **Step 2:** Connect `sarabi` as the Sarabi Zoho user; attempt `rcp` as the same user and read the `account_mismatch` page (G15 live); connect `rcp` as the RCP Zoho user.
- [ ] **Step 3:** From Claude Code on this Mac: `search_messages`, `get_thread`, one `reply` to an outside sender in an existing thread (expect `pending_approval`; approve; verify the mail arrives), one `send_message` internal-only (expect `executed`), one `update_draft`, one `trash_message` with approval and `untrash_message`. From Codex: `list_accounts`, one `get_message`, one attachment round trip to `~/Downloads/Mail`. From Claude Desktop: one `download_attachment` saved through the Desktop-configured companion. From claude.ai: one `download_attachment` and open its one-time link.
- [ ] **Step 4:** `delivery_unknown` live: block egress to `mail.zoho.com.au` for one send using the fault switch `env.FAULT_NEXT_SEND=1` (a dev-only Worker variable honoured by `executeZohoSend` only when `RECOVERY_PROFILE=scratch`, never in production config; run this step against a scratch deployment of the same build in the same account), confirm the operation reads `delivery_unknown`, confirm the probe leaves it unknown when nothing arrived and settles it when the matching Sent item exists.
- [ ] **Step 5:** Record every result with timestamps in `docs/superpowers/reports/2026-10-xx-zoho-mail-mcp-live.md` and in the Haji logs.

---

### Task 7.6: Handover

**Files:**

- Create: `docs/handover.md` (also exported to PDF for the client), `docs/runbooks/deploy.md`

- [ ] **Step 1:** `docs/handover.md`, one page, plain English, no em dashes: the welcome URL; the install line; the Claude Desktop and claude.ai connector URL and the Settings path; what asks for approval and how to allow a regular contact; where files land and where files to send go; how to reconnect a mailbox after the Zoho org move; who to call; what the service never does (expunge mail, read other mailboxes, send without the policy's say-so).
- [ ] **Step 2:** `docs/runbooks/deploy.md`: the provision script, secret names, how to rotate the Zoho client secret, how to roll back a deploy (`wrangler rollback`), how to re-run the gates, the probe schedule after the org move.
- [ ] **Step 3:** Delete the Self Client in the Zoho console; remove `ZOHO_PROBE_REFRESH_TOKEN`, `ZOHO_SELF_CLIENT_*` from `.env`. Confirm `.env` is mode 600 and not in git.
- [ ] **Step 4:** Final log entries in the Haji `AGENT.md`, `CHANGELOG.md`, `CLAUDE.md` migration status, Zurvan decision (status accepted), memory file update.

## M7 exit checklist

- [ ] Probe results dated in spec section 4; D16 open item closed or the DO-chunk fallback scheduled.
- [ ] G13, G14, G20 evidence files committed; G15 to G19 recorded live.
- [ ] Both slots connected by their own Zoho users; `account_mismatch` seen live.
- [ ] Handover delivered; Self Client deleted; `.env` clean.

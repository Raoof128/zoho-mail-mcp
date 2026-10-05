# AGENT log

Agent work on this repository, newest last. Each entry: date (Australia/Sydney), scope, summary, files, verification, follow-ups. Plans and spec: `docs/superpowers/`; the design history lives in the Haji repo (`docs/superpowers/specs/2026-10-03-zoho-mail-mcp-design.md`).

---

## Raouf: 2026-10-04 (Australia/Sydney) - Zoho Mail MCP: M0 and M1 executed, reviewed, fixed and pushed

**Scope:** Raouf: "proceed with inline execution of M1", then "commit and push and update all logs and zurvan". Code in the new repository `~/Desktop/Raouf/zoho-mail-mcp` (private GitHub `Raoof128/zoho-mail-mcp`, branch `feat/m0-m1`; `main` is the untouched fork of gmail-mcp at 70ba710). Haji repo: carried-item notes in the M3, M4 and M5 plans, and these logs. Nothing deployed, no live Zoho writes.

**Summary:** M0 (Tasks 0.1 to 0.8: rename, squashed Zoho schema with slots and sealed handles, env and `zohoFetch` seam, Zoho actions and errors, FakeZoho, AccountDO scaffold, probe script, test helpers) and M1 (Tasks 1.1 to 1.6: Zoho OIDC client, Sign in with Zoho, AccountDO token bucket, refresh lease, call budgets and TTL cache, slot-bound connect with `account_mismatch` and lease-guarded refresh, the one Zoho client, Google identity layer retired) executed inline under TDD with a ledger; every deviation is a recorded ruling. Two security defects were found after Task 1.6 and fixed with failing tests first: (1) a background security review found Gmail-era code now holding Zoho access tokens while the production Gmail transport was still real `fetch` to gmail.googleapis.com, so the transport now refuses in production (c4d2981); (2) the final whole-branch review (Sonnet, per Raouf's subagent rule) raised six Important findings, all confirmed against the code and fixed in afd5ce2: a request path could leave the account base or origin (now refused before any request, redirects never followed); retries and the 401 re-send skipped the budget and the 25/min bucket; a 401 after a 5xx skipped the forced refresh; a streamed body could be re-sent after being consumed; a failed code exchange left Zoho's minted refresh token live; and a failure after the account row was stored revoked its grant. Earlier in Task 1.6 two recovery tests were found sending a refresh to the real accounts.zoho.com.au (fake token, no secret); a test-setup guard now refuses every real network call. Nine Minor findings are deferred (listed in the zoho repo's CHANGELOG).

**Files Changed:** zoho-mail-mcp: 27 commits on `feat/m0-m1` (7ce659c..afd5ce2), `AGENT.md` (new), `CHANGELOG.md`. Haji: `docs/superpowers/plans/2026-10-03-zoho-mail-mcp-{m3-compose-and-recovery,m4-organise-tools,m5-attachments-streaming}.md` (carried items: `0002_accounts_slot_unique.sql` and the recovery probe rewrite in M3 Task 3.6; `label.manage` allow with `+destructive` in M4 Task 4.1; `googleFetch`, FakeGoogle and FakeGmail removal in M4 Task 4.2; `stage_upload` allow with `+outside_outbox` in M5 Task 5.3), `AGENT.md`, `CHANGELOG.md`.

**Verification:** `npm run verify` exit 0 after the fix pass: Worker 698 passed and 1 todo (90 files), shared 7, companion 23 passed and 1 skipped, qualification 165. Each of the 14 review-fix tests was watched failing for the stated reason before its fix. One verify run before that hit a 5 s timeout at load average 31 and passed on rerun. `gh repo view Raoof128/zoho-mail-mcp` reports PRIVATE; no `.env`, `.dev.vars` or key file is tracked.

**Follow-ups:** M2 (read tools) is next; pin `toolCallId` uniqueness per invocation there (review minor 13). Run the M0 probe against the client's real Zoho to confirm `INVALID_OAUTHTOKEN` shape and the account `type` field. Deferred minors 7 to 15 are tracked in the zoho CHANGELOG. Merge `feat/m0-m1` into `main` only on Raouf's say-so.

**M1 rulings (from the deleted ledger, 2026-10-04):**

- Task 1.2: FakeGoogle gained a transitional Zoho Accounts face so 21 Gmail-era test files keep logging in. Cost if wrong: test-only, removed in M4 Task 4.2.
- Task 1.2: `src/web` kept the Google connect form in `accounts.ts` until Task 1.4 replaced it. Tests now override `OWNER_ZOHO_SUBS` and assert the Zoho CSP. Cost if wrong: test-only.
- Task 1.3: five needless casts in the plan's Durable Object test were removed. Cost if wrong: none.
- Task 1.4: the plan's lease loop fell through to an unguarded refresh. It now refuses with `rate_limited` and uses another holder's token only when it is newer. A concurrent-refresh test was added and watched failing. Cost if wrong: a busy account waits instead of refreshing twice.
- Task 1.4: the fake's revoke handler now reads `?token=`, as Zoho does. Cost if wrong: test-only.
- Task 1.4: reconnects are keyed by slot, not by Zoho sub, because the org move returns the same mailbox under a new Zoho user. Cost if wrong: a reconnect could rebind a slot to another user who owns the same address.
- Task 1.4: `connectRequired` resolves the slot from the alias. Organisation domains are deployment-wide, so the per-account form was removed. The Google connect test was deleted early. The accounts page keeps its per-account blocks. Cost if wrong: an owner cannot widen trusted domains per account.
- Tasks 1.4 and 1.5: lint fixes were made in the plan's code blocks. Cost if wrong: none.
- Task 1.6: `Deps.googleFetch` stays until M4 Task 4.2. Its production default refuses every request. Cost if wrong: one seam removed later.
- Task 1.6: two recovery tests had reached the real accounts.zoho.com.au. Their stubs moved to `zohoFetch`, and `test/setup.ts` now rejects all real fetches. Cost if wrong: none.
- Task 1.6: recovery-http now matches `ZOHO.tokenUrl`. The plan's flaky TTL test was made deterministic. Cost if wrong: none.
- Final: the security review's "auth-bypass" in recovery-http is the same token leak, which the transport fix closed. The final reviewer ran on Sonnet, per Raouf's standing subagent rule. Cost if wrong: a weaker review; ask for a second pass.

---

## Raouf: 2026-10-05 (Australia/Sydney) - Zoho Mail MCP: M2 read tools executed, reviewed, fixed and pushed

**Scope:** Raouf: "proceed to M2". Code in `~/Desktop/Raouf/zoho-mail-mcp`, branch `feat/m2-read-tools` (off `feat/m0-m1`), pushed to the private `Raoof128/zoho-mail-mcp`. Haji: carried-item notes in the M3, M4 and M5 plans and these logs. Nothing deployed, no live Zoho calls.

**Summary:** M2 Tasks 2.1 to 2.5 executed inline under TDD: typed Zoho Mail wrappers and Zoho-shaped schemas, the message view model, system folders cached in the account Durable Object, and the eight read tools (`search_messages`, `search_threads`, `get_thread`, `get_message`, `list_drafts`, `get_draft`, `list_labels`, `list_folders`) answering from Zoho with each message's own folder id. Plan defects ruled during execution: deleting `GmailId` outright broke 55 Gmail-era tests, so an interim `LegacyGmailId` stays on Gmail-backed schemas until M3 and M4 rewrite them; `get_thread` as planned spent 3 Zoho calls per body, so 3 bodies used the whole 10-request budget, and thread bodies now cost one call each (1 + 8 = 9); the tool-call id is drawn once per invocation so per-call budgets hold. The final review (Sonnet) found one Critical and eight Important issues, verified against the saved official Zoho pages: the code was written to the test double, not to Zoho's documented list and search shapes (string versus numeric fields, lowercase `receivedtime`, numeric flag ids, escaped addresses, and 19-digit ids that lose precision as JSON numbers, now read from `URI`); folder search used `folder:` instead of `in:`; HTML to text was quadratic (22 s on 480 KB of hostile markup); `get_thread`'s cursor could not be passed back; `search_threads` skipped threads between pages; list calls omitted To details; a bare-id probe hid outages; a custom folder named Sent could shadow the real one. All fixed test-first; the double now answers in the documented shapes. Cross-folder thread listing and the meaning of list status "1" are carried to the M0 probe on the client's tenant.

**Files Changed:** zoho-mail-mcp: `shared/src/schemas.ts`, `worker/src/zoho/{mail,messages,folders,client}.ts`, `worker/src/tools/read.ts`, tests `zoho-mail`, `zoho-messages`, `zoho-folders`, `read-tools`, `m2-review-fixes`, `mcp`, `send-tools`, `fake-zoho-mail`; `AGENT.md`, `CHANGELOG.md`; plans M3 to M5 (carried notes). Haji: the same three plan notes, `AGENT.md`, `CHANGELOG.md`, `CLAUDE.md`.

**Verification:** `npm run verify` exit 0: Worker 717 passed and 1 todo (93 files), shared 7, companion 23 passed and 1 skipped, qualification 165. Every review-fix test was watched failing for the stated reason; tests that passed early were proven by toggling the code they guard.

**Follow-ups:** M3 compose and recovery is next. Probe items for the client's tenant: thread listing across folders without `folderId`, list `status` "1", the `details`, `content`, `header` and `originalmessage` shapes. Eight review minors deferred (listed in the zoho CHANGELOG). `download_attachment` returns in M5 Task 5.1.

**M2 rulings (from the ledger, deleted after the clean review):**

- Task 2.1: `ZohoId` (digits) for all new Zoho code; an interim `LegacyGmailId` stays on Gmail-backed schemas, moving to `ZohoId` as M3 and M4 rewrite each tool and deleted in M4 Task 4.2. Cost if wrong: a Gmail-shaped id passes validation on a Zoho tool until then, and Zoho answers 404.
- Task 2.1: the interim Gmail read path dropped `include_spam_trash` and the drafts query. A test now proves a label delete works while a message delete is still refused. Cost if wrong: none.
- Task 2.4: the tool-call id is drawn once per invocation, so per-call budgets hold. Cost if wrong: none.
- Task 2.4: thread bodies cost one Zoho call each (1 + 8 = 9). Thread messages carry no threading headers or attachment lists; `get_message` gives those. Cost if wrong: extra calls for an agent that needs every header.
- Task 2.4: the test fixture uses the real slot alias. The read inputs moved to `ZohoId`. `download_attachment` is unregistered until M5. A Gmail send test reads part ids from the Gmail double. Cost if wrong: test-only, and no attachment download until M5.
- Task 2.5: `google/messages.ts` stays until M3 and M4, because the Gmail-era tools still use it. Cost if wrong: none.
- Final: a missing system folder stays an error, and the 10-minute folder cache stays, because system folders cannot be deleted. Cost if wrong: 404s for up to 10 minutes after an impossible event.
- Final: cross-folder thread listing is carried to the M0 probe. Cost if wrong: `get_thread` omits replies stored in other folders.
- Final: the test double answers in the documented shapes. The reviewer ran on Sonnet. Cost if wrong: test-only, and a weaker review.

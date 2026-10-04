# M1: Sign in with Zoho, slot-bound connect, account Durable Object, Zoho client

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner signs in with Zoho, connects exactly the two expected mailboxes, and every Zoho call runs through one client that is admitted by the account's Durable Object, refreshes tokens once across isolates, and maps Zoho's errors correctly.

**Architecture:** `worker/src/zoho/oidc.ts` mirrors `google/oidc.ts` against `accounts.zoho.com.au`. `web/login.ts` switches provider. `connect.ts` carries the slot and refuses a mismatched mailbox. `AccountDO` holds a token bucket, a refresh lease and per-call budgets in SQLite. `tokens.ts` keeps the D1-guarded credential writes from Gmail and adds the DO lease for single flight. `client.ts` is the only path to `mail.zoho.com.au`.

**Tech Stack:** as the master plan. `jose` for JWKS verification, `cloudflare:workers` `DurableObject`.

**Spec:** sections 1 (D2, D3, D6, D7, D8), 2.1, 3.2, 3.3, 4 (error shape), 8 gate G15.

**Master:** `2026-10-03-zoho-mail-mcp-00-master.md`.

## File map

| Path | Responsibility |
|---|---|
| `worker/src/zoho/oidc.ts` | Zoho endpoints, auth URL, code exchange, refresh, id_token verification, accounts fetch, revoke |
| `worker/src/web/login.ts`, `worker/src/web/html.ts` | Owner login via Zoho, CSP form-action |
| `worker/src/zoho/account-do.ts` | bucket, refresh lease, budgets |
| `worker/src/zoho/tokens.ts` | `getAccessToken` with DO lease |
| `worker/src/zoho/connect.ts` | `/connect?slot=` and `/zoho/callback` |
| `worker/src/web/pages/accounts.ts` | two slot rows with Connect or Reconnect |
| `worker/src/zoho/client.ts` | `zohoJson`, `zohoStream`, `ZohoApiError` |
| `worker/test/zoho-oidc.test.ts`, `zoho-connect.test.ts`, `account-do.test.ts`, `zoho-client.test.ts`, `login.test.ts` | tests |

---

### Task 1.1: `zoho/oidc.ts`

**Files:**
- Create: `worker/src/zoho/oidc.ts`
- Test: `worker/test/zoho-oidc.test.ts`

**Interfaces:**
- Produces: `ZOHO`, `LOGIN_SCOPES`, `CONNECT_SCOPES`, `buildAuthUrl(env, o)`, `exchangeCode(env, deps, o): Promise<TokenResponse>` (`TokenResponse.location` is optional: verified live 2026-10-04, Zoho omits it unless multi-DC is enabled on the API client; `api_domain` must end in `.com.au`), `refreshAccessToken(env, deps, refreshToken): Promise<{access_token, expires_in} | "invalid_grant">` (Zoho answers token failures with HTTP 200 and `{error}`; `invalid_code` is a dead refresh token, verified live), `verifyIdToken(env, deps, idToken, {nonce}): Promise<{sub, email}>`, `fetchZohoAccounts(deps, location, accessToken): Promise<ZohoAccount[]>`, `revokeToken(deps, token)`, `hasScope(granted: string, needed: string): boolean`.

- [ ] **Step 1: Write the failing tests**

`worker/test/zoho-oidc.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FakeZoho } from "./fake-zoho";
import { testEnv, testDeps } from "./test-env";
import { ZOHO, CONNECT_SCOPES, buildAuthUrl, exchangeCode, verifyIdToken, fetchZohoAccounts, hasScope, refreshAccessToken } from "../src/zoho/oidc";

describe("zoho oidc", () => {
  it("builds an AU authorisation URL with comma scopes, offline access and consent", () => {
    const u = new URL(buildAuthUrl(testEnv(), { redirectUri: "https://h/zoho/callback", scope: CONNECT_SCOPES, state: "s", nonce: "n", offline: true }));
    expect(u.origin).toBe("https://accounts.zoho.com.au");
    expect(u.searchParams.get("scope")).toBe("openid,email,ZohoMail.messages.READ,ZohoMail.messages.CREATE,ZohoMail.messages.UPDATE,ZohoMail.folders.READ,ZohoMail.tags.ALL,ZohoMail.accounts.READ");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });
  it("exchanges a code, keeps location, verifies the id_token and lists accounts", async () => {
    const z = await FakeZoho.create();
    z.accounts.set("sub-1", { accountId: "191", primaryEmail: "sarabi@example.test", sendAs: ["sarabi@example.test", "rcp@example.test"] });
    const code = z.grantCode({ sub: "sub-1", email: "sarabi@example.test", nonce: "n1" });
    const t = await exchangeCode(testEnv(), testDeps(z), { code, redirectUri: "https://h/zoho/callback" });
    expect(t.location).toBeUndefined(); // single-DC client: Zoho omits it; the client routes on the deployment DC
    expect(t.api_domain).toBe("https://www.zohoapis.com.au");
    const id = await verifyIdToken(testEnv(), testDeps(z), t.id_token!, { nonce: "n1" });
    expect(id).toEqual({ sub: "sub-1", email: "sarabi@example.test" });
    const accounts = await fetchZohoAccounts(testDeps(z), "au", t.access_token);
    expect(accounts).toEqual([{ accountId: "191", primaryEmail: "sarabi@example.test", sendAs: ["sarabi@example.test", "rcp@example.test"] }]);
  });
  it("rejects a wrong nonce, a wrong issuer and a non-au location", async () => {
    const z = await FakeZoho.create();
    const bad = await z.issue({ sub: "s", email: "e@example.test", nonce: "x", iss: "https://accounts.zoho.com" });
    await expect(verifyIdToken(testEnv(), testDeps(z), bad, { nonce: "x" })).rejects.toThrow(/id_token rejected/);
    const good = await z.issue({ sub: "s", email: "e@example.test", nonce: "x" });
    await expect(verifyIdToken(testEnv(), testDeps(z), good, { nonce: "other" })).rejects.toThrow(/nonce/);
    expect(() => ZOHO.mailBase("eu" as never)).toThrow(/location/);
  });
  it("accepts VirtualOffice spelling and ALL when checking scopes, refuses CREATE for READ", () => {
    expect(hasScope("VirtualOffice.messages.CREATE VirtualOffice.accounts.READ", "ZohoMail.accounts.READ")).toBe(true);
    expect(hasScope("VirtualOffice.messages.CREATE", "ZohoMail.messages.READ")).toBe(false);
    expect(hasScope("ZohoMail.messages.ALL", "ZohoMail.messages.UPDATE")).toBe(true);
  });
  it("maps a 200 {error: invalid_code} refresh to invalid_grant and any other token error to a refusal", async () => {
    const z = await FakeZoho.create();
    expect(await refreshAccessToken(testEnv(), testDeps(z), "rt-nope")).toBe("invalid_grant");
    await expect(exchangeCode(testEnv({ ZOHO_CLIENT_SECRET: "wrong" }), testDeps(z), { code: "x", redirectUri: "https://h/cb" })).rejects.toThrow(/invalid_client_secret/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
cd worker && npx vitest run test/zoho-oidc.test.ts
```
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`worker/src/zoho/oidc.ts`:

```ts
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { McpError } from "@zoho-mail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";

const ACCOUNTS = "https://accounts.zoho.com.au";
export type Location = "au";
export const ZOHO = {
  issuer: ACCOUNTS,
  authUrl: `${ACCOUNTS}/oauth/v2/auth`,
  tokenUrl: `${ACCOUNTS}/oauth/v2/token`,
  jwksUrl: `${ACCOUNTS}/oauth/v2/keys`,
  revokeUrl: `${ACCOUNTS}/oauth/v2/token/revoke`,
  /** Spec D7: the Mail host comes from `location`, never from `api_domain`. Only AU is deployed. */
  mailBase(location: Location): string {
    if (location !== "au") throw new McpError("internal", `unsupported Zoho location ${String(location)}`);
    return "https://mail.zoho.com.au/api";
  },
} as const;

export const LOGIN_SCOPES = "openid,email,profile";
/** Spec D6: least privilege, no messages.DELETE, no folder writes. Comma separated, Zoho's separator. */
export const CONNECT_SCOPES =
  "openid,email,ZohoMail.messages.READ,ZohoMail.messages.CREATE,ZohoMail.messages.UPDATE,ZohoMail.folders.READ,ZohoMail.tags.ALL,ZohoMail.accounts.READ";

export function buildAuthUrl(
  env: Env,
  o: { redirectUri: string; scope: string; state: string; nonce: string; offline: boolean },
): string {
  const u = new URL(ZOHO.authUrl);
  u.searchParams.set("client_id", env.ZOHO_CLIENT_ID);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", o.scope);
  u.searchParams.set("state", o.state);
  u.searchParams.set("nonce", o.nonce);
  if (o.offline) {
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
  }
  return u.toString();
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((t) => t.toLowerCase() === "bearer"),
  expires_in: z.number().int().min(1).max(86_400),
  scope: z.string(),
  api_domain: z.string().optional(),
  /** Present only for multi-DC clients (verified live 2026-10-04: absent for the client's app). The deployment is AU-only. */
  location: z.literal("au").optional(),
  id_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;
const RefreshResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().int().min(1).max(86_400) });
/** Zoho answers token-endpoint failures with HTTP 200 and an `error` field (verified live 2026-10-04: invalid_code, invalid_client_secret). */
const TokenError = z.object({ error: z.string() });
function assertAuDomain(apiDomain: string | undefined): void {
  if (apiDomain !== undefined && !/\.com\.au$/.test(new URL(apiDomain).hostname))
    throw new McpError("internal", `zoho token belongs to another data centre: ${apiDomain}`);
}

async function tokenPost(env: Env, deps: Deps, form: Record<string, string>): Promise<Response> {
  return deps.zohoFetch(ZOHO.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.ZOHO_CLIENT_ID, client_secret: env.ZOHO_CLIENT_SECRET, ...form }),
  });
}

export async function exchangeCode(env: Env, deps: Deps, o: { code: string; redirectUri: string }): Promise<TokenResponse> {
  const res = await tokenPost(env, deps, { grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri });
  const body: unknown = await res.json().catch(() => null);
  const err = TokenError.safeParse(body);
  if (err.success) throw new McpError("unauthorized", `zoho token endpoint refused: ${err.data.error}`);
  if (!res.ok) throw new McpError("internal", `zoho token endpoint ${res.status}`);
  const parsed = TokenResponse.safeParse(body);
  if (!parsed.success) throw new McpError("internal", "zoho token endpoint returned an unexpected body");
  assertAuDomain(parsed.data.api_domain);
  return parsed.data;
}

export async function refreshAccessToken(
  env: Env,
  deps: Deps,
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number } | "invalid_grant"> {
  const res = await tokenPost(env, deps, { grant_type: "refresh_token", refresh_token: refreshToken });
  const body: unknown = await res.json().catch(() => null);
  const err = TokenError.safeParse(body);
  // Zoho says 200 either way; the body decides. invalid_code is what a revoked or unknown refresh token gets.
  if (err.success) {
    if (["invalid_code", "invalid_grant", "invalid_token"].includes(err.data.error)) return "invalid_grant";
    throw new McpError("internal", `zoho refresh refused: ${err.data.error}`);
  }
  if (!res.ok) throw new McpError("internal", `zoho refresh ${res.status}`);
  const parsed = RefreshResponse.safeParse(body);
  if (!parsed.success) throw new McpError("internal", "zoho refresh returned an unexpected body");
  return parsed.data;
}

async function jwks(deps: Deps) {
  const res = await deps.zohoFetch(ZOHO.jwksUrl);
  if (!res.ok) throw new McpError("internal", `zoho jwks ${res.status}`);
  return createLocalJWKSet(await res.json<JSONWebKeySet>());
}

export async function verifyIdToken(env: Env, deps: Deps, idToken: string, o: { nonce: string }): Promise<{ sub: string; email: string }> {
  try {
    const { payload } = await jwtVerify(idToken, await jwks(deps), {
      issuer: ZOHO.issuer,
      audience: env.ZOHO_CLIENT_ID,
      algorithms: ["RS256", "RS384"],
      requiredClaims: ["sub", "email", "iat", "exp", "nonce"],
      maxTokenAge: "10 minutes",
      clockTolerance: 60,
    });
    if (payload.nonce !== o.nonce) throw new Error("nonce");
    if (payload.email_verified !== true) throw new Error("email_verified");
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") throw new Error("claims");
    return { sub: payload.sub, email: payload.email.toLowerCase() };
  } catch (e) {
    throw new McpError("unauthorized", `id_token rejected: ${(e as Error).message}`);
  }
}

/** Zoho echoes Mail scopes as VirtualOffice.*; ALL covers every operation. */
export function hasScope(granted: string, needed: string): boolean {
  const [, resource, op] = needed.split(".");
  return granted.split(/[\s,]+/).some((g) => {
    const [svc, res, o] = g.split(".");
    return (svc === "ZohoMail" || svc === "VirtualOffice") && res === resource && (o === "ALL" || o === op);
  });
}

export type ZohoAccount = { accountId: string; primaryEmail: string; sendAs: string[] };
const AccountsResponse = z.object({
  data: z.array(
    z.object({
      accountId: z.string(),
      primaryEmailAddress: z.string(),
      sendMailDetails: z.array(z.object({ fromAddress: z.string() })).default([]),
    }),
  ),
});
export async function fetchZohoAccounts(deps: Deps, location: Location, accessToken: string): Promise<ZohoAccount[]> {
  const res = await deps.zohoFetch(`${ZOHO.mailBase(location)}/accounts`, { headers: { authorization: `Zoho-oauthtoken ${accessToken}`, accept: "application/json" } });
  if (!res.ok) throw new McpError("internal", `zoho accounts ${res.status}`);
  const parsed = AccountsResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new McpError("internal", "zoho accounts returned an unexpected body");
  return parsed.data.data.map((a) => ({
    accountId: a.accountId,
    primaryEmail: a.primaryEmailAddress.toLowerCase(),
    sendAs: [...new Set(a.sendMailDetails.map((s) => s.fromAddress.toLowerCase()))],
  }));
}

export async function revokeToken(deps: Deps, token: string): Promise<void> {
  await deps.zohoFetch(`${ZOHO.revokeUrl}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => undefined);
}
```

- [ ] **Step 4: Run, verify, commit**

```bash
cd worker && npx vitest run test/zoho-oidc.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(zoho): OIDC and OAuth client for accounts.zoho.com.au"
```

---

### Task 1.2: Owner login through Zoho

**Files:**
- Modify: `worker/src/web/login.ts` (imports from `../zoho/oidc`, `OWNER_ZOHO_SUBS` wording), `worker/src/web/html.ts` (CSP `form-action 'self' https://accounts.zoho.com.au`), `worker/src/web/static.ts` (button text "Sign in with Zoho")
- Test: `worker/test/login.test.ts` (existing, re-pointed at `FakeZoho`)

- [ ] **Step 1: Re-point the existing login test**

In `worker/test/login.test.ts` replace `FakeGoogle` with `FakeZoho`, `g.grantCode` stays (`FakeZoho.grantCode` has the same shape), and the owner bootstrap assertion text from `OWNER_GOOGLE_SUBS` to `OWNER_ZOHO_SUBS`. Run it:

```bash
cd worker && npx vitest run test/login.test.ts
```
Expected: FAIL, the callback still exchanges against Google.

- [ ] **Step 2: Implement**

In `worker/src/web/login.ts`:
- `import { LOGIN_SCOPES, buildAuthUrl, exchangeCode, verifyIdToken } from "../zoho/oidc";`
- In `oidcCallback`: `const tokens = await exchangeCode(...)`; then `if (!tokens.id_token) return htmlResponse("Login failed", "<p>Zoho returned no identity token.</p>", null, 400);` and `verifyIdToken(env, deps, tokens.id_token, { nonce: st.nonce })`.
- Bootstrap page text: replace `Google` with `Zoho`, `OWNER_GOOGLE_SUBS` with `OWNER_ZOHO_SUBS`, and the sentence about Gmail or Workspace mailboxes with: `Zoho marks the address verified when the user confirmed it once.`
- Error text `Google refused:` becomes `Zoho refused:`.
- Rename the callback path constant: `loginRedirectUri` returns `https://${env.WORKER_HOSTNAME}/zoho/login/callback` and the route pattern becomes `/^\/zoho\/login\/callback$/` (spec D5 names both redirect URIs).

In `worker/src/web/html.ts` line 13: `form-action 'self' https://accounts.zoho.com.au`.

In `worker/src/env.ts`: `ownerSubs()` now reads `OWNER_ZOHO_SUBS` (delete `ownerZohoSubs` and `OWNER_GOOGLE_SUBS`); `test-env.ts` drops `OWNER_GOOGLE_SUBS`. Then run M0 Task 0.8 (the test helpers) before continuing.

In `worker/src/web/static.ts` and `login.ts` page copy: every "Google" becomes "Zoho"; `grep -n "Google" worker/src/web/*.ts worker/src/web/pages/*.ts` must return 0 after this task, except the comment in `index.ts` that explains CIMD (delete the word there too).

- [ ] **Step 3: Run, verify, commit**

```bash
cd worker && npx vitest run test/login.test.ts && cd .. && npm run verify && grep -rn "Google\|google" worker/src/web | wc -l
git add -A && git commit -m "feat(web): owner login is Sign in with Zoho"
```
Expected grep count: 0.

---

### Task 1.3: `AccountDO`: bucket, refresh lease, budgets

**Files:**
- Modify: `worker/src/zoho/account-do.ts`
- Test: `worker/test/account-do.test.ts`

**Interfaces:**
- Produces: `admit(toolCallId: string): Promise<AdmitResult>`; `budget(toolCallId: string, counter: BudgetCounter, n: number): Promise<boolean>` (true if within budget after adding `n`); `acquireRefreshLease(holder: string, ttlMs: number): Promise<"acquired" | "held">`; `releaseRefreshLease(holder: string): Promise<void>`; `systemFoldersCache(get: true) | (set: Record<string,string>)` via `getCache(key)`/`setCache(key, value, ttlMs)`; constants `BUCKET_CAPACITY = 25`, `REFILL_PER_MS = 25 / 60_000`, `BUDGETS = { requests: 10, bodies: 8, attachments: 10, bytes: 32 * 1_000_000 }`.

- [ ] **Step 1: Write the failing tests**

Replace `worker/test/account-do.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { accountStub, BUCKET_CAPACITY, BUDGETS } from "../src/zoho/account-do";

describe("AccountDO", () => {
  it("admits 25 requests a minute per account and refuses the 26th with a retry_after", async () => {
    const stub = accountStub(env as never, "bucket-1");
    for (let i = 0; i < BUCKET_CAPACITY; i++) expect(await stub.admit(`c${i}`)).toEqual({ ok: true });
    const r = await stub.admit("c26");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retry_after_ms).toBeGreaterThan(0);
    const other = accountStub(env as never, "bucket-2");
    expect(await other.admit("x")).toEqual({ ok: true });
  });
  it("counts budgets per tool call and refuses past the cap", async () => {
    const stub = accountStub(env as never, "budget-1");
    for (let i = 0; i < BUDGETS.requests; i++) expect(await stub.budget("call-a", "requests", 1)).toBe(true);
    expect(await stub.budget("call-a", "requests", 1)).toBe(false);
    expect(await stub.budget("call-b", "requests", 1)).toBe(true);
    expect(await stub.budget("call-a", "bytes", BUDGETS.bytes)).toBe(true);
    expect(await stub.budget("call-a", "bytes", 1)).toBe(false);
  });
  it("hands the refresh lease to one holder at a time and expires it", async () => {
    const stub = accountStub(env as never, "lease-1");
    expect(await stub.acquireRefreshLease("h1", 50)).toBe("acquired");
    expect(await stub.acquireRefreshLease("h2", 50)).toBe("held");
    await new Promise((r) => setTimeout(r, 60));
    expect(await stub.acquireRefreshLease("h2", 50)).toBe("acquired");
    await stub.releaseRefreshLease("h2");
    expect(await stub.acquireRefreshLease("h3", 50)).toBe("acquired");
  });
  it("caches a value with a ttl", async () => {
    const stub = accountStub(env as never, "cache-1");
    await stub.setCache("folders", JSON.stringify({ inbox: "1" }), 50);
    expect(await stub.getCache("folders")).toBe(JSON.stringify({ inbox: "1" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(await stub.getCache("folders")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
cd worker && npx vitest run test/account-do.test.ts
```
Expected: FAIL, `admit is not a function`.

- [ ] **Step 3: Implement**

`worker/src/zoho/account-do.ts` (whole file):

```ts
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export const BUCKET_CAPACITY = 25;
export const REFILL_PER_MS = BUCKET_CAPACITY / 60_000;
export const BUDGETS = { requests: 10, bodies: 8, attachments: 10, bytes: 32 * 1_000_000 } as const;
export type BudgetCounter = keyof typeof BUDGETS;
export type AdmitResult = { ok: true } | { ok: false; retry_after_ms: number };

/**
 * One object per Zoho account (spec D8). Everything here needs strong consistency across isolates:
 * the 25 a minute bucket under Zoho's 30 a minute lock-out, the single-flight refresh, and the
 * per-tool-call budgets (D17). SQLite-backed, available on the Workers Free plan.
 */
export class AccountDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bucket(id INTEGER PRIMARY KEY CHECK(id=1), tokens REAL NOT NULL, updated_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO bucket VALUES (1, ${BUCKET_CAPACITY}, ${Date.now()});
      CREATE TABLE IF NOT EXISTS budgets(call_id TEXT NOT NULL, counter TEXT NOT NULL, used INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(call_id, counter));
      CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1), holder TEXT NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, value TEXT NOT NULL, until INTEGER NOT NULL);
    `);
  }
  ping(): "pong" {
    return "pong";
  }
  admit(_toolCallId: string): AdmitResult {
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{ tokens: number; updated_at: number }>("SELECT tokens, updated_at FROM bucket WHERE id=1").one();
    const tokens = Math.min(BUCKET_CAPACITY, row.tokens + (now - row.updated_at) * REFILL_PER_MS);
    if (tokens < 1) {
      this.ctx.storage.sql.exec("UPDATE bucket SET tokens=?, updated_at=? WHERE id=1", tokens, now);
      return { ok: false, retry_after_ms: Math.ceil((1 - tokens) / REFILL_PER_MS) };
    }
    this.ctx.storage.sql.exec("UPDATE bucket SET tokens=?, updated_at=? WHERE id=1", tokens - 1, now);
    return { ok: true };
  }
  budget(toolCallId: string, counter: BudgetCounter, n: number): boolean {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM budgets WHERE created_at < ?", now - 15 * 60_000);
    const row = this.ctx.storage.sql.exec<{ used: number }>("SELECT used FROM budgets WHERE call_id=? AND counter=?", toolCallId, counter).toArray()[0];
    const used = (row?.used ?? 0) + n;
    if (used > BUDGETS[counter]) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO budgets(call_id, counter, used, created_at) VALUES (?,?,?,?) ON CONFLICT(call_id, counter) DO UPDATE SET used=excluded.used",
      toolCallId, counter, used, now,
    );
    return true;
  }
  acquireRefreshLease(holder: string, ttlMs: number): "acquired" | "held" {
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{ holder: string; until: number }>("SELECT holder, until FROM lease WHERE id=1").toArray()[0];
    if (row && row.until > now && row.holder !== holder) return "held";
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO lease VALUES (1, ?, ?)", holder, now + ttlMs);
    return "acquired";
  }
  releaseRefreshLease(holder: string): void {
    this.ctx.storage.sql.exec("DELETE FROM lease WHERE id=1 AND holder=?", holder);
  }
  getCache(key: string): string | null {
    const row = this.ctx.storage.sql.exec<{ value: string; until: number }>("SELECT value, until FROM cache WHERE key=?", key).toArray()[0];
    if (!row || row.until <= Date.now()) return null;
    return row.value;
  }
  setCache(key: string, value: string, ttlMs: number): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO cache VALUES (?,?,?)", key, value, Date.now() + ttlMs);
  }
}
export function accountStub(env: Env, accountId: string): DurableObjectStub<AccountDO> {
  return env.ACCOUNT_DO.get(env.ACCOUNT_DO.idFromName(accountId));
}
```

- [ ] **Step 4: Run, verify, commit**

```bash
cd worker && npx vitest run test/account-do.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(do): token bucket, refresh lease, call budgets and ttl cache per account"
```

---

### Task 1.4: `zoho/tokens.ts` and slot-bound `zoho/connect.ts`

**Files:**
- Create: `worker/src/zoho/tokens.ts` (port of `google/tokens.ts`), `worker/src/zoho/connect.ts`
- Modify: `worker/src/web/pages/accounts.ts` (slot rows), `worker/src/tools/accounts.ts` (`COLS` uses `zoho_email`, adds `slot`, `zohoAccountId`, `location`), `worker/src/index.ts` (route import), `worker/src/mcp/server.ts` (`connect_account` takes `slot`)
- Test: `worker/test/zoho-connect.test.ts`, `worker/test/tokens.test.ts` (re-pointed)

**Interfaces:**
- Produces: `getAccessToken(env, deps, userId, accountId, o?)` as Gmail, single-flight through `acquireRefreshLease`; `revokeAccount(env, deps, userId, accountId)`; `connectRoutes`; `connectUrl(env, userId, slot)`; `AccountRef` gains `slot: Slot`, `zohoAccountId: string`, `location: "au"`.

- [ ] **Step 1: Write the failing connect test**

`worker/test/zoho-connect.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { FakeZoho } from "./fake-zoho";
import { testEnv, testDeps, HOST } from "./test-env";
import { createWorker } from "../src/index";
import { loginAs } from "./zoho-helpers";

describe("connect with slots", () => {
  it("stores the account when the Zoho user owns the slot's address, refuses otherwise", async () => {
    const z = await FakeZoho.create();
    z.accounts.set("owner-sub", { accountId: "191", primaryEmail: "sarabi@example.test", sendAs: ["sarabi@example.test", "rcp@example.test"] });
    z.accounts.set("rcp-sub", { accountId: "192", primaryEmail: "rcp@example.test", sendAs: ["rcp@example.test"] });
    const w = createWorker(testDeps(z));
    const e = testEnv();
    const b = await loginAs(w, e, z, { sub: "owner-sub", email: "sarabi@example.test" });
    // Start connect for slot sarabi, follow to Zoho, come back with a code for the owner's Zoho user.
    const start = await b.get(`/connect?slot=sarabi`);
    expect(start.status).toBe(303);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const code = z.grantCode({ sub: "owner-sub", email: "sarabi@example.test", nonce: "ignored" });
    // The nonce is bound by the stored state; the fake signs whatever we pass, so read it back:
    const nonce = JSON.parse((await e.DB.prepare("SELECT payload FROM oauth_states WHERE id=?").bind(state).first<{ payload: string }>())!.payload).nonce as string;
    z.codes.get(code)!.nonce = nonce;
    const cb = await b.get(`/zoho/callback?state=${state}&code=${code}`);
    expect(cb.status).toBe(303);
    const row = await e.DB.prepare("SELECT slot, zoho_account_id, zoho_email, send_as FROM accounts WHERE user_id='owner-sub'").first<{ slot: string; zoho_account_id: string; zoho_email: string; send_as: string }>();
    expect(row).toEqual({ slot: "sarabi", zoho_account_id: "191", zoho_email: "sarabi@example.test", send_as: JSON.stringify(["sarabi@example.test", "rcp@example.test"]) });

    // Wrong user for slot rcp: the Sarabi Zoho user has no rcp mailbox.
    const start2 = await b.get(`/connect?slot=rcp`);
    const state2 = new URL(start2.headers.get("location")!).searchParams.get("state")!;
    const code2 = z.grantCode({ sub: "owner-sub", email: "sarabi@example.test", nonce: "x" });
    z.codes.get(code2)!.nonce = JSON.parse((await e.DB.prepare("SELECT payload FROM oauth_states WHERE id=?").bind(state2).first<{ payload: string }>())!.payload).nonce;
    const cb2 = await b.get(`/zoho/callback?state=${state2}&code=${code2}`);
    expect(cb2.status).toBe(409);
    expect(await cb2.text()).toContain("account_mismatch");
    expect((await e.DB.prepare("SELECT count(*) AS n FROM accounts WHERE slot='rcp'").first<{ n: number }>())!.n).toBe(0);
    expect(z.revoked.size).toBe(1); // the refused grant was revoked
  });
  it("refuses a slot that is not sarabi or rcp", async () => {
    const z = await FakeZoho.create();
    const w = createWorker(testDeps(z));
    const e = testEnv();
    const b = await loginAs(w, e, z, { sub: "owner-sub", email: "sarabi@example.test" });
    const r = await b.get(`/connect?slot=other`);
    expect(r.status).toBe(400);
  });
});
```

`loginAs` comes from M0 Task 0.8. In `worker/test/browser.ts`, `Browser.login` must now follow the Zoho redirect: read `state` and `nonce` from the `accounts.zoho.com.au` URL and call `/zoho/login/callback`; its `g` parameter type becomes `FakeZoho`.

- [ ] **Step 2: Run to see it fail**

```bash
cd worker && npx vitest run test/zoho-connect.test.ts
```
Expected: FAIL, `/connect?slot=` returns 400 (the old route wants `alias`).

- [ ] **Step 3: Implement `tokens.ts`**

Copy `worker/src/google/tokens.ts` to `worker/src/zoho/tokens.ts` and make these changes only:
- imports: `refreshAccessToken, revokeToken` from `./oidc`; add `import { accountStub } from "./account-do";`
- wrap the refresh branch of `getAccessToken` in the lease:

```ts
  const stub = accountStub(env, accountId);
  const holder = crypto.randomUUID();
  for (let attempt = 0; attempt < 20; attempt++) {
    const got = await stub.acquireRefreshLease(holder, 30_000);
    if (got === "acquired") break;
    // Another isolate is refreshing. Re-read; if it finished, use its token.
    await deps.sleep(250);
    const fresh = await load(env.DB, userId, accountId);
    if (fresh.access_token_enc && fresh.access_token_key_id && fresh.access_expires_at && fresh.access_expires_at - Date.now() > EXPIRY_MARGIN_MS)
      return ring.decrypt(new Uint8Array(fresh.access_token_enc), fresh.access_token_key_id, { userId, accountId, field: "access_token" });
  }
  try {
    /* existing refresh body: decrypt refresh token, refreshAccessToken(), guardedWrite(...) */
  } finally {
    await stub.releaseRefreshLease(holder);
  }
```
- the guarded write SQL and `credential_version` logic stay as they are (they are the cross-isolate CAS).

- [ ] **Step 4: Implement `connect.ts`**

`worker/src/zoho/connect.ts`: copy `google/connect.ts`, then:
- `E_PURPOSE = "zoho-mail-mcp:connect:v1"`; `connectRedirectUri` returns `/zoho/callback`.
- Replace `alias` with `slot` everywhere in the routes and state: `const slot = z.enum(SLOT_NAMES).safeParse(url.searchParams.get("slot"))`, 400 text `A slot is sarabi or rcp.`
- Scope check after exchange: `for (const s of ["ZohoMail.messages.READ","ZohoMail.messages.CREATE","ZohoMail.messages.UPDATE","ZohoMail.folders.READ","ZohoMail.tags.ALL","ZohoMail.accounts.READ"]) if (!hasScope(tokens.scope, s)) return fail("Scope refused", \`<p>Zoho did not grant ${s}. Connect again and accept every permission.</p>\`, 400);`
- Mailbox binding (spec D3) replaces `fetchSendAs`:

```ts
        const expected = slots(env)[st.slot!];
        const accounts = await fetchZohoAccounts(deps, tokens.location ?? "au", tokens.access_token);
        const match = accounts.find((a) => a.primaryEmail === expected);
        if (!match) {
          return fail(
            "Wrong mailbox",
            `<p><code>account_mismatch</code>: this slot is for <strong>${escapeHtml(expected)}</strong>, but the Zoho user you signed in as owns ${
              accounts.length ? accounts.map((a) => `<code>${escapeHtml(a.primaryEmail)}</code>`).join(", ") : "no mailbox"
            }. Nothing was stored. Sign out of Zoho, sign in as the user who owns ${escapeHtml(expected)}, and connect again.</p>`,
            409,
          );
        }
```
- `upsertAccount` takes `{ userId, slot, zohoSub, email: match.primaryEmail, zohoAccountId: match.accountId, location: tokens.location ?? "au", sendAs: match.sendAs, scopes, refreshToken, accessToken, accessExpiresAt }`; alias is the slot name; `org_domains` is set from `orgDomains(env)` on insert; the INSERT names the new columns (`slot, expected_primary_email, zoho_account_id, location`), the UNIQUE races to catch are `accounts.user_id, accounts.slot` (reconnect path) and `accounts.user_id, accounts.zoho_sub`.
- Replace the Gmail-specific "No refresh token" page text with `Zoho did not return a refresh token. Remove this app under Zoho Accounts, Connected Apps, and connect again.`

- [ ] **Step 5: Accounts page and tool helper**

`worker/src/web/pages/accounts.ts`: replace the free-text connect form with two fixed rows built from `slots(env)`:

```ts
  const configured = slots(env);
  const slotRows = (Object.keys(configured) as Slot[]).map((slot) => {
    const a = accounts.find((x) => x.slot === slot);
    const label = slot === "sarabi" ? "Sarabi's Fine Rugs" : "Rug Cleaning Pro";
    return `<section data-slot="${slot}"><h2>${label} <span class="muted">${escapeHtml(configured[slot])}${a ? ` · ${escapeHtml(a.status)}` : " · not connected"}</span></h2>
<p>Sign in to Zoho as the user who owns <strong>${escapeHtml(configured[slot])}</strong>, then <a href="/connect?slot=${slot}">${a ? "Reconnect" : "Connect"}</a>.</p>${a ? accountControls(a) : ""}</section>`;
  });
```
`accountControls(a)` is the existing per-account block (default, revoke, trusted recipients, limits) minus the "Organisation domains" form, which is now deployment-wide (`ORG_DOMAINS`). Row type uses `zoho_email`, `slot`.

`worker/src/tools/accounts.ts`: `COLS = "id, alias, slot, zoho_email, zoho_account_id, location, send_as, org_domains, send_limit_bytes, status"`; `AccountRef` gains `slot`, `zohoAccountId`, `location`. `mcp/server.ts` `list_accounts` selects `alias, slot, zoho_email AS email, status, is_default`; `connect_account` input `{ slot: z.enum(SLOT_NAMES) }` and `connectRequired(toolContext(ctx), slot)`.

`worker/src/index.ts`: `import { connectRoutes } from "./zoho/connect";`.

- [ ] **Step 6: Run, verify, commit**

```bash
cd worker && npx vitest run test/zoho-connect.test.ts test/tokens.test.ts test/accounts.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(zoho): slot-bound connect with account_mismatch, lease-guarded token refresh"
```

---

### Task 1.5: `zoho/client.ts`

**Files:**
- Create: `worker/src/zoho/client.ts`
- Test: `worker/test/zoho-client.test.ts`

**Interfaces:**
- Produces: `ZohoRequest`, `ZohoApiError`, `zohoJson<T>(env, deps, acct, req): Promise<T>`, `zohoStream(env, deps, acct, req): Promise<Response>`, `ZohoAcct = { userId: string; accountId: string; toolCallId: string }`.

- [ ] **Step 1: Write the failing tests**

`worker/test/zoho-client.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { FakeZoho } from "./fake-zoho";
import { testEnv, testDeps } from "./test-env";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { zohoJson, ZohoApiError } from "../src/zoho/client";
import { McpError } from "@zoho-mail-mcp/shared/errors";

let n = 0;
async function setup(scope?: string) {
  const id = `a${++n}`;
  const z = await FakeZoho.create();
  const e = testEnv();
  await seedUserAndAccount(e.DB, { userId: "u", accountId: id, alias: `sarabi${n}`, slot: "sarabi" });
  z.accounts.set(`sub-${id}`, { accountId: `191000${n}`, primaryEmail: "sarabi@example.test", sendAs: ["sarabi@example.test"] });
  const token = z.directToken(`191000${n}`, scope);
  await seedAccessToken(e, { userId: "u", accountId: id, access: token });
  return { z, e, d: testDeps(z), acct: { userId: "u", accountId: id, toolCallId: "call-1" }, Z: `191000${n}` };
}

describe("zoho client", () => {
  it("routes to mail.zoho.com.au with the account id and unwraps data", async () => {
    const { z, e, d, acct, Z } = await setup();
    z.mail.ensureFolders(Z);
    const folders = await zohoJson<{ folderName: string }[]>(e, d, acct, { method: "GET", path: "folders", retry: "safe" });
    expect(folders.map((f) => f.folderName)).toContain("Inbox");
    expect(z.mail.requests.at(-1)!.url).toBe(`https://mail.zoho.com.au/api/accounts/${Z}/folders`);
  });
  it("maps the array-shaped INVALID_OAUTHSCOPE 401 to insufficient_scope", async () => {
    const { e, d, acct } = await setup("ZohoMail.messages.CREATE,ZohoMail.accounts.READ");
    await expect(zohoJson(e, d, acct, { method: "GET", path: "folders", retry: "safe" })).rejects.toMatchObject({ code: "insufficient_scope" });
  });
  it("refreshes once and retries on INVALID_OAUTHTOKEN, then reconnect_required on invalid_grant", async () => {
    const { z, e, d, acct, Z } = await setup();
    z.tokens.clear(); // every stored access token is now dead
    z.refreshTokens.set("rt-seeded", { state: "ok", sub: `sub-${acct.accountId}`, scope: "ZohoMail.messages.ALL,ZohoMail.folders.ALL,ZohoMail.tags.ALL,ZohoMail.accounts.READ" });
    z.mail.ensureFolders(Z);
    const folders = await zohoJson<unknown[]>(e, d, acct, { method: "GET", path: "folders", retry: "safe" });
    expect(folders.length).toBeGreaterThan(0);
    expect(z.tokenCalls).toBe(1);
    z.tokens.clear();
    z.refreshTokens.set("rt-seeded", { state: "invalid_grant", sub: `sub-${acct.accountId}`, scope: "" });
    await expect(zohoJson(e, d, acct, { method: "GET", path: "folders", retry: "safe" })).rejects.toMatchObject({ code: "account_needs_reconnect" });
  });
  it("maps 429 to rate_limited with retry_after and never retries a retry:none POST", async () => {
    const { z, e, d, acct } = await setup();
    z.mail.faults.push({ status: 429, errorCode: "RATE_LIMIT", retryAfter: 7 });
    await expect(zohoJson(e, d, acct, { method: "POST", path: "messages", json: {}, retry: "none" })).rejects.toMatchObject({ code: "rate_limited", details: { retry_after_ms: 7000 } });
    expect(z.mail.requests.filter((r) => r.method === "POST").length).toBe(1);
  });
  it("is refused by the account bucket after 25 calls in a minute", async () => {
    const { z, e, d, acct, Z } = await setup();
    z.mail.ensureFolders(Z);
    for (let i = 0; i < 25; i++) await zohoJson(e, d, { ...acct, toolCallId: `c${i}` }, { method: "GET", path: "folders", retry: "safe" });
    await expect(zohoJson(e, d, { ...acct, toolCallId: "c26" }, { method: "GET", path: "folders", retry: "safe" })).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("is refused by the per-call budget after 10 requests in one tool call", async () => {
    const { z, e, d, acct, Z } = await setup();
    z.mail.ensureFolders(Z);
    for (let i = 0; i < 10; i++) await zohoJson(e, d, acct, { method: "GET", path: "folders", retry: "safe" });
    await expect(zohoJson(e, d, acct, { method: "GET", path: "folders", retry: "safe" })).rejects.toMatchObject({ code: "budget_exceeded" });
  });
  it("exposes the Zoho error code on other failures", async () => {
    const { z, e, d, acct } = await setup();
    z.mail.faults.push({ status: 400, errorCode: "INVALID_FOLDER" });
    const err = await zohoJson(e, d, acct, { method: "GET", path: "folders", retry: "safe" }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ZohoApiError);
    expect((err as ZohoApiError).zohoCode).toBe("INVALID_FOLDER");
    expect(err).toBeInstanceOf(McpError);
  });
});
```

`seedAccessToken` in `fixtures.ts` already writes an encrypted access token; its default refresh token is the string `rt-seeded`, which the test registers in the fake. Each case seeds its own account (`a1`, `a2`, ...): D1 rows persist across cases within a file, so a shared id hits the unique constraint on the second case (gauntlet round 2). Zoho account ids are numeric (`191000N`) because the fake routes on digits, as Zoho does.

- [ ] **Step 2: Run to see it fail**

```bash
cd worker && npx vitest run test/zoho-client.test.ts
```
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`worker/src/zoho/client.ts`:

```ts
import { McpError } from "@zoho-mail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { accountStub } from "./account-do";
import { ZOHO } from "./oidc";
import { getAccessToken } from "./tokens";

export type ZohoAcct = { userId: string; accountId: string; toolCallId: string };
export type ZohoRequest = {
  method: "GET" | "POST" | "PUT";
  /** Relative to /api/accounts/{zohoAccountId}/ when scope is "account", to /api/ when "root". */
  path: string;
  scope?: "account" | "root";
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  body?: ReadableStream<Uint8Array> | Uint8Array;
  headers?: Record<string, string>;
  /** `safe` may be re-sent after a 5xx; `none` is sent once. A 401 retry after a refresh is always safe: Zoho refused before acting. */
  retry: "safe" | "none";
};

export class ZohoApiError extends McpError {
  constructor(public readonly status: number, public readonly zohoCode: string | null, message: string) {
    super("zoho_error", `zoho_error: ${status} ${zohoCode ?? ""} ${message}`.trim(), { status, zohoCode });
    this.name = "ZohoApiError";
  }
}

const MAX_TRIES = 3;
const BACKOFF_MS = [300, 900];

type ParsedError = { code: string | null; message: string };
/** Zoho answers auth failures as `[2, {errorCode, msg}]` and everything else as `{status:{code,description}, data?}`. Both are parsed. */
export function parseZohoError(body: unknown, fallback: string): ParsedError {
  if (Array.isArray(body)) {
    const o = body.find((x) => typeof x === "object" && x !== null) as { errorCode?: string; msg?: string } | undefined;
    return { code: o?.errorCode ?? null, message: o?.msg ?? fallback };
  }
  if (typeof body === "object" && body !== null) {
    const b = body as { status?: { description?: string; code?: number }; data?: { errorCode?: string; moreInfo?: string } };
    return { code: b.data?.errorCode ?? b.status?.description ?? null, message: b.data?.moreInfo ?? b.status?.description ?? fallback };
  }
  return { code: null, message: fallback };
}

async function accountRow(env: Env, acct: ZohoAcct): Promise<{ zoho_account_id: string; location: "au" }> {
  const row = await env.DB.prepare("SELECT zoho_account_id, location FROM accounts WHERE id=? AND user_id=? AND status='active'")
    .bind(acct.accountId, acct.userId)
    .first<{ zoho_account_id: string; location: "au" }>();
  if (!row) throw new McpError("account_needs_reconnect", "account_needs_reconnect");
  return row;
}

function url(base: string, path: string, query?: ZohoRequest["query"]): string {
  const u = new URL(path, base.endsWith("/") ? base : base + "/");
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

/** The one path to Zoho. Admission by the account DO, one refresh-and-retry on INVALID_OAUTHTOKEN, bounded retries for safe requests. */
export async function zohoFetch(env: Env, deps: Deps, acct: ZohoAcct, req: ZohoRequest): Promise<Response> {
  const stub = accountStub(env, acct.accountId);
  if (!(await stub.budget(acct.toolCallId, "requests", 1)))
    throw new McpError("budget_exceeded", "budget_exceeded: more than 10 Zoho requests in one tool call", { counter: "requests" });
  const admitted = await stub.admit(acct.toolCallId);
  if (!admitted.ok) throw new McpError("rate_limited", "rate_limited: account bucket", { retry_after_ms: admitted.retry_after_ms });
  const row = await accountRow(env, acct);
  const base = req.scope === "root" ? ZOHO.mailBase(row.location) : `${ZOHO.mailBase(row.location)}/accounts/${row.zoho_account_id}`;
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    const token = await getAccessToken(env, deps, acct.userId, acct.accountId, { forceRefresh: refreshed && attempt === 2 });
    const headers = new Headers({ authorization: `Zoho-oauthtoken ${token}`, accept: "application/json", ...req.headers });
    let body: BodyInit | undefined;
    if (req.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(req.json); }
    else if (req.body) body = req.body as BodyInit;
    const res = await deps.zohoFetch(url(base, req.path, req.query), { method: req.method, headers, body, ...(req.body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
    if (res.ok) return res;
    const parsed = parseZohoError(await res.clone().json().catch(() => null), res.statusText);
    if (res.status === 401 && parsed.code === "INVALID_OAUTHTOKEN" && !refreshed) {
      refreshed = true; // getAccessToken with forceRefresh on the next loop; invalid_grant surfaces as account_needs_reconnect from tokens.ts
      continue;
    }
    if (res.status === 401 && parsed.code === "INVALID_OAUTHSCOPE")
      throw new McpError("insufficient_scope", "insufficient_scope: reconnect the mailbox and accept every permission", { zohoCode: parsed.code });
    if (res.status === 401) throw new McpError("account_needs_reconnect", `account_needs_reconnect: ${parsed.code ?? "401"}`);
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after") ?? "60");
      throw new McpError("rate_limited", "rate_limited: zoho", { retry_after_ms: (Number.isFinite(ra) ? ra : 60) * 1000, zohoCode: parsed.code });
    }
    if (res.status >= 500 && req.retry === "safe" && attempt < MAX_TRIES) {
      await deps.sleep(BACKOFF_MS[attempt - 1] ?? 900);
      continue;
    }
    throw new ZohoApiError(res.status, parsed.code, parsed.message);
  }
}

export async function zohoJson<T>(env: Env, deps: Deps, acct: ZohoAcct, req: ZohoRequest): Promise<T> {
  const res = await zohoFetch(env, deps, acct, req);
  const body = (await res.json().catch(() => null)) as { data?: T } | null;
  if (!body || !("data" in body)) throw new ZohoApiError(res.status, null, "response without data");
  return body.data as T;
}

/** For attachment bytes: the caller owns the stream. */
export async function zohoStream(env: Env, deps: Deps, acct: ZohoAcct, req: ZohoRequest): Promise<Response> {
  return zohoFetch(env, deps, acct, { ...req, headers: { ...req.headers, accept: "*/*" } });
}
```

Note on `forceRefresh`: `getAccessToken` already refreshes when the cached token is near expiry; the explicit flag covers Zoho rejecting a token that D1 still believes is valid (a revocation or a password change).

- [ ] **Step 4: Run, verify, commit**

```bash
cd worker && npx vitest run test/zoho-client.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(zoho): the one client: bucket, budget, refresh-once, error mapping"
```

---

### Task 1.6: Retire the Google identity layer

**Files:**
- Delete: `worker/src/google/oidc.ts`, `worker/src/google/connect.ts`, `worker/src/google/tokens.ts`, `worker/test/oidc.test.ts`, `worker/test/connect.test.ts`
- Modify: `worker/src/env.ts` (remove `GOOGLE_*`, `OWNER_GOOGLE_SUBS`), `worker/src/deps.ts` (remove `googleFetch`), `worker/test/test-env.ts`, `worker/test/fake-zoho.ts` (remove the `google` proxy and the Google host branch), every remaining `import ... from "../google/tokens"` (replace with `../zoho/tokens`), `worker/wrangler.jsonc` vars
- Keep for now (retired in M3 and M4): `worker/src/google/gmail.ts`, `messages.ts`, `mutation-receipt.ts`, `recovery-http.ts`, `resumable.ts`, `worker/test/fake-google.ts`, `fake-gmail.ts`. Until then `FakeZoho.fetch` must still answer `gmail.googleapis.com` through `FakeGmail` only (not `FakeGoogle`), and the Gmail tool tests seed access tokens directly, which they already do.

- [ ] **Step 1: Delete and re-point**

```bash
cd worker && git rm src/google/oidc.ts src/google/connect.ts src/google/tokens.ts test/oidc.test.ts test/connect.test.ts
grep -rln "google/tokens\|google/oidc\|google/connect" src test | xargs sed -i '' -e 's#\.\./google/tokens#../zoho/tokens#g' -e 's#\./google/tokens#./zoho/tokens#g' -e 's#\.\./\.\./google/tokens#../../zoho/tokens#g'
```
Then remove `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OWNER_GOOGLE_SUBS` from `env.ts`, `test-env.ts`, `.dev.vars.example`, both wrangler files; remove `googleFetch` from `deps.ts` and `test-env.ts`. In `fake-zoho.ts` replace the Google branch with `if (url.hostname === "gmail.googleapis.com") return this.gmail.fetch(req);` where `readonly gmail = new FakeGmail();` (so M2 to M4 can migrate tool tests one family at a time).

- [ ] **Step 2: Verify and commit**

```bash
cd .. && npm run verify && grep -rn "GOOGLE_\|googleFetch\|accounts.google" worker/src | wc -l
git add -A && git commit -m "chore: retire the Google identity layer"
```
Expected grep count: 0.

---

## M1 exit checklist

- [ ] Login page says Sign in with Zoho; `OWNER_ZOHO_SUBS` bootstrap flow proven by `login.test.ts`.
- [ ] Both slots connect; a wrong Zoho user is refused with `account_mismatch`, nothing stored, grant revoked (`zoho-connect.test.ts`).
- [ ] Bucket, budget, lease and cache proven in `account-do.test.ts`.
- [ ] `zoho-client.test.ts` proves: array-shaped 401 handling, refresh-once-then-retry, `insufficient_scope`, `rate_limited` with retry-after, budget refusal, no retry for `retry: "none"`.
- [ ] `npm run verify` green. No `GOOGLE_` symbol remains in `worker/src`.

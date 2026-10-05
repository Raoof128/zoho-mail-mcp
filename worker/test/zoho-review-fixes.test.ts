import { describe, it, expect } from "vitest";
import { FakeZoho } from "./fake-zoho";
import { testEnv, testDeps } from "./test-env";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { zohoJson, zohoFetch } from "../src/zoho/client";
import { exchangeCode } from "../src/zoho/oidc";
import { createWorker } from "../src/index";
import { loginAs } from "./zoho-helpers";

// Final whole-branch review of M1 (2026-10-04), Important findings 1 to 6. Each test failed before its fix.
let n = 0;
async function setup() {
  const id = `r${++n}`;
  const z = await FakeZoho.create();
  const e = testEnv();
  const Z = `19200${n}`;
  await seedUserAndAccount(e.DB, { userId: "u", accountId: id, alias: `sarabi${n}`, slot: "sarabi", zohoAccountId: Z });
  z.accounts.set(`sub-${id}`, { accountId: Z, primaryEmail: "sarabi@example.test", sendAs: [] });
  await seedAccessToken(e, { userId: "u", accountId: id, access: z.directToken(Z) });
  z.refreshTokens.set("rt-seeded", {
    state: "ok",
    sub: `sub-${id}`,
    scope: "ZohoMail.messages.ALL,ZohoMail.folders.ALL,ZohoMail.tags.ALL,ZohoMail.accounts.READ",
  });
  z.mail.ensureFolders(Z);
  return { z, e, d: testDeps(z), acct: { userId: "u", accountId: id, toolCallId: "call-1" }, Z };
}
const GET = { method: "GET" as const, path: "folders", retry: "safe" as const };

describe("review finding 1: a 401 after a 5xx still forces the refresh", () => {
  it("refreshes the token when INVALID_OAUTHTOKEN arrives on the second attempt", async () => {
    const { z, e, d, acct } = await setup();
    z.mail.faults.push({ status: 503, errorCode: "BUSY" });
    z.mail.faults.push({ status: 401, errorCode: "INVALID_OAUTHTOKEN", shape: "array" });
    await zohoJson(e, d, acct, GET);
    expect(z.tokenCalls).toBe(1);
  });
});

describe("review finding 2: a request never leaves the account's base on mail.zoho.com.au", () => {
  for (const path of [
    "//evil.example/x",
    "https://evil.example/x",
    "/x",
    "messages/../../x",
    "messages/%2e%2e/%2e%2e/x",
  ])
    it(`refuses path ${path} before any request`, async () => {
      const { z, e, d, acct } = await setup();
      await expect(zohoJson(e, d, acct, { ...GET, path })).rejects.toMatchObject({ code: "forbidden" });
      expect(z.mail.requests.length).toBe(0);
    });
  it("never follows a redirect", async () => {
    const { e, acct } = await setup();
    const seen: (string | undefined)[] = [];
    const z2 = await FakeZoho.create();
    const d = {
      ...testDeps(z2),
      zohoFetch: (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init?.redirect);
        return Promise.resolve(Response.json({ status: { code: 200 }, data: [] }));
      },
    };
    await zohoJson(e, d, acct, GET);
    expect(seen).toEqual(["manual"]); // Workers accepts only follow or manual; a 3xx then fails as a non-ok answer
  });
});

describe("review finding 3: a failed code exchange revokes the refresh token Zoho already minted", () => {
  it("revokes when the token answer names another data centre", async () => {
    const z = await FakeZoho.create();
    z.codeResponsePatch = { api_domain: "https://www.zohoapis.com" };
    const code = z.grantCode({ sub: "s", email: "sarabi@example.test", nonce: "n" });
    const refresh = z.codes.get(code)!.refresh;
    await expect(exchangeCode(testEnv(), testDeps(z), { code, redirectUri: "https://h/cb" })).rejects.toThrow(
      /another data centre/,
    );
    expect(z.revoked.has(refresh)).toBe(true);
  });
  it("revokes when the token answer does not parse", async () => {
    const z = await FakeZoho.create();
    z.codeResponsePatch = { location: "AU" };
    const code = z.grantCode({ sub: "s", email: "sarabi@example.test", nonce: "n" });
    const refresh = z.codes.get(code)!.refresh;
    await expect(exchangeCode(testEnv(), testDeps(z), { code, redirectUri: "https://h/cb" })).rejects.toThrow();
    expect(z.revoked.has(refresh)).toBe(true);
  });
});

describe("review finding 4: retries count against the per-call budget and the account bucket", () => {
  it("a 5xx retry spends a request from the tool call's budget", async () => {
    const { z, e, d, acct } = await setup();
    for (let i = 0; i < 9; i++) await zohoJson(e, d, acct, GET);
    z.mail.faults.push({ status: 503, errorCode: "BUSY" });
    await expect(zohoJson(e, d, acct, GET)).rejects.toMatchObject({ code: "budget_exceeded" });
  });
});

describe("review finding 5: a streamed body is never sent twice", () => {
  it("refreshes but does not resend a stream after INVALID_OAUTHTOKEN", async () => {
    const { z, e, d, acct } = await setup();
    z.mail.faults.push({ status: 401, errorCode: "INVALID_OAUTHTOKEN", shape: "array" });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
    await expect(
      zohoFetch(e, d, acct, { method: "POST", path: "messages/attachments", body, retry: "none" }),
    ).rejects.toMatchObject({
      code: "zoho_error",
    });
    expect(z.mail.requests.filter((r) => r.method === "POST").length).toBe(1);
    expect(z.tokenCalls).toBe(1);
  });
  it("does not retry a stream after a 5xx even when marked safe", async () => {
    const { z, e, d, acct } = await setup();
    z.mail.faults.push({ status: 503, errorCode: "BUSY" });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    await expect(zohoFetch(e, d, acct, { method: "PUT", path: "x", body, retry: "safe" })).rejects.toMatchObject({
      code: "zoho_error",
    });
    expect(z.mail.requests.length).toBe(1);
  });
});

describe("review finding 6: a stored grant is never revoked by a later failure", () => {
  it("keeps the refresh token live when the audit write after the upsert fails", async () => {
    const z = await FakeZoho.create();
    z.accounts.set("owner-sub", { accountId: "191", primaryEmail: "sarabi@example.test", sendAs: [] });
    const w = createWorker(testDeps(z));
    const e = testEnv();
    const b = await loginAs(w, e, z, { sub: "owner-sub", email: "sarabi@example.test" });
    const start = await b.get(`/connect?slot=sarabi`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const code = z.grantCode({ sub: "owner-sub", email: "sarabi@example.test", nonce: "x" });
    z.codes.get(code)!.nonce = JSON.parse(
      (await e.DB.prepare("SELECT payload FROM oauth_states WHERE id=?").bind(state).first<{ payload: string }>())!
        .payload,
    ).nonce as string;
    await e.DB.prepare(
      "CREATE TRIGGER fail_connected BEFORE INSERT ON audit_log WHEN NEW.decision='connected' BEGIN SELECT RAISE(ABORT,'d1 hiccup'); END",
    ).run();
    await b.get(`/zoho/callback?state=${state}&code=${code}`).catch(() => null);
    await e.DB.prepare("DROP TRIGGER fail_connected").run();
    const row = await e.DB.prepare("SELECT status FROM accounts WHERE user_id='owner-sub' AND slot='sarabi'").first();
    expect(row).toEqual({ status: "active" });
    expect(z.revoked.size).toBe(0);
  });
});

describe("M3: attachment transfers spend the attachments budget, not the 10-request budget (spec D17)", () => {
  it("a transfer-marked request passes the bucket but not the request counter", async () => {
    const { z, e, d, acct, Z } = await setup();
    for (let i = 0; i < 10; i++) await zohoJson(e, d, acct, GET);
    await expect(zohoJson(e, d, acct, GET)).rejects.toMatchObject({ code: "budget_exceeded" });
    void z;
    void Z;
    await expect(zohoJson(e, d, acct, { ...GET, transfer: true })).resolves.toBeDefined();
  });
});

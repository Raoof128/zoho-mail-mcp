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
  z.accounts.set(`sub-${id}`, {
    accountId: `191000${n}`,
    primaryEmail: "sarabi@example.test",
    sendAs: ["sarabi@example.test"],
  });
  const token = z.directToken(`191000${n}`, scope);
  await seedAccessToken(e, { userId: "u", accountId: id, access: token });
  return { z, e, d: testDeps(z), acct: { userId: "u", accountId: id, toolCallId: "call-1" }, Z: `191000${n}` };
}

describe("zoho client", () => {
  it("routes to mail.zoho.com.au with the account id and unwraps data", async () => {
    const { z, e, d, acct, Z } = await setup();
    z.mail.ensureFolders(Z);
    const folders = await zohoJson<{ folderName: string }[]>(e, d, acct, {
      method: "GET",
      path: "folders",
      retry: "safe",
    });
    expect(folders.map((f) => f.folderName)).toContain("Inbox");
    expect(z.mail.requests.at(-1)!.url).toBe(`https://mail.zoho.com.au/api/accounts/${Z}/folders`);
  });
  it("maps the array-shaped INVALID_OAUTHSCOPE 401 to insufficient_scope", async () => {
    const { e, d, acct } = await setup("ZohoMail.messages.CREATE,ZohoMail.accounts.READ");
    await expect(zohoJson(e, d, acct, { method: "GET", path: "folders", retry: "safe" })).rejects.toMatchObject({
      code: "insufficient_scope",
    });
  });
  it("refreshes once and retries on INVALID_OAUTHTOKEN, then reconnect_required on invalid_grant", async () => {
    const { z, e, d, acct, Z } = await setup();
    z.tokens.clear(); // every stored access token is now dead
    z.refreshTokens.set("rt-seeded", {
      state: "ok",
      sub: `sub-${acct.accountId}`,
      scope: "ZohoMail.messages.ALL,ZohoMail.folders.ALL,ZohoMail.tags.ALL,ZohoMail.accounts.READ",
    });
    z.mail.ensureFolders(Z);
    const folders = await zohoJson<unknown[]>(e, d, acct, { method: "GET", path: "folders", retry: "safe" });
    expect(folders.length).toBeGreaterThan(0);
    expect(z.tokenCalls).toBe(1);
    z.tokens.clear();
    z.refreshTokens.set("rt-seeded", { state: "invalid_grant", sub: `sub-${acct.accountId}`, scope: "" });
    await expect(zohoJson(e, d, acct, { method: "GET", path: "folders", retry: "safe" })).rejects.toMatchObject({
      code: "account_needs_reconnect",
    });
  });
  it("maps 429 to rate_limited with retry_after and never retries a retry:none POST", async () => {
    const { z, e, d, acct } = await setup();
    z.mail.faults.push({ status: 429, errorCode: "RATE_LIMIT", retryAfter: 7 });
    await expect(
      zohoJson(e, d, acct, { method: "POST", path: "messages", json: {}, retry: "none" }),
    ).rejects.toMatchObject({ code: "rate_limited", details: { retry_after_ms: 7000 } });
    expect(z.mail.requests.filter((r) => r.method === "POST").length).toBe(1);
  });
  it("is refused by the account bucket after 25 calls in a minute", async () => {
    const { z, e, d, acct, Z } = await setup();
    z.mail.ensureFolders(Z);
    for (let i = 0; i < 25; i++)
      await zohoJson(e, d, { ...acct, toolCallId: `c${i}` }, { method: "GET", path: "folders", retry: "safe" });
    await expect(
      zohoJson(e, d, { ...acct, toolCallId: "c26" }, { method: "GET", path: "folders", retry: "safe" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("is refused by the per-call budget after 10 requests in one tool call", async () => {
    const { z, e, d, acct, Z } = await setup();
    z.mail.ensureFolders(Z);
    for (let i = 0; i < 10; i++) await zohoJson(e, d, acct, { method: "GET", path: "folders", retry: "safe" });
    await expect(zohoJson(e, d, acct, { method: "GET", path: "folders", retry: "safe" })).rejects.toMatchObject({
      code: "budget_exceeded",
    });
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

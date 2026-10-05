import { env, createExecutionContext } from "cloudflare:test";
import { it, expect } from "vitest";
import { createWorker } from "../src/index";
import { FakeZoho } from "./fake-zoho";
import { Browser, mintToken } from "./browser";
import { testEnv, testDeps, HOST } from "./test-env";
import { registerCompanionClient } from "../src/auth/companion";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { setPolicy } from "../src/policy/engine";
it("authenticates identity and uploads through the real staging OAuth route", async () => {
  const g = await FakeZoho.create();
  const w = createWorker(testDeps(g));
  const e = testEnv();
  // Since M5 the upload streams to Zoho, so the account needs a mailbox and a token in the double.
  await seedUserAndAccount(env.DB, {
    userId: "owner-sub",
    accountId: "api-account",
    alias: "work",
    zohoAccountId: "1970001",
  });
  g.accounts.set("sub-api-account", { accountId: "1970001", primaryEmail: "work@example.test", sendAs: [] });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "api-account", access: g.directToken("1970001") });
  await setPolicy(env.DB, {
    userId: "owner-sub",
    accountId: "api-account",
    action: "attachment.stage_upload",
    level: "allow",
  });
  const browser = new Browser(w, e);
  await browser.login(g, { sub: "owner-sub", email: "owner@example.test" });
  const clientId = await registerCompanionClient({ ...e, OAUTH_PROVIDER: undefined as never }, w);
  const token = (
    await mintToken(w, e, g, { scope: "staging", clientId, redirectUri: "http://127.0.0.1:61234/callback", browser })
  ).accessToken;
  const call = (path: string, init: RequestInit = {}) =>
    w.fetch(
      new Request(HOST + path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } }),
      { ...e },
      createExecutionContext(),
    );
  expect(await (await call("/staging/identity")).json()).toMatchObject({ user_id: "owner-sub" });
  const response = await call("/staging/intent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "ensure",
      transfer_id: `tr_${"z".repeat(43)}`,
      account: "work",
      metadata: {
        filename: "empty.txt",
        size: 0,
        mime: "text/plain",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    }),
  });
  expect(response.status).toBe(200);
  const ticket = (await response.json()) as any;
  const result = await call(`/staging/${ticket.ticket_id}`, {
    method: "PUT",
    headers: { "content-length": "0", "content-type": "text/plain" },
    body: "",
  });
  expect(result.status).toBe(200);
  const done = await result.json<{ state: string; handle: string }>();
  expect(done).toMatchObject({ state: "completed" });
  // Sealed in D1, bytes held by Zoho: nothing in Cloudflare storage.
  const row = await env.DB.prepare("SELECT direction, provider_ref FROM sealed_handles WHERE handle = ?")
    .bind(done.handle)
    .first<{ direction: string; provider_ref: string }>();
  expect(row!.direction).toBe("upload");
  expect(g.mail.uploads.has((JSON.parse(row!.provider_ref) as { storeName: string }).storeName)).toBe(true);
});

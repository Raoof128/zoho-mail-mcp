import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { FakeZoho } from "./fake-zoho";
import { testEnv, testDeps, HOST } from "./test-env";
import { createWorker } from "../src/index";
import { loginAs } from "./zoho-helpers";

describe("connect with slots", () => {
  it("stores the account when the Zoho user owns the slot's address, refuses otherwise", async () => {
    const z = await FakeZoho.create();
    z.accounts.set("owner-sub", {
      accountId: "191",
      primaryEmail: "sarabi@example.test",
      sendAs: ["sarabi@example.test", "rcp@example.test"],
    });
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
    const nonce = JSON.parse(
      (await e.DB.prepare("SELECT payload FROM oauth_states WHERE id=?").bind(state).first<{ payload: string }>())!
        .payload,
    ).nonce as string;
    z.codes.get(code)!.nonce = nonce;
    const cb = await b.get(`/zoho/callback?state=${state}&code=${code}`);
    expect(cb.status).toBe(303);
    const row = await e.DB.prepare(
      "SELECT slot, zoho_account_id, zoho_email, send_as FROM accounts WHERE user_id='owner-sub'",
    ).first<{ slot: string; zoho_account_id: string; zoho_email: string; send_as: string }>();
    expect(row).toEqual({
      slot: "sarabi",
      zoho_account_id: "191",
      zoho_email: "sarabi@example.test",
      send_as: JSON.stringify(["sarabi@example.test", "rcp@example.test"]),
    });

    // Wrong user for slot rcp: the Sarabi Zoho user has no rcp mailbox.
    const start2 = await b.get(`/connect?slot=rcp`);
    const state2 = new URL(start2.headers.get("location")!).searchParams.get("state")!;
    const code2 = z.grantCode({ sub: "owner-sub", email: "sarabi@example.test", nonce: "x" });
    z.codes.get(code2)!.nonce = JSON.parse(
      (await e.DB.prepare("SELECT payload FROM oauth_states WHERE id=?").bind(state2).first<{ payload: string }>())!
        .payload,
    ).nonce;
    const cb2 = await b.get(`/zoho/callback?state=${state2}&code=${code2}`);
    expect(cb2.status).toBe(409);
    expect(await cb2.text()).toContain("account_mismatch");
    expect((await e.DB.prepare("SELECT count(*) AS n FROM accounts WHERE slot='rcp'").first<{ n: number }>())!.n).toBe(
      0,
    );
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

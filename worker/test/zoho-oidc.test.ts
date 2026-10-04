import { describe, it, expect } from "vitest";
import { FakeZoho } from "./fake-zoho";
import { testEnv, testDeps } from "./test-env";
import {
  ZOHO,
  CONNECT_SCOPES,
  buildAuthUrl,
  exchangeCode,
  verifyIdToken,
  fetchZohoAccounts,
  hasScope,
  refreshAccessToken,
} from "../src/zoho/oidc";

describe("zoho oidc", () => {
  it("builds an AU authorisation URL with comma scopes, offline access and consent", () => {
    const u = new URL(
      buildAuthUrl(testEnv(), {
        redirectUri: "https://h/zoho/callback",
        scope: CONNECT_SCOPES,
        state: "s",
        nonce: "n",
        offline: true,
      }),
    );
    expect(u.origin).toBe("https://accounts.zoho.com.au");
    expect(u.searchParams.get("scope")).toBe(
      "openid,email,ZohoMail.messages.READ,ZohoMail.messages.CREATE,ZohoMail.messages.UPDATE,ZohoMail.folders.READ,ZohoMail.tags.ALL,ZohoMail.accounts.READ",
    );
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });
  it("exchanges a code, keeps location, verifies the id_token and lists accounts", async () => {
    const z = await FakeZoho.create();
    z.accounts.set("sub-1", {
      accountId: "191",
      primaryEmail: "sarabi@example.test",
      sendAs: ["sarabi@example.test", "rcp@example.test"],
    });
    const code = z.grantCode({ sub: "sub-1", email: "sarabi@example.test", nonce: "n1" });
    const t = await exchangeCode(testEnv(), testDeps(z), { code, redirectUri: "https://h/zoho/callback" });
    expect(t.location).toBeUndefined(); // single-DC client: Zoho omits it; the client routes on the deployment DC
    expect(t.api_domain).toBe("https://www.zohoapis.com.au");
    const id = await verifyIdToken(testEnv(), testDeps(z), t.id_token!, { nonce: "n1" });
    expect(id).toEqual({ sub: "sub-1", email: "sarabi@example.test" });
    const accounts = await fetchZohoAccounts(testDeps(z), "au", t.access_token);
    expect(accounts).toEqual([
      { accountId: "191", primaryEmail: "sarabi@example.test", sendAs: ["sarabi@example.test", "rcp@example.test"] },
    ]);
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
    await expect(
      exchangeCode(testEnv({ ZOHO_CLIENT_SECRET: "wrong" }), testDeps(z), { code: "x", redirectUri: "https://h/cb" }),
    ).rejects.toThrow(/invalid_client_secret/);
  });
});

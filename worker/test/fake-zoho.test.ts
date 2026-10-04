import { describe, it, expect } from "vitest";
import { FakeZoho } from "./fake-zoho";

describe("FakeZoho", () => {
  it("answers discovery, JWKS, code exchange with location au, and accounts", async () => {
    const z = await FakeZoho.create();
    z.accounts.set("sub-1", {
      accountId: "191",
      primaryEmail: "sarabi@example.test",
      sendAs: ["sarabi@example.test", "rcp@example.test"],
    });
    const code = z.grantCode({ sub: "sub-1", email: "sarabi@example.test", nonce: "n" });
    const disc = await (
      await z.fetch("https://accounts.zoho.com.au/.well-known/openid-configuration")
    ).json<{ issuer: string }>();
    expect(disc.issuer).toBe("https://accounts.zoho.com.au");
    const tok = await (
      await z.fetch("https://accounts.zoho.com.au/oauth/v2/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: "1000.ZOHOTEST",
          client_secret: "zsecret",
          redirect_uri: "https://x/cb",
        }),
      })
    ).json<{ access_token: string; refresh_token: string; location: string; api_domain: string; scope: string }>();
    expect(tok.location).toBeUndefined(); // live shape for a single-DC client
    expect(tok.api_domain).toBe("https://www.zohoapis.com.au");
    z.multiDc = true;
    const code2 = z.grantCode({ sub: "sub-1", email: "sarabi@example.test", nonce: "n" });
    const tok2 = await (
      await z.fetch("https://accounts.zoho.com.au/oauth/v2/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code2,
          client_id: "1000.ZOHOTEST",
          client_secret: "zsecret",
          redirect_uri: "https://x/cb",
        }),
      })
    ).json<{ location?: string }>();
    expect(tok2.location).toBe("au");
    expect(tok.scope).toContain("VirtualOffice.messages.READ");
    const acc = await (
      await z.fetch("https://mail.zoho.com.au/api/accounts", {
        headers: { authorization: `Zoho-oauthtoken ${tok.access_token}` },
      })
    ).json<{ data: { accountId: string; primaryEmailAddress: string }[] }>();
    expect(acc.data[0]!.accountId).toBe("191");
  });
  it("returns the array-shaped 401 for a scope the token lacks", async () => {
    const z = await FakeZoho.create();
    z.accounts.set("sub-2", { accountId: "192", primaryEmail: "a@example.test", sendAs: ["a@example.test"] });
    const code = z.grantCode({ sub: "sub-2", email: "a@example.test", nonce: "n", scope: "ZohoMail.messages.CREATE" });
    const tok = await (
      await z.fetch("https://accounts.zoho.com.au/oauth/v2/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: "1000.ZOHOTEST",
          client_secret: "zsecret",
          redirect_uri: "https://x/cb",
        }),
      })
    ).json<{ access_token: string }>();
    const res = await z.fetch("https://mail.zoho.com.au/api/accounts/192/folders", {
      headers: { authorization: `Zoho-oauthtoken ${tok.access_token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json<unknown[]>();
    expect(Array.isArray(body)).toBe(true);
    expect((body[1] as { errorCode: string }).errorCode).toBe("INVALID_OAUTHSCOPE");
  });
  it("lists, searches, filters by threadId and updates with the documented mode literals", async () => {
    const z = await FakeZoho.create();
    const m1 = z.mail.seedMessage("191", {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "Hello",
      content: "<p>hi</p>",
      threadId: "t1",
    });
    z.mail.seedMessage("191", {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "Re: Hello",
      content: "<p>yo</p>",
      threadId: "t1",
    });
    const tok = z.directToken("191");
    const list = await (
      await z.fetch(`https://mail.zoho.com.au/api/accounts/191/messages/view?threadId=t1&limit=10`, {
        headers: { authorization: `Zoho-oauthtoken ${tok}` },
      })
    ).json<{ data: { messageId: string; folderId: string }[] }>();
    expect(list.data).toHaveLength(2);
    expect(new Set(list.data.map((m) => m.folderId)).size).toBe(2);
    const upd = await z.fetch(`https://mail.zoho.com.au/api/accounts/191/updatemessage`, {
      method: "PUT",
      headers: { authorization: `Zoho-oauthtoken ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "setFlag", flagid: "important", messageId: [m1.messageId] }),
    });
    expect(upd.status).toBe(200);
    expect(z.mail.get("191", m1.messageId)!.flagid).toBe("important");
    const bad = await z.fetch(`https://mail.zoho.com.au/api/accounts/191/updatemessage`, {
      method: "PUT",
      headers: { authorization: `Zoho-oauthtoken ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "flag", flagid: 2, messageId: [m1.messageId] }),
    });
    expect(bad.status).toBe(400);
  });
});

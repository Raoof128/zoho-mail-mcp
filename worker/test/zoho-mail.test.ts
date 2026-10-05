import { describe, it, expect } from "vitest";
import { FakeZoho } from "./fake-zoho";
import { testEnv, testDeps } from "./test-env";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import * as mail from "../src/zoho/mail";

let seq = 0;
/** One fresh account per call: D1 rows persist across cases within a file, and Zoho account ids are numeric. */
export async function zohoFixture() {
  const n = ++seq;
  const id = `a${n}`,
    Z = `19100${n}`;
  const z = await FakeZoho.create();
  const e = testEnv();
  // Tools address the account by its slot name, as a real connect stores it. D1 rows persist across cases in a file
  // and aliases are unique per user, so the previous case's account steps aside first.
  await e.DB.prepare(
    "UPDATE accounts SET alias = 'old-' || id, status = 'revoked', is_default = 0 WHERE user_id = 'u' AND alias = 'sarabi'",
  ).run();
  // Like the client's mailbox: info@ owns the Sarabi address with RCP as a send-as alias.
  await seedUserAndAccount(e.DB, {
    userId: "u",
    accountId: id,
    alias: "sarabi",
    isDefault: true,
    slot: "sarabi",
    sendAs: ["sarabi@example.test", "rcp@example.test"],
    zohoAccountId: Z,
  });
  z.accounts.set(`sub-${id}`, {
    accountId: Z,
    primaryEmail: "sarabi@example.test",
    sendAs: ["sarabi@example.test", "rcp@example.test"],
  });
  await seedAccessToken(e, { userId: "u", accountId: id, access: z.directToken(Z) });
  return { z, e, d: testDeps(z), acct: { userId: "u", accountId: id, toolCallId: "t" }, Z, accountId: id };
}

describe("zoho mail wrappers", () => {
  it("lists with limit and threadId, reads details, content and headers by folder", async () => {
    const { z, e, d, acct, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "Hi",
      content: "<p>body</p>",
      threadId: "7",
    });
    z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "Re: Hi",
      content: "<p>r</p>",
      threadId: "7",
    });
    const rows = await mail.listMessages(e, d, acct, { threadId: "7", limit: 50 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.folderId)).toContain(z.mail.folderId(Z, "Sent"));
    expect((await mail.messageContent(e, d, acct, m.folderId, m.messageId)).content).toBe("<p>body</p>");
    const h = await mail.messageHeaders(e, d, acct, m.folderId, m.messageId);
    expect(h["Message-ID"]?.[0]).toMatch(/^<.*@fake\.zoho>$/);
  });
  it("sends the documented mode literals", async () => {
    const { z, e, d, acct, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "Hi",
      content: "x",
    });
    await mail.updateMessages(e, d, acct, "setFlag", [m.messageId], { flagid: "followup" });
    await mail.updateMessages(e, d, acct, "archiveMails", [m.messageId]);
    await mail.updateMessages(e, d, acct, "moveToSpam", [m.messageId]);
    const got = z.mail.get(Z, m.messageId)!;
    expect(got.flagid).toBe("followup");
    expect(got.archived).toBe(true);
    expect(got.folderId).toBe(z.mail.folderId(Z, "Spam"));
    const bodies = z.mail.requests.filter((r) => r.method === "PUT");
    expect(bodies).toHaveLength(3);
  });
  it("uploads raw bytes and returns the store triple", async () => {
    const { e, d, acct } = await zohoFixture();
    const ref = await mail.uploadAttachment(e, d, acct, "a.txt", new Uint8Array([1, 2, 3]));
    expect(ref).toMatchObject({ attachmentName: "a.txt", attachmentSize: 3 });
    expect(ref.storeName).toMatch(/^store-/);
  });
  it("deletes a label, while a message delete is still refused by the token's scopes", async () => {
    const { z, e, d, acct, Z } = await zohoFixture();
    const l = await mail.createLabel(e, d, acct, { labelName: "Quotes" });
    expect((await mail.deleteLabel(e, d, acct, l.labelId)).status).toBe(200);
    expect(await mail.listLabels(e, d, acct)).toEqual([]);
    const m = z.mail.seedMessage(Z, { folder: "Inbox", from: "c@example.org", to: [], subject: "x", content: "x" });
    const { zohoFetch } = await import("../src/zoho/client");
    await expect(
      zohoFetch(e, d, acct, { method: "DELETE", path: `folders/${m.folderId}/messages/${m.messageId}`, retry: "none" }),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
  });
});

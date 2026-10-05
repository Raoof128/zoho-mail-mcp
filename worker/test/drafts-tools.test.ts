import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { approvePending, callTool } from "./zoho-helpers";

describe("drafts on Zoho (D12, G17)", () => {
  it("update_draft saves the new draft before touching the old one; a failed save leaves the old draft", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const c = await callTool(e, d, "u", "create_draft", {
      account: "sarabi",
      to: ["rcp@example.test"],
      subject: "v1",
      body: "one",
    });
    const oldId = c.draft_id as string;
    z.mail.faults.push({ status: 500, errorCode: "DOWN", pathRe: /^\/messages$/ });
    await expect(
      callTool(e, d, "u", "update_draft", { account: "sarabi", draft_id: oldId, subject: "v2", body: "two" }),
    ).rejects.toBeTruthy();
    expect(z.mail.get(Z, oldId)!.folderId).toBe(z.mail.folderId(Z, "Drafts"));
    const u = await callTool(e, d, "u", "update_draft", {
      account: "sarabi",
      draft_id: oldId,
      subject: "v2",
      body: "two",
    });
    expect(u.previous_draft_id).toBe(oldId);
    expect(u.old_draft_cleanup).toBe("done");
    expect(z.mail.get(Z, oldId)!.folderId).toBe(z.mail.folderId(Z, "Trash"));
    expect(z.mail.get(Z, u.draft_id as string)!.subject).toBe("v2");
  });
  it("send_draft sends the snapshot and trashes the draft only on a confirmed send", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const c = await callTool(e, d, "u", "create_draft", {
      account: "sarabi",
      to: ["rcp@example.test"],
      subject: "go",
      body: "x",
    });
    z.mail.faults.push({ status: 503, errorCode: "DOWN", pathRe: /^\/messages$/ });
    // A lost send is answered as the delivery_unknown error, and the draft stays where it was.
    await expect(callTool(e, d, "u", "send_draft", { account: "sarabi", draft_id: c.draft_id })).rejects.toMatchObject({
      code: "delivery_unknown",
    });
    expect(z.mail.get(Z, c.draft_id as string)!.folderId).toBe(z.mail.folderId(Z, "Drafts"));
    const ok = await callTool(e, d, "u", "send_draft", {
      account: "sarabi",
      draft_id: c.draft_id,
      idempotency_key: "second",
    });
    expect(ok.status).toBe("executed");
    expect(z.mail.get(Z, c.draft_id as string)!.folderId).toBe(z.mail.folderId(Z, "Trash"));
  });
  it("send_draft fails closed on a draft with attachments it cannot reconstruct", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Drafts",
      from: "sarabi@example.test",
      to: ["rcp@example.test"],
      subject: "with file",
      content: "c",
      attachments: [{ name: "a.pdf", bytes: new Uint8Array([1]), mime: "application/pdf" }],
    });
    await expect(callTool(e, d, "u", "send_draft", { account: "sarabi", draft_id: m.messageId })).rejects.toMatchObject(
      { code: "draft_not_reconstructible" },
    );
    expect(z.mail.sent).toHaveLength(0);
  });
  it("create_draft as a reply carries the parent's Message-ID as In-Reply-To and References", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const parent = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "Q",
      content: "q",
    });
    z.mail.get(Z, parent.messageId)!.messageIdHeader = "<q@example.org>";
    const c = await callTool(e, d, "u", "create_draft", {
      account: "sarabi",
      to: ["c@example.org"],
      subject: "Re: Q",
      body: "a",
      reply_to_message_id: parent.messageId,
      reply_to_folder_id: parent.folderId,
    });
    expect(z.mail.get(Z, c.draft_id as string)!.inReplyTo).toBe("<q@example.org>");
  });
  it("create_draft with attachments is refused until the probe confirms Zoho keeps them on drafts", async () => {
    const { z, e, d } = await zohoFixture();
    await expect(
      callTool(e, d, "u", "create_draft", {
        account: "sarabi",
        to: ["rcp@example.test"],
        subject: "f",
        body: "x",
        attachments: ["sh_" + "d".repeat(43)],
      }),
    ).rejects.toMatchObject({ code: "draft_attachments_unsupported" });
    expect(z.mail.requests).toHaveLength(0);
  });
  it("a draft edited after approval is a payload mismatch: nothing is sent and the draft is kept", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const c = await callTool(e, d, "u", "create_draft", {
      account: "sarabi",
      to: ["outside@else.example"],
      subject: "s",
      body: "x",
    });
    const pending = await callTool(e, d, "u", "send_draft", { account: "sarabi", draft_id: c.draft_id });
    expect(pending.status).toBe("pending_approval");
    z.mail.get(Z, c.draft_id as string)!.content = "edited after approval";
    await expect(approvePending(e, d, "u", pending)).rejects.toMatchObject({ code: "payload_mismatch" });
    expect(z.mail.sent).toHaveLength(0);
    expect(z.mail.get(Z, c.draft_id as string)!.folderId).toBe(z.mail.folderId(Z, "Drafts"));
  });
  it("refuses a Gmail-shaped draft id before any Zoho request", async () => {
    const { z, e, d } = await zohoFixture();
    await expect(callTool(e, d, "u", "send_draft", { account: "sarabi", draft_id: "r-18f3a9c2b" })).rejects.toThrow();
    expect(z.mail.requests).toHaveLength(0);
  });
});

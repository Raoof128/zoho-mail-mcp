import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { approvePending, callTool } from "./zoho-helpers";
import { insertSealed } from "../src/staging/sealed";
import * as mail from "../src/zoho/mail";

describe("send tools on Zoho", () => {
  it("reply_all reconstructs Reply-To plus To and Cc minus own addresses, never Bcc (Review Focus 2 fallback included)", async () => {
    const { z, e, d, Z, accountId } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "Carla <c@example.org>",
      to: ["sarabi@example.test", "k@example.org"],
      cc: ["rcp@example.test", "l@example.org"],
      subject: "Plan",
      content: "p",
    });
    z.mail.get(Z, m.messageId)!.messageIdHeader = "<plan@example.org>";
    await e.DB.prepare("INSERT INTO contact_allowlist (user_id, account_id, pattern) VALUES ('u', ?, '@example.org')")
      .bind(accountId)
      .run();
    const r = await callTool(e, d, "u", "reply", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      reply_all: true,
      body: "ok",
    });
    expect(r.status).toBe("executed");
    const body = z.mail.sent[0]!.body;
    expect(String(body.toAddress).split(",").sort()).toEqual(["c@example.org", "k@example.org"].sort());
    expect(String(body.ccAddress).split(",")).toEqual(["l@example.org"]);
    expect(body.bccAddress).toBeUndefined();
    expect(body.action).toBe("Reply");
    // A note to self: own addresses removed leaves nothing, fall back to original To, then to self.
    const self = z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["sarabi@example.test"],
      subject: "note",
      content: "n",
    });
    const r2 = await callTool(e, d, "u", "reply", {
      account: "sarabi",
      message_id: self.messageId,
      folder_id: self.folderId,
      body: "more",
    });
    expect(r2.status).toBe("executed");
    expect(z.mail.sent[1]!.body.toAddress).toBe("sarabi@example.test");
  });
  it("forward asks by default and carries the originals after approval; more than 10 is refused before any upload (D17, G19)", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const seed = (n: number) =>
      z.mail.seedMessage(Z, {
        folder: "Inbox",
        from: "c@example.org",
        to: ["sarabi@example.test"],
        subject: "Docs",
        content: "see attached",
        attachments: Array.from({ length: n }, (_, i) => ({
          name: `f${i}.txt`,
          bytes: new Uint8Array([i]),
          mime: "text/plain",
        })),
      });
    const small = seed(3);
    const r = await callTool(e, d, "u", "forward", {
      account: "sarabi",
      message_id: small.messageId,
      folder_id: small.folderId,
      to: ["rcp@example.test"],
      include_original_attachments: true,
    });
    expect(r.status).toBe("pending_approval");
    expect(r.action).toBe("send.forward");
    expect(z.mail.uploads.size).toBe(0); // nothing re-uploaded before approval
    const done = await callTool(
      e,
      d,
      "u",
      "forward",
      {
        account: "sarabi",
        message_id: small.messageId,
        folder_id: small.folderId,
        to: ["rcp@example.test"],
        include_original_attachments: true,
      },
      { approve: true },
    );
    expect(done.status).toBe("executed");
    expect((z.mail.sent.at(-1)!.body.attachments as unknown[]).length).toBe(3);

    const big = seed(12);
    const before = z.mail.uploads.size;
    await expect(
      callTool(e, d, "u", "forward", {
        account: "sarabi",
        message_id: big.messageId,
        folder_id: big.folderId,
        to: ["rcp@example.test"],
        include_original_attachments: true,
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    await expect(
      callTool(e, d, "u", "forward", {
        account: "sarabi",
        message_id: big.messageId,
        folder_id: big.folderId,
        to: ["rcp@example.test"],
        attach_from_message: z.mail
          .get(Z, big.messageId)!
          .attachments.slice(0, 11)
          .map((x) => ({
            message_id: big.messageId,
            folder_id: big.folderId,
            attachment_id: x.attachmentId,
          })),
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(z.mail.uploads.size).toBe(before);
  });
  it("refuses a message whose attachments exceed 32 MB before any upload (D14)", async () => {
    const { e, d } = await zohoFixture();
    await expect(
      callTool(e, d, "u", "send_message", {
        account: "sarabi",
        to: ["rcp@example.test"],
        subject: "big",
        body: "x",
        attachments: ["sh_" + "z".repeat(43)],
      }),
    ).rejects.toMatchObject({ code: "handle_invalid" });
  });
  it("a staged file is sent as a Zoho upload and its handle is consumed", async () => {
    const { z, e, d, acct, accountId } = await zohoFixture();
    const up = await mail.uploadAttachment(
      e,
      d,
      { ...acct, toolCallId: "stage" },
      "quote.pdf",
      new Uint8Array([1, 2, 3]),
    );
    const handle = "sh_" + "q".repeat(43);
    await insertSealed(e.DB, {
      handle,
      user_id: "u",
      account_id: accountId,
      direction: "upload",
      provider_ref: JSON.stringify(up),
      filename: "quote.pdf",
      mime: "application/pdf",
      size: 3,
      sha256: "0".repeat(64),
      created_at: Date.now(),
      expires_at: Date.now() + 600_000,
    });
    const r = await callTool(
      e,
      d,
      "u",
      "send_message",
      { account: "sarabi", to: ["rcp@example.test"], subject: "q", body: "x", attachments: [handle] },
      { approve: true },
    );
    expect(r.status).toBe("executed");
    expect(z.mail.sent.at(-1)!.body.attachments).toEqual([up]);
    const row = await e.DB.prepare("SELECT consumed_at FROM sealed_handles WHERE handle = ?")
      .bind(handle)
      .first<{ consumed_at: number | null }>();
    expect(row!.consumed_at).not.toBeNull();
  });
  it("a handle that expired between approval and execution is handle_expired and nothing is sent (Review Focus 4)", async () => {
    const { z, e, d, acct, accountId } = await zohoFixture();
    const up = await mail.uploadAttachment(e, d, { ...acct, toolCallId: "stage2" }, "a.txt", new Uint8Array([1]));
    const handle = "sh_" + "x".repeat(43);
    await insertSealed(e.DB, {
      handle,
      user_id: "u",
      account_id: accountId,
      direction: "upload",
      provider_ref: JSON.stringify(up),
      filename: "a.txt",
      mime: "text/plain",
      size: 1,
      sha256: "0".repeat(64),
      created_at: Date.now(),
      expires_at: Date.now() + 600_000,
    });
    const args = { account: "sarabi", to: ["outside@else.example"], subject: "s", body: "b", attachments: [handle] };
    const pending = await callTool(e, d, "u", "send_message", args);
    expect(pending.status).toBe("pending_approval");
    await e.DB.prepare("UPDATE sealed_handles SET expires_at = ? WHERE handle = ?")
      .bind(Date.now() - 1, handle)
      .run();
    const sentBefore = z.mail.sent.length;
    await expect(approvePending(e, d, "u", pending)).rejects.toMatchObject({ code: "handle_expired" });
    expect(z.mail.sent.length).toBe(sentBefore);
  });
  it("attachments over the account's limit are refused before any Zoho request", async () => {
    const { z, e, d, accountId } = await zohoFixture();
    const handles = ["sh_" + "m".repeat(43), "sh_" + "n".repeat(43)];
    for (const handle of handles)
      await insertSealed(e.DB, {
        handle,
        user_id: "u",
        account_id: accountId,
        direction: "upload",
        provider_ref: "{}",
        filename: "big.bin",
        mime: "application/octet-stream",
        size: 13_200_000, // two of these exceed the 20 MB limit the owner sets below
        sha256: "0".repeat(64),
        created_at: Date.now(),
        expires_at: Date.now() + 600_000,
      });
    // The default is now the 32 MB message ceiling (D14); an owner-lowered limit must still refuse.
    await e.DB.prepare("UPDATE accounts SET send_limit_bytes = 20000000 WHERE id = ?").bind(accountId).run();
    await expect(
      callTool(e, d, "u", "send_message", {
        account: "sarabi",
        to: ["rcp@example.test"],
        subject: "big",
        body: "x",
        attachments: handles,
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(z.mail.requests).toHaveLength(0);
  });
  it("refuses a Gmail-shaped message id on reply before any Zoho request", async () => {
    const { z, e, d } = await zohoFixture();
    await expect(
      callTool(e, d, "u", "reply", { account: "sarabi", message_id: "18f3a9c2b", body: "x" }),
    ).rejects.toThrow();
    expect(z.mail.requests).toHaveLength(0);
  });
});

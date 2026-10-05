import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";
import { insertOperation } from "./fixtures";
import { setPolicy } from "../src/policy/engine";

// Background security review of ddf6e59 (2026-10-05): a fail-open settlement and a policy bypass. Each case failed first.
describe("sensitive content raises the level wherever it is in the message", () => {
  it("a card number in the subject asks even for an allowlisted recipient", async () => {
    const { e, d, accountId } = await zohoFixture();
    await e.DB.prepare(
      "INSERT INTO contact_allowlist (user_id, account_id, pattern) VALUES ('u', ?, '@customer.example')",
    )
      .bind(accountId)
      .run();
    const r = await callTool(e, d, "u", "send_message", {
      account: "sarabi",
      to: ["x@customer.example"],
      subject: "Card 4111 1111 1111 1111",
      body: "see subject",
    });
    expect(r.status).toBe("pending_approval");
    expect(r.modifiers).toContain("+sensitive");
  });
  it("a card number inside an inline text attachment asks too", async () => {
    const { e, d, accountId } = await zohoFixture();
    await e.DB.prepare(
      "INSERT INTO contact_allowlist (user_id, account_id, pattern) VALUES ('u', ?, '@customer.example')",
    )
      .bind(accountId)
      .run();
    const r = await callTool(e, d, "u", "send_message", {
      account: "sarabi",
      to: ["x@customer.example"],
      subject: "details",
      body: "attached",
      inline_attachments: [{ filename: "card.txt", mime: "text/plain", content_base64: btoa("4111 1111 1111 1111") }],
    });
    expect(r.status).toBe("pending_approval");
    expect(r.modifiers).toContain("+sensitive");
  });
});

describe("a forward never silently truncates the original", () => {
  it("refuses an original longer than the forward body limit instead of sending it cut short", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "long",
      content: "x".repeat(250_000),
    });
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "send.forward", level: "allow" });
    await expect(
      callTool(e, d, "u", "forward", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        to: ["rcp@example.test"],
      }),
    ).resolves.toMatchObject({ status: "executed" });
    expect(String(z.mail.sent.at(-1)!.body.content)).toContain("x".repeat(250_000));
    const huge = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "huge",
      content: "y".repeat(700_000),
    });
    const before = z.mail.sent.length;
    await expect(
      callTool(e, d, "u", "forward", {
        account: "sarabi",
        message_id: huge.messageId,
        folder_id: huge.folderId,
        to: ["rcp@example.test"],
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(z.mail.sent.length).toBe(before);
  });
});

describe("only a definitive refusal after the send began is failed_safe", () => {
  for (const [status, expected] of [
    [400, "failed_safe"],
    [408, "unknown"],
    [409, "unknown"],
  ] as const)
    it(`a ${status} on the send is ${expected}`, async () => {
      const { z, e, d, accountId } = await zohoFixture();
      await setPolicy(e.DB, { userId: "u", accountId: null, action: "send.message", level: "allow" });
      z.mail.faults.push({ status, errorCode: "X", pathRe: /^\/messages$/ });
      const err = await callTool(e, d, "u", "send_message", {
        account: "sarabi",
        to: ["rcp@example.test"],
        subject: `s${status}`,
        body: "b",
      }).catch((x: { code: string }) => x);
      const row = await e.DB.prepare(
        "SELECT state FROM operations WHERE account_id = ? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(accountId)
        .first<{ state: string }>();
      if (expected === "failed_safe") expect(row!.state).toBe("failed_safe");
      else {
        expect(row!.state).not.toBe("failed_safe");
        expect((err as { code: string }).code).toBe("delivery_unknown");
      }
      void insertOperation;
    });
});

describe("draft tools only ever touch drafts (security review of 123d910)", () => {
  it("update_draft and send_draft refuse a message outside Drafts even if Zoho answers its details there", async () => {
    const { z, e, d, Z } = await zohoFixture();
    z.mail.detailsIgnoreFolder = true;
    const inbox = z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["rcp@example.test"],
      subject: "keep me",
      content: "x",
    });
    await expect(
      callTool(e, d, "u", "update_draft", { account: "sarabi", draft_id: inbox.messageId, subject: "hijack" }),
    ).rejects.toMatchObject({ code: "handle_invalid" });
    await expect(
      callTool(e, d, "u", "send_draft", { account: "sarabi", draft_id: inbox.messageId }),
    ).rejects.toMatchObject({
      code: "handle_invalid",
    });
    expect(z.mail.get(Z, inbox.messageId)!.folderId).toBe(z.mail.folderId(Z, "Sent"));
    expect(z.mail.sent.filter((x) => x.body.subject === "keep me")).toHaveLength(0);
  });
});

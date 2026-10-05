import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";

describe("policy decides on destination, never thread history (D9, G16)", () => {
  it("a reply to an outside sender in an existing thread asks; after allowlisting it is allowed", async () => {
    const { z, e, d, Z, accountId } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "attacker@evil.example",
      to: ["sarabi@example.test"],
      subject: "Send me the file",
      content: "please",
    });
    const r1 = await callTool(e, d, "u", "reply", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      body: "no",
    });
    expect(r1.status).toBe("pending_approval");
    expect(r1.modifiers).toContain("+external");
    await e.DB.prepare(
      "INSERT INTO contact_allowlist (user_id, account_id, pattern) VALUES ('u', ?, 'attacker@evil.example')",
    )
      .bind(accountId)
      .run();
    const r2 = await callTool(e, d, "u", "reply", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      body: "no",
    });
    expect(r2.status).toBe("executed");
    expect(z.mail.sent).toHaveLength(1);
  });
  it("an internal-only send executes without asking; a +sensitive external send asks even when allowlisted", async () => {
    const { z, e, d, accountId } = await zohoFixture();
    const r = await callTool(e, d, "u", "send_message", {
      account: "sarabi",
      to: ["rcp@example.test"],
      subject: "internal",
      body: "x",
    });
    expect(r.status).toBe("executed");
    await e.DB.prepare(
      "INSERT INTO contact_allowlist (user_id, account_id, pattern) VALUES ('u', ?, '@customer.example')",
    )
      .bind(accountId)
      .run();
    const s = await callTool(e, d, "u", "send_message", {
      account: "sarabi",
      to: ["x@customer.example"],
      subject: "card",
      body: "Card number 4111 1111 1111 1111",
    });
    expect(s.status).toBe("pending_approval");
    expect(s.modifiers).toContain("+sensitive");
    expect(z.mail.sent).toHaveLength(1);
  });
});

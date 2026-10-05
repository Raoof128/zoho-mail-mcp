import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";
import { setPolicy } from "../src/policy/engine";

// Background security review of ba631b3 ("authorization-policy-bypass in organise.ts", 2026-10-05). Each failed first.
describe("organising tools cannot reach a stricter action through a looser one", () => {
  it("apply_sensitive_message_label SPAM is decided by spam.mark, not trash.move", async () => {
    const { z, e, d, Z } = await zohoFixture();
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "trash.move", level: "allow" });
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "spam.mark", level: "deny" });
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "s",
      content: "x",
    });
    await expect(
      callTool(e, d, "u", "apply_sensitive_message_label", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        label_option: "SPAM",
      }),
    ).rejects.toThrow();
    expect(z.mail.get(Z, m.messageId)!.folderId).toBe(z.mail.folderId(Z, "Inbox"));
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "trash.move", level: "ask" });
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "spam.mark", level: "ask" });
  });
  it("a message cannot be moved into Drafts, where the draft tools would trash it under draft.write", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "keep",
      content: "x",
    });
    await expect(
      callTool(e, d, "u", "move_message", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        folder: "Drafts",
      }),
    ).rejects.toMatchObject({ code: "policy_denied" });
    expect(z.mail.get(Z, m.messageId)!.folderId).toBe(z.mail.folderId(Z, "Inbox"));
  });
});

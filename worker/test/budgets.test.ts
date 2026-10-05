import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";

describe("D17 budgets end to end (G19)", () => {
  it("a forward of a message with 100 attachments is refused before any upload", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const atts = Array.from({ length: 100 }, (_, i) => ({
      name: `f${i}`,
      bytes: new Uint8Array([1]),
      mime: "text/plain",
    }));
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "many",
      content: "x",
      attachments: atts,
    });
    const before = z.mail.uploads.size;
    await expect(
      callTool(e, d, "u", "forward", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        to: ["rcp@example.test"],
        include_original_attachments: true,
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(z.mail.uploads.size).toBe(before);
  });
  it("inline attachments count against the 10-attachment budget, refused before any upload (M3 review minor)", async () => {
    const { z, e, d } = await zohoFixture();
    const before = z.mail.uploads.size;
    const inline = Array.from({ length: 11 }, (_, i) => ({
      filename: `i${i}.txt`,
      mime: "text/plain",
      content_base64: btoa(`x${i}`),
    }));
    await expect(
      callTool(e, d, "u", "send_message", {
        account: "sarabi",
        to: ["rcp@example.test"],
        subject: "many",
        body: "x",
        inline_attachments: inline,
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(z.mail.uploads.size).toBe(before);
  });
});

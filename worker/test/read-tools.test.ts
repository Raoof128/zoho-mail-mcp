import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";

describe("read tools on Zoho", () => {
  it("search_messages returns flat rows with folder_id and thread_id", async () => {
    const { z, e, d, Z } = await zohoFixture();
    z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "Invoice 12",
      content: "x",
    });
    const r = await callTool(e, d, "u", "search_messages", { account: "sarabi", query: "subject:Invoice" });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ subject: "Invoice 12", folder_id: z.mail.folderId(Z, "Inbox") });
  });
  it("get_thread costs one call for metadata and at most 8 bodies for full, with a cursor", async () => {
    const { z, e, d, Z } = await zohoFixture();
    for (let i = 0; i < 12; i++)
      z.mail.seedMessage(Z, {
        folder: i % 2 ? "Sent" : "Inbox",
        from: "c@example.org",
        to: ["sarabi@example.test"],
        subject: `m${i}`,
        content: `<p>${i}</p>`,
        threadId: "500",
      });
    const before = z.mail.requests.length;
    const meta = await callTool(e, d, "u", "get_thread", {
      account: "sarabi",
      thread_id: "500",
      message_format: "METADATA_ONLY",
    });
    expect(z.mail.requests.length - before).toBe(1);
    expect(meta.thread.messages).toHaveLength(12);
    const full = await callTool(e, d, "u", "get_thread", {
      account: "sarabi",
      thread_id: "500",
      message_format: "PLAIN_TEXT",
    });
    expect(
      full.thread.messages.filter((m: { plaintext_body?: string }) => m.plaintext_body !== undefined),
    ).toHaveLength(8);
    expect(full.thread.next_cursor).toBeDefined();
  });
  it("get_message resolves a bare message_id by probing system folders and refuses an unknown id", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "S",
      content: "<p>sent</p>",
    });
    const r = await callTool(e, d, "u", "get_message", { account: "sarabi", message_id: m.messageId });
    expect(r.message.plaintext_body).toBe("sent");
    await expect(callTool(e, d, "u", "get_message", { account: "sarabi", message_id: "424242" })).rejects.toMatchObject(
      { code: "handle_invalid" },
    );
  });
  it("list_folders and list_labels", async () => {
    const { z, e, d, Z } = await zohoFixture();
    z.mail.seedLabel(Z, "Clients", "#00ff00");
    const f = await callTool(e, d, "u", "list_folders", { account: "sarabi" });
    expect(f.folders.map((x: { name: string }) => x.name)).toContain("Inbox");
    const l = await callTool(e, d, "u", "list_labels", { account: "sarabi" });
    expect(l.labels[0]).toMatchObject({ name: "Clients", color: "#00ff00" });
  });
  it("gives every tool invocation its own budget: two full get_thread calls each read 8 bodies (M1 review minor 13)", async () => {
    const { z, e, d, Z } = await zohoFixture();
    for (let i = 0; i < 9; i++)
      z.mail.seedMessage(Z, {
        folder: "Inbox",
        from: "c@example.org",
        to: ["sarabi@example.test"],
        subject: `b${i}`,
        content: `<p>${i}</p>`,
        threadId: "600",
      });
    const bodies = (r: { thread: { messages: { plaintext_body?: string }[] } }) =>
      r.thread.messages.filter((m) => m.plaintext_body !== undefined).length;
    const args = { account: "sarabi", thread_id: "600", message_format: "PLAIN_TEXT" };
    expect(bodies(await callTool(e, d, "u", "get_thread", args))).toBe(8);
    expect(bodies(await callTool(e, d, "u", "get_thread", args))).toBe(8);
  });
  it("refuses a Gmail-shaped id on the Zoho read tools", async () => {
    const { z, e, d } = await zohoFixture();
    await expect(callTool(e, d, "u", "get_message", { account: "sarabi", message_id: "18f3a9c2b" })).rejects.toThrow();
    expect(z.mail.requests).toHaveLength(0); // refused at input validation, before any folder probe
  });
});

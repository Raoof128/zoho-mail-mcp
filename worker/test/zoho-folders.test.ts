import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { systemFolders, threadMessages } from "../src/zoho/folders";

describe("folders", () => {
  it("resolves system folders once and caches them", async () => {
    const { z, e, d, acct, Z } = await zohoFixture();
    z.mail.ensureFolders(Z);
    const a = await systemFolders(e, d, acct);
    expect(a.inbox).toBe(z.mail.folderId(Z, "Inbox"));
    expect(a.trash).toBe(z.mail.folderId(Z, "Trash"));
    const before = z.mail.requests.length;
    await systemFolders(e, d, acct);
    expect(z.mail.requests.length).toBe(before);
  });
  it("reads a thread across folders with each message's own folder id (Review Focus 3)", async () => {
    const { z, e, d, acct, Z } = await zohoFixture();
    z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "A",
      content: "1",
      threadId: "77",
    });
    z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "Re: A",
      content: "2",
      threadId: "77",
    });
    const rows = await threadMessages(e, d, acct, "77", 50);
    expect(rows.map((r) => r.folderId).sort()).toEqual(
      [z.mail.folderId(Z, "Inbox"), z.mail.folderId(Z, "Sent")].sort(),
    );
  });
});

import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";
import { setPolicy } from "../src/policy/engine";
import { insertOperation } from "./fixtures";

// Final review of M4 (2026-10-05). The double now answers updates as the saved pages do: status only, no data.
describe("C1: updates succeed on Zoho's documented status-only answer", () => {
  it("flag, archive and move report executed", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "x",
      content: "x",
    });
    const base = { account: "sarabi", message_id: m.messageId, folder_id: m.folderId };
    expect((await callTool(e, d, "u", "flag_message", { ...base, flag: "important" })).status).toBe("executed");
    expect((await callTool(e, d, "u", "archive_message", base)).status).toBe("executed");
    z.mail.seedFolder(Z, "Clients");
    expect((await callTool(e, d, "u", "move_message", { ...base, folder: "Clients" })).status).toBe("executed");
  });
});

describe("I1 and I2: untrash restores only a verified, safe source folder", () => {
  it("a folder_id hint pointing at Spam is not recorded: untrash returns the message to where it really was", async () => {
    const { z, e, d, Z } = await zohoFixture();
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "trash.move", level: "allow" });
    z.mail.detailsIgnoreFolder = true; // Zoho may answer details under any folder path
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "x",
      content: "x",
    });
    await callTool(e, d, "u", "trash_message", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: z.mail.folderId(Z, "Spam"),
    });
    await callTool(e, d, "u", "untrash_message", { account: "sarabi", message_id: m.messageId });
    expect(z.mail.get(Z, m.messageId)!.folderId).toBe(z.mail.folderId(Z, "Inbox"));
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "trash.move", level: "ask" });
  });
  it("a newer trash record without a source folder does not shadow the one that has it", async () => {
    const { z, e, d, Z, accountId } = await zohoFixture();
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "trash.move", level: "allow" });
    const m = z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "x",
      content: "x",
    });
    await callTool(e, d, "u", "trash_message", { account: "sarabi", message_id: m.messageId, folder_id: m.folderId });
    await insertOperation(e.DB, "shadow", "u", accountId, "executed");
    await e.DB.prepare(
      "UPDATE operations SET action = 'trash.move', result_json = ?, created_at = ? WHERE id = 'shadow'",
    )
      .bind(JSON.stringify({ updated: [m.messageId], mode: "moveMessage" }), Date.now() + 60_000)
      .run();
    await callTool(e, d, "u", "untrash_message", { account: "sarabi", message_id: m.messageId });
    expect(z.mail.get(Z, m.messageId)!.folderId).toBe(z.mail.folderId(Z, "Sent"));
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "trash.move", level: "ask" });
  });
});

describe("I3: a move never targets Sent, Outbox or Templates", () => {
  it("refuses Sent, whose contents the delivery probe treats as evidence", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "x",
      content: "x",
    });
    for (const folder of ["Sent", "Outbox", "Templates"])
      await expect(
        callTool(e, d, "u", "move_message", {
          account: "sarabi",
          message_id: m.messageId,
          folder_id: m.folderId,
          folder,
        }),
      ).rejects.toMatchObject({ code: "policy_denied" });
    expect(z.mail.get(Z, m.messageId)!.folderId).toBe(z.mail.folderId(Z, "Inbox"));
  });
});

describe("I4: thread actions other than labels go to updatemessage with threadId", () => {
  it("archive_thread and mark_read on threads", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "x",
      content: "x",
      threadId: "7700",
    });
    expect((await callTool(e, d, "u", "archive_thread", { account: "sarabi", thread_id: "7700" })).status).toBe(
      "executed",
    );
    expect(z.mail.get(Z, m.messageId)!.archived).toBe(true);
    expect((await callTool(e, d, "u", "mark_read", { account: "sarabi", thread_ids: ["7700"] })).status).toBe(
      "executed",
    );
    expect(z.mail.get(Z, m.messageId)!.status).toBe("read");
  });
});

describe("I5: apply_sensitive_* offers only TRASH", () => {
  it("SPAM is not an accepted option", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "x",
      content: "x",
    });
    await expect(
      callTool(e, d, "u", "apply_sensitive_message_label", {
        account: "sarabi",
        message_id: m.messageId,
        label_option: "SPAM",
      }),
    ).rejects.toThrow(/Input validation/);
  });
});

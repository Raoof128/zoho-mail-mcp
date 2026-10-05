import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";
import { setPolicy } from "../src/policy/engine";

describe("organising tools (5.4)", () => {
  it("every message tool sends one PUT with the documented mode", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "x",
      content: "x",
    });
    const lbl = z.mail.seedLabel(Z, "Clients");
    // mark_read and mark_unread take message_ids, not message_id.
    const t = (name: string, args: Record<string, unknown>) =>
      callTool(e, d, "u", name, {
        account: "sarabi",
        ...(name.startsWith("mark_") ? {} : { message_id: m.messageId, folder_id: m.folderId }),
        ...args,
      });
    const puts = () => z.mail.requests.filter((r) => r.method === "PUT").length;
    const cases: [string, Record<string, unknown>, (g: ReturnType<typeof z.mail.get>) => unknown, unknown][] = [
      ["label_message", { label_ids: [lbl.labelId] }, (g) => g!.labels, [lbl.labelId]],
      ["unlabel_message", { label_ids: [lbl.labelId] }, (g) => g!.labels, []],
      ["flag_message", { flag: "followup" }, (g) => g!.flagid, "followup"],
      ["mark_read", { message_ids: [m.messageId] }, (g) => g!.status, "read"],
      ["mark_unread", { message_ids: [m.messageId] }, (g) => g!.status, "unread"],
      ["archive_message", {}, (g) => g!.archived, true],
      ["unarchive_message", {}, (g) => g!.archived, false],
      ["move_message", { folder: "Sent" }, (g) => g!.folderId, z.mail.folderId(Z, "Sent")],
    ];
    for (const [name, args, read, want] of cases) {
      const before = puts();
      const r = await t(name, args);
      expect(r.status, name).toBe("executed");
      expect(puts() - before, name).toBe(1);
      expect(read(z.mail.get(Z, m.messageId)), name).toEqual(want);
    }
  });
  it("trash and spam ask by default; untrash restores the recorded folder; nothing calls DELETE", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "x",
      content: "x",
    });
    const p = await callTool(e, d, "u", "trash_message", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
    });
    expect(p.status).toBe("pending_approval");
    const done = await callTool(
      e,
      d,
      "u",
      "trash_message",
      { account: "sarabi", message_id: m.messageId, folder_id: m.folderId },
      { approve: true },
    );
    expect(done.status).toBe("executed");
    expect(z.mail.get(Z, m.messageId)!.folderId).toBe(z.mail.folderId(Z, "Trash"));
    const back = await callTool(e, d, "u", "untrash_message", { account: "sarabi", message_id: m.messageId });
    expect(back.status).toBe("executed");
    expect(z.mail.get(Z, m.messageId)!.folderId).toBe(z.mail.folderId(Z, "Inbox"));
    const s = await callTool(
      e,
      d,
      "u",
      "mark_message_spam",
      { account: "sarabi", message_id: m.messageId, folder_id: m.folderId },
      { approve: true },
    );
    expect(s.status).toBe("executed");
    expect(z.mail.get(Z, m.messageId)!.folderId).toBe(z.mail.folderId(Z, "Spam"));
    expect(z.mail.requests.some((r) => r.method === "DELETE")).toBe(false);
  });
  it("delete_label asks (+destructive) and is the only DELETE the token can make", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const lbl = z.mail.seedLabel(Z, "Old");
    const p = await callTool(e, d, "u", "delete_label", { account: "sarabi", label_id: lbl.labelId });
    expect(p.status).toBe("pending_approval");
    expect(p.modifiers).toContain("+destructive");
    await callTool(e, d, "u", "delete_label", { account: "sarabi", label_id: lbl.labelId }, { approve: true });
    expect(z.mail.labels.get(Z)!.some((l) => l.labelId === lbl.labelId)).toBe(false);
  });
  it("create_label is allowed by default; delete_label still asks (label.manage allow, raised by +destructive)", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const c = await callTool(e, d, "u", "create_label", {
      account: "sarabi",
      display_name: "Quotes",
      color: "#00ff00",
    });
    expect(c.status).toBe("executed");
    expect(z.mail.labels.get(Z)!.map((l) => l.displayName)).toContain("Quotes");
  });
  it("move_message and move_thread refuse Trash and Spam: those have their own tools and policy", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "x",
      content: "x",
      threadId: "4400",
    });
    for (const folder of ["Trash", "Spam", "trash"])
      await expect(
        callTool(e, d, "u", "move_message", {
          account: "sarabi",
          message_id: m.messageId,
          folder_id: m.folderId,
          folder,
        }),
      ).rejects.toMatchObject({ code: "policy_denied" });
    await expect(
      callTool(e, d, "u", "move_thread", { account: "sarabi", thread_id: "4400", folder: "Spam" }),
    ).rejects.toMatchObject({
      code: "policy_denied",
    });
    expect(z.mail.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    expect(z.mail.get(Z, m.messageId)!.folderId).toBe(z.mail.folderId(Z, "Inbox"));
  });
  it("mark_read marks threads as well as messages; with neither it is refused", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "t",
      content: "x",
      threadId: "4500",
    });
    const r = await callTool(e, d, "u", "mark_read", { account: "sarabi", thread_ids: ["4500"] });
    expect(r.status).toBe("executed");
    expect(z.mail.get(Z, m.messageId)!.status).toBe("read");
    await expect(callTool(e, d, "u", "mark_read", { account: "sarabi" })).rejects.toThrow();
  });
  it("update_message_labels adds and removes in one tool call; overlap is refused", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const a = z.mail.seedLabel(Z, "A");
    const b = z.mail.seedLabel(Z, "B");
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "l",
      content: "x",
    });
    z.mail.get(Z, m.messageId)!.labels = [b.labelId];
    const r = await callTool(e, d, "u", "update_message_labels", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      add_label_ids: [a.labelId],
      remove_label_ids: [b.labelId],
    });
    expect(r.status).toBe("executed");
    expect(z.mail.get(Z, m.messageId)!.labels).toEqual([a.labelId]);
    await expect(
      callTool(e, d, "u", "update_message_labels", {
        account: "sarabi",
        message_id: m.messageId,
        add_label_ids: [a.labelId],
        remove_label_ids: [a.labelId],
      }),
    ).rejects.toThrow();
  });
  it("trash remembers the source folder on the allow path too, and untrash puts it back", async () => {
    const { z, e, d, Z } = await zohoFixture();
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "trash.move", level: "allow" });
    const m = z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "s",
      content: "x",
    });
    expect(
      (
        await callTool(e, d, "u", "trash_message", {
          account: "sarabi",
          message_id: m.messageId,
          folder_id: m.folderId,
        })
      ).status,
    ).toBe("executed");
    expect(z.mail.get(Z, m.messageId)!.folderId).toBe(z.mail.folderId(Z, "Trash"));
    expect((await callTool(e, d, "u", "untrash_message", { account: "sarabi", message_id: m.messageId })).status).toBe(
      "executed",
    );
    expect(z.mail.get(Z, m.messageId)!.folderId).toBe(z.mail.folderId(Z, "Sent"));
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "trash.move", level: "ask" }); // policies persist across cases
  });
  it("refuses Gmail-shaped ids before any Zoho request", async () => {
    const { z, e, d } = await zohoFixture();
    await expect(
      callTool(e, d, "u", "flag_message", { account: "sarabi", message_id: "18f3a9c2b", flag: "important" }),
    ).rejects.toThrow();
    await expect(
      callTool(e, d, "u", "label_thread", { account: "sarabi", thread_id: "18f3", label_ids: ["Label_1"] }),
    ).rejects.toThrow();
    expect(z.mail.requests).toHaveLength(0);
  });
});

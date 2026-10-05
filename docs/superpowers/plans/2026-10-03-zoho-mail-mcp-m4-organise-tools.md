# M4: Labels, move, flag, archive, read marks, trash, spam

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The twenty organising tools from spec section 5.4, every one a single `updatemessage` or `updatethread` call with the documented literal, nothing that expunges, and `delete_label` the only destructive one.

**Architecture:** `tools/labels.ts` is rewritten as `tools/organise.ts` with one generic `updateTool` factory that takes the action, the Zoho mode, the extra body and the summary wording. Trash remembers the source folder in `operations.result_json` so `untrash_*` can put the message back. The Gmail `google/gmail.ts` and its fakes are retired at the end.

**Spec:** D13, section 5.4, section 6.

**Master:** `2026-10-03-zoho-mail-mcp-00-master.md`.

---

### Task 4.1: The generic update tool factory and label tools

> **Carried from M2 execution (2026-10-05):** label, target and organise schemas still use `LegacyGmailId`; move them to `ZohoId` here.

> **Carried from M0 execution (2026-10-04):** `label.manage` stays at `ask` in the shared defaults (commit 88ce6ae). Set it to `allow` in this task together with the `+destructive` modifier that raises a delete, in the same commit, with a test that a label delete still asks.

**Files:**

- Create: `worker/src/tools/organise.ts`
- Delete: `worker/src/tools/labels.ts`, `worker/test/labels-tools.test.ts` (in this task, not 4.2: the label schema shapes change here and the Gmail file compiles against the old ones)
- Modify: `shared/src/schemas.ts` (inputs below, plus `CreateLabelInput { account, display_name, color? }`, `UpdateLabelInput { account, label_id, display_name?, color? }`, delete `LabelListVisibility` and `MessageListVisibility`; declare `MessageTargetInput` and friends **before** `LabelIds`, which uses them), `worker/src/mcp/server.ts` (`registerOrganiseTools` replaces `registerLabelTools`)
- Test: `worker/test/organise-tools.test.ts`

**Interfaces:**

- Produces: `updateTool(spec: { name; description; input; action; mode: UpdateMode; target: "message" | "thread"; extra?: (args) => Record<string, unknown>; modifiers?: Modifier[]; summary: (args) => string })`; schemas `MessageTargetInput { account, message_id, folder_id? }`, `ThreadTargetInput { account, thread_id }`, `FlagMessageInput { ...MessageTarget, flag: z.enum(["info","important","followup","flag_not_set"]) }`, `MoveMessageInput { ...MessageTarget, folder: ZohoFolderName }`, `MoveThreadInput { ...ThreadTarget, folder }`, `MarkReadInput { account, message_ids?: ZohoId[], thread_ids?: ZohoId[] }` (at least one), label inputs unchanged in shape.

- [ ] **Step 1: Failing test**

`worker/test/organise-tools.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";

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
    const t = (name: string, args: Record<string, unknown>) =>
      callTool(e, d, "u", name, { account: "sarabi", message_id: m.messageId, folder_id: m.folderId, ...args });
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
});
```

`callTool(e, d, user, name, args, { approve: true })` is the M0 Task 0.8 helper: it opens the approval URL with the owner's browser session, posts the approve form, then calls `execute_pending`.

- [ ] **Step 2: Implement** `worker/src/tools/organise.ts`:

```ts
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Action, Modifier } from "@zoho-mail-mcp/shared/actions";
import { McpError } from "@zoho-mail-mcp/shared/errors";
import * as S from "@zoho-mail-mcp/shared/schemas";
import type { Env } from "../env";
import { folderByName, systemFolders } from "../zoho/folders";
import * as mail from "../zoho/mail";
import type { ZohoAcct } from "../zoho/client";
import { defineTool, type Plan } from "./define";
import type { ExecRun, ToolContext } from "./gate";
import { resolveRef } from "./read";

const acct = (run: ExecRun): ZohoAcct => ({
  userId: run.userId,
  accountId: run.account.id,
  toolCallId: run.operationId ?? run.pendingId ?? crypto.randomUUID(),
});
const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

type UpdateSpec<Sch extends z.ZodObject<z.ZodRawShape>> = {
  name: string;
  description: string;
  input: Sch;
  action: Action;
  mode: mail.UpdateMode;
  target: "message" | "thread";
  modifiers?: Modifier[];
  extra?: (e: Env, d: ToolContext["deps"], a: ZohoAcct, args: z.infer<Sch>) => Promise<Record<string, unknown>>;
  summary: (args: z.infer<Sch>) => string;
  remember?: boolean;
};

export function updateTool<Sch extends z.ZodObject<z.ZodRawShape>>(
  server: McpServer,
  toolContext: (ctx: ServerContext) => ToolContext,
  env: Env,
  s: UpdateSpec<Sch>,
): void {
  defineTool(server, toolContext, env, {
    name: s.name,
    version: 1,
    description: s.description,
    input: s.input as never,
    annotations: rw,
    action: s.action,
    journal: false,
    plan: (_e, _t, _a, args): Promise<Plan> => {
      const { account: _x, ...payload } = args as Record<string, unknown>;
      const ids = [
        payload.message_id,
        payload.thread_id,
        ...((payload.message_ids as string[]) ?? []),
        ...((payload.thread_ids as string[]) ?? []),
      ].filter((x): x is string => typeof x === "string");
      return Promise.resolve({
        modifiers: s.modifiers ?? [],
        summary: s.summary(args),
        facts: { ids },
        build: () => Promise.resolve({ payload, handles: [] }),
      });
    },
    execute: async (e, d, run) => {
      const args = (s.input as z.ZodObject<z.ZodRawShape>).omit({ account: true }).parse(run.payload) as z.infer<Sch> &
        Record<string, unknown>;
      const a = acct(run);
      const extra = s.extra ? await s.extra(e, d, a, args) : {};
      const ids =
        s.target === "message"
          ? [args.message_id as string | undefined, ...((args.message_ids as string[] | undefined) ?? [])].filter(
              (x): x is string => !!x,
            )
          : [args.thread_id as string | undefined, ...((args.thread_ids as string[] | undefined) ?? [])].filter(
              (x): x is string => !!x,
            );
      if (ids.length === 0) throw new McpError("invalid_header", "invalid_header: nothing to update");
      let remembered: Record<string, unknown> = {};
      if (s.remember && s.target === "message" && args.message_id) {
        const ref = await resolveRef(e, d, a, {
          message_id: args.message_id as string,
          folder_id: args.folder_id as string | undefined,
        });
        remembered = { previous_folder_id: ref.folderId };
      }
      if (s.target === "message") await mail.updateMessages(e, d, a, s.mode, ids, extra);
      else await mail.updateThreads(e, d, a, s.mode, ids, extra);
      return { updated: ids, mode: s.mode, ...remembered };
    },
  });
}

export function registerOrganiseTools(
  server: McpServer,
  toolContext: (ctx: ServerContext) => ToolContext,
  env: Env,
): void {
  const t = <Sch extends z.ZodObject<z.ZodRawShape>>(s: UpdateSpec<Sch>) => updateTool(server, toolContext, env, s);
  const labels = (args: { label_ids: string[] }) => ({ labelId: args.label_ids });
  t({
    name: "label_message",
    description: "Apply labels to a message.",
    input: S.LabelMessageInput,
    action: "label.apply",
    mode: "applyLabel",
    target: "message",
    extra: async (_e, _d, _a, a) => labels(a),
    summary: (a) => `Label message ${a.message_id}`,
  });
  t({
    name: "unlabel_message",
    description: "Remove labels from a message.",
    input: S.UnlabelMessageInput,
    action: "label.apply",
    mode: "removeLabel",
    target: "message",
    extra: async (_e, _d, _a, a) => labels(a),
    summary: (a) => `Unlabel message ${a.message_id}`,
  });
  t({
    name: "label_thread",
    description: "Apply labels to every message in a thread.",
    input: S.LabelThreadInput,
    action: "label.apply",
    mode: "applyLabel",
    target: "thread",
    extra: async (_e, _d, _a, a) => labels(a),
    summary: (a) => `Label thread ${a.thread_id}`,
  });
  t({
    name: "unlabel_thread",
    description: "Remove labels from a thread.",
    input: S.UnlabelThreadInput,
    action: "label.apply",
    mode: "removeLabel",
    target: "thread",
    extra: async (_e, _d, _a, a) => labels(a),
    summary: (a) => `Unlabel thread ${a.thread_id}`,
  });
  t({
    name: "flag_message",
    description: "Set the flag: info, important, followup or flag_not_set.",
    input: S.FlagMessageInput,
    action: "flag.set",
    mode: "setFlag",
    target: "message",
    extra: async (_e, _d, _a, a) => ({ flagid: a.flag }),
    summary: (a) => `Flag message ${a.message_id} as ${a.flag}`,
  });
  t({
    name: "mark_read",
    description: "Mark messages or threads read.",
    input: S.MarkReadInput,
    action: "read.mark",
    mode: "markAsRead",
    target: "message",
    summary: () => "Mark read",
  });
  t({
    name: "mark_unread",
    description: "Mark messages or threads unread.",
    input: S.MarkReadInput,
    action: "read.mark",
    mode: "markAsUnread",
    target: "message",
    summary: () => "Mark unread",
  });
  t({
    name: "archive_message",
    description: "Archive a message (Zoho archive state; older accounts keep it in its folder).",
    input: S.MessageTargetInput,
    action: "archive.set",
    mode: "archiveMails",
    target: "message",
    summary: (a) => `Archive message ${a.message_id}`,
  });
  t({
    name: "unarchive_message",
    description: "Unarchive a message.",
    input: S.MessageTargetInput,
    action: "archive.set",
    mode: "unArchiveMails",
    target: "message",
    summary: (a) => `Unarchive message ${a.message_id}`,
  });
  t({
    name: "archive_thread",
    description: "Archive a thread.",
    input: S.ThreadTargetInput,
    action: "archive.set",
    mode: "archiveMails",
    target: "thread",
    summary: (a) => `Archive thread ${a.thread_id}`,
  });
  t({
    name: "unarchive_thread",
    description: "Unarchive a thread.",
    input: S.ThreadTargetInput,
    action: "archive.set",
    mode: "unArchiveMails",
    target: "thread",
    summary: (a) => `Unarchive thread ${a.thread_id}`,
  });
  const dest = async (e: Env, d: ToolContext["deps"], a: ZohoAcct, args: { folder: string }) => ({
    destfolderId: (await folderByName(e, d, a, args.folder)).folderId,
  });
  t({
    name: "move_message",
    description: "Move a message to a folder by name.",
    input: S.MoveMessageInput,
    action: "folder.move",
    mode: "moveMessage",
    target: "message",
    extra: dest,
    summary: (a) => `Move message ${a.message_id} to ${a.folder}`,
  });
  t({
    name: "move_thread",
    description: "Move a thread to a folder by name.",
    input: S.MoveThreadInput,
    action: "folder.move",
    mode: "moveMessage",
    target: "thread",
    extra: dest,
    summary: (a) => `Move thread ${a.thread_id} to ${a.folder}`,
  });
  const toTrash = async (e: Env, d: ToolContext["deps"], a: ZohoAcct) => ({
    destfolderId: (await systemFolders(e, d, a)).trash,
  });
  t({
    name: "trash_message",
    description: "Move a message to Trash. Nothing is expunged; Zoho's Trash retention applies.",
    input: S.MessageTargetInput,
    action: "trash.move",
    mode: "moveMessage",
    target: "message",
    extra: toTrash,
    remember: true,
    summary: (a) => `Trash message ${a.message_id}`,
  });
  t({
    name: "trash_thread",
    description: "Move a thread to Trash.",
    input: S.ThreadTargetInput,
    action: "trash.move",
    mode: "moveMessage",
    target: "thread",
    extra: toTrash,
    summary: (a) => `Trash thread ${a.thread_id}`,
  });
  const fromTrash = async (e: Env, d: ToolContext["deps"], a: ZohoAcct, args: { message_id?: string }) => {
    const sys = await systemFolders(e, d, a);
    const prev = args.message_id
      ? await e.DB.prepare(
          "SELECT result_json FROM operations WHERE user_id=? AND account_id=? AND action='trash.move' AND result_json LIKE ? ORDER BY created_at DESC LIMIT 1",
        )
          .bind(a.userId, a.accountId, `%"${args.message_id}"%`)
          .first<{ result_json: string }>()
      : null;
    const previous = prev
      ? (JSON.parse(prev.result_json) as { previous_folder_id?: string }).previous_folder_id
      : undefined;
    return { destfolderId: previous ?? sys.inbox };
  };
  t({
    name: "untrash_message",
    description: "Move a message out of Trash, back to the folder it came from when known, else Inbox.",
    input: S.MessageTargetInput,
    action: "trash.restore",
    mode: "moveMessage",
    target: "message",
    extra: fromTrash,
    summary: (a) => `Restore message ${a.message_id}`,
  });
  t({
    name: "untrash_thread",
    description: "Move a thread out of Trash to Inbox.",
    input: S.ThreadTargetInput,
    action: "trash.restore",
    mode: "moveMessage",
    target: "thread",
    extra: async (e, d, a) => ({ destfolderId: (await systemFolders(e, d, a)).inbox }),
    summary: (a) => `Restore thread ${a.thread_id}`,
  });
  t({
    name: "mark_message_spam",
    description: "Move a message to Spam.",
    input: S.MessageTargetInput,
    action: "spam.mark",
    mode: "moveToSpam",
    target: "message",
    summary: (a) => `Mark message ${a.message_id} spam`,
  });
  t({
    name: "mark_thread_spam",
    description: "Move a thread to Spam.",
    input: S.ThreadTargetInput,
    action: "spam.mark",
    mode: "moveToSpam",
    target: "thread",
    summary: (a) => `Mark thread ${a.thread_id} spam`,
  });
  t({
    name: "unmark_message_spam",
    description: "Mark a message not spam.",
    input: S.MessageTargetInput,
    action: "spam.unmark",
    mode: "markNotSpam",
    target: "message",
    summary: (a) => `Unmark spam ${a.message_id}`,
  });
  t({
    name: "unmark_thread_spam",
    description: "Mark a thread not spam.",
    input: S.ThreadTargetInput,
    action: "spam.unmark",
    mode: "markNotSpam",
    target: "thread",
    summary: (a) => `Unmark spam thread ${a.thread_id}`,
  });
  t({
    name: "apply_sensitive_message_label",
    description: "TRASH or SPAM a message (same as trash_message or mark_message_spam).",
    input: S.ApplySensitiveMessageLabelInput,
    action: "trash.move",
    mode: "moveMessage",
    target: "message",
    extra: async (e, d, a, args) => (args.label_option === "SPAM" ? { mode: "moveToSpam" } : toTrash(e, d, a)),
    summary: (a) => `${a.label_option} message ${a.message_id}`,
  });
  t({
    name: "apply_sensitive_thread_label",
    description: "TRASH or SPAM a thread.",
    input: S.ApplySensitiveThreadLabelInput,
    action: "trash.move",
    mode: "moveMessage",
    target: "thread",
    extra: async (e, d, a, args) => (args.label_option === "SPAM" ? { mode: "moveToSpam" } : toTrash(e, d, a)),
    summary: (a) => `${a.label_option} thread ${a.thread_id}`,
  });
  // Label CRUD (create and update journal nothing; delete is destructive).
  defineTool(server, toolContext, env, {
    name: "create_label",
    version: 1,
    description: "Create a label with an optional colour.",
    input: S.CreateLabelInput,
    annotations: rw,
    action: "label.manage",
    journal: false,
    plan: (_e, _t, _a, args) =>
      Promise.resolve({
        modifiers: [],
        summary: `Create label ${args.display_name}`,
        facts: {},
        build: () => Promise.resolve({ payload: { display_name: args.display_name, color: args.color }, handles: [] }),
      }),
    execute: async (e, d, run) => {
      const p = run.payload as { display_name: string; color?: string };
      const l = await mail.createLabel(e, d, acct(run), {
        labelName: p.display_name,
        ...(p.color ? { color: p.color } : {}),
      });
      return { label: { id: l.labelId, name: l.displayName, color: l.color ?? null } };
    },
  });
  defineTool(server, toolContext, env, {
    name: "update_label",
    version: 1,
    description: "Rename a label or change its colour.",
    input: S.UpdateLabelInput,
    annotations: rw,
    action: "label.manage",
    journal: false,
    plan: (_e, _t, _a, args) =>
      Promise.resolve({
        modifiers: [],
        summary: `Update label ${args.label_id}`,
        facts: { ids: [args.label_id] },
        build: () =>
          Promise.resolve({
            payload: { label_id: args.label_id, display_name: args.display_name, color: args.color },
            handles: [],
          }),
      }),
    execute: async (e, d, run) => {
      const p = run.payload as { label_id: string; display_name?: string; color?: string };
      await mail.updateLabel(e, d, acct(run), p.label_id, {
        ...(p.display_name ? { labelName: p.display_name } : {}),
        ...(p.color ? { color: p.color } : {}),
      });
      return { updated: p.label_id };
    },
  });
  defineTool(server, toolContext, env, {
    name: "delete_label",
    version: 1,
    description: "Delete a label and remove it from every message. Destructive: asks by default.",
    input: S.DeleteLabelInput,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    action: "label.manage",
    journal: false,
    plan: (_e, _t, _a, args) =>
      Promise.resolve({
        modifiers: ["+destructive"],
        summary: `Delete label ${args.label_id}`,
        facts: { ids: [args.label_id] },
        build: () => Promise.resolve({ payload: { label_id: args.label_id }, handles: [] }),
      }),
    execute: async (e, d, run) => {
      const p = run.payload as { label_id: string };
      await mail.deleteLabel(e, d, acct(run), p.label_id);
      return { deleted: p.label_id };
    },
  });
}
```

The `apply_sensitive_*` extras return `{ mode: "moveToSpam" }` to override the spec's `mode`; make `updateMessages`'s `extra` spread after `mode` in `mail.ts` (`json: { mode, messageId, ...extra }` already does).

Schemas to add in `shared/src/schemas.ts`:

```ts
export const MessageTargetInput = z.object({ account: AccountAlias, message_id: ZohoId, folder_id: ZohoId.optional() });
export const ThreadTargetInput = z.object({ account: AccountAlias, thread_id: ZohoId });
export const FlagMessageInput = MessageTargetInput.extend({
  flag: z.enum(["info", "important", "followup", "flag_not_set"]),
});
export const MoveMessageInput = MessageTargetInput.extend({ folder: ZohoFolderName });
export const MoveThreadInput = ThreadTargetInput.extend({ folder: ZohoFolderName });
export const MarkReadInput = z
  .object({
    account: AccountAlias,
    message_ids: z.array(ZohoId).max(100).default([]),
    thread_ids: z.array(ZohoId).max(100).default([]),
  })
  .refine((v) => v.message_ids.length + v.thread_ids.length > 0, { message: "give message_ids or thread_ids" });
```

- [ ] **Step 3: Run, verify, commit**

```bash
cd worker && npx vitest run test/organise-tools.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(tools): organising tools on updatemessage and updatethread"
```

---

### Task 4.2: Retire the Gmail client and fakes

> **Carried from M2 execution (2026-10-05):** delete `LegacyGmailId` from `shared/src/schemas.ts`; `grep -rn LegacyGmailId shared worker` must be 0.

> **Carried from M1 execution (2026-10-04):** remove `Deps.googleFetch` (its production default already refuses, commit c4d2981), `test/gmail-transport-retired.test.ts`, FakeGmail inside FakeZoho, and FakeGoogle including its transitional Zoho Accounts face. Afterwards `grep -rn "googleFetch\|FakeGoogle\|gmail.googleapis" worker` must be 0.

**Files:**

- Delete: `worker/src/google/` (whole directory), `worker/test/fake-google.ts`, `worker/test/fake-gmail.ts`, `worker/test/gmail-client.test.ts`
- Modify: `worker/test/fake-zoho.ts` (remove the `gmail` field and host branch), `worker/src/mcp/server.ts` (imports), `worker/test/mcp.test.ts` (tool count: 7 control + 8 read + 3 compose + 3 drafts + 25 organising = 46, plus `download_attachment` from M5 makes 47)

- [ ] **Step 1: Delete, verify, commit**

```bash
cd worker && git rm -r src/google test/fake-google.ts test/fake-gmail.ts test/gmail-client.test.ts
grep -rn "google/\|googleapis\|FakeGmail\|FakeGoogle" src test | wc -l   # expected: 0 after edits
cd .. && npm run verify && git add -A && git commit -m "chore: retire the Gmail client, label tools and fakes"
```

## M4 exit checklist

- [ ] Every organising tool makes exactly one PUT with the documented literal; no request method is DELETE except `delete_label`.
- [ ] `trash_*` and `spam.mark` ask by default; `untrash_message` restores the recorded folder.
- [ ] No Google symbol remains anywhere under `worker/`.

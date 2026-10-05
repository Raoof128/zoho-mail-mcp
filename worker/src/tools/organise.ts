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
import { beginOperation } from "../operations/journal";

/** One budget id per tool invocation, stable across its Zoho calls (M2 ruling). */
const callIds = new WeakMap<ExecRun, string>();
const acct = (run: ExecRun): ZohoAcct => {
  let id = callIds.get(run);
  if (!id) {
    id = run.operationId ?? run.pendingId ?? crypto.randomUUID();
    callIds.set(run, id);
  }
  return { userId: run.userId, accountId: run.account.id, toolCallId: id };
};
/**
 * Spec 3.5 step 3: an operation exists whenever the run journals or came through an approval claim, and it must be
 * open (executing) before Zoho can change; the gate's settlement requires it.
 */
const open = async (env: Env, run: ExecRun): Promise<void> => {
  if (run.operationId) await beginOperation(env.DB, run.operationId);
};
/** Trash and Spam have their own tools and policy (trash.move, spam.mark ask); a plain move must not reach them. */
// Drafts too: a message moved into Drafts could then be trashed by update_draft or send_draft under draft.write
// (security review of ba631b3).
const SYSTEM_GUARDED = new Set(["trash", "spam", "drafts"]);
function refuseGuardedName(folder: string): void {
  if (SYSTEM_GUARDED.has(folder.trim().toLowerCase()))
    throw new McpError(
      "policy_denied",
      `policy_denied: moving to ${folder} is not allowed here: use trash_message, trash_thread, mark_message_spam, mark_thread_spam or create_draft`,
    );
}
const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

type UpdateSpec<Sch extends z.ZodObject<z.ZodRawShape>> = {
  name: string;
  description: string;
  input: Sch;
  action: Action;
  mode: mail.UpdateMode;
  target: "message" | "thread" | "both";
  modifiers?: Modifier[];
  extra?: (e: Env, d: ToolContext["deps"], a: ZohoAcct, args: z.infer<Sch>) => Promise<Record<string, unknown>>;
  summary: (args: z.infer<Sch>) => string;
  remember?: boolean;
  /** MCP annotation: the tool removes something from view (trash, unlabel, spam), as the Gmail tools declared. */
  destructive?: boolean;
  /** Plan-time refusal before any Zoho call. */
  check?: (args: z.infer<Sch>) => void;
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
    annotations: s.destructive ? { ...rw, destructiveHint: true } : rw,
    action: s.action,
    // Trash journals so the source folder is remembered on every path, including an owner's allow.
    journal: s.remember === true,
    plan: (_e, _t, _a, args): Promise<Plan> => {
      s.check?.(args);
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
      const messageIds = [
        args.message_id as string | undefined,
        ...((args.message_ids as string[] | undefined) ?? []),
      ].filter((x): x is string => !!x);
      const threadIds = [
        args.thread_id as string | undefined,
        ...((args.thread_ids as string[] | undefined) ?? []),
      ].filter((x): x is string => !!x);
      const ids = s.target === "message" ? messageIds : threadIds;
      if (messageIds.length + threadIds.length === 0)
        throw new McpError("invalid_header", "invalid_header: nothing to update");
      let remembered: Record<string, unknown> = {};
      if (s.remember && s.target === "message" && args.message_id) {
        const ref = await resolveRef(e, d, a, {
          message_id: args.message_id as string,
          folder_id: args.folder_id as string | undefined,
        });
        remembered = { previous_folder_id: ref.folderId };
      }
      const { mode: modeOverride, ...rest } = extra as { mode?: mail.UpdateMode } & Record<string, unknown>;
      const mode = modeOverride ?? s.mode;
      await open(e, run);
      if (s.target === "both") {
        // mark_read and mark_unread take message ids, thread ids or both (spec 5.4).
        if (messageIds.length) await mail.updateMessages(e, d, a, mode, messageIds, rest);
        if (threadIds.length) await mail.updateThreads(e, d, a, mode, threadIds, rest);
        return { updated: [...messageIds, ...threadIds], mode };
      }
      if (ids.length === 0) throw new McpError("invalid_header", "invalid_header: nothing to update");
      if (s.target === "message") await mail.updateMessages(e, d, a, mode, ids, rest);
      else await mail.updateThreads(e, d, a, mode, ids, rest);
      return { updated: ids, mode, ...remembered };
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
    extra: (_e, _d, _a, a) => Promise.resolve(labels(a)),
    summary: (a) => `Label message ${a.message_id}`,
  });
  t({
    name: "unlabel_message",
    destructive: true,
    description: "Remove labels from a message.",
    input: S.UnlabelMessageInput,
    action: "label.apply",
    mode: "removeLabel",
    target: "message",
    extra: (_e, _d, _a, a) => Promise.resolve(labels(a)),
    summary: (a) => `Unlabel message ${a.message_id}`,
  });
  t({
    name: "label_thread",
    description: "Apply labels to every message in a thread.",
    input: S.LabelThreadInput,
    action: "label.apply",
    mode: "applyLabel",
    target: "thread",
    extra: (_e, _d, _a, a) => Promise.resolve(labels(a)),
    summary: (a) => `Label thread ${a.thread_id}`,
  });
  t({
    name: "unlabel_thread",
    destructive: true,
    description: "Remove labels from a thread.",
    input: S.UnlabelThreadInput,
    action: "label.apply",
    mode: "removeLabel",
    target: "thread",
    extra: (_e, _d, _a, a) => Promise.resolve(labels(a)),
    summary: (a) => `Unlabel thread ${a.thread_id}`,
  });
  t({
    name: "flag_message",
    description: "Set the flag: info, important, followup or flag_not_set.",
    input: S.FlagMessageInput,
    action: "flag.set",
    mode: "setFlag",
    target: "message",
    extra: (_e, _d, _a, a) => Promise.resolve({ flagid: a.flag }),
    summary: (a) => `Flag message ${a.message_id} as ${a.flag}`,
  });
  t({
    name: "mark_read",
    description: "Mark messages or threads read.",
    input: S.MarkReadInput,
    action: "read.mark",
    mode: "markAsRead",
    target: "both",
    summary: () => "Mark read",
  });
  t({
    name: "mark_unread",
    description: "Mark messages or threads unread.",
    input: S.MarkReadInput,
    action: "read.mark",
    mode: "markAsUnread",
    target: "both",
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
  const dest = async (e: Env, d: ToolContext["deps"], a: ZohoAcct, args: { folder: string }) => {
    refuseGuardedName(args.folder);
    const f = await folderByName(e, d, a, args.folder);
    const sys = await systemFolders(e, d, a);
    if (f.folderId === sys.trash || f.folderId === sys.spam || f.folderId === sys.drafts)
      refuseGuardedName(f.folderId === sys.trash ? "Trash" : f.folderId === sys.spam ? "Spam" : "Drafts");
    return { destfolderId: f.folderId };
  };
  t({
    name: "move_message",
    description: "Move a message to a folder by name.",
    input: S.MoveMessageInput,
    action: "folder.move",
    mode: "moveMessage",
    target: "message",
    extra: dest,
    check: (a) => refuseGuardedName(a.folder),
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
    check: (a) => refuseGuardedName(a.folder),
    summary: (a) => `Move thread ${a.thread_id} to ${a.folder}`,
  });
  const toTrash = async (e: Env, d: ToolContext["deps"], a: ZohoAcct) => ({
    destfolderId: (await systemFolders(e, d, a)).trash,
  });
  t({
    name: "trash_message",
    destructive: true,
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
    destructive: true,
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
    destructive: true,
    description: "Move a message to Spam.",
    input: S.MessageTargetInput,
    action: "spam.mark",
    mode: "moveToSpam",
    target: "message",
    summary: (a) => `Mark message ${a.message_id} spam`,
  });
  t({
    name: "mark_thread_spam",
    destructive: true,
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
    // SPAM must be decided by spam.mark, not by this tool's trash.move (security review of ba631b3).
    check: (a) => {
      if (a.label_option === "SPAM")
        throw new McpError("policy_denied", "policy_denied: use mark_message_spam to move to Spam");
    },
    destructive: true,
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
    // SPAM must be decided by spam.mark, not by this tool's trash.move (security review of ba631b3).
    check: (a) => {
      if (a.label_option === "SPAM")
        throw new McpError("policy_denied", "policy_denied: use mark_thread_spam to move to Spam");
    },
    destructive: true,
    description: "TRASH or SPAM a thread.",
    input: S.ApplySensitiveThreadLabelInput,
    action: "trash.move",
    mode: "moveMessage",
    target: "thread",
    extra: async (e, d, a, args) => (args.label_option === "SPAM" ? { mode: "moveToSpam" } : toTrash(e, d, a)),
    summary: (a) => `${a.label_option} thread ${a.thread_id}`,
  });
  defineTool(server, toolContext, env, {
    name: "update_message_labels",
    version: 1,
    description: "Add and remove labels on a message in one call. A label cannot be both added and removed.",
    input: S.UpdateMessageLabelsInput,
    annotations: rw,
    action: "label.apply",
    journal: false,
    plan: (_e, _t, _a, args) => {
      if (args.add_label_ids.length + args.remove_label_ids.length === 0)
        throw new McpError("invalid_header", "invalid_header: add or remove at least one label");
      if (args.add_label_ids.some((id) => args.remove_label_ids.includes(id)))
        throw new McpError("invalid_header", "invalid_header: a label cannot be both added and removed");
      const { account: _x, ...payload } = args;
      return Promise.resolve({
        modifiers: [],
        summary: `Relabel message ${args.message_id}`,
        facts: { ids: [args.message_id] },
        build: () => Promise.resolve({ payload, handles: [] }),
      });
    },
    execute: async (e, d, run) => {
      const p = run.payload as { message_id: string; add_label_ids: string[]; remove_label_ids: string[] };
      const a = acct(run);
      await open(e, run);
      if (p.remove_label_ids.length)
        await mail.updateMessages(e, d, a, "removeLabel", [p.message_id], { labelId: p.remove_label_ids });
      if (p.add_label_ids.length)
        await mail.updateMessages(e, d, a, "applyLabel", [p.message_id], { labelId: p.add_label_ids });
      return { updated: [p.message_id], added: p.add_label_ids, removed: p.remove_label_ids };
    },
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
      await open(e, run);
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
      await open(e, run);
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
      await open(e, run);
      await mail.deleteLabel(e, d, acct(run), p.label_id);
      return { deleted: p.label_id };
    },
  });
}

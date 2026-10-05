import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { McpError } from "@zoho-mail-mcp/shared/errors";
import {
  GetDraftInput,
  GetMessageInput,
  GetThreadInput,
  ListDraftsInput,
  ListFoldersInput,
  ListLabelsInput,
  SearchMessagesInput,
  SearchThreadsInput,
  ZohoId,
  type MessageFormat,
} from "@zoho-mail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { accountStub, BUDGETS } from "../zoho/account-do";
import { ZohoApiError, type ZohoAcct } from "../zoho/client";
import { folderByName, systemFolders, threadMessages } from "../zoho/folders";
import * as mail from "../zoho/mail";
import { messageView, type MessageView, type ZohoMessageRef } from "../zoho/messages";
import { defineTool, type Plan } from "./define";
import type { ExecRun, ToolContext } from "./gate";

const fmt = (f: MessageFormat | "MESSAGE_FORMAT_UNSPECIFIED"): MessageFormat =>
  f === "MESSAGE_FORMAT_UNSPECIFIED" ? "PLAIN_TEXT" : f;
/**
 * The account DO keys per-call budgets by toolCallId, so the id must be unique per tool invocation and stable within it.
 * Read tools have no operation row; a fresh id is drawn once per run and remembered for every Zoho call the run makes.
 */
const callIds = new WeakMap<ExecRun, string>();
const acct = (run: ExecRun): ZohoAcct => {
  let id = callIds.get(run);
  if (!id) {
    id = run.operationId ?? run.pendingId ?? crypto.randomUUID();
    callIds.set(run, id);
  }
  return { userId: run.userId, accountId: run.account.id, toolCallId: id };
};
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const ADDRESSING =
  " Results carry id and folder_id; pass both back to any tool that takes a message. A bare message_id is resolved by probing Inbox, Sent, Drafts, Spam and Trash, which costs up to 5 of the 10 Zoho calls a tool call may make.";
const readPlan = (args: Record<string, unknown>, summary: string, ids: string[] = []): Promise<Plan> => {
  const { account: _a, ...payload } = args;
  return Promise.resolve({
    modifiers: [],
    summary,
    facts: ids.length ? { ids } : {},
    build: () => Promise.resolve({ payload, handles: [] }),
  });
};

/** Zoho's answers for "not in this folder": anything else (403, 5xx after retries) is a real failure and surfaces. */
const notHere = (e: unknown) => e instanceof ZohoApiError && (e.status === 404 || e.status === 400);

export async function resolveRef(
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  o: { message_id: string; folder_id?: string | undefined },
): Promise<ZohoMessageRef & { row?: mail.ZohoListRow }> {
  if (o.folder_id) return { folderId: o.folder_id, messageId: o.message_id };
  const sys = await systemFolders(env, deps, a);
  for (const folderId of [sys.inbox, sys.sent, sys.drafts, sys.spam, sys.trash]) {
    try {
      const row = await mail.messageDetails(env, deps, a, folderId, o.message_id);
      return { folderId, messageId: o.message_id, row };
    } catch (e) {
      if (!notHere(e)) throw e;
    }
  }
  throw new McpError(
    "handle_invalid",
    `handle_invalid: message ${o.message_id} not found in any system folder; pass folder_id`,
  );
}

export async function getMessage(
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  ref: ZohoMessageRef,
  format: MessageFormat,
  o = { bodyCharLimit: 20_000, includeBody: true },
): Promise<MessageView> {
  const row =
    (ref as { row?: mail.ZohoListRow }).row ?? (await mail.messageDetails(env, deps, a, ref.folderId, ref.messageId));
  const headers =
    format === "MINIMAL" ? undefined : await mail.messageHeaders(env, deps, a, ref.folderId, ref.messageId);
  const content =
    o.includeBody && format !== "METADATA_ONLY" && format !== "MINIMAL" && format !== "RAW"
      ? (await mail.messageContent(env, deps, a, ref.folderId, ref.messageId)).content
      : undefined;
  const raw = format === "RAW" ? await mail.originalMessage(env, deps, a, ref.messageId) : undefined;
  const attachments = row.hasAttachment
    ? (await mail.attachmentInfo(env, deps, a, ref.folderId, ref.messageId)).map((x) => ({
        attachment_id: x.attachmentId,
        filename: x.attachmentName,
        size: x.attachmentSize,
        mime: null,
      }))
    : [];
  return messageView(row, {
    content,
    headers,
    raw,
    format,
    bodyCharLimit: o.bodyCharLimit,
    includeBody: o.includeBody,
    attachments,
  });
}

export function registerReadTools(server: McpServer, toolContext: (ctx: ServerContext) => ToolContext, env: Env): void {
  defineTool(server, toolContext, env, {
    name: "search_messages",
    version: 1,
    description:
      "Search messages with Zoho syntax: param:value pairs joined by '::' (entire, content, sender, to, cc, subject, fileName, fileContent, has:attachment; quotes for phrases). Flat results, newest first, up to 200 per page via start/limit." +
      ADDRESSING,
    input: SearchMessagesInput,
    annotations: ro,
    action: "read.search",
    journal: false,
    plan: (_e, _t, _a, args) => readPlan(args, `Search messages: ${args.query}`),
    execute: async (e, d, run) => {
      const p = SearchMessagesInput.omit({ account: true }).parse(run.payload);
      // Zoho's search syntax names a folder with in:<folder name>; a name with a space is quoted.
      const key = p.folder
        ? `${p.query}::in:${/\s/.test(p.folder) ? `"${p.folder.replace(/"/g, "")}"` : p.folder}`
        : p.query;
      const rows = await mail.searchMessages(e, d, acct(run), {
        searchKey: key,
        start: p.start,
        limit: p.limit,
        includeto: p.include_to,
      });
      return {
        messages: rows.map((r) => messageView(r, { format: "METADATA_ONLY", bodyCharLimit: 0, includeBody: false })),
        next_start: rows.length === p.limit ? p.start + p.limit : null,
      };
    },
  });
  defineTool(server, toolContext, env, {
    name: "search_threads",
    version: 1,
    description:
      "Search and group by thread: one row per thread with its newest message. page_token is the Zoho start offset." +
      ADDRESSING,
    input: SearchThreadsInput,
    annotations: ro,
    action: "read.search",
    journal: false,
    plan: (_e, _t, _a, args) => readPlan(args, `Search threads: ${args.query ?? "(all)"}`),
    execute: async (e, d, run) => {
      const p = SearchThreadsInput.omit({ account: true }).parse(run.payload);
      const start = p.page_token ? Number(p.page_token) : 1;
      const rows = p.query
        ? await mail.searchMessages(e, d, acct(run), { searchKey: p.query, start, limit: 200, includeto: true })
        : await mail.listMessages(e, d, acct(run), { start, limit: 200, includeto: true });
      // Rows come newest first. Threads are taken in order of first appearance until `limit` distinct threads; the
      // next page starts at the first row of the next thread, so nothing between pages is skipped (final review I4).
      const order: string[] = [];
      const newest = new Map<string, mail.ZohoListRow>();
      let nextStart: number | null = null;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        const k = r.threadId || r.messageId;
        if (!newest.has(k)) {
          if (order.length === p.limit) {
            nextStart = start + i;
            break;
          }
          order.push(k);
          newest.set(k, r);
        } else if (r.receivedTime > newest.get(k)!.receivedTime) newest.set(k, r);
      }
      if (nextStart === null && rows.length === 200) nextStart = start + 200;
      const threads = order.map((k) => {
        const r = newest.get(k)!;
        return {
          id: k,
          message_count: r.threadCount,
          newest: messageView(r, { format: "METADATA_ONLY", bodyCharLimit: 0, includeBody: false }),
        };
      });
      return { threads, ...(nextStart !== null ? { next_page_token: String(nextStart) } : {}) };
    },
  });
  defineTool(server, toolContext, env, {
    name: "get_thread",
    version: 1,
    description:
      `A thread's messages across folders, one call for metadata. With a body format, at most ${BUDGETS.bodies} bodies per call; pass next_cursor back as cursor to get the rest. Thread messages carry bodies but not threading headers or attachment lists: use get_message for those.` +
      ADDRESSING,
    input: GetThreadInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: (_e, _t, _a, args) => readPlan(args, `Get thread ${args.thread_id}`, [args.thread_id]),
    execute: async (e, d, run) => {
      const p = GetThreadInput.omit({ account: true }).parse(run.payload);
      const f = fmt(p.message_format);
      const a = acct(run);
      const rows = (await threadMessages(e, d, a, p.thread_id, p.max_messages)).sort(
        (x, y) => x.receivedTime - y.receivedTime,
      );
      const wantBodies = p.include_body && f !== "METADATA_ONLY" && f !== "MINIMAL";
      const stub = accountStub(e, a.accountId);
      let budget = p.total_body_char_limit;
      let cursor: string | undefined;
      const messages: MessageView[] = [];
      // With a cursor from a previous call, messages before it already had their bodies: metadata only until it.
      let resumed = p.cursor === undefined || !rows.some((r) => r.messageId === p.cursor);
      for (const r of rows) {
        if (!resumed && r.messageId === p.cursor) resumed = true;
        if (!resumed) {
          messages.push(messageView(r, { format: "METADATA_ONLY", bodyCharLimit: 0, includeBody: false }));
          continue;
        }
        if (!wantBodies || budget <= 0 || !(await stub.budget(a.toolCallId, "bodies", 1))) {
          if (wantBodies && !cursor) cursor = r.messageId;
          messages.push(messageView(r, { format: "METADATA_ONLY", bodyCharLimit: 0, includeBody: false }));
          continue;
        }
        // One Zoho call per body (content, or the original for RAW): the list row already holds the metadata, so
        // 8 bodies plus the list stay inside the 10-request budget. Headers and attachment lists are get_message's.
        const limit = Math.min(p.body_char_limit, budget);
        const v =
          f === "RAW"
            ? messageView(r, {
                raw: await mail.originalMessage(e, d, a, r.messageId),
                format: f,
                bodyCharLimit: limit,
                includeBody: true,
              })
            : messageView(r, {
                content: (await mail.messageContent(e, d, a, r.folderId, r.messageId)).content,
                format: f,
                bodyCharLimit: limit,
                includeBody: true,
              });
        budget -= (v.plaintext_body?.length ?? 0) + (v.html_body?.length ?? 0) + (v.raw?.length ?? 0);
        messages.push(v);
      }
      return { thread: { id: p.thread_id, messages, ...(cursor ? { next_cursor: cursor } : {}) } };
    },
  });
  defineTool(server, toolContext, env, {
    name: "get_message",
    version: 1,
    description: "One message with headers and attachment metadata." + ADDRESSING,
    input: GetMessageInput.extend({ folder_id: ZohoId.optional() }),
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: (_e, _t, _a, args) => readPlan(args, `Get message ${args.message_id}`, [args.message_id]),
    execute: async (e, d, run) => {
      const p = GetMessageInput.omit({ account: true }).extend({ folder_id: ZohoId.optional() }).parse(run.payload);
      const a = acct(run);
      return {
        message: await getMessage(e, d, a, await resolveRef(e, d, a, p), fmt(p.message_format), {
          bodyCharLimit: p.body_char_limit,
          includeBody: p.include_body,
        }),
      };
    },
  });
  defineTool(server, toolContext, env, {
    name: "list_drafts",
    version: 1,
    description: "Drafts, newest first (the Drafts folder listing)." + ADDRESSING,
    input: ListDraftsInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: (_e, _t, _a, args) => readPlan(args, "List drafts"),
    execute: async (e, d, run) => {
      const p = ListDraftsInput.omit({ account: true }).parse(run.payload);
      const a = acct(run);
      const sys = await systemFolders(e, d, a);
      const start = p.page_token ? Number(p.page_token) : 1;
      const rows = await mail.listMessages(e, d, a, { folderId: sys.drafts, start, limit: p.limit, includeto: true });
      return {
        drafts: rows.map((r) => ({
          id: r.messageId,
          message: messageView(r, { format: "METADATA_ONLY", bodyCharLimit: 0, includeBody: false }),
        })),
        ...(rows.length === p.limit ? { next_page_token: String(start + p.limit) } : {}),
      };
    },
  });
  defineTool(server, toolContext, env, {
    name: "get_draft",
    version: 1,
    description: "One draft by its message id in the Drafts folder.",
    input: GetDraftInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: (_e, _t, _a, args) => readPlan(args, `Get draft ${args.draft_id}`, [args.draft_id]),
    execute: async (e, d, run) => {
      const p = GetDraftInput.omit({ account: true }).parse(run.payload);
      const a = acct(run);
      const sys = await systemFolders(e, d, a);
      return {
        draft: {
          id: p.draft_id,
          message: await getMessage(e, d, a, { folderId: sys.drafts, messageId: p.draft_id }, fmt(p.message_format), {
            bodyCharLimit: p.body_char_limit,
            includeBody: true,
          }),
        },
      };
    },
  });
  defineTool(server, toolContext, env, {
    name: "list_labels",
    version: 1,
    description: "All labels (Zoho tags) with colours.",
    input: ListLabelsInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: () => readPlan({}, "List labels"),
    execute: async (e, d, run) => ({
      labels: (await mail.listLabels(e, d, acct(run))).map((l) => ({
        id: l.labelId,
        name: l.displayName,
        color: l.color ?? null,
      })),
    }),
  });
  defineTool(server, toolContext, env, {
    name: "list_folders",
    version: 1,
    description:
      "All folders with ids; system folders are Inbox, Drafts, Sent, Spam, Trash and, on newer accounts, Archive.",
    input: ListFoldersInput,
    annotations: ro,
    action: "read.message",
    journal: false,
    plan: () => readPlan({}, "List folders"),
    execute: async (e, d, run) => ({
      folders: (await mail.listFolders(e, d, acct(run))).map((f) => ({
        id: f.folderId,
        name: f.folderName,
        type: f.folderType ?? null,
        path: f.path ?? null,
      })),
    }),
  });
  void folderByName;
}

import { z } from "zod";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { zohoJson, zohoStream, type ZohoAcct } from "./client";

const FLAG_BY_ID: Record<string, string> = { "0": "flag_not_set", "1": "info", "2": "important", "3": "followup" };
/** Zoho escapes address and summary text in list rows (`&quot;rebecca&quot;&lt;rebecca@zylker.com&gt;`). */
export function unescapeZoho(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d{1,7});/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&amp;/g, "&");
}
/** A scalar field as a string; objects and arrays (never sent for these fields) read as absent. */
const scalar = (v: unknown): string | undefined =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint"
    ? String(v)
    : undefined;
const text = (v: unknown): string => unescapeZoho(scalar(v) ?? "");
const addresses = (v: unknown): string => (v === "Not Provided" ? "" : text(v));
/**
 * The list page (messages/view) returns every field as a string ("status": "1", "hasAttachment": "0"); the search page
 * returns numbers ("flagid": 2, "receivedtime" in lower case) and ids as JSON numbers, which lose precision past 2^53,
 * so the exact ids are read from URI when present. Both shapes come from the saved official pages (2026-10-03);
 * the meaning of list status "1" (read) is to be confirmed by the M0 probe.
 */
function normaliseRow(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const r = raw as Record<string, unknown>;
  const fromUri = typeof r.URI === "string" ? /\/folders\/(\d+)\/messages\/(\d+)/.exec(r.URI) : null;
  const id = scalar;
  const thread = id(r.threadId);
  const status = scalar(r.status) ?? "";
  const flag = scalar(r.flagid) ?? "flag_not_set";
  const att = r.hasAttachment;
  return {
    ...r,
    messageId: fromUri?.[2] ?? id(r.messageId),
    folderId: fromUri?.[1] ?? id(r.folderId),
    threadId: thread === "0" ? "" : (thread ?? ""),
    threadCount: Number(r.threadCount ?? 0) || 0,
    fromAddress: addresses(r.fromAddress),
    toAddress: addresses(r.toAddress),
    ccAddress: addresses(r.ccAddress),
    subject: text(r.subject),
    summary: text(r.summary),
    sender: text(r.sender),
    receivedTime: Number(r.receivedTime ?? r.receivedtime ?? 0) || 0,
    sentDateInGMT: Number(r.sentDateInGMT ?? 0) || 0,
    status: status === "1" || status === "read" ? "read" : "unread",
    flagid: FLAG_BY_ID[flag] ?? flag,
    hasAttachment: att === true || att === 1 || att === "1" || att === "true" ? 1 : 0,
  };
}
export const ListRow = z.preprocess(
  normaliseRow,
  z.object({
    messageId: z.string().regex(/^\d{1,32}$/),
    folderId: z.string().regex(/^\d{1,32}$/),
    threadId: z.string(),
    threadCount: z.number(),
    fromAddress: z.string(),
    toAddress: z.string(),
    ccAddress: z.string(),
    subject: z.string(),
    summary: z.string(),
    receivedTime: z.number(),
    sentDateInGMT: z.number(),
    status: z.enum(["read", "unread"]),
    flagid: z.string(),
    hasAttachment: z.union([z.literal(0), z.literal(1)]),
    sender: z.string(),
  }),
);
export type ZohoListRow = z.infer<typeof ListRow>;
const rows = (x: unknown) => z.array(ListRow).parse(x);

export type ListQuery = {
  folderId?: string;
  threadId?: string;
  start?: number;
  limit?: number;
  includeto?: boolean;
  includesent?: boolean;
  includearchive?: boolean;
  status?: "read" | "unread" | "all";
  labelid?: string;
};
export const listMessages = (env: Env, deps: Deps, a: ZohoAcct, q: ListQuery) =>
  zohoJson<unknown>(env, deps, a, {
    method: "GET",
    path: "messages/view",
    query: { ...q, includesent: q.includesent ?? true },
    retry: "safe",
  }).then(rows);
export const searchMessages = (
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  q: { searchKey: string; start?: number; limit?: number; includeto?: boolean },
) => zohoJson<unknown>(env, deps, a, { method: "GET", path: "messages/search", query: q, retry: "safe" }).then(rows);
export const messageDetails = (env: Env, deps: Deps, a: ZohoAcct, folderId: string, messageId: string) =>
  zohoJson<unknown>(env, deps, a, {
    method: "GET",
    path: `folders/${folderId}/messages/${messageId}/details`,
    retry: "safe",
  }).then((x) => ListRow.parse(x));
export const messageContent = (env: Env, deps: Deps, a: ZohoAcct, folderId: string, messageId: string) =>
  zohoJson<{ content?: string }>(env, deps, a, {
    method: "GET",
    path: `folders/${folderId}/messages/${messageId}/content`,
    retry: "safe",
  }).then((x) => ({ content: x.content ?? "" }));
/** Header map: Zoho returns headerContent as {Name: [values]}. */
export const messageHeaders = (env: Env, deps: Deps, a: ZohoAcct, folderId: string, messageId: string) =>
  zohoJson<{ headerContent?: Record<string, string[]> }>(env, deps, a, {
    method: "GET",
    path: `folders/${folderId}/messages/${messageId}/header`,
    retry: "safe",
  }).then((x) => x.headerContent ?? {});
export const originalMessage = (env: Env, deps: Deps, a: ZohoAcct, messageId: string) =>
  zohoJson<{ content?: string }>(env, deps, a, {
    method: "GET",
    path: `messages/${messageId}/originalmessage`,
    retry: "safe",
  }).then((x) => x.content ?? "");
export const AttachmentInfo = z.object({
  attachmentId: z.string(),
  attachmentName: z.string(),
  attachmentSize: z.coerce.number(),
});
export const attachmentInfo = (env: Env, deps: Deps, a: ZohoAcct, folderId: string, messageId: string) =>
  zohoJson<{ attachments?: unknown[] }>(env, deps, a, {
    method: "GET",
    path: `folders/${folderId}/messages/${messageId}/attachmentinfo`,
    retry: "safe",
  }).then((x) => z.array(AttachmentInfo).parse(x.attachments ?? []));
export const attachmentStream = (
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  folderId: string,
  messageId: string,
  attachmentId: string,
) =>
  zohoStream(env, deps, a, {
    method: "GET",
    path: `folders/${folderId}/messages/${messageId}/attachments/${attachmentId}`,
    retry: "safe",
  });
export const UploadRef = z.object({
  storeName: z.string(),
  attachmentName: z.string(),
  attachmentPath: z.string(),
  attachmentSize: z.coerce.number(),
});
export type ZohoUploadRef = z.infer<typeof UploadRef>;
export const uploadAttachment = (
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  fileName: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
) =>
  zohoJson<unknown>(env, deps, a, {
    method: "POST",
    path: "messages/attachments",
    query: { fileName },
    body,
    headers: { "content-type": "application/octet-stream" },
    retry: "none",
  }).then((x) => UploadRef.parse(x));
export type SendBody = {
  fromAddress: string;
  toAddress: string;
  ccAddress?: string;
  bccAddress?: string;
  subject?: string;
  content?: string;
  mailFormat?: "html" | "plaintext";
  encoding?: "UTF-8";
  attachments?: ZohoUploadRef[];
  inReplyTo?: string;
  refHeader?: string;
  mode?: "draft";
};
const SentRef = z.object({ messageId: z.string(), folderId: z.string().optional() });
export const sendMessage = (env: Env, deps: Deps, a: ZohoAcct, body: SendBody) =>
  zohoJson<unknown>(env, deps, a, { method: "POST", path: "messages", json: body, retry: "none" }).then((x) =>
    SentRef.parse(x),
  );
export const replyMessage = (env: Env, deps: Deps, a: ZohoAcct, messageId: string, body: Omit<SendBody, "mode">) =>
  zohoJson<unknown>(env, deps, a, {
    method: "POST",
    path: `messages/${messageId}`,
    json: { ...body, action: "Reply" },
    retry: "none",
  }).then((x) => SentRef.parse(x));
export const saveDraft = (env: Env, deps: Deps, a: ZohoAcct, body: Omit<SendBody, "mode">) =>
  zohoJson<unknown>(env, deps, a, {
    method: "POST",
    path: "messages",
    json: { ...body, mode: "draft" },
    retry: "none",
  }).then((x) => SentRef.parse(x));
export type UpdateMode =
  | "markAsRead"
  | "markAsUnread"
  | "moveMessage"
  | "setFlag"
  | "applyLabel"
  | "removeLabel"
  | "removeAllLabels"
  | "archiveMails"
  | "unArchiveMails"
  | "moveToSpam"
  | "markNotSpam";
export const updateMessages = (
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  mode: UpdateMode,
  messageId: string[],
  extra: Record<string, unknown> = {},
) =>
  zohoJson<unknown>(env, deps, a, {
    method: "PUT",
    path: "updatemessage",
    json: { mode, messageId, ...extra },
    retry: "safe",
  });
export const updateThreads = (
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  mode: UpdateMode,
  threadId: string[],
  extra: Record<string, unknown> = {},
) =>
  zohoJson<unknown>(env, deps, a, {
    method: "PUT",
    path: "updatethread",
    json: { mode, threadId, ...extra },
    retry: "safe",
  });
export const Folder = z.object({
  folderId: z.string(),
  folderName: z.string(),
  folderType: z.string().optional(),
  path: z.string().optional(),
});
export type ZohoFolder = z.infer<typeof Folder>;
export const listFolders = (env: Env, deps: Deps, a: ZohoAcct) =>
  zohoJson<unknown>(env, deps, a, { method: "GET", path: "folders", retry: "safe" }).then((x) =>
    z.array(Folder).parse(x),
  );
export const Label = z.object({ labelId: z.string(), displayName: z.string(), color: z.string().optional() });
export type ZohoLabel = z.infer<typeof Label>;
export const listLabels = (env: Env, deps: Deps, a: ZohoAcct) =>
  zohoJson<unknown>(env, deps, a, { method: "GET", path: "labels", retry: "safe" }).then((x) =>
    z.array(Label).parse(x),
  );
export const createLabel = (env: Env, deps: Deps, a: ZohoAcct, body: { labelName: string; color?: string }) =>
  zohoJson<unknown>(env, deps, a, { method: "POST", path: "labels", json: body, retry: "none" }).then((x) =>
    Label.parse(x),
  );
export const updateLabel = (
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  labelId: string,
  body: { labelName?: string; color?: string },
) => zohoJson<unknown>(env, deps, a, { method: "PUT", path: `labels/${labelId}`, json: body, retry: "safe" });
export const deleteLabel = (env: Env, deps: Deps, a: ZohoAcct, labelId: string) =>
  zohoStream(env, deps, a, { method: "DELETE", path: `labels/${labelId}`, retry: "none" });

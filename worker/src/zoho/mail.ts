import { z } from "zod";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { zohoJson, zohoStream, type ZohoAcct } from "./client";

export const ListRow = z.object({
  messageId: z.string(),
  folderId: z.string(),
  threadId: z.string().optional().default(""),
  threadCount: z.number().optional().default(0),
  fromAddress: z.string().optional().default(""),
  toAddress: z.string().optional().default(""),
  ccAddress: z.string().optional().default(""),
  subject: z.string().optional().default(""),
  summary: z.string().optional().default(""),
  receivedTime: z.coerce.number().optional().default(0),
  sentDateInGMT: z.coerce.number().optional().default(0),
  status: z.string().optional().default("unread"),
  flagid: z.union([z.string(), z.number()]).optional().default("flag_not_set"),
  hasAttachment: z.union([z.number(), z.boolean()]).optional().default(0),
  sender: z.string().optional().default(""),
});
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

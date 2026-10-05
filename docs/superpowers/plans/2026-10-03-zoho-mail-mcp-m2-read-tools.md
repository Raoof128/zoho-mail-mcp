# M2: Message view model, folders, labels, read tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every read tool in the Gmail set answers from Zoho through `zohoJson`, with the same result field names, on a view model that carries each message's folder id so no later call can 404.

**Architecture:** `zoho/mail.ts` holds one typed wrapper per endpoint from spec section 4. `zoho/messages.ts` builds `MessageView` from a list row plus optional content and headers. `zoho/folders.ts` resolves system folder ids once per account and caches them in the account DO. `tools/read.ts` is rewritten on these; `download_attachment` moves to M5.

**Tech Stack:** as master.

**Spec:** sections 4, 5.2, D17 (bodies budget).

**Master:** `2026-10-03-zoho-mail-mcp-00-master.md`.

## File map

| Path                                                                           | Responsibility                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `shared/src/schemas.ts`                                                        | `ZohoId`, `SearchMessagesInput`, `ListFoldersInput`, Zoho label inputs; Gmail-only visibility fields removed |
| `worker/src/zoho/mail.ts`                                                      | typed wrappers                                                                                               |
| `worker/src/zoho/folders.ts`                                                   | `systemFolders`, `folderByName`                                                                              |
| `worker/src/zoho/messages.ts`                                                  | `MessageView`, `messageView`, address parsing                                                                |
| `worker/src/tools/read.ts`                                                     | the read family                                                                                              |
| `worker/test/zoho-mail.test.ts`, `zoho-messages.test.ts`, `read-tools.test.ts` | tests                                                                                                        |

---

### Task 2.1: Schemas and `zoho/mail.ts`

**Files:**

- Modify: `shared/src/schemas.ts`
- Create: `worker/src/zoho/mail.ts`
- Test: `worker/test/zoho-mail.test.ts`

**Interfaces:**

- Produces (schemas): `ZohoId = z.string().regex(/^\d{1,32}$/)`; `GmailId` is deleted and every use becomes `ZohoId`; `SearchMessagesInput { account?, query, folder?, start=1, limit=20 (max 200), include_to=false }`; `SearchThreadsInput` keeps `query, limit, page_token` where `page_token` is the Zoho `start` as a string; `GetThreadInput` keeps its fields, `max_messages` max 200; `ListFoldersInput { account? }`; `CreateLabelInput { account, display_name, color? }`, `UpdateLabelInput { account, label_id, display_name?, color? }` (Gmail visibility fields removed); `MessageFormat` unchanged.
- Produces (mail.ts): `ZohoListRow`, `listMessages(env, deps, acct, q)`, `searchMessages(env, deps, acct, q)`, `messageDetails(env, deps, acct, folderId, messageId)`, `messageContent(...)`, `messageHeaders(...)`, `originalMessage(env, deps, acct, messageId)`, `attachmentInfo(...)`, `attachmentStream(...)`, `uploadAttachment(env, deps, acct, fileName, body)`, `sendMessage(env, deps, acct, body)`, `replyMessage(env, deps, acct, messageId, body)`, `saveDraft(env, deps, acct, body)`, `updateMessages(env, deps, acct, mode, ids, extra)`, `updateThreads(...)`, `listFolders`, `listLabels`, `createLabel`, `updateLabel`, `deleteLabel`.

- [ ] **Step 1: Write the failing test**

`worker/test/zoho-mail.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FakeZoho } from "./fake-zoho";
import { testEnv, testDeps } from "./test-env";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import * as mail from "../src/zoho/mail";

let seq = 0;
/** One fresh account per call: D1 rows persist across cases within a file, and Zoho account ids are numeric. */
export async function zohoFixture() {
  const n = ++seq;
  const id = `a${n}`,
    Z = `19100${n}`;
  const z = await FakeZoho.create();
  const e = testEnv();
  await seedUserAndAccount(e.DB, {
    userId: "u",
    accountId: id,
    alias: `sarabi${n}`,
    slot: "sarabi",
    sendAs: ["sarabi@example.test"],
    zohoAccountId: Z,
  });
  z.accounts.set(`sub-${id}`, { accountId: Z, primaryEmail: "sarabi@example.test", sendAs: ["sarabi@example.test"] });
  await seedAccessToken(e, { userId: "u", accountId: id, access: z.directToken(Z) });
  return { z, e, d: testDeps(z), acct: { userId: "u", accountId: id, toolCallId: "t" }, Z, accountId: id };
}

describe("zoho mail wrappers", () => {
  it("lists with limit and threadId, reads details, content and headers by folder", async () => {
    const { z, e, d, acct, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "Hi",
      content: "<p>body</p>",
      threadId: "7",
    });
    z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "Re: Hi",
      content: "<p>r</p>",
      threadId: "7",
    });
    const rows = await mail.listMessages(e, d, acct, { threadId: "7", limit: 50 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.folderId)).toContain(z.mail.folderId(Z, "Sent"));
    expect((await mail.messageContent(e, d, acct, m.folderId, m.messageId)).content).toBe("<p>body</p>");
    const h = await mail.messageHeaders(e, d, acct, m.folderId, m.messageId);
    expect(h["Message-ID"]?.[0]).toMatch(/^<.*@fake\.zoho>$/);
  });
  it("sends the documented mode literals", async () => {
    const { z, e, d, acct, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "Hi",
      content: "x",
    });
    await mail.updateMessages(e, d, acct, "setFlag", [m.messageId], { flagid: "followup" });
    await mail.updateMessages(e, d, acct, "archiveMails", [m.messageId]);
    await mail.updateMessages(e, d, acct, "moveToSpam", [m.messageId]);
    const got = z.mail.get(Z, m.messageId)!;
    expect(got.flagid).toBe("followup");
    expect(got.archived).toBe(true);
    expect(got.folderId).toBe(z.mail.folderId(Z, "Spam"));
    const bodies = z.mail.requests.filter((r) => r.method === "PUT");
    expect(bodies).toHaveLength(3);
  });
  it("uploads raw bytes and returns the store triple", async () => {
    const { e, d, acct } = await zohoFixture();
    const ref = await mail.uploadAttachment(e, d, acct, "a.txt", new Uint8Array([1, 2, 3]));
    expect(ref).toMatchObject({ attachmentName: "a.txt", attachmentSize: 3 });
    expect(ref.storeName).toMatch(/^store-/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
cd worker && npx vitest run test/zoho-mail.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Schemas**

In `shared/src/schemas.ts`:

- Replace `export const GmailId = ...` with `export const ZohoId = z.string().regex(/^\d{1,32}$/);\nexport const ZohoFolderName = z.string().min(1).max(255);` and `sed -i '' 's/GmailId/ZohoId/g' shared/src/schemas.ts worker/src/**/*.ts worker/test/**/*.ts`.
- `LabelId = ZohoId`.
- Leave `LabelListVisibility`, `MessageListVisibility`, `CreateLabelInput` and `UpdateLabelInput` exactly as they are: the Gmail `tools/labels.ts` compiles against them until M4 Task 4.1 replaces both at once (gauntlet round 3 found the M2 change broke the typecheck).
- Declare `ZohoFolderName` immediately after `ZohoId` (M4's target schemas use it before the search inputs are declared).
- Add:

```ts
export const SearchMessagesInput = z.object({
  account: AccountAlias.optional(),
  query: z.string().min(1).max(2048),
  folder: ZohoFolderName.optional(),
  start: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(200).default(20),
  include_to: z.boolean().default(false),
});
export const ListFoldersInput = z.object({ account: AccountAlias.optional() });
export const SearchThreadsInput = z.object({
  account: AccountAlias.optional(),
  query: z.string().max(2048).optional(),
  limit: PageLimit,
  page_token: PageToken,
});
```

and in `GetThreadInput` set `max_messages: z.number().int().min(1).max(200).default(25)`. `ListDraftsInput` loses `query`.

- [ ] **Step 4: `zoho/mail.ts`**

```ts
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
```

`deleteLabel` is `DELETE /labels/{labelId}` under `ZohoMail.tags.ALL` (a label delete, not an email delete, so the token allows it). Add `"DELETE"` to `ZohoRequest.method` in `client.ts`. The fake answers `DELETE /labels/{id}` with 200 and still refuses `DELETE /folders/.../messages/...` with the array 401 (handle the label delete before the generic DELETE branch in `FakeZohoMail.fetch`).

- [ ] **Step 5: Run, verify, commit**

```bash
cd worker && npx vitest run test/zoho-mail.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(zoho): typed Mail API wrappers and Zoho-shaped schemas"
```

---

### Task 2.2: `zoho/messages.ts` view model

**Files:**

- Create: `worker/src/zoho/messages.ts`
- Test: `worker/test/zoho-messages.test.ts`

**Interfaces:**

- Produces: `MessageView` (Gmail field names plus `folder_id`, `flag`, `archived`, `read`), `messageView(row, o: { content?: string; headers?: Record<string,string[]>; raw?: string; format: MessageFormat; bodyCharLimit: number; includeBody: boolean })`, `splitAddressList(s: string): string[]`, `htmlToText(html: string): string`, `ZohoMessageRef = { folderId: string; messageId: string }`.

- [ ] **Step 1: Write the failing test**

`worker/test/zoho-messages.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { messageView, splitAddressList, htmlToText } from "../src/zoho/messages";

const row = {
  messageId: "9",
  folderId: "1",
  threadId: "7",
  threadCount: 2,
  fromAddress: "Carla <c@example.org>",
  toAddress: "sarabi@example.test, rcp@example.test",
  ccAddress: "",
  subject: "Hi",
  summary: "s",
  receivedTime: 1700000000000,
  sentDateInGMT: 1700000000000,
  status: "unread",
  flagid: "important",
  hasAttachment: 1,
  sender: "Carla",
};

describe("messageView", () => {
  it("keeps Gmail field names and adds folder, flag, archived, read", () => {
    const v = messageView(row, {
      format: "PLAIN_TEXT",
      bodyCharLimit: 100,
      includeBody: true,
      content: "<p>Hello <b>there</b></p>",
      headers: { "Message-ID": ["<a@b>"], "In-Reply-To": ["<z@b>"], "Reply-To": ["r@example.org"] },
    });
    expect(v).toMatchObject({
      id: "9",
      thread_id: "7",
      folder_id: "1",
      subject: "Hi",
      from: "Carla <c@example.org>",
      to: ["sarabi@example.test", "rcp@example.test"],
      message_id_header: "<a@b>",
      in_reply_to: "<z@b>",
      reply_to: ["r@example.org"],
      flag: "important",
      archived: false,
      read: false,
      plaintext_body: "Hello there",
    });
    expect(v.date).toBe(new Date(1700000000000).toISOString());
  });
  it("truncates and flags the body, and omits it when asked", () => {
    const v = messageView(row, { format: "PLAIN_TEXT", bodyCharLimit: 3, includeBody: true, content: "abcdef" });
    expect(v.plaintext_body).toBe("abc");
    expect(v.body_truncated).toBe(true);
    expect(
      messageView(row, { format: "METADATA_ONLY", bodyCharLimit: 3, includeBody: false }).plaintext_body,
    ).toBeUndefined();
  });
  it("splits address lists on commas outside quotes and brackets", () => {
    expect(splitAddressList('"Doe, Jane" <j@example.org>, k@example.org')).toEqual([
      '"Doe, Jane" <j@example.org>',
      "k@example.org",
    ]);
    expect(htmlToText("<div>a<br>b</div><p>c</p>")).toBe("a\nb\nc");
  });
});
```

- [ ] **Step 2: Run to see it fail**, then implement.

`worker/src/zoho/messages.ts`:

```ts
import type { MessageFormat } from "@zoho-mail-mcp/shared/schemas";
import type { ZohoListRow } from "./mail";

export type ZohoMessageRef = { folderId: string; messageId: string };
export type AttachmentMeta = { attachment_id: string; filename: string; size: number; mime: string | null };
export type MessageView = {
  id: string;
  thread_id: string;
  folder_id: string;
  label_ids: string[];
  snippet: string;
  date: string | null;
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  message_id_header: string | null;
  in_reply_to: string | null;
  references: string | null;
  flag: string;
  archived: boolean;
  read: boolean;
  has_attachment: boolean;
  plaintext_body?: string;
  html_body?: string;
  raw?: string;
  body_truncated?: boolean;
  attachments: AttachmentMeta[];
};

export function splitAddressList(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let depth = 0;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") depth++;
    else if (!quoted && ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && !quoted && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n")
    .trim();
}

const first = (h: Record<string, string[]> | undefined, name: string): string | null => {
  if (!h) return null;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k && h[k]?.[0] ? h[k][0] : null;
};

export function messageView(
  row: ZohoListRow,
  o: {
    content?: string | undefined;
    headers?: Record<string, string[]> | undefined;
    raw?: string | undefined;
    format: MessageFormat;
    bodyCharLimit: number;
    includeBody: boolean;
    attachments?: AttachmentMeta[] | undefined;
  },
): MessageView {
  const v: MessageView = {
    id: row.messageId,
    thread_id: row.threadId || row.messageId,
    folder_id: row.folderId,
    label_ids: [],
    snippet: row.summary,
    date: row.receivedTime ? new Date(row.receivedTime).toISOString() : null,
    subject: row.subject || null,
    from: row.fromAddress || null,
    to: splitAddressList(row.toAddress),
    cc: splitAddressList(row.ccAddress),
    bcc: [],
    reply_to: splitAddressList(first(o.headers, "Reply-To") ?? ""),
    message_id_header: first(o.headers, "Message-ID"),
    in_reply_to: first(o.headers, "In-Reply-To"),
    references: first(o.headers, "References"),
    flag: String(row.flagid),
    archived: false,
    read: row.status === "read",
    has_attachment: Boolean(row.hasAttachment),
    attachments: o.attachments ?? [],
  };
  if (o.includeBody && o.content !== undefined && o.format !== "METADATA_ONLY" && o.format !== "MINIMAL") {
    const html = o.content;
    if (o.format === "FULL_CONTENT") {
      v.html_body = html.length > o.bodyCharLimit ? html.slice(0, o.bodyCharLimit) : html;
      v.body_truncated = html.length > o.bodyCharLimit;
    } else {
      const text = htmlToText(html);
      v.plaintext_body = text.length > o.bodyCharLimit ? text.slice(0, o.bodyCharLimit) : text;
      v.body_truncated = text.length > o.bodyCharLimit;
    }
  }
  if (o.format === "RAW" && o.raw !== undefined) v.raw = o.raw.slice(0, o.bodyCharLimit);
  return v;
}
```

- [ ] **Step 3: Run, verify, commit**

```bash
cd worker && npx vitest run test/zoho-messages.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(zoho): message view model with folder id, flag, archived and read"
```

---

### Task 2.3: `zoho/folders.ts` and the thread reader

**Files:**

- Create: `worker/src/zoho/folders.ts`
- Test: `worker/test/zoho-folders.test.ts`

**Interfaces:**

- Produces: `SystemFolders = { inbox, drafts, sent, trash, spam: string; archive: string | null }`; `systemFolders(env, deps, acct): Promise<SystemFolders>` (cached 10 minutes in the account DO under key `folders`); `folderByName(env, deps, acct, name): Promise<ZohoFolder>`; `threadMessages(env, deps, acct, threadId, limit): Promise<ZohoListRow[]>`.

- [ ] **Step 1: Failing test**

`worker/test/zoho-folders.test.ts`:

```ts
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
```

- [ ] **Step 2: Implement**

```ts
import { McpError } from "@zoho-mail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { accountStub } from "./account-do";
import type { ZohoAcct } from "./client";
import { listFolders, listMessages, type ZohoFolder, type ZohoListRow } from "./mail";

export type SystemFolders = {
  inbox: string;
  drafts: string;
  sent: string;
  trash: string;
  spam: string;
  archive: string | null;
};
const TTL = 10 * 60_000;
const pick = (fs: ZohoFolder[], name: string) =>
  fs.find(
    (f) => f.folderName.toLowerCase() === name.toLowerCase() || f.folderType?.toLowerCase() === name.toLowerCase(),
  );

export async function systemFolders(env: Env, deps: Deps, acct: ZohoAcct): Promise<SystemFolders> {
  const stub = accountStub(env, acct.accountId);
  const cached = await stub.getCache("folders");
  if (cached) return JSON.parse(cached) as SystemFolders;
  const fs = await listFolders(env, deps, acct);
  const need = (n: string) => {
    const f = pick(fs, n);
    if (!f) throw new McpError("zoho_error", `zoho_error: system folder ${n} not found`);
    return f.folderId;
  };
  const out: SystemFolders = {
    inbox: need("Inbox"),
    drafts: need("Drafts"),
    sent: need("Sent"),
    trash: need("Trash"),
    spam: need("Spam"),
    archive: pick(fs, "Archive")?.folderId ?? null,
  };
  await stub.setCache("folders", JSON.stringify(out), TTL);
  return out;
}
export async function folderByName(env: Env, deps: Deps, acct: ZohoAcct, name: string): Promise<ZohoFolder> {
  const f = pick(await listFolders(env, deps, acct), name);
  if (!f) throw new McpError("invalid_header", `invalid_header: no folder named ${name}`);
  return f;
}
/** One list call with the threadId filter; Zoho returns every folder's messages, each with its own folderId. */
export function threadMessages(
  env: Env,
  deps: Deps,
  acct: ZohoAcct,
  threadId: string,
  limit: number,
): Promise<ZohoListRow[]> {
  return listMessages(env, deps, acct, {
    threadId,
    limit: Math.min(200, limit),
    includesent: true,
    includearchive: true,
  });
}
```

- [ ] **Step 3: Run, verify, commit**

```bash
cd worker && npx vitest run test/zoho-folders.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(zoho): system folder resolution with DO cache; thread reader"
```

---

### Task 2.4: Rewrite `tools/read.ts`

**Files:**

- Modify: `worker/src/tools/read.ts` (rewritten), `worker/src/tools/compose.ts` (`getMessage` becomes Zoho: `getMessage(env, deps, acct, messageId, format)` resolves the folder by listing with `threadId` unknown, so it searches `messages/view` with `start=1,limit=1`? No: Zoho needs `folderId`. Therefore every message reference the server hands out is `folder_id:message_id` in the tool argument `message_ref`, or the tool accepts `message_id` plus optional `folder_id` and falls back to a two-step lookup described below.)
- Test: `worker/test/read-tools.test.ts` (rewritten on `FakeZoho`)

**Interfaces:**

- Produces: tools `search_messages`, `search_threads`, `get_thread`, `get_message`, `list_drafts`, `get_draft`, `list_labels`, `list_folders`; helper `resolveRef(env, deps, acct, { message_id, folder_id? }): Promise<ZohoMessageRef>`; `getMessage(env, deps, acct, ref, format): Promise<MessageView>`.
- Message addressing rule, documented in every tool description: results carry `id` and `folder_id`; callers pass both back. When only `message_id` is given, `resolveRef` tries the Inbox, Sent, Drafts, Spam and Trash details endpoints in that order (at most 5 calls, within the budget) and refuses with `handle_invalid` if none answers.

- [ ] **Step 1: Write the failing test**

`worker/test/read-tools.test.ts` (replace the file):

```ts
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
});
```

- [ ] **Step 2: Run to see it fail**, then implement `tools/read.ts`:

```ts
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
import type { ZohoAcct } from "../zoho/client";
import { folderByName, systemFolders, threadMessages } from "../zoho/folders";
import * as mail from "../zoho/mail";
import { messageView, type MessageView, type ZohoMessageRef } from "../zoho/messages";
import { defineTool, type Plan } from "./define";
import type { ExecRun, ToolContext } from "./gate";

const fmt = (f: MessageFormat | "MESSAGE_FORMAT_UNSPECIFIED"): MessageFormat =>
  f === "MESSAGE_FORMAT_UNSPECIFIED" ? "PLAIN_TEXT" : f;
const acct = (run: ExecRun): ZohoAcct => ({
  userId: run.userId,
  accountId: run.account.id,
  toolCallId: run.operationId ?? run.pendingId ?? crypto.randomUUID(),
});
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

export async function resolveRef(
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  o: { message_id: string; folder_id?: string | undefined },
): Promise<ZohoMessageRef> {
  if (o.folder_id) return { folderId: o.folder_id, messageId: o.message_id };
  const sys = await systemFolders(env, deps, a);
  for (const folderId of [sys.inbox, sys.sent, sys.drafts, sys.spam, sys.trash]) {
    try {
      await mail.messageDetails(env, deps, a, folderId, o.message_id);
      return { folderId, messageId: o.message_id };
    } catch (e) {
      if (!(e instanceof McpError) || e.code !== "zoho_error") throw e;
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
  const row = await mail.messageDetails(env, deps, a, ref.folderId, ref.messageId);
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
      const key = p.folder ? `${p.query}::folder:${p.folder}` : p.query;
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
        ? await mail.searchMessages(e, d, acct(run), { searchKey: p.query, start, limit: 200 })
        : await mail.listMessages(e, d, acct(run), { start, limit: 200 });
      const byThread = new Map<string, mail.ZohoListRow>();
      for (const r of rows) {
        const k = r.threadId || r.messageId;
        const prev = byThread.get(k);
        if (!prev || r.receivedTime > prev.receivedTime) byThread.set(k, r);
      }
      const threads = [...byThread.values()].slice(0, p.limit).map((r) => ({
        id: r.threadId || r.messageId,
        message_count: r.threadCount,
        newest: messageView(r, { format: "METADATA_ONLY", bodyCharLimit: 0, includeBody: false }),
      }));
      return { threads, ...(rows.length === 200 ? { next_page_token: String(start + 200) } : {}) };
    },
  });
  defineTool(server, toolContext, env, {
    name: "get_thread",
    version: 1,
    description:
      `A thread's messages across folders, one call for metadata. With a body format, at most ${BUDGETS.bodies} bodies per call; next_cursor continues.` +
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
      for (const r of rows) {
        if (!wantBodies || budget <= 0 || !(await stub.budget(a.toolCallId, "bodies", 1))) {
          if (wantBodies && !cursor) cursor = r.messageId;
          messages.push(messageView(r, { format: "METADATA_ONLY", bodyCharLimit: 0, includeBody: false }));
          continue;
        }
        const v = await getMessage(e, d, a, { folderId: r.folderId, messageId: r.messageId }, f, {
          bodyCharLimit: Math.min(p.body_char_limit, budget),
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
      const rows = await mail.listMessages(e, d, a, { folderId: sys.drafts, start, limit: p.limit });
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
```

`tools/compose.ts`'s Gmail `getMessage` is replaced in M3; until then `compose.ts` keeps its own. The `zohoFixture` in `zoho-mail.test.ts` seeds one fresh account per call (D1 rows persist across cases within a file) and is what every later Zoho test imports.

- [ ] **Step 3: Run, verify, commit**

```bash
cd worker && npx vitest run test/read-tools.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(tools): read family on Zoho with folder-aware addressing and body budget"
```

---

### Task 2.5: Retire the Gmail read path

**Files:**

- Delete: `worker/src/google/messages.ts` references from `tools/read.ts` (already none), `worker/test/messages.test.ts`
- Modify: `worker/test/mcp.test.ts` tool-count assertion (now 7 control tools + 8 read tools + the unchanged Gmail label, draft and send families until M3 and M4)

- [ ] **Step 1: Verify and commit**

```bash
cd worker && git rm test/messages.test.ts && cd .. && npm run verify
git add -A && git commit -m "chore: retire the Gmail message view tests"
```

## M2 exit checklist

- [ ] `read-tools.test.ts` proves: flat search with folder ids, one-call metadata thread, 8-body cap with cursor, bare-id resolution and refusal, folders and labels.
- [ ] Every read result carries `id` and `folder_id`.
- [ ] `npm run verify` green.

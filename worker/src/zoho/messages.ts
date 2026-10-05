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

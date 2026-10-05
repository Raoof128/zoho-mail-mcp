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

const BREAK_TAGS = /^(br|\/p|\/div|\/li|\/tr|\/h[1-6])$/;
const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
/**
 * Linear-time HTML to text. Every search moves forward from the current position, and an opener with no closer ends
 * the scan, so hostile mail (half a megabyte of "<style" or "<") costs one pass instead of a rescan per opener
 * (final review of M2, I2).
 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break; // an unclosed tag: the rest is markup, not text
    const name = /^\s*(\/?[a-z0-9]+)/.exec(lower.slice(lt + 1, Math.min(gt, lt + 40)))?.[1] ?? "";
    if (name === "style" || name === "script") {
      const close = lower.indexOf(`</${name}`, gt + 1);
      if (close === -1) break; // unterminated style or script: drop the rest
      const end = html.indexOf(">", close);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (BREAK_TAGS.test(name)) out += "\n";
    i = gt + 1;
  }
  return out
    .replace(/&(#\d{1,7}|[a-z]+);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (k in ENTITIES) return ENTITIES[k]!;
      if (k.startsWith("#")) return String.fromCodePoint(Math.min(Number(k.slice(1)), 0x10ffff));
      return m;
    })
    .split("\n")
    .map((l) => l.trim())
    .filter((l, idx, a) => l !== "" || (idx > 0 && a[idx - 1] !== ""))
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

import { McpError } from "@zoho-mail-mcp/shared/errors";
import { CarriedAttachmentRef, MediaType, type InlineAttachment } from "@zoho-mail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { sha256Hex } from "../crypto/canonical";
import { fromB64url } from "../crypto/random";
import { LIMITS, assertHeaderSafe, assertNotBlocked, utf8Length } from "../policy/limits";
import { addressOf, parseAddress } from "../policy/recipients";
import { listUploadHandles, type SealedRow } from "../staging/sealed";
import { accountStub, BUDGETS } from "../zoho/account-do";
import type { ZohoAcct } from "../zoho/client";
import { attachmentInfo, attachmentStream, uploadAttachment, type SendBody, type ZohoUploadRef } from "../zoho/mail";
import type { MessageView } from "../zoho/messages";
import type { AccountRef } from "./accounts";
import { resolveRef } from "./read";

export type ComposeArgs = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | undefined;
  body?: string | undefined;
  html_body?: string | undefined;
};

/** Spec 2.7 and 3.8, before policy and before any row: addresses parse, headers are clean, sizes fit. */
export function validateCompose(a: ComposeArgs): void {
  const all = [...a.to, ...a.cc, ...a.bcc];
  if (all.length > 500) throw new McpError("limit_exceeded", `limit_exceeded: recipients ${all.length} > 500`);
  for (const r of all) parseAddress(r);
  if (a.subject !== undefined) assertHeaderSafe("subject", a.subject);
  const bodyBytes = utf8Length(a.body ?? "") + utf8Length(a.html_body ?? "");
  if (bodyBytes > LIMITS.bodyBytes)
    throw new McpError("limit_exceeded", `limit_exceeded: body ${bodyBytes} > ${LIMITS.bodyBytes} bytes`);
}

export function senderFor(account: AccountRef, from?: string): string {
  if (from === undefined) return account.email;
  const norm = parseAddress(from).normalized;
  const allowed = [account.email, ...account.sendAs].map((s) => parseAddress(s).normalized);
  if (!allowed.includes(norm))
    throw new McpError("invalid_address", `invalid_address: ${from} is not a verified sender on this account`);
  return from;
}

export type DecodedInline = { filename: string; mime: string; size: number; sha256: string; bytes: Uint8Array };

function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  try {
    return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  } catch {
    return fromB64url(clean);
  }
}

/**
 * Spec 2.7's 1 MB is enforced before the bytes exist: each string's decoded size is projected from its
 * length, the running total is checked before the decode, and the blocked list and media type are
 * checked before that. Fifty strings just under the per-item cap cannot add up to more than 1 MiB decoded.
 */
export async function decodeInline(inline: InlineAttachment[] | undefined): Promise<DecodedInline[]> {
  const out: DecodedInline[] = [];
  let total = 0;
  for (const i of inline ?? []) {
    assertNotBlocked(i.filename);
    MediaType.parse(i.mime);
    const projected = Math.floor((i.content_base64.length * 3) / 4) - 2;
    if (total + projected > LIMITS.inlineAttachmentBytes) {
      throw new McpError(
        "limit_exceeded",
        `limit_exceeded: inline attachments exceed ${LIMITS.inlineAttachmentBytes} bytes`,
      );
    }
    const bytes = decodeBase64(i.content_base64);
    total += bytes.byteLength;
    if (total > LIMITS.inlineAttachmentBytes) {
      throw new McpError(
        "limit_exceeded",
        `limit_exceeded: inline attachments exceed ${LIMITS.inlineAttachmentBytes} bytes`,
      );
    }
    out.push({
      filename: i.filename,
      mime: i.mime,
      size: bytes.byteLength,
      sha256: await sha256Hex(new Uint8Array(bytes)),
      bytes,
    });
  }
  return out;
}

/** The client's arguments as the intent hash sees them: inline bytes replaced by their digest. */
export function intentArgs(args: Record<string, unknown>, inline: DecodedInline[]): Record<string, unknown> {
  const { inline_attachments: _dropped, ...rest } = args;
  for (const k of Object.keys(rest)) if (rest[k] === undefined) delete rest[k];
  return inline.length === 0
    ? rest
    : {
        ...rest,
        inline_attachments: inline.map((d) => ({ filename: d.filename, mime: d.mime, size: d.size, sha256: d.sha256 })),
      };
}

export function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function attachmentSummary(files: { filename: string; size: number }[]): string {
  if (files.length === 0) return "no attachments";
  return `${files.length} attachment${files.length === 1 ? "" : "s"} (${files.map((f) => `${f.filename}, ${human(f.size)}`).join("; ")})`;
}
export function recipientSummary(p: {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | null | undefined;
}): string {
  const parts = [`To: ${p.to.join(", ") || "none"}`];
  if (p.cc.length) parts.push(`Cc: ${p.cc.join(", ")}`);
  if (p.bcc.length) parts.push(`Bcc: ${p.bcc.join(", ")}`);
  parts.push(`Subject: ${p.subject ?? "(none)"}`);
  return parts.join(" · ");
}

export const MESSAGE_BYTES_CEILING = 32 * 1_000_000; // D14 preflight under Zoho's 40 MB
export type CarriedAttachment = { ref: ZohoUploadRef; filename: string; size: number };

/** Sealed upload rows for the handles named: ownership, expiry, the blocked list, the account cap and the D14 ceiling. */
export async function attachmentsFor(
  env: Env,
  userId: string,
  account: AccountRef,
  handles: string[],
  otherBytes: number,
): Promise<{ rows: SealedRow[] }> {
  const rows = await listUploadHandles(env.DB, { handles, userId, accountId: account.id });
  for (const r of rows) assertNotBlocked(r.filename);
  const total = rows.reduce((n, r) => n + r.size, 0) + otherBytes;
  if (total > MESSAGE_BYTES_CEILING)
    throw new McpError(
      "limit_exceeded",
      `limit_exceeded: attachments ${total} bytes exceed the ${MESSAGE_BYTES_CEILING} byte message ceiling`,
    );
  if (total > account.sendLimitBytes)
    throw new McpError(
      "limit_exceeded",
      `limit_exceeded: attachments ${total} > send limit ${account.sendLimitBytes} bytes`,
    );
  return { rows };
}

/** A mailbox attachment chosen for carrying, resolved at plan time; the bytes move only after approval. */
export type CarrySpec = {
  message_id: string;
  folder_id: string;
  attachment_id: string;
  filename: string;
  size: number;
};

/**
 * Plan time, no uploads (spec D17, G19): the cap of 10 is checked first, then each message is resolved once and each
 * attachment confirmed with its name and size. Hostile mail with hundreds of attachments is refused here.
 */
export async function carryPlan(
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  refs: { message_id: string; folder_id?: string | undefined; attachment_id: string }[],
): Promise<CarrySpec[]> {
  if (refs.length === 0) return [];
  if (refs.length > BUDGETS.attachments)
    throw new McpError(
      "budget_exceeded",
      `budget_exceeded: at most ${BUDGETS.attachments} attachments can be carried in one call; ${refs.length} asked`,
      { counter: "attachments" },
    );
  const infoByMessage = new Map<string, { folderId: string; info: Awaited<ReturnType<typeof attachmentInfo>> }>();
  const out: CarrySpec[] = [];
  for (const r of refs) {
    let m = infoByMessage.get(r.message_id);
    if (!m) {
      const ref = await resolveRef(env, deps, a, r);
      m = { folderId: ref.folderId, info: await attachmentInfo(env, deps, a, ref.folderId, ref.messageId) };
      infoByMessage.set(r.message_id, m);
    }
    const info = m.info.find((x) => x.attachmentId === r.attachment_id);
    if (!info)
      throw new McpError(
        "handle_invalid",
        `handle_invalid: no attachment ${r.attachment_id} on message ${r.message_id}. Available: ${
          m.info.map((x) => `${x.attachmentId} (${x.attachmentName})`).join(", ") || "none"
        }`,
      );
    assertNotBlocked(info.attachmentName);
    out.push({
      message_id: r.message_id,
      folder_id: m.folderId,
      attachment_id: r.attachment_id,
      filename: info.attachmentName,
      size: info.attachmentSize,
    });
  }
  return out;
}

/** After approval: stream each carried attachment into a fresh Zoho upload, within the attachments and bytes budgets. */
export async function carryExecute(
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  specs: CarrySpec[],
): Promise<CarriedAttachment[]> {
  if (specs.length === 0) return [];
  const stub = accountStub(env, a.accountId);
  if (!(await stub.budget(a.toolCallId, "attachments", specs.length)))
    throw new McpError("budget_exceeded", `budget_exceeded: at most ${BUDGETS.attachments} attachments in one call`, {
      counter: "attachments",
    });
  const out: CarriedAttachment[] = [];
  for (const c of specs) {
    if (!(await stub.budget(a.toolCallId, "bytes", c.size)))
      throw new McpError("limit_exceeded", `limit_exceeded: carried attachments exceed ${BUDGETS.bytes} bytes`);
    const res = await attachmentStream(env, deps, a, c.folder_id, c.message_id, c.attachment_id);
    const up = await uploadAttachment(env, deps, a, c.filename, res.body as ReadableStream<Uint8Array>);
    out.push({ ref: up, filename: c.filename, size: c.size });
  }
  return out;
}

/** Inline attachments become Zoho uploads in the build step, after the policy decision, like a carried file. */
export async function uploadInline(
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  inline: DecodedInline[],
): Promise<CarriedAttachment[]> {
  const out: CarriedAttachment[] = [];
  for (const d of inline) {
    const ref = await uploadAttachment(env, deps, a, d.filename, d.bytes);
    out.push({ ref, filename: d.filename, size: d.size });
  }
  return out;
}

export function zohoBody(
  args: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject?: string | undefined;
    body?: string | undefined;
    html_body?: string | undefined;
  },
  from: string,
  attachments: ZohoUploadRef[],
  extra: Partial<SendBody> = {},
): SendBody {
  // What is sent is exactly what policy parsed: the normalized address of each recipient, never the raw string
  // (final review of M3, I1: `evil@x;<ok@org>` parses as ok@org and must not reach Zoho as written).
  const norm = (list: string[]) => list.map((r) => parseAddress(r).normalized).join(",");
  const b: SendBody = {
    fromAddress: parseAddress(from).normalized,
    toAddress: norm(args.to),
    encoding: "UTF-8",
    ...extra,
  };
  if (args.cc.length) b.ccAddress = norm(args.cc);
  if (args.bcc.length) b.bccAddress = norm(args.bcc);
  if (args.subject !== undefined) b.subject = args.subject;
  if (args.html_body !== undefined) {
    b.content = args.html_body;
    b.mailFormat = "html";
  } else {
    b.content = args.body ?? "";
    b.mailFormat = "plaintext";
  }
  if (attachments.length) b.attachments = attachments;
  return b;
}

/** Spec 5.3: Reply-To if present else From; plus To and Cc on reply_all; minus own and send-as; de-duplicated; never Bcc. Fallbacks for notes to self. */
export function replyRecipients(
  view: MessageView,
  self: string[],
  args: { to: string[]; cc: string[]; reply_all: boolean },
): { to: string[]; cc: string[] } {
  const norm = (s: string) => addressOf(s);
  const selfSet = new Set(self.map(norm));
  const dedupe = (list: string[], exclude = new Set<string>()) => {
    const seen = new Set(exclude);
    const out: string[] = [];
    for (const r of list) {
      const n = norm(r);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  };
  const primary = view.reply_to.length ? view.reply_to : view.from ? [view.from] : [];
  let to = dedupe([...primary, ...(args.reply_all ? view.to : []), ...args.to], selfSet);
  if (to.length === 0) to = dedupe(view.to, selfSet);
  if (to.length === 0) to = dedupe([...primary, ...view.to]);
  const cc = dedupe(args.reply_all ? [...view.cc, ...args.cc] : args.cc, new Set([...selfSet, ...to]));
  return { to, cc };
}
export { CarriedAttachmentRef };
export type { InlineAttachment };

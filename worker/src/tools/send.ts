import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Modifier } from "@zoho-mail-mcp/shared/actions";
import { McpError } from "@zoho-mail-mcp/shared/errors";
import { ForwardInput, ReplyInput, SendMessageInput } from "@zoho-mail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { executeZohoSend } from "../operations/zoho-send";
import { recipientModifiers } from "../policy/recipients";
import { listUploadHandles } from "../staging/sealed";
import type { ZohoAcct } from "../zoho/client";
import type { ZohoUploadRef } from "../zoho/mail";
import { htmlToText, type MessageView } from "../zoho/messages";
import { trustContext, type AccountRef } from "./accounts";
import {
  attachmentSummary,
  attachmentsFor,
  carryExecute,
  carryPlan,
  recipientSummary,
  replyRecipients,
  senderFor,
  uploadInline,
  validateCompose,
  zohoBody,
  type CarrySpec,
  type DecodedInline,
} from "./compose";
import { defineTool, type Plan } from "./define";
import type { ExecRun, ToolContext } from "./gate";
import { getMessage, resolveRef } from "./read";

type SendKind = "send" | "reply";
export type SendPayload = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | undefined;
  body?: string | undefined;
  html_body?: string | undefined;
  from: string;
  /** Sealed upload handles from the companion, reserved by the gate. */
  attachments: string[];
  /** Mailbox attachments to re-upload after approval. */
  carry: CarrySpec[];
  /** Inline attachments already uploaded to Zoho in the build step. */
  uploaded: { ref: ZohoUploadRef; filename: string; size: number }[];
  kind: SendKind;
  message_id?: string | undefined;
  folder_id?: string | undefined;
  thread_id?: string | null | undefined;
  /** send_draft: the draft sent, and the hash of the snapshot the owner approved. */
  draft_id?: string | undefined;
  draft_sha?: string | undefined;
};
type SendArgs = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | undefined;
  body?: string | undefined;
  html_body?: string | undefined;
  from?: string | undefined;
  attachments?: string[] | undefined;
  idempotency_key?: string | undefined;
};
const openWorld = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
/** Plan-time Zoho calls share one budget per tool invocation. */
export const planAcct = (t: ToolContext, account: AccountRef): ZohoAcct => ({
  userId: t.principal.userId,
  accountId: account.id,
  toolCallId: crypto.randomUUID(),
});
/** Card numbers and Australian tax file numbers raise the level even for trusted recipients (spec D9). */
const SENSITIVE = [/\b(?:\d[ -]?){13,19}\b/, /\b\d{3}[ -]?\d{3}[ -]?\d{3}\b.*\bTFN\b/i];

async function modifiersFor(
  env: Env,
  userId: string,
  account: AccountRef,
  p: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject?: string | undefined;
    body?: string | undefined;
    html_body?: string | undefined;
  },
  hasAttachments: boolean,
  inline: DecodedInline[] = [],
): Promise<Modifier[]> {
  const mods = recipientModifiers([...p.to, ...p.cc, ...p.bcc], await trustContext(env, userId, account));
  if (hasAttachments) mods.unshift("+attachment");
  // Everything the server can read is scanned: subject, both bodies and inline text attachments (security review).
  const inlineText = inline
    .filter((d) => d.mime.startsWith("text/"))
    .map((d) => new TextDecoder().decode(d.bytes))
    .join("\n");
  const text = `${p.subject ?? ""}\n${p.body ?? ""}\n${p.html_body ? htmlToText(p.html_body) : ""}\n${inlineText}`;
  if (SENSITIVE.some((re) => re.test(text)) && !mods.includes("+sensitive")) mods.push("+sensitive");
  return mods;
}

/** Shared plan for send_message, reply and forward once recipients are settled. Policy runs on the final recipients. */
export async function planSend(
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  account: AccountRef,
  args: SendArgs,
  inline: DecodedInline[],
  extra: {
    carry: CarrySpec[];
    kind: SendKind;
    message_id?: string;
    folder_id?: string;
    thread_id?: string | null;
    draft_id?: string;
    draft_sha?: string;
  },
  verb: string,
): Promise<Plan> {
  validateCompose(args);
  if (args.to.length + args.cc.length + args.bcc.length === 0)
    throw new McpError("invalid_address", "invalid_address: at least one recipient is required");
  const from = senderFor(account, args.from);
  const given = args.attachments ?? [];
  const otherBytes = extra.carry.reduce((n, c) => n + c.size, 0) + inline.reduce((n, d) => n + d.size, 0);
  const { rows } = await attachmentsFor(env, a.userId, account, given, otherBytes);
  const files = [
    ...rows.map((r) => ({ filename: r.filename, size: r.size })),
    ...inline.map((d) => ({ filename: d.filename, size: d.size })),
    ...extra.carry,
  ];
  const recipients = { to: args.to, cc: args.cc, bcc: args.bcc };
  return {
    modifiers: await modifiersFor(
      env,
      a.userId,
      account,
      { ...recipients, subject: args.subject, body: args.body, html_body: args.html_body },
      files.length > 0,
      inline,
    ),
    summary: `${verb ? `${verb} · ` : ""}${recipientSummary({ ...recipients, subject: args.subject })} · ${attachmentSummary(files)}`,
    facts: {
      recipients: args.to.length + args.cc.length + args.bcc.length,
      attachments: files.length,
      ...(extra.message_id ? { ids: [extra.message_id] } : {}),
    },
    idempotencyKey: args.idempotency_key,
    build: async () => {
      const payload: SendPayload = {
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
        html_body: args.html_body,
        from,
        attachments: given,
        carry: extra.carry,
        uploaded: (await uploadInline(env, deps, a, inline)).map((u) => ({ ...u })),
        kind: extra.kind,
        message_id: extra.message_id,
        folder_id: extra.folder_id,
        thread_id: extra.thread_id ?? null,
        ...(extra.draft_id ? { draft_id: extra.draft_id, draft_sha: extra.draft_sha } : {}),
      };
      return { payload: payload as unknown as Record<string, unknown>, handles: given };
    },
  };
}

/** After approval: sealed handles still valid (Review Focus 4), carried files re-uploaded, then one send. */
export async function executeSend(env: Env, deps: Deps, run: ExecRun) {
  const p = run.payload as unknown as SendPayload;
  if (!run.operationId) throw new McpError("internal", "send runs with an operation");
  const a: ZohoAcct = { userId: run.userId, accountId: run.account.id, toolCallId: run.operationId };
  if (p.attachments.length) {
    const ph = p.attachments.map(() => "?").join(",");
    const expired = await env.DB.prepare(
      `SELECT handle FROM sealed_handles WHERE handle IN (${ph}) AND user_id = ? AND account_id = ? AND expires_at <= ?`,
    )
      .bind(...p.attachments, run.userId, run.account.id, Date.now())
      .all<{ handle: string }>();
    if (expired.results.length)
      throw new McpError(
        "handle_expired",
        `handle_expired: stage ${expired.results.map((r) => r.handle).join(", ")} again`,
      );
  }
  const rows = await listUploadHandles(env.DB, {
    handles: p.attachments,
    userId: run.userId,
    accountId: run.account.id,
  });
  const carried = await carryExecute(env, deps, a, p.carry);
  const refs: ZohoUploadRef[] = [
    ...rows.map((r) => JSON.parse(r.provider_ref) as ZohoUploadRef),
    ...p.uploaded.map((u) => u.ref),
    ...carried.map((c) => c.ref),
  ];
  const out = await executeZohoSend(env, deps, {
    ...a,
    operationId: run.operationId,
    kind: p.kind,
    ...(p.kind === "reply" && p.message_id ? { messageId: p.message_id } : {}),
    body: zohoBody(p, p.from, refs),
  });
  return {
    provider_result_id: out.message_id,
    message_id: out.message_id,
    folder_id: out.folder_id,
    thread_id: p.thread_id ?? null,
  };
}

function quoted(v: MessageView): string {
  return [
    "---------- Forwarded message ----------",
    `From: ${v.from ?? ""}`,
    `Date: ${v.date ?? ""}`,
    `Subject: ${v.subject ?? ""}`,
    `To: ${v.to.join(", ")}`,
    ...(v.cc.length ? [`Cc: ${v.cc.join(", ")}`] : []),
    "",
    v.plaintext_body ?? htmlToText(v.html_body ?? ""),
  ].join("\n");
}

export function registerSendTools(server: McpServer, toolContext: (ctx: ServerContext) => ToolContext, env: Env): void {
  defineTool(server, toolContext, env, {
    name: "send_message",
    version: 1,
    description:
      "Send new mail. Replies go through `reply`. To attach a file already in this mailbox, pass attach_from_message with its message_id, folder_id and attachment_id from get_message (at most 10); `attachments` is only for handles uploaded by the local companion.",
    input: SendMessageInput,
    annotations: openWorld,
    action: "send.message",
    journal: true,
    plan: async (e, t, account, args, inline) => {
      const a = planAcct(t, account);
      return planSend(
        e,
        t.deps,
        a,
        account,
        args,
        inline,
        { carry: await carryPlan(e, t.deps, a, args.attach_from_message), kind: "send" },
        "",
      );
    },
    execute: executeSend,
  });

  defineTool(server, toolContext, env, {
    name: "reply",
    version: 1,
    description:
      "Reply to a message; pass its message_id and folder_id. The Worker derives the recipients: Reply-To or From, plus the original To and Cc with reply_all, minus this account; never the original Bcc. Policy is decided on those recipients, not on the thread.",
    input: ReplyInput,
    annotations: openWorld,
    action: "send.message",
    journal: true,
    plan: async (e, t, account, args, inline) => {
      const a = planAcct(t, account);
      const view = await getMessage(e, t.deps, a, await resolveRef(e, t.deps, a, args), "METADATA_ONLY", {
        bodyCharLimit: 1,
        includeBody: false,
      });
      const { to, cc } = replyRecipients(view, [account.email, ...account.sendAs], args);
      const subjectRaw = view.subject ?? "";
      const subject = /^\s*re:/i.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`;
      return planSend(
        e,
        t.deps,
        a,
        account,
        { ...args, to, cc, subject },
        inline,
        {
          carry: await carryPlan(e, t.deps, a, args.attach_from_message),
          kind: "reply",
          message_id: view.id,
          folder_id: view.folder_id,
          thread_id: view.thread_id,
        },
        "Reply",
      );
    },
    execute: executeSend,
  });

  defineTool(server, toolContext, env, {
    name: "forward",
    version: 1,
    description:
      "Forward a message with optional text; pass its message_id and folder_id. Original attachments are excluded unless include_original_attachments is true; at most 10 attachments are carried, and a message with more is refused before anything is uploaded.",
    input: ForwardInput,
    annotations: openWorld,
    action: "send.forward",
    journal: true,
    plan: async (e, t, account, args, inline) => {
      const a = planAcct(t, account);
      const ref = await resolveRef(e, t.deps, a, args);
      const v = await getMessage(e, t.deps, a, ref, "PLAIN_TEXT", { bodyCharLimit: 600_000, includeBody: true });
      // Spec D17: a send is never silently truncated. An original longer than the body limit is refused.
      if (v.body_truncated)
        throw new McpError(
          "limit_exceeded",
          "limit_exceeded: the original is longer than a forward can carry; forward it from Zoho Mail instead",
        );
      // Originals are refused above 10 before any upload (spec D17, G19); picked files go through carryPlan's cap.
      if (args.include_original_attachments && v.attachments.length > 10)
        throw new McpError(
          "budget_exceeded",
          `budget_exceeded: the message has ${v.attachments.length} attachments; at most 10 can be forwarded`,
          { counter: "attachments" },
        );
      const carry = args.include_original_attachments
        ? v.attachments.map((x) => ({
            message_id: v.id,
            folder_id: v.folder_id,
            attachment_id: x.attachment_id,
            filename: x.filename,
            size: x.size,
          }))
        : await carryPlan(e, t.deps, a, args.attach_from_message);
      const subjectRaw = v.subject ?? "";
      const subject = /^\s*fwd?:/i.test(subjectRaw) ? subjectRaw : `Fwd: ${subjectRaw}`;
      const body = `${args.forward_text ? args.forward_text + "\n\n" : ""}${quoted(v)}`;
      return planSend(
        e,
        t.deps,
        a,
        account,
        { ...args, subject, body },
        inline,
        { carry, kind: "send", message_id: v.id },
        "Forward",
      );
    },
    execute: executeSend,
  });
}

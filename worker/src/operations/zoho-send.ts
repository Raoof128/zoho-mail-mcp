import { McpError } from "@zoho-mail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { replyMessage, saveDraft, sendMessage, type SendBody } from "../zoho/mail";
import { beginOperation } from "./journal";
import { hashCanonical } from "../crypto/canonical";
import type { ExpectedSend } from "./probe";
import { splitAddressList } from "../zoho/messages";

export type SendKind = "send" | "reply" | "draft";
export type SendOutcome = { message_id: string; folder_id: string | null };

/**
 * Spec 5.5. Settlement protocol 1: the row moves to `executing` immediately before the one request
 * that has a side effect, and to `executed` only after a parsed success. Anything thrown after the
 * request was sent leaves `executing`, which the gate settles as `delivery_unknown`; anything thrown
 * before leaves `claimed`, which settles `failed_safe`. Nothing here retries.
 */
export async function executeZohoSend(
  env: Env,
  deps: Deps,
  o: {
    userId: string;
    accountId: string;
    toolCallId: string;
    operationId: string;
    kind: SendKind;
    messageId?: string;
    body: SendBody;
  },
): Promise<SendOutcome> {
  const acct = { userId: o.userId, accountId: o.accountId, toolCallId: o.toolCallId };
  const row = await env.DB.prepare(
    "SELECT zoho_email, send_as FROM accounts WHERE id=? AND user_id=? AND status='active'",
  )
    .bind(o.accountId, o.userId)
    .first<{ zoho_email: string; send_as: string }>();
  if (!row) throw new McpError("account_needs_reconnect", "account_needs_reconnect");
  const allowed = [row.zoho_email, ...(JSON.parse(row.send_as) as string[])].map((s) => s.toLowerCase());
  if (!allowed.includes(o.body.fromAddress.toLowerCase()))
    throw new McpError("invalid_address", `invalid_address: ${o.body.fromAddress} is not a sender on this account`);
  if (o.kind !== "draft" && !o.body.toAddress && !o.body.ccAddress && !o.body.bccAddress)
    throw new McpError("invalid_address", "invalid_address: at least one recipient is required");
  const expected: ExpectedSend = {
    from: o.body.fromAddress,
    to: splitAddressList(o.body.toAddress ?? ""),
    cc: splitAddressList(o.body.ccAddress ?? ""),
    subject: o.body.subject ?? "",
    startedAt: Date.now(),
    attachmentCount: o.body.attachments?.length ?? 0,
    attachmentNames: (o.body.attachments ?? []).map((a) => a.attachmentName),
    bodySha256: o.body.content ? await hashCanonical(o.body.content) : null,
  };
  await env.DB.prepare("UPDATE operations SET settlement_context_json=? WHERE id=? AND state='claimed'")
    .bind(JSON.stringify(expected), o.operationId)
    .run();
  // Throws unless this run moved the row from claimed: a concurrent or replayed run must never send twice.
  await beginOperation(env.DB, o.operationId);
  const sent =
    o.kind === "reply"
      ? await replyMessage(env, deps, acct, o.messageId!, o.body)
      : o.kind === "draft"
        ? await saveDraft(env, deps, acct, o.body)
        : await sendMessage(env, deps, acct, o.body);
  await env.DB.prepare(
    "UPDATE operations SET state='executed', provider_result_id=?, result_json=?, updated_at=? WHERE id=? AND state='executing'",
  )
    .bind(
      sent.messageId,
      JSON.stringify({ message_id: sent.messageId, folder_id: sent.folderId ?? null }),
      Date.now(),
      o.operationId,
    )
    .run();
  return { message_id: sent.messageId, folder_id: sent.folderId ?? null };
}

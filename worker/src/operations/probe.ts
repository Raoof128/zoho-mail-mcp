import { z } from "zod";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { hashCanonical } from "../crypto/canonical";
import { bodyDigestText } from "./zoho-send";
import { systemFolders } from "../zoho/folders";
import { listMessages, messageContent, type ZohoListRow } from "../zoho/mail";
import { splitAddressList } from "../zoho/messages";

export const ExpectedSend = z.object({
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  startedAt: z.number(),
  attachmentCount: z.number(),
  attachmentNames: z.array(z.string()),
  bodySha256: z.string().nullable(),
});
export type ExpectedSend = z.infer<typeof ExpectedSend>;
const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^.*<([^>]+)>.*$/, "$1");
const sameSet = (a: string[], b: string[]) => {
  const x = a.map(norm).sort(),
    y = b.map(norm).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Every field Zoho exposes must match; a field we cannot read is not a match. */
export function matchCandidate(exp: ExpectedSend, row: ZohoListRow, contentSha?: string | null): boolean {
  if (norm(row.fromAddress) !== norm(exp.from)) return false;
  if (!sameSet(splitAddressList(row.toAddress), exp.to)) return false;
  if (!sameSet(splitAddressList(row.ccAddress), exp.cc)) return false;
  if (row.subject.trim() !== exp.subject.trim()) return false;
  const t = row.sentDateInGMT || row.receivedTime;
  // Created at or after the send began (30 s of clock skew allowed), so an earlier identical mail is not evidence.
  if (t < exp.startedAt - 30_000 || t > exp.startedAt + 86_400_000) return false;
  if ((row.hasAttachment ? 1 : 0) !== (exp.attachmentCount > 0 ? 1 : 0)) return false;
  if (exp.bodySha256 && contentSha !== undefined && contentSha !== exp.bodySha256) return false;
  return true;
}

export async function probeDeliveries(
  env: Env,
  deps: Deps,
  now: number,
  limit = 50,
): Promise<{ settled: number; left: number }> {
  const rows = (
    await env.DB.prepare(
      "SELECT id, user_id, account_id, settlement_context_json FROM operations WHERE state='delivery_unknown' AND settlement_context_json IS NOT NULL AND updated_at > ? ORDER BY updated_at LIMIT ?",
    )
      .bind(now - 7 * 86_400_000, limit)
      .all<{ id: string; user_id: string; account_id: string; settlement_context_json: string }>()
  ).results;
  let settled = 0;
  for (const op of rows) {
    const exp = ExpectedSend.safeParse(JSON.parse(op.settlement_context_json));
    if (!exp.success) continue;
    const acct = { userId: op.user_id, accountId: op.account_id, toolCallId: `probe:${op.id}:${now}` };
    try {
      const sys = await systemFolders(env, deps, acct);
      // includeto: Zoho omits To details by default (M2 review), and a row without them can never match.
      const sent = await listMessages(env, deps, acct, {
        folderId: sys.sent,
        limit: 200,
        includesent: true,
        includeto: true,
      });
      // A Sent message already credited to an operation is never evidence for another one (final review of M3, I3).
      const taken = new Set(
        (
          await env.DB.prepare(
            "SELECT provider_result_id FROM operations WHERE account_id = ? AND provider_result_id IS NOT NULL",
          )
            .bind(op.account_id)
            .all<{ provider_result_id: string }>()
        ).results.map((x) => x.provider_result_id),
      );
      const candidates = sent.filter((r) => !taken.has(r.messageId) && matchCandidate(exp.data, r));
      if (candidates.length !== 1) continue; // zero or several: stays delivery_unknown
      const c = candidates[0]!;
      if (exp.data.bodySha256) {
        const sha = await hashCanonical(
          bodyDigestText((await messageContent(env, deps, acct, c.folderId, c.messageId)).content),
        );
        if (sha !== exp.data.bodySha256) continue;
      }
      const res = await env.DB.prepare(
        "UPDATE operations SET state='executed', provider_result_id=?, result_json=?, updated_at=? WHERE id=? AND state='delivery_unknown'",
      )
        .bind(
          c.messageId,
          JSON.stringify({ message_id: c.messageId, folder_id: c.folderId, settled_by: "probe" }),
          now,
          op.id,
        )
        .run();
      settled += res.meta.changes ?? 0;
    } catch {
      continue; // a search error is not evidence of anything
    }
  }
  return { settled, left: rows.length - settled };
}

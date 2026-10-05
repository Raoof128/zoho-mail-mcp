import { McpError } from "@zoho-mail-mcp/shared/errors";
import { STAGING_LIMITS as L } from "@zoho-mail-mcp/shared/staging";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { streamFromZoho } from "../zoho/attachments";
import { recoveryBudget } from "./budgets";
import type { SealedRow } from "./sealed";

/**
 * Spec D16: a download handle names an attachment Zoho holds; the bytes stream from Zoho on each read and are never
 * stored in Cloudflare. The companion verifies them against the sealed digest.
 */
export async function leasedDownload(
  env: Env,
  deps: Deps,
  user: string,
  handle: string,
): Promise<{ row: SealedRow; body: ReadableStream<Uint8Array> }> {
  const row = await env.DB.prepare(
    "SELECT s.* FROM sealed_handles s JOIN accounts a ON a.id=s.account_id AND a.user_id=s.user_id WHERE s.handle=? AND s.user_id=? AND s.direction='download' AND s.consumed_at IS NULL AND a.status='active'",
  )
    .bind(handle, user)
    .first<SealedRow>();
  if (!row) throw new McpError("handle_invalid", "handle_invalid");
  if (row.expires_at <= Date.now()) throw new McpError("handle_expired", "handle_expired");
  const ref = JSON.parse(row.provider_ref) as { folderId: string; messageId: string; attachmentId: string };
  const res = await streamFromZoho(
    env,
    deps,
    { userId: user, accountId: row.account_id, toolCallId: `dl:${handle}` },
    ref,
  );
  return { row, body: res.body as ReadableStream<Uint8Array> };
}

/** The companion saved the file: mark the handle used. A repeat is answered as a replay. */
export async function acknowledgeDownload(
  env: Env,
  user: string,
  handle: string,
): Promise<{ acknowledged: true; replayed: boolean } | null> {
  const db = env.DB;
  const now = Date.now();
  const old = await db
    .prepare("SELECT 1 FROM staging_acknowledgements WHERE user_id=? AND handle=? AND retain_until>?")
    .bind(user, handle, now)
    .first();
  if (old) return { acknowledged: true, replayed: true };
  const row = await db
    .prepare(
      "SELECT account_id FROM sealed_handles WHERE handle=? AND user_id=? AND direction='download' AND consumed_at IS NULL AND expires_at>?",
    )
    .bind(handle, user, now)
    .first<{ account_id: string }>();
  if (!row) return null;
  const budget = recoveryBudget(db, user, "download:" + handle, 1, now + L.retentionMs);
  const done = await db.batch([
    ...budget,
    db
      .prepare("INSERT OR IGNORE INTO staging_acknowledgements VALUES(?,?,?,?,?)")
      .bind(user, handle, row.account_id, now, now + L.retentionMs),
    db
      .prepare(
        "UPDATE sealed_handles SET consumed_at=? WHERE handle=? AND user_id=? AND direction='download' AND consumed_at IS NULL",
      )
      .bind(now, handle, user),
  ]);
  return { acknowledged: true, replayed: (done[budget.length]!.meta.changes ?? 0) === 0 };
}

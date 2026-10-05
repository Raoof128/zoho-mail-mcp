import { McpError } from "@zoho-mail-mcp/shared/errors";
import { STAGING_LIMITS as L } from "@zoho-mail-mcp/shared/staging";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { streamFromZoho } from "../zoho/attachments";
import { recoveryBudget } from "./budgets";
import type { SealedRow } from "./sealed";
import { randomId } from "../crypto/random";
import { accountAssert, assertion } from "./transfers";

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
  const db = env.DB;
  const now = Date.now();
  const row = await db
    .prepare(
      "SELECT s.* FROM sealed_handles s JOIN accounts a ON a.id=s.account_id AND a.user_id=s.user_id WHERE s.handle=? AND s.user_id=? AND s.direction='download' AND s.consumed_at IS NULL AND a.status='active'",
    )
    .bind(handle, user)
    .first<SealedRow>();
  if (!row) throw new McpError("handle_invalid", "handle_invalid");
  if (row.expires_at <= now || row.created_at + 60 * 60_000 <= now)
    throw new McpError("handle_expired", "handle_expired");
  // The R2 path's admission controls, kept for the Zoho stream (security review of e8fbdc9): the account is live, the
  // recovery budget holds, and concurrent streams are capped globally and per owner. A stream slot is a lease that
  // is released when the body ends, errors or is cancelled, and lapses on its own if the Worker dies.
  const until = Math.min(now + L.leaseMs, row.created_at + 60 * 60_000);
  const id = randomId("ds");
  try {
    await db.batch([
      accountAssert(db, user, row.account_id),
      ...recoveryBudget(db, user, "download:" + handle, 2, now + L.retentionMs),
      assertion(db, "(SELECT count(*) FROM download_streams WHERE lease_until>?)<?", [now, L.downloadsGlobal]),
      assertion(db, "(SELECT count(*) FROM download_streams WHERE user_id=? AND lease_until>?)<?", [
        user,
        now,
        L.downloadsOwner,
      ]),
      db
        .prepare(
          "INSERT INTO download_admissions(user_id,handle,account_id,admitted_at,lease_until,retain_until) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,handle) DO UPDATE SET lease_until=MAX(lease_until,excluded.lease_until),retain_until=MAX(retain_until,excluded.retain_until)",
        )
        .bind(user, handle, row.account_id, now, until, now + L.retentionMs),
      db.prepare("INSERT INTO download_streams VALUES(?,?,?,?)").bind(id, user, handle, until),
    ]);
  } catch {
    throw new McpError("handle_invalid", "handle_invalid: download admission lost or busy");
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await db.prepare("DELETE FROM download_streams WHERE id=?").bind(id).run();
  };
  let res: Response;
  try {
    const ref = JSON.parse(row.provider_ref) as { folderId: string; messageId: string; attachmentId: string };
    res = await streamFromZoho(env, deps, { userId: user, accountId: row.account_id, toolCallId: `dl:${handle}` }, ref);
  } catch (e) {
    await release();
    throw e;
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  return {
    row,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            controller.close();
            await release();
          } else controller.enqueue(part.value);
        } catch (e) {
          controller.error(e);
          await release();
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
        await release();
      },
    }),
  };
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

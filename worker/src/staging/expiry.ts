import type { Env } from "../env";
import { assertion, auditFor, type TransferRow } from "./transfers";
import { auditStatement } from "../audit/log";

/**
 * The upload state machine's housekeeping, kept when the R2 recovery was removed in M5 (security review of 421a605):
 * stale tickets expire, uploads whose lease lapsed are abandoned, and transfers whose authority lapsed expire with
 * their operation failed safe, so nothing holds an upload cap forever. There are no bytes in Cloudflare to delete;
 * an upload Zoho accepted but we never sealed expires on Zoho's side.
 */
export async function expireUploads(env: Env, now: number, limit = 200): Promise<void> {
  const db = env.DB;
  await db.batch([
    db
      .prepare(
        "UPDATE upload_generations SET state='expired',cleanup_state='released',writer_stopped=1 WHERE ticket_id IN (SELECT ticket_id FROM upload_generations WHERE state='issued' AND issued_until<=? LIMIT ?)",
      )
      .bind(now, limit),
    db
      .prepare(
        "UPDATE upload_generations SET state='abandoned',cleanup_state='released',writer_stopped=1 WHERE ticket_id IN (SELECT ticket_id FROM upload_generations WHERE state IN ('uploading','stored') AND lease_until<=? LIMIT ?)",
      )
      .bind(now, limit),
  ]);
  const expired = await db
    .prepare(
      "SELECT * FROM upload_transfers WHERE authority_until<=? AND state IN ('authorized','awaiting_approval','in_progress') AND NOT EXISTS(SELECT 1 FROM upload_generations g WHERE g.user_id=upload_transfers.user_id AND g.transfer_id=upload_transfers.id AND g.generation=upload_transfers.active_generation AND g.state IN ('uploading','stored') AND g.lease_until>?) LIMIT ?",
    )
    .bind(now, now, limit)
    .all<TransferRow>();
  for (const t of expired.results) {
    try {
      await db.batch([
        assertion(
          db,
          "EXISTS(SELECT 1 FROM upload_transfers WHERE user_id=? AND id=? AND authority_until<=? AND state IN ('authorized','awaiting_approval','in_progress') AND NOT EXISTS(SELECT 1 FROM upload_generations g WHERE g.user_id=upload_transfers.user_id AND g.transfer_id=upload_transfers.id AND g.generation=upload_transfers.active_generation AND g.state IN ('uploading','stored') AND g.lease_until>?))",
          [t.user_id, t.id, now, now],
        ),
        db
          .prepare("UPDATE upload_transfers SET state='expired',error='pending_expired' WHERE user_id=? AND id=?")
          .bind(t.user_id, t.id),
        db
          .prepare(
            "UPDATE operations SET state='failed_safe',updated_at=? WHERE id=? AND action='attachment.stage_upload' AND state IN ('claimed','executing')",
          )
          .bind(now, t.operation_id),
        db
          .prepare(
            "UPDATE pending_actions SET state='expired',payload_json=NULL,summary='redacted' WHERE id=? AND action='attachment.stage_upload' AND state IN ('pending','approved','executing')",
          )
          .bind(t.pending_id),
        auditStatement(db, "outcome", auditFor(t, "expired")),
      ]);
    } catch {
      // A concurrent completion can win; never overwrite that durable outcome.
      const current = await db
        .prepare("SELECT state FROM upload_transfers WHERE user_id=? AND id=?")
        .bind(t.user_id, t.id)
        .first<{ state: string }>();
      if (current && ["authorized", "awaiting_approval", "in_progress"].includes(current.state))
        throw new Error("upload recovery transaction failed");
    }
  }
}

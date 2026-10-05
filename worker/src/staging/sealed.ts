import { McpError } from "@zoho-mail-mcp/shared/errors";

export const UPLOAD_HANDLE_TTL_MS = 30 * 60_000;
export type SealedRow = {
  handle: string;
  user_id: string;
  account_id: string;
  direction: "download" | "upload";
  provider_ref: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  reserved_by_operation_id: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
};
export async function insertSealed(
  db: D1Database,
  r: Omit<SealedRow, "reserved_by_operation_id" | "consumed_at">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sealed_handles (handle, user_id, account_id, direction, provider_ref, filename, mime, size, sha256, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      r.handle,
      r.user_id,
      r.account_id,
      r.direction,
      r.provider_ref,
      r.filename,
      r.mime,
      r.size,
      r.sha256,
      r.created_at,
      r.expires_at,
    )
    .run();
}
export async function purgeExpiredSealed(db: D1Database, now: number, limit = 200): Promise<{ deleted: number }> {
  // One-time links reference handles, so they go first: spent or expired links, and any link on a handle about to be
  // purged. Without this the handle delete hit the foreign key and stopped every cleanup (security review, M5).
  const due = `SELECT handle FROM sealed_handles WHERE (expires_at <= ? OR consumed_at IS NOT NULL) AND reserved_by_operation_id IS NULL LIMIT ?`;
  const [, res] = await db.batch([
    db
      .prepare(`DELETE FROM download_links WHERE expires_at <= ? OR consumed_at IS NOT NULL OR handle IN (${due})`)
      .bind(now, now, limit),
    db.prepare(`DELETE FROM sealed_handles WHERE handle IN (${due})`).bind(now, limit),
  ]);
  return { deleted: res!.meta.changes ?? 0 };
}

/** Holds referenced handles open while an approval is pending. Only ever raises the expiry. */
export async function extendExpiry(
  db: D1Database,
  handles: string[],
  userId: string,
  accountId: string,
  until: number,
): Promise<void> {
  const stmt = extendExpiryStatement(db, handles, userId, accountId, until);
  if (stmt) await stmt.run();
}

export function reserveStatements(
  db: D1Database,
  o: { operationId: string; handles: string[]; userId: string; accountId: string; now: number },
): D1PreparedStatement[] {
  if (o.handles.length === 0) return [];
  return [
    db
      .prepare(
        `UPDATE sealed_handles SET reserved_by_operation_id = ?
         WHERE handle IN (${o.handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ? AND direction = 'upload'
           AND consumed_at IS NULL AND reserved_by_operation_id IS NULL AND expires_at > ?`,
      )
      .bind(o.operationId, ...o.handles, o.userId, o.accountId, o.now),
    db
      .prepare(
        `INSERT INTO _assert (x) SELECT 1 WHERE (SELECT count(*) FROM sealed_handles WHERE reserved_by_operation_id = ?) != ?`,
      )
      .bind(o.operationId, o.handles.length),
  ];
}

export function extendExpiryStatement(
  db: D1Database,
  handles: string[],
  userId: string,
  accountId: string,
  until: number,
): D1PreparedStatement | null {
  if (handles.length === 0) return null;
  return db
    .prepare(
      `UPDATE sealed_handles SET expires_at = MAX(expires_at, ?) WHERE handle IN (${handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ?`,
    )
    .bind(until, ...handles, userId, accountId);
}

export async function listUploadHandles(
  db: D1Database,
  o: { handles: string[]; userId: string; accountId: string },
): Promise<SealedRow[]> {
  if (o.handles.length === 0) return [];
  const rows = await db
    .prepare(
      `SELECT * FROM sealed_handles WHERE handle IN (${o.handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ?
         AND direction = 'upload' AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(...o.handles, o.userId, o.accountId, Date.now())
    .all<SealedRow>();
  const found = new Set(rows.results.map((r) => r.handle));
  const missing = o.handles.filter((h) => !found.has(h));
  if (missing.length > 0) {
    // An owned, unused upload that only ran out of time is handle_expired: the fix is to stage it again.
    const expired = await db
      .prepare(
        `SELECT handle FROM sealed_handles WHERE handle IN (${missing.map(() => "?").join(",")}) AND user_id = ? AND account_id = ?
           AND direction = 'upload' AND consumed_at IS NULL AND expires_at <= ?`,
      )
      .bind(...missing, o.userId, o.accountId, Date.now())
      .all<{ handle: string }>();
    if (expired.results.length === missing.length)
      throw new McpError("handle_expired", `handle_expired: stage ${missing.join(", ")} again`, { handles: missing });
    throw new McpError("handle_invalid", `handle_invalid: ${missing.join(", ")}`, { handles: missing });
  }
  return o.handles.map((h) => rows.results.find((r) => r.handle === h)!);
}

/** Marks reserved uploads used and clears the reservation so the purge can collect them. */
export async function consume(db: D1Database, operationId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE sealed_handles SET consumed_at = ?, reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL",
    )
    .bind(Date.now(), operationId)
    .run();
}

/** Returns unconsumed reservations to the pool after an operation failed before its side effect. */
export async function release(db: D1Database, operationId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE sealed_handles SET reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL",
    )
    .bind(operationId)
    .run();
}

/** Statements that mark an operation's reserved uploads used (settled executed). */
export function consumeStatements(db: D1Database, operationId: string, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "UPDATE sealed_handles SET consumed_at = ?, reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL",
      )
      .bind(now, operationId),
  ];
}

/** Statements that return an operation's unconsumed reservations to the pool (settled failed_safe). */
export function releaseStatements(db: D1Database, operationId: string): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "UPDATE sealed_handles SET reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL",
      )
      .bind(operationId),
  ];
}

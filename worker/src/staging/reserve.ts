/**
 * Interim (M3 to M5): a staging handle lives either in the old R2-backed `staging_objects` (Gmail draft tools until
 * Task 3.4, the companion upload until M5) or in `sealed_handles` (Zoho send tools). Both use the same `sh_` format, so
 * the gate reserves across both tables and asserts the total; a handle in neither table fails the batch. M5 deletes
 * the old store and this module with it.
 */
export function reserveStatements(
  db: D1Database,
  o: { operationId: string; handles: string[]; userId: string; accountId: string; now: number },
): D1PreparedStatement[] {
  if (o.handles.length === 0) return [];
  const ph = o.handles.map(() => "?").join(",");
  return [
    db
      .prepare(
        `UPDATE staging_objects SET reserved_by_operation_id = ?
         WHERE handle IN (${ph}) AND user_id = ? AND account_id = ? AND direction = 'upload'
           AND consumed_at IS NULL AND reserved_by_operation_id IS NULL AND cleanup_state='available' AND expires_at > ?`,
      )
      .bind(o.operationId, ...o.handles, o.userId, o.accountId, o.now),
    db
      .prepare(
        `UPDATE sealed_handles SET reserved_by_operation_id = ?
         WHERE handle IN (${ph}) AND user_id = ? AND account_id = ? AND direction = 'upload'
           AND consumed_at IS NULL AND reserved_by_operation_id IS NULL AND expires_at > ?`,
      )
      .bind(o.operationId, ...o.handles, o.userId, o.accountId, o.now),
    db
      .prepare(
        `INSERT INTO _assert (x) SELECT 1 WHERE
           (SELECT count(*) FROM staging_objects WHERE reserved_by_operation_id = ?)
         + (SELECT count(*) FROM sealed_handles WHERE reserved_by_operation_id = ?) != ?`,
      )
      .bind(o.operationId, o.operationId, o.handles.length),
  ];
}

/** Holds referenced handles open while an approval is pending, in whichever table holds them. Only raises expiry. */
export function extendExpiryStatements(
  db: D1Database,
  handles: string[],
  userId: string,
  accountId: string,
  until: number,
): D1PreparedStatement[] {
  if (handles.length === 0) return [];
  const ph = handles.map(() => "?").join(",");
  return [
    db
      .prepare(
        `UPDATE staging_objects SET expires_at = MAX(expires_at, ?) WHERE handle IN (${ph}) AND user_id = ? AND account_id = ? AND cleanup_state='available'`,
      )
      .bind(until, ...handles, userId, accountId),
    db
      .prepare(
        `UPDATE sealed_handles SET expires_at = MAX(expires_at, ?) WHERE handle IN (${ph}) AND user_id = ? AND account_id = ?`,
      )
      .bind(until, ...handles, userId, accountId),
  ];
}

/** Statements that mark an operation's reserved handles used (settled executed). */
export function consumeStatements(db: D1Database, operationId: string, now: number): D1PreparedStatement[] {
  return ["staging_objects", "sealed_handles"].map((t) =>
    db
      .prepare(
        `UPDATE ${t} SET consumed_at = ?, reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL`,
      )
      .bind(now, operationId),
  );
}

/** Statements that return an operation's unconsumed reservations to the pool (settled failed_safe). */
export function releaseStatements(db: D1Database, operationId: string): D1PreparedStatement[] {
  return ["staging_objects", "sealed_handles"].map((t) =>
    db
      .prepare(
        `UPDATE ${t} SET reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL`,
      )
      .bind(operationId),
  );
}

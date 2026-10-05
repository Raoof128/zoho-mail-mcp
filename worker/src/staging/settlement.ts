/**
 * The old staging store's batch. The storage permit existed for Gmail protocol-2 sends, which were retired in M3
 * Task 3.6, so no operation can need it any more; the store itself goes in M5.
 */
export async function storageBatch(
  db: D1Database,
  _handles: string[],
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  return db.batch(statements);
}
export async function producerStopped(db: D1Database, key: string): Promise<boolean> {
  return Boolean(
    await db
      .prepare(
        `SELECT 1 WHERE (EXISTS(SELECT 1 FROM staging_ingests WHERE provider_ref=? AND writer_stopped=1 AND state='published') OR EXISTS(SELECT 1 FROM upload_generations WHERE provider_ref=? AND writer_stopped=1 AND cleanup_state='published')) AND NOT EXISTS(SELECT 1 FROM staging_ingests WHERE provider_ref=? AND writer_stopped=0) AND NOT EXISTS(SELECT 1 FROM upload_generations WHERE provider_ref=? AND writer_stopped=0)`,
      )
      .bind(key, key, key, key)
      .first(),
  );
}

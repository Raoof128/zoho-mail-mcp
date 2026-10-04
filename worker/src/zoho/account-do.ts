import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export const BUCKET_CAPACITY = 25;
export const REFILL_PER_MS = BUCKET_CAPACITY / 60_000;
export const BUDGETS = { requests: 10, bodies: 8, attachments: 10, bytes: 32 * 1_000_000 } as const;
export type BudgetCounter = keyof typeof BUDGETS;
export type AdmitResult = { ok: true } | { ok: false; retry_after_ms: number };

/**
 * One object per Zoho account (spec D8). Everything here needs strong consistency across isolates:
 * the 25 a minute bucket under Zoho's 30 a minute lock-out, the single-flight refresh, and the
 * per-tool-call budgets (D17). SQLite-backed, available on the Workers Free plan.
 */
export class AccountDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bucket(id INTEGER PRIMARY KEY CHECK(id=1), tokens REAL NOT NULL, updated_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO bucket VALUES (1, ${BUCKET_CAPACITY}, ${Date.now()});
      CREATE TABLE IF NOT EXISTS budgets(call_id TEXT NOT NULL, counter TEXT NOT NULL, used INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(call_id, counter));
      CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1), holder TEXT NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, value TEXT NOT NULL, until INTEGER NOT NULL);
    `);
  }
  ping(): "pong" {
    return "pong";
  }
  admit(_toolCallId: string): AdmitResult {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<{ tokens: number; updated_at: number }>("SELECT tokens, updated_at FROM bucket WHERE id=1")
      .one();
    const tokens = Math.min(BUCKET_CAPACITY, row.tokens + (now - row.updated_at) * REFILL_PER_MS);
    if (tokens < 1) {
      this.ctx.storage.sql.exec("UPDATE bucket SET tokens=?, updated_at=? WHERE id=1", tokens, now);
      return { ok: false, retry_after_ms: Math.ceil((1 - tokens) / REFILL_PER_MS) };
    }
    this.ctx.storage.sql.exec("UPDATE bucket SET tokens=?, updated_at=? WHERE id=1", tokens - 1, now);
    return { ok: true };
  }
  budget(toolCallId: string, counter: BudgetCounter, n: number): boolean {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM budgets WHERE created_at < ?", now - 15 * 60_000);
    const row = this.ctx.storage.sql
      .exec<{ used: number }>("SELECT used FROM budgets WHERE call_id=? AND counter=?", toolCallId, counter)
      .toArray()[0];
    const used = (row?.used ?? 0) + n;
    if (used > BUDGETS[counter]) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO budgets(call_id, counter, used, created_at) VALUES (?,?,?,?) ON CONFLICT(call_id, counter) DO UPDATE SET used=excluded.used",
      toolCallId,
      counter,
      used,
      now,
    );
    return true;
  }
  acquireRefreshLease(holder: string, ttlMs: number): "acquired" | "held" {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<{ holder: string; until: number }>("SELECT holder, until FROM lease WHERE id=1")
      .toArray()[0];
    if (row && row.until > now && row.holder !== holder) return "held";
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO lease VALUES (1, ?, ?)", holder, now + ttlMs);
    return "acquired";
  }
  releaseRefreshLease(holder: string): void {
    this.ctx.storage.sql.exec("DELETE FROM lease WHERE id=1 AND holder=?", holder);
  }
  getCache(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string; until: number }>("SELECT value, until FROM cache WHERE key=?", key)
      .toArray()[0];
    if (!row || row.until <= Date.now()) return null;
    return row.value;
  }
  setCache(key: string, value: string, ttlMs: number): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO cache VALUES (?,?,?)", key, value, Date.now() + ttlMs);
  }
}
export function accountStub(env: Env, accountId: string): DurableObjectStub<AccountDO> {
  return env.ACCOUNT_DO.get(env.ACCOUNT_DO.idFromName(accountId));
}

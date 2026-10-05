import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { NativeRefusal } from "./config.ts";

export type JournalRecord = { requestHash: string; payload: string };
export type JournalEntry = { scope: string; key: string; record: JournalRecord };
const refuse = (code: string): never => {
  throw new NativeRefusal(code);
};
const physicalPath = (inputPath: string): string => {
  try {
    return join(realpathSync(dirname(inputPath)), basename(inputPath));
  } catch {
    return refuse("journal_open");
  }
};
const openDatabase = (path: string): DatabaseSync => {
  try {
    return new DatabaseSync(path);
  } catch {
    return refuse("journal_open");
  }
};
const RECORD_LIMIT = 1000;
const RECORD_BYTES = 16 * 1024 * 1024;

/** Port of Journal.swift: records under (scope, key) with an idempotency hash, and byte reservations. */
export class Journal {
  private readonly db: DatabaseSync;
  constructor(inputPath: string) {
    const path = physicalPath(inputPath);
    // SQLITE_OPEN_NOFOLLOW is not exposed by node:sqlite; refuse a symlink in the journal's place instead.
    try {
      if (!lstatSync(path).isFile()) refuse("journal_open");
    } catch (e) {
      if (e instanceof NativeRefusal) throw e;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") refuse("journal_open");
    }
    this.db = openDatabase(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec("PRAGMA busy_timeout=30000");
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec("PRAGMA synchronous=FULL");
      this.db.exec("PRAGMA fullfsync=ON");
      this.db.exec("PRAGMA checkpoint_fullfsync=ON");
      this.db.exec("PRAGMA foreign_keys=ON");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS records(scope TEXT NOT NULL,key TEXT NOT NULL,request_hash TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(scope,key))",
      );
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,bytes INTEGER NOT NULL CHECK(bytes>=0))",
      );
      if (
        String(this.scalar("PRAGMA synchronous")) !== "2" ||
        String(this.scalar("PRAGMA fullfsync")) !== "1" ||
        String(this.scalar("PRAGMA journal_mode")) !== "wal" ||
        String(this.scalar("PRAGMA checkpoint_fullfsync")) !== "1" ||
        String(this.scalar("PRAGMA foreign_keys")) !== "1" ||
        String(this.scalar("PRAGMA quick_check")) !== "ok"
      )
        refuse("journal_integrity");
      let directory: number;
      try {
        directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch {
        return refuse("journal_directory");
      }
      try {
        fsyncSync(directory);
      } catch {
        refuse("journal_directory_sync");
      } finally {
        closeSync(directory);
      }
    } catch (e) {
      this.db.close();
      if (e instanceof NativeRefusal) throw e;
      refuse("journal_open");
    }
  }
  close(): void {
    if (this.db.isOpen) this.db.close();
  }
  private scalar(sql: string, ...values: SQLInputValue[]): unknown {
    const row = this.db.prepare(sql).get(...values);
    return row === undefined ? undefined : Object.values(row)[0];
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = work();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw e;
    }
  }
  get(scope: string, key: string): JournalRecord | null {
    if (scope.includes("\0") || key.includes("\0")) refuse("journal_key");
    const row = this.db.prepare("SELECT request_hash,payload FROM records WHERE scope=? AND key=?").get(scope, key);
    if (!row) return null;
    if (typeof row.request_hash !== "string" || typeof row.payload !== "string") refuse("journal_read");
    return { requestHash: row.request_hash as string, payload: row.payload as string };
  }
  put(scope: string, key: string, requestHash: string, payload: string): void {
    if ([scope, key, requestHash, payload].some((v) => v.includes("\0"))) refuse("journal_key");
    const size = (v: string) => Buffer.byteLength(v);
    if (size(scope) > 1024 || size(key) > 1024 || size(payload) > 65536) refuse("journal_size");
    this.transaction(() => {
      const old = this.get(scope, key);
      if (old) {
        if (old.requestHash !== requestHash) refuse("idempotency_conflict");
      } else if (Number(this.scalar("SELECT count(*) FROM records")) >= RECORD_LIMIT) refuse("receipt_budget");
      const used = Number(
        this.scalar(
          "SELECT coalesce(sum(length(CAST(payload AS BLOB))+length(CAST(scope AS BLOB))+length(CAST(key AS BLOB))+256),0) FROM records",
        ),
      );
      if (used + size(payload) + size(scope) + size(key) + 256 > RECORD_BYTES) refuse("receipt_budget");
      this.db
        .prepare("INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET payload=excluded.payload")
        .run(scope, key, requestHash, payload, Math.floor(Date.now() / 1000));
    });
  }
  reserve(id: string, bytes: number, maximum: number, count: number, kind: "snapshot" | "save" = "snapshot"): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum) refuse("spool_budget");
    const save = kind === "save" ? 1 : 0;
    this.transaction(() => {
      const old = this.scalar("SELECT bytes FROM reservations WHERE id=?", id);
      if (old !== undefined) {
        if (Number(old) !== bytes) refuse("reservation_conflict");
        return;
      }
      const used = Number(
        this.scalar("SELECT coalesce(sum(bytes),0) FROM reservations WHERE (id LIKE 'save:%') = ?", save),
      );
      const n = Number(this.scalar("SELECT count(*) FROM reservations WHERE (id LIKE 'save:%') = ?", save));
      if (used + bytes > maximum || n >= count) refuse("spool_budget");
      this.db.prepare("INSERT INTO reservations VALUES(?,?)").run(id, bytes);
    });
  }
  release(id: string): void {
    this.db.prepare("DELETE FROM reservations WHERE id=?").run(id);
  }
  /** entries() returns scope, key, hash and payload only; the charge lives here, under a digest of scope and handle. */
  reservedBytes(id: string): number | null {
    const value = this.scalar("SELECT bytes FROM reservations WHERE id=?", id);
    if (value === undefined) return null;
    const bytes = Number(value);
    if (!Number.isSafeInteger(bytes)) refuse("journal_read");
    return bytes;
  }
  entries(prefix: string): JournalEntry[] {
    return this.db
      .prepare("SELECT scope,key,request_hash,payload FROM records WHERE substr(scope,1,?)=?")
      .all(prefix.length, prefix)
      .map((row) => {
        if ([row.scope, row.key, row.request_hash, row.payload].some((v) => typeof v !== "string"))
          refuse("journal_read");
        return {
          scope: row.scope as string,
          key: row.key as string,
          record: { requestHash: row.request_hash as string, payload: row.payload as string },
        };
      });
  }
  snapshotReservations(): string[] {
    return this.db
      .prepare("SELECT id FROM reservations WHERE id NOT LIKE 'save:%'")
      .all()
      .map((row) => (typeof row.id === "string" ? row.id : refuse("journal_read")));
  }
  purgeRetained(scope: string, key: string, now: number): void {
    if (scope.startsWith("auth_")) refuse("retention_scope");
    this.db.prepare("DELETE FROM records WHERE scope=? AND key=? AND created_at<=?").run(scope, key, now - 7 * 86400);
  }
}

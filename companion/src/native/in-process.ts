import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import type { NativePort, NativeReply } from "../protocol.ts";
import {
  NativeRefusal,
  Paths,
  assertFreeSpace,
  privateDirectory,
  readConfig,
  writeConfigExclusive,
  type CompanionConfiguration,
} from "./config.ts";
import { Journal } from "./journal.ts";
import { AuthState, KeychainCredentials, mapCredentials, type CredentialStore } from "./keychain.ts";
import { SafeFiles, type FileResult } from "./safe-files.ts";
import { SaveReceipts } from "./receipts.ts";

export type NativePaths = { configDir: string; stateDir: string; snapshots: string; journal: string; lock: string };
export type InProcessOptions = {
  initialize?: boolean;
  paths?: NativePaths;
  keychain?: CredentialStore | Map<string, Buffer>;
  /** How long a call waits for another companion process to finish before refusing with lock_busy. */
  lockWaitMs?: number;
};
type Snapshot = {
  state: string;
  transfer_id: string;
  root: string;
  path: string;
  mime: string;
  created_at: number;
  file?: FileResult | null;
};
type Ready = {
  config: CompanionConfiguration;
  files: SafeFiles;
  journal: Journal;
  auth: AuthState;
  account: string;
  saves: SaveReceipts;
};
const refuse = (code: string): never => {
  throw new NativeRefusal(code);
};
const TRANSFER = /^tr_[A-Za-z0-9_-]{43}$/;
const SNAPSHOT_TTL_SECONDS = 900;
const now = () => Date.now() / 1000;
const reply = (meta: unknown, body: Uint8Array = new Uint8Array()): NativeReply => ({
  meta,
  body: new Uint8Array(body),
});
function required(value: unknown): string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value) > 4096) refuse("command_field");
  return value as string;
}
function parseSnapshot(payload: string): Snapshot {
  const s = JSON.parse(payload) as Snapshot;
  if (typeof s.state !== "string" || typeof s.transfer_id !== "string" || typeof s.created_at !== "number")
    refuse("journal_integrity");
  return s;
}
const unlinkIfPresent = (path: string, code: string) => {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") refuse(code);
  }
};

/**
 * The companion's native port, in process: the Swift helper's protocol and startup sequence
 * (main.swift) on Node primitives. One instance per tool call, as before. The process lock is an
 * exclusive SQLite transaction on `companion.lock`: an OS advisory lock that dies with the process,
 * taken on the first call and held until close(), as the helper held flock for its lifetime.
 */
export class InProcessNative implements NativePort {
  private readonly paths: NativePaths;
  private readonly store: CredentialStore;
  private readonly initialize: boolean;
  private readonly lockWaitMs: number;
  private lock: DatabaseSync | undefined;
  private state: Ready | undefined;
  private failure: string | undefined;
  private busy = false;
  private closed = false;
  constructor(o: InProcessOptions = {}) {
    this.paths = o.paths ?? Paths;
    this.initialize = o.initialize ?? false;
    this.lockWaitMs = o.lockWaitMs ?? 6 * 60_000;
    this.store = o.keychain instanceof Map ? mapCredentials(o.keychain) : (o.keychain ?? new KeychainCredentials());
  }
  private async acquire(): Promise<void> {
    if (this.lock) return;
    const deadline = Date.now() + this.lockWaitMs;
    try {
      const st = lstatSync(this.paths.lock);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0)
        refuse("lock_permissions");
    } catch (e) {
      if (e instanceof NativeRefusal) throw e;
      const fd = openSync(this.paths.lock, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
    }
    const db = new DatabaseSync(this.paths.lock);
    db.exec("PRAGMA busy_timeout=0");
    for (;;) {
      try {
        db.exec("BEGIN EXCLUSIVE");
        this.lock = db;
        return;
      } catch {
        if (this.closed || Date.now() >= deadline) {
          db.close();
          refuse("lock_busy");
        }
        await sleep(50);
      }
    }
  }
  private startup(): Ready {
    const p = this.paths;
    const config = readConfig(join(p.configDir, "config.json"));
    const files = new SafeFiles(config.roots, p.snapshots);
    new SafeFiles(config.roots, p.stateDir);
    new SafeFiles(config.roots, p.configDir);
    const journal = new Journal(p.journal);
    try {
      const auth = new AuthState(journal, this.store);
      const account = SafeFiles.digest(Buffer.from(config.origin + "\0" + config.client_id));
      const saves = new SaveReceipts(files, journal);
      saves.recoverStartup();
      // The process lock proves no earlier companion still owns these copies.
      const retained = new Set<string>();
      for (const item of journal.entries("snapshot:")) {
        const record = parseSnapshot(item.record.payload);
        if (!TRANSFER.test(record.transfer_id)) refuse("journal_integrity");
        retained.add(record.transfer_id);
        const target = join(p.snapshots, record.transfer_id);
        let present = true;
        try {
          lstatSync(target);
        } catch {
          present = false;
        }
        if (
          record.state === "preparing" ||
          record.created_at + SNAPSHOT_TTL_SECONDS <= now() ||
          (record.state === "ready" && !present)
        ) {
          unlinkIfPresent(target, "snapshot_cleanup");
          record.state = record.state === "preparing" ? "failed" : "expired";
          journal.put(item.scope, item.key, item.record.requestHash, JSON.stringify(record));
          journal.release(record.transfer_id);
        }
        if (["expired", "failed", "released"].includes(record.state))
          journal.purgeRetained(item.scope, item.key, Math.floor(now()));
      }
      for (const id of journal.snapshotReservations()) {
        if (retained.has(id)) continue;
        if (!TRANSFER.test(id)) refuse("journal_integrity");
        unlinkIfPresent(join(p.snapshots, id), "snapshot_cleanup");
        journal.release(id);
      }
      privateDirectory(p.snapshots);
      for (const item of journal.entries("transfer:")) journal.purgeRetained(item.scope, item.key, Math.floor(now()));
      for (const item of journal.entries("save:")) {
        const receipt = JSON.parse(item.record.payload) as { state?: unknown };
        if (receipt.state === "acknowledged") journal.purgeRetained(item.scope, item.key, Math.floor(now()));
      }
      return { config, files, journal, auth, account, saves };
    } catch (e) {
      journal.close();
      throw e;
    }
  }
  private initialise(raw: Record<string, unknown>, body: Uint8Array): NativeReply {
    if (body.length) refuse("configuration_invalid");
    const p = this.paths;
    const config = raw as unknown as CompanionConfiguration;
    if (typeof config.origin !== "string" || typeof config.client_id !== "string" || typeof config.roots !== "object")
      refuse("configuration_invalid");
    for (const grant of Object.values(config.roots))
      if (grant.write) mkdirSync(grant.path, { recursive: true, mode: 0o700 });
    new SafeFiles(config.roots, p.stateDir);
    new SafeFiles(config.roots, p.configDir);
    writeConfigExclusive(join(p.configDir, "config.json"), {
      origin: config.origin,
      client_id: config.client_id,
      roots: config.roots,
    });
    privateDirectory(p.configDir);
    return reply({ ok: true });
  }
  async call(command: Record<string, unknown>, body: Uint8Array = new Uint8Array()): Promise<NativeReply> {
    if (this.closed || this.busy) throw new NativeRefusal("native_busy_or_unavailable");
    if (this.failure) throw new NativeRefusal(this.failure);
    this.busy = true;
    try {
      if (!this.lock) {
        privateDirectory(this.paths.configDir);
        privateDirectory(this.paths.stateDir);
        privateDirectory(this.paths.snapshots);
        await this.acquire();
      }
      if (this.initialize) return this.initialise(command, body);
      if (!this.state) {
        try {
          this.state = this.startup();
        } catch (e) {
          // Refusal codes carry no paths, input or tokens; anything else is reported generically.
          this.failure = e instanceof NativeRefusal ? e.message : "native_startup_failed";
          throw new NativeRefusal(this.failure);
        }
      }
      return this.dispatch(this.state, command, body);
    } catch (e) {
      if (e instanceof NativeRefusal) throw e;
      throw new NativeRefusal("native_operation_failed");
    } finally {
      this.busy = false;
    }
  }
  private dispatch(s: Ready, c: Record<string, unknown>, body: Uint8Array): NativeReply {
    const { config, journal, auth, account, saves } = s;
    const op = c.op;
    if (op !== "save.publish" && op !== "auth.commit" && body.length) refuse("unexpected_body");
    switch (op) {
      case "config":
        return reply({ origin: config.origin, client_id: config.client_id });
      case "roots":
        return reply({
          roots: Object.keys(config.roots)
            .sort()
            .map((id) => ({ id, read: config.roots[id]!.read, write: config.roots[id]!.write })),
        });
      case "auth.begin":
        return reply({ epoch: auth.epoch(account) }, auth.read(account) ?? new Uint8Array());
      case "auth.commit":
        auth.commit(account, required(c.epoch), Buffer.from(body));
        return reply({ ok: true });
      case "auth.logout":
        auth.logout(account);
        return reply({ ok: true });
      case "journal.get": {
        const record = journal.get("transfer:" + required(c.scope), required(c.key));
        return reply(record ? { requestHash: record.requestHash, payload: record.payload } : {});
      }
      case "journal.put":
        journal.put("transfer:" + required(c.scope), required(c.key), required(c.requestHash), required(c.payload));
        return reply({ ok: true });
      case "snapshot.prepare":
        return this.prepareSnapshot(s, c);
      case "snapshot.read":
      case "snapshot.check": {
        const old = journal.get("snapshot:" + required(c.scope), required(c.key));
        if (!old) return refuse("snapshot_missing");
        const record = parseSnapshot(old.payload);
        const file = record.file;
        if (record.state !== "ready" || !file || record.created_at + SNAPSHOT_TTL_SECONDS <= now())
          return refuse("snapshot_expired");
        let fd: number;
        try {
          fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        } catch {
          return refuse("snapshot_missing");
        }
        try {
          const st = fstatSync(fd, { bigint: true });
          if (
            Number(st.dev) !== file.device ||
            Number(st.ino) !== file.inode ||
            Number(st.size) !== file.size ||
            st.nlink !== 1n
          )
            refuse("snapshot_changed");
          const data = Buffer.alloc(file.size + 1);
          let n = 0;
          for (;;) {
            const got = readSync(fd, data, n, data.length - n, null);
            if (got === 0) break;
            n += got;
            if (n === data.length) break;
          }
          const bytes = data.subarray(0, n);
          if (n !== file.size || SafeFiles.digest(bytes) !== file.sha256) refuse("snapshot_changed");
          return reply({ ok: true }, op === "snapshot.read" ? bytes : new Uint8Array());
        } finally {
          closeSync(fd);
        }
      }
      case "snapshot.release": {
        const scope = "snapshot:" + required(c.scope);
        const key = required(c.key);
        const old = journal.get(scope, key);
        if (!old) return refuse("snapshot_missing");
        const record = parseSnapshot(old.payload);
        if (record.file) unlinkIfPresent(record.file.path, "snapshot_cleanup");
        record.state = "released";
        journal.put(scope, key, old.requestHash, JSON.stringify(record));
        journal.release(record.transfer_id);
        return reply({ ok: true });
      }
      case "save.prepare": {
        const root = required(c.root);
        const grant = config.roots[root];
        if (!grant || !grant.write) refuse("root_permission");
        assertFreeSpace(grant!.path);
        return reply(saves.prepare(required(c.scope), required(c.handle), root, required(c.path)));
      }
      case "save.publish":
        return reply(
          saves.publish(
            required(c.scope),
            required(c.handle),
            required(c.root),
            required(c.path),
            body,
            required(c.sha256),
          ),
        );
      case "save.ack":
        return reply(saves.acknowledge(required(c.scope), required(c.handle), required(c.root), required(c.path)));
      case "debt.list":
        return reply({ rows: saves.unresolvedDebt() });
      case "debt.release":
        return reply({ outcome: saves.releaseDebt(required(c.scope), required(c.handle)) });
      default:
        return refuse("unknown_command");
    }
  }
  private prepareSnapshot(s: Ready, c: Record<string, unknown>): NativeReply {
    const { files, journal } = s;
    const scope = "snapshot:" + required(c.scope);
    const key = required(c.key);
    const hash = required(c.requestHash);
    const old = journal.get(scope, key);
    if (old) {
      if (old.requestHash !== hash) refuse("idempotency_conflict");
      return reply(JSON.parse(old.payload));
    }
    const id = required(c.transfer_id);
    const root = required(c.root);
    const path = required(c.path);
    const mime = required(c.mime);
    if (!TRANSFER.test(id)) refuse("transfer_id");
    assertFreeSpace(this.paths.snapshots);
    journal.reserve(id, SafeFiles.maximum, 100 * 1024 * 1024, 4);
    const record: Snapshot = { state: "preparing", transfer_id: id, root, path, mime, created_at: now(), file: null };
    journal.put(scope, key, hash, JSON.stringify(record));
    try {
      record.file = files.snapshot(root, path, id);
      record.state = "ready";
    } catch (e) {
      record.state = "failed";
      journal.put(scope, key, hash, JSON.stringify(record));
      journal.release(id);
      throw e;
    }
    journal.put(scope, key, hash, JSON.stringify(record));
    return reply(record);
  }
  close(): void {
    this.closed = true;
    this.state?.journal.close();
    this.state = undefined;
    if (this.lock) {
      try {
        this.lock.exec("ROLLBACK");
      } catch {
        /* closing the connection releases the lock regardless */
      }
      this.lock.close();
      this.lock = undefined;
    }
  }
}

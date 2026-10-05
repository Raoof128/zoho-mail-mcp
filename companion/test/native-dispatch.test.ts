import { it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  linkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InProcessNative } from "../src/native/in-process.ts";
import { Journal } from "../src/native/journal.ts";
import { SafeFiles } from "../src/native/safe-files.ts";
import { SaveReceipts } from "../src/native/receipts.ts";

function paths() {
  const base = mkdtempSync(join(tmpdir(), "zmd-"));
  const p = {
    configDir: join(base, "cfg"),
    stateDir: join(base, "state"),
    get snapshots() {
      return join(this.stateDir, "snapshots");
    },
    get journal() {
      return join(this.stateDir, "journal.sqlite");
    },
    get lock() {
      return join(this.stateDir, "companion.lock");
    },
  };
  const docs = join(base, "docs");
  mkdirSync(docs, { mode: 0o700 });
  writeFileSync(join(docs, "r.pdf"), "pdf");
  return { base, p, docs };
}
it("initialises, answers config and roots, snapshots once per key and reads it back, and refuses an unknown op", async () => {
  const { base, p, docs } = paths();
  const init = new InProcessNative({ initialize: true, paths: p, keychain: new Map() });
  await init.call({
    origin: "https://mail-mcp.example.test",
    client_id: "cid",
    roots: {
      attachments: { path: join(base, "out"), read: false, write: true },
      documents: { path: docs, read: true, write: false },
    },
  });
  init.close();
  const n = new InProcessNative({ paths: p, keychain: new Map() });
  expect((await n.call({ op: "config" })).meta).toEqual({ origin: "https://mail-mcp.example.test", client_id: "cid" });
  expect((await n.call({ op: "roots" })).meta).toEqual({
    roots: [
      { id: "attachments", read: false, write: true },
      { id: "documents", read: true, write: false },
    ],
  });
  const ctx = { scope: "s", key: "k", requestHash: "h" };
  const snap = (
    await n.call({
      op: "snapshot.prepare",
      ...ctx,
      root: "documents",
      path: "r.pdf",
      mime: "application/pdf",
      transfer_id: "tr_" + "a".repeat(43),
    })
  ).meta as { state: string; file: { size: number } };
  expect(snap.state).toBe("ready");
  const again = (
    await n.call({
      op: "snapshot.prepare",
      ...ctx,
      root: "documents",
      path: "r.pdf",
      mime: "application/pdf",
      transfer_id: "tr_" + "b".repeat(43),
    })
  ).meta as { transfer_id: string };
  expect(again.transfer_id).toBe("tr_" + "a".repeat(43));
  const read = await n.call({ op: "snapshot.read", ...ctx });
  expect(Buffer.from(read.body).toString()).toBe("pdf");
  await n.call({ op: "snapshot.release", ...ctx });
  await expect(n.call({ op: "snapshot.read", ...ctx })).rejects.toThrow("snapshot_expired");
  await expect(n.call({ op: "nope" })).rejects.toThrow("unknown_command");
  const begin = await n.call({ op: "auth.begin" });
  expect((begin.meta as { epoch: string }).epoch).toMatch(/^[0-9a-f-]{36}$/);
  expect(begin.body.length).toBe(0);
  n.close();
});

async function initialised() {
  const { base, p, docs } = paths();
  const init = new InProcessNative({ initialize: true, paths: p, keychain: new Map() });
  await init.call({
    origin: "https://mail-mcp.example.test",
    client_id: "cid",
    roots: {
      attachments: { path: join(base, "out"), read: false, write: true },
      documents: { path: docs, read: true, write: false },
    },
  });
  init.close();
  return { base, p, docs };
}
it("saves, acknowledges, recovers a publish interrupted before its receipt, and lists no debt", async () => {
  const { base, p } = await initialised();
  const keychain = new Map<string, Buffer>();
  const bytes = Buffer.from("attachment");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const ctx = { scope: "s", handle: "sh_" + "h".repeat(43), root: "attachments", path: "a.txt" };
  const n = new InProcessNative({ paths: p, keychain });
  expect(((await n.call({ op: "save.prepare", ...ctx })).meta as { state: string }).state).toBe("prepared");
  const published = (await n.call({ op: "save.publish", ...ctx, sha256: sha }, bytes)).meta as { state: string };
  expect(published.state).toBe("published");
  expect(readFileSync(join(base, "out", "a.txt"), "utf8")).toBe("attachment");
  expect(((await n.call({ op: "save.ack", ...ctx })).meta as { state: string }).state).toBe("acknowledged");
  expect((await n.call({ op: "debt.list" })).meta).toEqual({ rows: [] });
  expect((await n.call({ op: "debt.release", scope: "s", handle: "sh_none" })).meta).toEqual({
    outcome: "no_such_receipt",
  });
  await expect(n.call({ op: "save.prepare", ...ctx, root: "documents" })).rejects.toThrow("root_permission");
  await expect(n.call({ op: "config" }, bytes)).rejects.toThrow("unexpected_body");
  n.close();

  // A crash after the file is published but before the receipt says so: the next process finds the
  // file by its recorded identity and reports it published, without writing it twice.
  const journal = new Journal(p.journal);
  const files = new SafeFiles({ attachments: { path: join(base, "out"), read: false, write: true } }, p.snapshots);
  const saves = new SaveReceipts(files, journal);
  const crash = { ...ctx, handle: "sh_" + "c".repeat(43), path: "c.txt" };
  saves.prepare("s", crash.handle, crash.root, crash.path);
  expect(() =>
    saves.publish("s", crash.handle, crash.root, crash.path, bytes, sha, () => {
      throw new Error("crash");
    }),
  ).toThrow("crash");
  journal.close();
  const after = new InProcessNative({ paths: p, keychain });
  expect(((await after.call({ op: "save.prepare", ...crash })).meta as { state: string }).state).toBe("published");
  expect(readdirSync(join(base, "out")).sort()).toEqual(["a.txt", "c.txt"]);
  after.close();
});
it("holds the process lock from the first call until close, so a second companion waits, then refuses lock_busy", async () => {
  const { p } = await initialised();
  const first = new InProcessNative({ paths: p, keychain: new Map() });
  await first.call({ op: "config" });
  const second = new InProcessNative({ paths: p, keychain: new Map(), lockWaitMs: 200 });
  await expect(second.call({ op: "config" })).rejects.toThrow("lock_busy");
  const third = new InProcessNative({ paths: p, keychain: new Map(), lockWaitMs: 5000 });
  const waiting = third.call({ op: "config" });
  setTimeout(() => first.close(), 100);
  expect((await waiting).meta).toEqual({ origin: "https://mail-mcp.example.test", client_id: "cid" });
  third.close();
});
it("cleans an expired snapshot and a stale reservation at startup", async () => {
  const { p } = await initialised();
  const n = new InProcessNative({ paths: p, keychain: new Map() });
  const id = "tr_" + "e".repeat(43);
  await n.call({
    op: "snapshot.prepare",
    scope: "s",
    key: "k",
    requestHash: "h",
    root: "documents",
    path: "r.pdf",
    mime: "application/pdf",
    transfer_id: id,
  });
  n.close();
  expect(existsSync(join(p.snapshots, id))).toBe(true);
  const journal = new Journal(p.journal);
  const row = journal.get("snapshot:s", "k")!;
  journal.put("snapshot:s", "k", "h", JSON.stringify({ ...JSON.parse(row.payload), created_at: 0 }));
  journal.reserve("tr_" + "o".repeat(43), 10, 100 * 1024 * 1024, 4);
  journal.close();
  const later = new InProcessNative({ paths: p, keychain: new Map() });
  await expect(later.call({ op: "snapshot.read", scope: "s", key: "k", requestHash: "h" })).rejects.toThrow(
    "snapshot_expired",
  );
  later.close();
  expect(existsSync(join(p.snapshots, id))).toBe(false);
  const check = new Journal(p.journal);
  expect(check.snapshotReservations()).toEqual([]);
  check.close();
});

it("finishes a publish interrupted between link and unlink instead of leaving every later save blocked (final review I2)", async () => {
  const { base, p } = await initialised();
  const bytes = Buffer.from("linked");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const out = join(base, "out");
  const journal = new Journal(p.journal);
  const files = new SafeFiles({ attachments: { path: out, read: false, write: true } }, p.snapshots);
  const saves = new SaveReceipts(files, journal);
  const handle = "sh_" + "l".repeat(43);
  const prepared = saves.prepare("s", handle, "attachments", "l.txt");
  // The state a crash leaves after linkSync(temp, final) and before unlinkSync(temp).
  const temp = join(out, prepared.temporary!);
  writeFileSync(temp, bytes, { mode: 0o600 });
  const st = statSync(temp);
  const identity = { size: bytes.length, sha256: sha, device: st.dev, inode: st.ino };
  linkSync(temp, join(out, "l.txt"));
  journal.put(
    "save:s",
    handle,
    SafeFiles.digest(Buffer.from("attachments\0l.txt")),
    JSON.stringify({
      ...prepared,
      state: "verified",
      created: { ...identity, path: prepared.temporary },
      file: { ...identity, path: "l.txt" },
    }),
  );
  journal.close();
  const n = new InProcessNative({ paths: p, keychain: new Map() });
  const ctx = { scope: "s", handle, root: "attachments", path: "l.txt" };
  expect(((await n.call({ op: "save.prepare", ...ctx })).meta as { state: string }).state).toBe("published");
  expect(existsSync(temp)).toBe(false);
  expect(statSync(join(out, "l.txt")).nlink).toBe(1);
  // The save budget is free again: another handle can save.
  const other = { ...ctx, handle: "sh_" + "m".repeat(43), path: "m.txt" };
  expect(((await n.call({ op: "save.prepare", ...other })).meta as { state: string }).state).toBe("prepared");
  n.close();
});

# M6: Plain-JavaScript companion, launchd, tarball, one-line installer, client configuration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The client runs one line in Terminal and ends up with a running companion, a login-time agent, Claude Code, Codex and Claude Desktop configured, and no compiler, no signing and no manual JSON. Nothing of ours is a binary.

**Architecture:** The Swift helper's fifteen operations and `--init` are reimplemented in `companion/src/native/*.ts` behind the frozen `NativePort` interface, in process (no child process). Keychain through macOS's built-in `security` command, journal through `node:sqlite`, files through `fs.open` flags. The companion is bundled with esbuild into one file, packed as `companion.tgz`, and served by the Worker as a static asset beside `install.sh` and `companion.sha256`. The CLI gains `install-agent` and `configure-clients`.

**Spec:** D10, D11, D15, section 2.1, section 7, gate G20.

**Master:** `2026-10-03-zoho-mail-mcp-00-master.md`. The `NativePort` contract: `call(command, body?) => Promise<{ meta: unknown; body: Uint8Array }>`, errors are thrown as `Error` whose `message` is a lowercase code (`idempotency_conflict`, `snapshot_missing`, ...), exactly what `transfers.ts` matches on.

## File map

| Path                                                                                        | Responsibility                                                                                       |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `companion/src/native/config.ts`                                                            | configuration file, private directories, free-space check                                            |
| `companion/src/native/keychain.ts`                                                          | `security` wrapper, epoch-bound credentials                                                          |
| `companion/src/native/journal.ts`                                                           | SQLite records and reservations                                                                      |
| `companion/src/native/safe-files.ts`                                                        | roots, validated paths, snapshot, save, verify                                                       |
| `companion/src/native/receipts.ts`                                                          | save receipts and debt                                                                               |
| `companion/src/native/in-process.ts`                                                        | `InProcessNative implements NativePort`, the dispatcher                                              |
| `companion/src/native.ts`                                                                   | now re-exports `InProcessNative` as `NativeProcess` (name kept for `server.ts`, `auth.ts`, `cli.ts`) |
| `companion/src/cli.ts`                                                                      | `init`, `login`, `logout`, `serve`, `debt`, `install-agent`, `configure-clients`                     |
| `companion/scripts/bundle.mjs`                                                              | esbuild to `dist/` and `npm pack`                                                                    |
| `worker/public/install.sh`, `worker/public/companion.tgz`, `worker/public/companion.sha256` | static assets                                                                                        |
| `companion/test/native-*.test.ts`, `companion/test/configure-clients.test.ts`               | tests                                                                                                |

---

### Task 6.1: Configuration and private state

> **Carried from M5 execution (2026-10-05):** the Worker allows staging only from a companion root named exactly `outbox` (`+outside_outbox` raises every other root, or a missing one, to ask). The companion's `init`/configure must create that root under that name, and `companion/src/transfers.ts` already sends `root` in the upload metadata.

**Files:**

- Delete: `companion/native-swift-retired/` (whole directory)
- Create: `companion/src/native/config.ts`
- Test: `companion/test/native-config.test.ts`

**Interfaces:**

- Produces: `CompanionConfiguration = { origin: string; client_id: string; roots: Record<string, { path: string; read: boolean; write: boolean }> }`; `validateConfiguration(c)`; `privateDirectory(path): string` (creates 0700, refuses symlinks and group/other bits, returns the real path); `readConfig(path): CompanionConfiguration` (refuses mode bits other than 0600, size over 64 KiB, symlinks); `writeConfigExclusive(path, c)` (O_EXCL, 0600, fsync); `assertFreeSpace(path)` (125 MiB on a local volume); `Paths = { configDir: ~/.config/zoho-mail-mcp, stateDir: ~/Library/Application Support/zoho-mail-mcp, snapshots: stateDir/snapshots }`.

- [ ] **Step 1: Failing test**

`companion/test/native-config.test.ts`:

```ts
import { it, expect } from "vitest";
import { mkdtempSync, symlinkSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateDirectory, readConfig, writeConfigExclusive, validateConfiguration } from "../src/native/config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "zmc-"));
it("creates a private directory with mode 0700 and refuses a symlink in its place", () => {
  const base = tmp();
  const dir = privateDirectory(join(base, "state"));
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  symlinkSync(dir, join(base, "link"));
  expect(() => privateDirectory(join(base, "link"))).toThrow("private_symlink");
});
it("writes the configuration once, refuses a second write, refuses loose permissions on read", () => {
  const base = tmp();
  const c = {
    origin: "https://mail-mcp.example.test",
    client_id: "cid",
    roots: { attachments: { path: join(base, "out"), read: false, write: true } },
  };
  const file = join(privateDirectory(join(base, "cfg")), "config.json");
  writeConfigExclusive(file, c);
  expect(() => writeConfigExclusive(file, c)).toThrow("configuration_exists");
  expect(readConfig(file)).toEqual(c);
  chmodSync(file, 0o644);
  expect(() => readConfig(file)).toThrow("configuration_permissions");
});
it("validates origin, client id and root names", () => {
  expect(() => validateConfiguration({ origin: "http://x", client_id: "c", roots: {} })).toThrow(
    "configuration_invalid",
  );
  expect(() => validateConfiguration({ origin: "https://x.test/path", client_id: "c", roots: {} })).toThrow(
    "configuration_invalid",
  );
  expect(() =>
    validateConfiguration({
      origin: "https://x.test",
      client_id: "c",
      roots: { "Bad Name": { path: "/tmp", read: true, write: false } },
    }),
  ).toThrow("configuration_invalid");
});
```

- [ ] **Step 2: Implement** `companion/src/native/config.ts`:

```ts
import {
  constants,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export class NativeRefusal extends Error {
  constructor(code: string) {
    super(code);
    this.name = "NativeRefusal";
  }
}
const refuse = (code: string): never => {
  throw new NativeRefusal(code);
};
export type RootGrant = { path: string; read: boolean; write: boolean };
export type CompanionConfiguration = { origin: string; client_id: string; roots: Record<string, RootGrant> };
export const Paths = {
  configDir: join(homedir(), ".config", "zoho-mail-mcp"),
  stateDir: join(homedir(), "Library", "Application Support", "zoho-mail-mcp"),
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
export function validateConfiguration(c: CompanionConfiguration): void {
  let u: URL;
  try {
    u = new URL(c.origin);
  } catch {
    return refuse("configuration_invalid");
  }
  if (u.protocol !== "https:" || !u.host || u.username || u.password || u.pathname !== "/" || u.search || u.hash)
    refuse("configuration_invalid");
  if (!c.client_id || Buffer.byteLength(c.client_id) > 1024) refuse("configuration_invalid");
  const names = Object.keys(c.roots);
  if (names.length > 16 || !names.every((n) => /^[a-z][a-z0-9_-]{0,63}$/.test(n))) refuse("configuration_invalid");
}
export function privateDirectory(path: string): string {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") refuse("private_directory");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    st = lstatSync(path);
  }
  if (!st.isDirectory()) refuse("private_symlink");
  const physical = realpathSync(path);
  const pst = lstatSync(physical);
  if (!pst.isDirectory() || pst.uid !== process.getuid!() || (pst.mode & 0o077) !== 0) refuse("private_permissions");
  const fd = openSync(physical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return physical;
}
export function assertFreeSpace(path: string): void {
  const v = statfsSync(path);
  if (Number(v.bavail) * Number(v.bsize) < 125 * 1024 * 1024) refuse("space_or_volume");
}
export function readConfig(path: string): CompanionConfiguration {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return refuse("run_init");
  }
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0 || st.size > 65536)
      refuse("configuration_permissions");
    const c = JSON.parse(readFileSync(fd, "utf8")) as CompanionConfiguration;
    validateConfiguration(c);
    return c;
  } finally {
    closeSync(fd);
  }
}
export function writeConfigExclusive(path: string, c: CompanionConfiguration): void {
  validateConfiguration(c);
  for (const g of Object.values(c.roots)) if (g.write) mkdirSync(g.path, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    return refuse("configuration_exists");
  }
  try {
    writeSync(fd, JSON.stringify(c));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const d = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(d);
  } finally {
    closeSync(d);
  }
}
```

- [ ] **Step 3: Run, commit**

```bash
git rm -r companion/native-swift-retired
cd companion && npx vitest run test/native-config.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(companion): Node configuration and private state; Swift removed"
```

---

### Task 6.2: Keychain through `security`, journal through `node:sqlite`

**Files:**

- Create: `companion/src/native/keychain.ts`, `companion/src/native/journal.ts`
- Test: `companion/test/native-journal.test.ts`, `companion/test/native-keychain.test.ts` (the keychain test runs only when `process.platform === "darwin"` and `ZMC_KEYCHAIN_TESTS=1`, against a service name suffixed `.test`)

**Interfaces:**

- Note: `node:sqlite` is unflagged since Node 22.13 but still prints an ExperimentalWarning to stderr; the `bin/companion` shim (Task 6.6) passes `--no-warnings=ExperimentalWarning` so the stdio transport stays clean.
- Produces: `KeychainCredentials { read(account): Buffer | null; write(account, data: Buffer); delete(account) }` using `security find-generic-password -a <account> -s <service> -w`, `security add-generic-password -a -s -w <base64> -U` (base64 so bytes never hit a shell: `execFileSync("/usr/bin/security", [...])` with an argv, never a shell string), `security delete-generic-password`; `AuthState { epoch(account); read(account); commit(account, epoch, data); logout(account) }` exactly as the Swift class; `Journal` with `get`, `put` (BEGIN IMMEDIATE, idempotency conflict, 1,000 records and 16 MiB budget), `reserve(id, bytes, maximum, count, kind)`, `release`, `reservedBytes`, `entries(prefix)`, `snapshotReservations`, `purgeRetained(scope, key, now)` on `DatabaseSync` from `node:sqlite` with the same PRAGMAs (`journal_mode=WAL`, `synchronous=FULL`, `fullfsync=ON`, `checkpoint_fullfsync=ON`, `foreign_keys=ON`, `quick_check`).

- [ ] **Step 1: Failing journal test**

`companion/test/native-journal.test.ts`:

```ts
import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/native/journal.ts";

it("stores records under scope and key, refuses a different request hash for the same key, and reserves bytes within a budget", () => {
  const j = new Journal(join(mkdtempSync(join(tmpdir(), "zmj-")), "journal.sqlite"));
  j.put("transfer:s", "k", "h1", "p1");
  expect(j.get("transfer:s", "k")).toEqual({ requestHash: "h1", payload: "p1" });
  expect(() => j.put("transfer:s", "k", "h2", "p2")).toThrow("idempotency_conflict");
  j.put("transfer:s", "k", "h1", "p3");
  expect(j.get("transfer:s", "k")!.payload).toBe("p3");
  j.reserve("tr_a", 1000, 2000, 2);
  j.reserve("tr_b", 1000, 2000, 2);
  expect(() => j.reserve("tr_c", 1, 2000, 2)).toThrow("spool_budget");
  j.release("tr_a");
  expect(j.reservedBytes("tr_a")).toBeNull();
  expect(j.snapshotReservations()).toEqual(["tr_b"]);
  expect(j.entries("transfer:")).toHaveLength(1);
});
```

- [ ] **Step 2: Implement** `journal.ts` with `DatabaseSync` (`import { DatabaseSync } from "node:sqlite"`), opening the file, `chmodSync(path, 0o600)`, running the PRAGMAs and asserting each as the Swift did (`db.prepare("PRAGMA synchronous").get()` equals `2`, etc.), and `keychain.ts` with `execFileSync`. Every refusal throws `NativeRefusal(code)` with the same codes as Swift (`journal_open`, `journal_integrity`, `journal_key`, `journal_size`, `receipt_budget`, `spool_budget`, `reservation_conflict`, `retention_scope`, `keychain_read`, `keychain_write`, `keychain_delete`, `credential_size`, `auth_epoch_changed`).

- [ ] **Step 3: Run, verify, commit**

```bash
cd companion && npx vitest run test/native-journal.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(companion): SQLite journal and security-backed keychain in Node"
```

---

### Task 6.3: Safe files: snapshot, save, verify

**Files:**

- Create: `companion/src/native/safe-files.ts`
- Test: `companion/test/native-safe-files.test.ts`

**Interfaces:**

- Produces: `SafeFiles` with `constructor(roots, privateDir)` (opens each root with `O_DIRECTORY | O_NOFOLLOW`, records dev and ino, refuses non-local volumes via `statfsSync` type not in `apfs`/`hfs`, refuses overlaps with each other and with the private directory), `snapshot(rootId, relative, id): FileResult` (reads at most 25 MiB with `O_NOFOLLOW`, refuses non-regular, nlink over 1, cross-device; copies into `privateDir/<id>` with `O_EXCL` 0600, fsyncs file and directory, returns `{ path, size, sha256, device, inode }`), `save(rootId, relative, bytes, sha256, hooks): FileResult` (temp `.zoho-mail-mcp-<uuid>` in the parent with `O_EXCL` 0600, write, fsync, verify, `renameSync` only if the destination does not exist (`linkSync` then `unlinkSync` for the exclusive publish), fsync parent, verify again by dev/ino/size/digest and refuse `publication_unknown` on mismatch), `verify(rootId, relative, expected)`, `discardTemporary(rootId, path, expected)`, `static digest(bytes)`, `maximum = 25 MiB`, `validated(relative)` with the same rules as the Swift (no leading slash, no backslash, 1,024 bytes, 16 parts, NFC, no `.`/`..`, no part starting `.zoho-mail-mcp-`, no control or format characters).

- [ ] **Step 1: Failing test**

`companion/test/native-safe-files.test.ts`:

```ts
import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeFiles } from "../src/native/safe-files.ts";

function world() {
  const base = mkdtempSync(join(tmpdir(), "zsf-"));
  const priv = join(base, "private");
  mkdirSync(priv, { mode: 0o700 });
  const out = join(base, "out");
  mkdirSync(out, { mode: 0o700 });
  const docs = join(base, "docs");
  mkdirSync(docs, { mode: 0o700 });
  return {
    base,
    priv,
    out,
    docs,
    files: new SafeFiles(
      { attachments: { path: out, read: false, write: true }, documents: { path: docs, read: true, write: false } },
      priv,
    ),
  };
}
it("snapshots a readable file into the private directory and refuses symlinks and paths that escape", () => {
  const { docs, files, priv } = world();
  writeFileSync(join(docs, "a.txt"), "abc");
  const r = files.snapshot("documents", "a.txt", "tr_" + "x".repeat(43));
  expect(r.size).toBe(3);
  expect(r.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(existsSync(join(priv, "tr_" + "x".repeat(43)))).toBe(true);
  symlinkSync(join(docs, "a.txt"), join(docs, "link.txt"));
  expect(() => files.snapshot("documents", "link.txt", "tr_" + "y".repeat(43))).toThrow(
    /source_open|source_type_or_size/,
  );
  expect(() => files.snapshot("documents", "../out/a.txt", "tr_" + "z".repeat(43))).toThrow("invalid_path");
  expect(() => files.snapshot("attachments", "a.txt", "tr_" + "w".repeat(43))).toThrow("root_permission");
});
it("saves with a temporary file and an exclusive publish; never overwrites; verifies after", () => {
  const { out, files } = world();
  const bytes = Buffer.from("hello");
  const sha = SafeFiles.digest(bytes);
  const r = files.save("attachments", "h.txt", bytes, sha, {});
  expect(readFileSync(join(out, "h.txt"), "utf8")).toBe("hello");
  expect(r.size).toBe(5);
  expect(() => files.save("attachments", "h.txt", bytes, sha, {})).toThrow(/publish|exists/);
  expect(() => files.save("attachments", "bad.txt", bytes, "0".repeat(64), {})).toThrow("digest_or_size");
  expect(() => files.save("attachments", "nodir/x.txt", bytes, sha, {})).toThrow(/temporary_create/);
});
```

- [ ] **Step 2: Implement** `safe-files.ts` following the Swift line for line with Node primitives: `openSync(path, flags, 0o600)`, `fstatSync`, `readSync` into a buffer bounded at `maximum + 1`, `linkSync(temp, final)` then `unlinkSync(temp)` for the exclusive publish (`link` fails with `EEXIST` when the destination exists, which is the no-overwrite guarantee; rename would replace), `fsyncSync` on the file and the parent directory fd, `realpathSync` on the parent before and after the publish and refuse `publication_unknown` on mismatch (spec D15's stated weakening).

- [ ] **Step 3: Run, verify, commit**

```bash
cd companion && npx vitest run test/native-safe-files.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(companion): safe snapshot, save and verify in Node"
```

---

### Task 6.4: Receipts, debt and the in-process dispatcher

**Files:**

- Create: `companion/src/native/receipts.ts`, `companion/src/native/in-process.ts`
- Replace: `companion/src/native.ts` with `export { InProcessNative as NativeProcess } from "./native/in-process.ts"; export type { NativePort, NativeReply } from "./protocol.ts";`
- Test: `companion/test/native-dispatch.test.ts`; the existing `save.test.ts`, `transfers.test.ts`, `save-crash-matrix.test.ts`, `approval.test.ts`, `stdio.test.ts`, `cli.test.ts` must keep passing (they use `NativePort` doubles)

**Interfaces:**

- Produces: `InProcessNative implements NativePort` whose `call({ op, ...fields }, body?)` dispatches `config`, `roots`, `auth.begin`, `auth.commit`, `auth.logout`, `journal.get`, `journal.put`, `snapshot.prepare`, `snapshot.check`, `snapshot.read`, `snapshot.release`, `save.prepare`, `save.publish`, `save.ack`, `debt.list`, `debt.release` with the same reply shapes as the Swift (`{ok:true}`, `{origin, client_id}`, `{roots:[{id, read, write}]}`, `{epoch}` plus body, the `Snapshot` and `SaveReceipt` JSON); `constructor(o?: { initialize?: boolean; paths?: typeof Paths })`; takes the process lock (`flock` is unavailable in Node, so the lock is an `O_EXCL` lock file containing the pid, with stale detection by `process.kill(pid, 0)`), runs the startup recovery (`recoverStartup`, snapshot cleanup, retention purge) exactly as `main.swift`; `close()` releases the lock.

- [ ] **Step 1: Failing dispatch test**

`companion/test/native-dispatch.test.ts`:

```ts
import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InProcessNative } from "../src/native/in-process.ts";

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
```

`keychain: new Map()` is a test credential store; the real one is `KeychainCredentials`. Both satisfy `{ read, write, delete }`.

- [ ] **Step 2: Implement** `receipts.ts` (port of `SaveReceipts.swift`: `recover`, `prepare`, `publish`, `acknowledge`, `unresolvedDebt`, `releaseDebt`, `recoverStartup`) and `in-process.ts` (constructor runs the `main.swift` startup sequence; `call` is the `switch` from `main.swift` returning `{ meta, body }` or throwing `NativeRefusal`). Errors not of class `NativeRefusal` surface as `native_operation_failed`.

- [ ] **Step 3: Run the whole companion suite, verify, commit**

```bash
cd companion && npx vitest run && cd .. && npm run verify
git add -A && git commit -m "feat(companion): in-process native port with receipts and debt"
```

---

### Task 6.5: CLI: `init` defaults, `install-agent`

**Files:**

- Modify: `companion/src/cli.ts`
- Create: `companion/src/launchd.ts`
- Test: `companion/test/cli.test.ts` (extend), `companion/test/launchd.test.ts`

**Interfaces:**

- Produces: `init --server https://HOST --client-id ID [--write-root PATH] [--read-root ID=PATH]*` with defaults: `attachments` write `~/Downloads/Mail`, `outbox` read `~/Downloads/Mail/To Send`, `desktop` read `~/Desktop`, `downloads` read `~/Downloads`, `documents` read `~/Documents` (the installer creates `~/Downloads/Mail/To Send` first; `outbox` is the root name M5 Task 5.3 allows without asking); `install-agent` writes `~/Library/LaunchAgents/au.com.sarabisfinerugs.mail-mcp.companion.plist` and runs `launchctl bootstrap gui/$(id -u) <plist>`; `launchdPlist(o: { label; program: string; args: string[]; logPath: string }): string`.

- [ ] **Step 1: Failing test** (`companion/test/launchd.test.ts`):

```ts
import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchdPlist } from "../src/launchd.ts";

it("emits a plist that plutil accepts, with RunAtLoad and KeepAlive on the serve command", () => {
  const xml = launchdPlist({
    label: "au.com.sarabisfinerugs.mail-mcp.companion",
    program: "/usr/local/bin/node",
    args: ["/Users/x/Library/Application Support/zoho-mail-mcp/bin/companion", "serve"],
    logPath: "/Users/x/Library/Logs/zoho-mail-mcp.log",
  });
  expect(xml).toContain("<key>RunAtLoad</key><true/>");
  expect(xml).toContain("<string>serve</string>");
  if (process.platform === "darwin") {
    const f = join(mkdtempSync(join(tmpdir(), "zpl-")), "a.plist");
    writeFileSync(f, xml);
    expect(execFileSync("/usr/bin/plutil", ["-lint", f]).toString()).toContain("OK");
  }
});
```

- [ ] **Step 2: Implement** `launchd.ts`:

```ts
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function launchdPlist(o: { label: string; program: string; args: string[]; logPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${esc(o.label)}</string>
<key>ProgramArguments</key><array>${[o.program, ...o.args].map((a) => `<string>${esc(a)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>StandardOutPath</key><string>${esc(o.logPath)}</string>
<key>StandardErrorPath</key><string>${esc(o.logPath)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin</string></dict>
</dict></plist>
`;
}
```

The agent keeps a `serve` process alive, which is harmless (stdio MCP servers are started per client; this one idles) and gives the owner a running process to `debt` against. If the client's MCP clients each spawn their own `serve`, the agent's instance only holds the lock while a call is in flight (the lock in Task 6.4 is per call, not per process, so several `serve` processes coexist).

In `cli.ts`: `init` builds the default roots above (creating the write root and the outbox with `mkdirSync({ recursive: true, mode: 0o700 })`), then `new NativeProcess({ initialize: true }).call({ origin, client_id, roots })`; `install-agent` writes the plist and runs `launchctl bootout` then `bootstrap`; both print one line of plain English and exit non-zero with the refusal code on failure. Usage text lists all commands. No em dashes.

- [ ] **Step 3: Run, verify, commit**

```bash
cd companion && npx vitest run && cd .. && npm run verify
git add -A && git commit -m "feat(companion): init defaults with an outbox root; launchd agent"
```

---

### Task 6.6: Bundle and pack; static assets on the Worker

**Files:**

- Create: `companion/scripts/bundle.mjs`, `companion/dist/` (generated, gitignored), `worker/public/.gitkeep`
- Modify: `package.json` (`"build:companion": "node companion/scripts/bundle.mjs"`), `worker/wrangler.jsonc` and `wrangler.prod.jsonc` (`"assets": { "directory": "./public", "binding": "ASSETS" }`), `worker/src/index.ts` (serve `/install.sh`, `/companion.tgz`, `/companion.sha256` from `env.ASSETS.fetch(request)` before the OAuth provider; `/healthz` stays), `.gitignore`
- Test: `companion/test/bundle.test.ts`

**Interfaces:**

- Produces: `worker/public/companion.tgz` (an npm package `zoho-mail-mcp-companion` with `bin/companion` pointing at `dist/companion.mjs`, `engines.node >= 22.18`, no dependencies: esbuild bundles `@zoho-mail-mcp/shared`, `@modelcontextprotocol/server` and `zod`, externals `node:*`), `worker/public/companion.sha256` (hex plus two spaces plus `companion.tgz`), `worker/public/companion.version` (the package version).

- [ ] **Step 1: Failing test** (`companion/test/bundle.test.ts`):

```ts
import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

it("bundles the companion into one file, packs it, and writes a matching sha256", () => {
  execFileSync("node", ["companion/scripts/bundle.mjs"], { cwd: new URL("../..", import.meta.url), stdio: "inherit" });
  const root = new URL("../../worker/public/", import.meta.url);
  const tgz = readFileSync(new URL("companion.tgz", root));
  const sha = readFileSync(new URL("companion.sha256", root), "utf8").split(/\s+/)[0];
  expect(createHash("sha256").update(tgz).digest("hex")).toBe(sha);
  expect(existsSync(new URL("install.sh", root))).toBe(true);
  const listing = execFileSync("tar", ["-tzf", new URL("companion.tgz", root).pathname]).toString();
  expect(listing).toContain("package/dist/companion.mjs");
  expect(listing).toContain("package/bin/companion");
  expect(listing).not.toContain("node_modules/");
  // The bundle must run: a duplicate shebang or an unresolved workspace import fails here, not on the client's Mac.
  execFileSync("tar", ["-xzf", new URL("companion.tgz", root).pathname, "-C", process.env.TMPDIR ?? "/tmp"]);
  const out = execFileSync("node", [(process.env.TMPDIR ?? "/tmp") + "/package/dist/companion.mjs", "nope"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
  expect(out).toContain("Usage");
});
```

- [ ] **Step 2: Implement** `companion/scripts/bundle.mjs`:

```js
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
const companion = new URL("..", import.meta.url);
const dist = new URL("dist/", companion);
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("src/cli.ts", companion))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: fileURLToPath(new URL("companion.mjs", dist)),
  external: ["node:*"],
  legalComments: "none",
});
// No `banner`: esbuild keeps the shebang that cli.ts already carries, and a second one is a syntax error (gauntlet round 3 ran the bundle).
const pkg = JSON.parse(readFileSync(new URL("package.json", companion), "utf8"));
const stage = new URL("pack/", dist);
mkdirSync(new URL("bin/", stage), { recursive: true });
mkdirSync(new URL("dist/", stage), { recursive: true });
cpSync(new URL("companion.mjs", dist), new URL("dist/companion.mjs", stage));
writeFileSync(
  new URL("bin/companion", stage),
  '#!/bin/sh\nexec node --no-warnings=ExperimentalWarning "$(dirname "$0")/../dist/companion.mjs" "$@"\n',
  { mode: 0o755 },
);
writeFileSync(
  new URL("package.json", stage),
  JSON.stringify(
    {
      name: "zoho-mail-mcp-companion",
      version: pkg.version,
      type: "module",
      bin: { companion: "bin/companion" },
      engines: { node: ">=22.18.0" },
      license: "MIT",
      files: ["bin", "dist"],
    },
    null,
    2,
  ),
);
const out = execFileSync("npm", ["pack", "--json", "--pack-destination", fileURLToPath(dist)], {
  cwd: fileURLToPath(stage),
}).toString();
const file = JSON.parse(out)[0].filename;
const publicDir = new URL("../../worker/public/", import.meta.url);
mkdirSync(publicDir, { recursive: true });
const bytes = readFileSync(new URL(file, dist));
writeFileSync(new URL("companion.tgz", publicDir), bytes);
writeFileSync(
  new URL("companion.sha256", publicDir),
  `${createHash("sha256").update(bytes).digest("hex")}  companion.tgz\n`,
);
writeFileSync(new URL("companion.version", publicDir), pkg.version + "\n");
cpSync(new URL("install.sh", companion), new URL("install.sh", publicDir));
console.log(`packed ${file} (${bytes.length} bytes) into worker/public`);
```

Add `esbuild` to the root `devDependencies` (pin the current version from `npm view esbuild version`; 0.28.1 is already resolvable as wrangler's dependency, but a direct pin keeps the bundle reproducible). `companion/install.sh` is written in Task 6.7.

In `worker/src/index.ts`, before `providerFor(...).provider.fetch`:

```ts
const path = new URL(request.url).pathname;
if (
  request.method === "GET" &&
  ["/install.sh", "/companion.tgz", "/companion.sha256", "/companion.version"].includes(path)
)
  return stamp(await env.ASSETS.fetch(request));
```

- [ ] **Step 3: Run, verify, commit** (the test needs `install.sh` from the next task; write a one-line placeholder `#!/bin/sh` now and replace it in 6.7)

```bash
npm run build:companion && cd companion && npx vitest run test/bundle.test.ts && cd .. && npm run verify
git add -A && git commit -m "build(companion): esbuild bundle, npm pack, static assets on the Worker"
```

---

### Task 6.7: `install.sh` and `configure-clients`

**Files:**

- Create: `companion/install.sh`, `companion/src/configure.ts`
- Modify: `companion/src/cli.ts` (`configure-clients`)
- Test: `companion/test/configure-clients.test.ts`, `companion/test/install-sh.test.ts`

**Interfaces:**

- Produces: `configureClaudeCode(appDir, host)` (runs `claude mcp add --scope user --transport http zoho-mail https://HOST/mcp` and `claude mcp add --scope user zoho-mail-companion -- <appDir>/bin/companion serve`, idempotent: `claude mcp get <name>` first), `configureCodex(appDir, host)` (`codex mcp add zoho-mail --url https://HOST/mcp`, `codex mcp add zoho-mail-companion -- <appDir>/bin/companion serve`; idempotent via `codex mcp get`), `mergeClaudeDesktopConfig(path, entry): { changed: boolean; backup: string | null }` (reads the file if present, parses JSON, sets `mcpServers["zoho-mail-companion"] = { command, args }`, keeps every other key, writes `<path>.bak-<timestamp>` then writes a temp file in the same directory and renames; a file that fails to parse is left untouched and reported), `printDesktopConnectorInstructions(host)`.

- [ ] **Step 1: Failing tests**

`companion/test/configure-clients.test.ts`:

```ts
import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeClaudeDesktopConfig } from "../src/configure.ts";

it("merges one entry into an existing hand-edited config, keeps other servers, writes a backup (Review Focus 5)", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcd-"));
  const file = join(dir, "claude_desktop_config.json");
  writeFileSync(
    file,
    '{\n  "mcpServers": {\n    "other": { "command": "x", "args": ["y"] }\n  },\n  "theme": "dark"\n}\n   \n',
  );
  const r = mergeClaudeDesktopConfig(file, { command: "/app/bin/companion", args: ["serve"] });
  expect(r.changed).toBe(true);
  expect(r.backup).not.toBeNull();
  const after = JSON.parse(readFileSync(file, "utf8"));
  expect(after.theme).toBe("dark");
  expect(after.mcpServers.other).toEqual({ command: "x", args: ["y"] });
  expect(after.mcpServers["zoho-mail-companion"]).toEqual({ command: "/app/bin/companion", args: ["serve"] });
  expect(readdirSync(dir).some((f) => f.startsWith("claude_desktop_config.json.bak-"))).toBe(true);
  expect(mergeClaudeDesktopConfig(file, { command: "/app/bin/companion", args: ["serve"] }).changed).toBe(false);
});
it("creates the file when absent and refuses to touch one that does not parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcd-"));
  const file = join(dir, "claude_desktop_config.json");
  expect(mergeClaudeDesktopConfig(file, { command: "c", args: [] }).changed).toBe(true);
  expect(existsSync(file)).toBe(true);
  writeFileSync(file, "{ not json");
  expect(() => mergeClaudeDesktopConfig(file, { command: "c", args: [] })).toThrow("desktop_config_unparseable");
  expect(readFileSync(file, "utf8")).toBe("{ not json");
});
```

`companion/test/install-sh.test.ts`:

```ts
import { it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sh = fileURLToPath(new URL("../install.sh", import.meta.url));
it("passes sh -n and shellcheck, downloads once, and installs the exact verified file", () => {
  expect(spawnSync("sh", ["-n", sh]).status).toBe(0);
  const sc = spawnSync("shellcheck", ["-S", "warning", sh]);
  if (sc.status !== null && sc.error === undefined) expect(sc.status, sc.stdout.toString()).toBe(0);
  const text = execFileSync("cat", [sh]).toString();
  expect(text.match(/curl .*companion\.tgz/g)?.length).toBe(1);
  expect(text).toContain('npm install --prefix "$APP" "$TMP/companion.tgz"');
  expect(text).not.toContain("npm install -g");
  expect(text).toContain("pkgutil --check-signature");
  expect(text).not.toMatch(/\u2014/);
});
```

- [ ] **Step 2: Implement** `companion/install.sh`:

```sh
#!/bin/sh
# zoho-mail-mcp companion installer for macOS. One download of each artefact, verified before use.
# Usage: curl -fsSL https://HOST/install.sh | sh        (HOST is baked in below at build time)
set -eu
HOST="mail-mcp.sarabisfinerugs.com.au"
APP="$HOME/Library/Application Support/zoho-mail-mcp"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say() { printf '%s\n' "$*"; }
fail() { say "Install stopped: $*"; exit 1; }
[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS"

need_node() {
  if command -v node >/dev/null 2>&1; then
    v="$(node -p 'process.versions.node')"
    major="${v%%.*}"; rest="${v#*.}"; minor="${rest%%.*}"
    if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; }; then return 0; fi
  fi
  say "Installing Node.js (official package from nodejs.org)."
  arch="$(uname -m)"; case "$arch" in arm64) na="arm64";; x86_64) na="x64";; *) fail "unsupported CPU $arch";; esac
  curl -fsSL "https://nodejs.org/dist/v22.18.0/node-v22.18.0.pkg" -o "$TMP/node.pkg"
  # Pinned from https://nodejs.org/dist/v22.18.0/SHASUMS256.txt on 2026-10-04, in addition to the Apple signature check.
  [ "$(shasum -a 256 "$TMP/node.pkg" | cut -d' ' -f1)" = "6dcf25409694feab54e7c634f30cc722f0a31941c81d9d9715e880cb64ef5c35" ] || fail "Node package checksum did not match the pinned value"
  pkgutil --check-signature "$TMP/node.pkg" | grep -q "Node.js Foundation" || fail "Node package signature did not name the Node.js Foundation"
  sudo installer -pkg "$TMP/node.pkg" -target / >/dev/null
  command -v node >/dev/null 2>&1 || fail "Node did not install"
  : "$na"
}
need_node

say "Downloading the companion from https://$HOST"
curl -fsSL "https://$HOST/companion.tgz" -o "$TMP/companion.tgz"
curl -fsSL "https://$HOST/companion.sha256" -o "$TMP/companion.sha256"
expected="$(cut -d' ' -f1 "$TMP/companion.sha256")"
actual="$(shasum -a 256 "$TMP/companion.tgz" | cut -d' ' -f1)"
[ "$expected" = "$actual" ] || fail "companion download did not match its published checksum"

mkdir -p "$APP" "$HOME/Downloads/Mail/To Send"
chmod 700 "$APP"
say "Installing into $APP"
npm install --prefix "$APP" "$TMP/companion.tgz" --no-audit --no-fund --loglevel=error >/dev/null
BIN="$APP/node_modules/.bin/companion"
mkdir -p "$APP/bin"; ln -sf "$BIN" "$APP/bin/companion"

if [ ! -f "$HOME/.config/zoho-mail-mcp/config.json" ]; then
  CLIENT_ID="$(curl -fsSL "https://$HOST/companion.version" >/dev/null && curl -fsSL "https://$HOST/companion-client-id" || true)"
  [ -n "$CLIENT_ID" ] || fail "the server did not publish a companion client id yet; the owner registers it on the Accounts page first"
  "$APP/bin/companion" init --server "https://$HOST" --client-id "$CLIENT_ID"
  say "Opening your browser to approve the companion; sign in with Zoho if asked."
  "$APP/bin/companion" login
fi
"$APP/bin/companion" install-agent
"$APP/bin/companion" configure-clients --host "$HOST"
say "Done. Open Claude or Codex and ask for your inbox."
say "For Claude Desktop and claude.ai, add this connector once in Settings, Connectors: https://$HOST/mcp"
say "Codex: run   codex mcp login zoho-mail   the first time."
```

The Worker serves `/companion-client-id` (public, the companion's OAuth client id is not a secret; it is a public client with PKCE) from the `settings` row written by `registerCompanionClient` (`auth/companion.ts`); add that route in `web/router` with no session: `GET /companion-client-id` answers `text/plain` or 404 while unregistered.

`configure.ts`: `mergeClaudeDesktopConfig` as specified; `configureClaudeCode` and `configureCodex` through `execFileSync` with argv arrays, swallowing "already exists" exit codes after a `get`. `configure-clients --host HOST` runs all three and prints what it did, one line each, then the connector URL.

- [ ] **Step 3: Run, verify, commit**

```bash
npm run build:companion && cd companion && npx vitest run && cd .. && npm run verify
git add -A && git commit -m "feat(installer): one-line install.sh and client configuration"
```

---

### Task 6.8: Companion runbook and settings page copy

**Files:**

- Replace: `docs/runbooks/companion.md`
- Modify: `worker/src/web/pages/accounts.ts` (section "Set up my Mac": the install line, the Desktop connector paste, the companion version from `/companion.version`, the stated weakening from D15)

- [ ] **Step 1: Write the runbook** covering: what the install line does step by step, the roots and the outbox rule, `publication_unknown` guidance (unchanged), the D15 note (`verify-after-publish re-checks the parent; a rename race between the two checks is refused rather than detected atomically`), `debt`, logout, updating by re-running the line, and uninstall (`launchctl bootout`, delete the app dir, `claude mcp remove`, `codex mcp remove`, remove the Desktop entry).

- [ ] **Step 2: Em dash and verify, commit**

```bash
LC_ALL=C grep -c $'\xe2\x80\x94' docs/runbooks/companion.md companion/install.sh worker/src/web/pages/accounts.ts   # expected: 0 each
npm run verify && git add -A && git commit -m "docs: companion runbook and setup page copy"
```

## M6 exit checklist

- [ ] No Swift, no `codesign`, no `notarytool` anywhere in the repository.
- [ ] `companion/test` suite green including the Node native port, dispatch, launchd plist lint, bundle and sha256, config merge (Review Focus 5), install.sh static checks.
- [ ] `worker/public` holds `install.sh`, `companion.tgz`, `companion.sha256`, `companion.version` after `npm run build:companion`.
- [ ] `LC_ALL=C grep -rn $'\xe2\x80\x94' companion worker/public docs/runbooks/companion.md | wc -l` is 0.

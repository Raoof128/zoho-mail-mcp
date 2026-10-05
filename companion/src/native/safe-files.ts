import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, sep } from "node:path";
import { NativeRefusal, type RootGrant } from "./config.ts";

export type FileResult = { path: string; size: number; sha256: string; device: number; inode: number };
export type TemporaryPresence = "present" | "absent" | "unknown";
export type SaveHooks = {
  temporary?: string;
  afterCreate?: (file: FileResult) => void;
  beforePublish?: (file: FileResult) => void;
};
const refuse = (code: string): never => {
  throw new NativeRefusal(code);
};
const TEMPORARY = /^\.zoho-mail-mcp-[A-Fa-f0-9-]{36}$/;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = constants;

/**
 * The filesystem a root lives on, from /sbin/mount: Node's statfs gives a numeric type and no
 * MNT_LOCAL flag. A mount line is "<source> on <mount point> (<type>, <options>)" and the source and
 * mount point are user-controlled (a share or volume name can contain " on " or "(apfs, local)"),
 * so the text is never trusted to say where a mount is. Each " on " split is a candidate, and a
 * line counts only when a candidate path has the root's own device id. The options are the final
 * parenthesis, which the kernel writes. Every matching line must agree.
 */
export function mountedVolume(
  table: string,
  dev: bigint,
  devOf: (path: string) => bigint | undefined,
): { type: string; local: boolean } {
  const found: { type: string; local: boolean }[] = [];
  for (const line of table.split("\n")) {
    const options = /^(.*) \(([^,()]+)((?:, [^,()]+)*)\)$/.exec(line);
    if (!options) continue;
    const head = options[1]!;
    let at = head.indexOf(" on ");
    while (at >= 0) {
      if (devOf(head.slice(at + 4)) === dev) {
        found.push({ type: options[2]!, local: (options[3] ?? "").split(", ").includes("local") });
        break;
      }
      at = head.indexOf(" on ", at + 1);
    }
  }
  if (!found.length) return refuse("unsupported_volume");
  return found.every((v) => v.type === found[0]!.type && v.local === found[0]!.local)
    ? found[0]!
    : { type: "ambiguous", local: false };
}
function localVolumeType(dev: bigint): { type: string; local: boolean } {
  let table: string;
  try {
    table = execFileSync("/sbin/mount", [], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
  } catch {
    return refuse("unsupported_volume");
  }
  return mountedVolume(table, dev, (path) => {
    try {
      return lstatSync(path, { bigint: true }).dev;
    } catch {
      return undefined;
    }
  });
}
const sameTime = (a: BigIntStats, b: BigIntStats) => a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function syncDirectory(path: string, code: string): void {
  let fd: number;
  try {
    fd = openSync(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch {
    return refuse(code);
  }
  try {
    fsyncSync(fd); // libuv issues F_FULLFSYNC on macOS
  } catch {
    refuse(code);
  } finally {
    closeSync(fd);
  }
}
function readBounded(fd: number, limit: number): Buffer {
  const out = Buffer.alloc(limit);
  let n = 0;
  while (n < limit) {
    const got = readSync(fd, out, n, limit - n, null);
    if (got === 0) break;
    n += got;
  }
  return out.subarray(0, n);
}
function ancestry(path: string): Set<string> {
  const out = new Set<string>();
  let value = path;
  for (;;) {
    let st;
    try {
      st = lstatSync(value, { bigint: true });
    } catch {
      return refuse("ancestry");
    }
    out.add(`${st.dev}:${st.ino}`);
    if (value === "/") return out;
    value = dirname(value);
  }
}
function physical(path: string, code: string): string {
  try {
    return realpathSync(path);
  } catch {
    return refuse(code);
  }
}
function directoryStat(path: string, code: string): BigIntStats {
  let fd: number;
  try {
    fd = openSync(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch {
    return refuse(code);
  }
  try {
    return fstatSync(fd, { bigint: true });
  } finally {
    closeSync(fd);
  }
}
const components = (p: string) => p.split(sep).filter(Boolean);
const startsWith = (a: string[], b: string[]) => b.length <= a.length && b.every((v, i) => a[i] === v);

class Root {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  constructor(readonly grant: RootGrant) {
    this.path = physical(grant.path, "root_open");
    const st = directoryStat(this.path, "root_open");
    if (Number(st.uid) !== process.getuid!() || (Number(st.mode) & 0o022) !== 0) refuse("unsupported_root");
    this.dev = st.dev;
    this.ino = st.ino;
    const volume = localVolumeType(this.dev);
    if (!volume.local) refuse("unsupported_root");
    if (volume.type !== "apfs" && volume.type !== "hfs") refuse("unsupported_volume");
  }
  check(): void {
    let st;
    try {
      st = lstatSync(this.path, { bigint: true });
    } catch {
      return refuse("root_changed");
    }
    if (st.dev !== this.dev || st.ino !== this.ino || !st.isDirectory()) refuse("root_changed");
  }
  /**
   * Node has no openat(O_RESOLVE_BENEATH | O_NOFOLLOW_ANY). Every ancestor beneath the root is
   * lstat'd and must be a real directory, the leaf is opened with O_NOFOLLOW, and the parent's
   * physical path is compared after the open. Spec D15: a rename race between those checks is
   * refused when seen, not prevented atomically.
   */
  open(relative: string, flags: number, mode: number, code: string): { fd: number; errno?: string } {
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++) {
      let st;
      try {
        st = lstatSync(join(this.path, ...parts.slice(0, i)));
      } catch (e) {
        return { fd: -1, errno: (e as NodeJS.ErrnoException).code ?? "EIO" };
      }
      if (!st.isDirectory()) return { fd: -1, errno: "ELOOP" };
    }
    const full = join(this.path, relative);
    let fd: number;
    try {
      fd = openSync(full, flags | O_NOFOLLOW, mode);
    } catch (e) {
      return { fd: -1, errno: (e as NodeJS.ErrnoException).code ?? "EIO" };
    }
    if (!this.beneath(relative)) {
      closeSync(fd);
      refuse(code);
    }
    return { fd };
  }
  beneath(relative: string): boolean {
    const parent = dirname(join(this.path, relative));
    try {
      return realpathSync(parent) === parent;
    } catch {
      return false;
    }
  }
}

/** Port of SafeFiles.swift on Node primitives; the weakenings against openat/renameatx_np are stated in spec D15. */
export class SafeFiles {
  static readonly maximum = 25 * 1024 * 1024;
  private readonly roots = new Map<string, Root>();
  private readonly privatePath: string;
  constructor(roots: Record<string, RootGrant>, privateDir: string) {
    this.privatePath = physical(privateDir, "private_stat");
    const privateAncestors = ancestry(this.privatePath);
    let privateStat;
    try {
      privateStat = lstatSync(this.privatePath, { bigint: true });
    } catch {
      return refuse("private_stat");
    }
    for (const [id, grant] of Object.entries(roots)) {
      const root = new Root(grant);
      if (
        privateAncestors.has(`${root.dev}:${root.ino}`) ||
        ancestry(root.path).has(`${privateStat.dev}:${privateStat.ino}`)
      )
        refuse("private_overlap");
      const a = components(root.path),
        b = components(this.privatePath);
      if (startsWith(a, b) || startsWith(b, a)) refuse("private_overlap");
      for (const old of this.roots.values()) {
        const c = components(old.path);
        if (startsWith(a, c) || startsWith(c, a) || (root.dev === old.dev && root.ino === old.ino))
          refuse("root_overlap");
      }
      this.roots.set(id, root);
    }
  }
  static digest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }
  validated(path: string): string {
    const parts = path.split("/");
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      Buffer.byteLength(path) > 1024 ||
      parts.length > 16 ||
      path !== path.normalize("NFC") ||
      !parts.every(
        (p) => p !== "" && p !== "." && p !== ".." && !p.startsWith(".zoho-mail-mcp-") && Buffer.byteLength(p) <= 255,
      ) ||
      /[\p{Cc}\p{Cf}]/u.test(path)
    )
      refuse("invalid_path");
    return path;
  }
  private root(id: string, write: boolean): Root {
    const r = this.roots.get(id);
    if (!r || !(write ? r.grant.write : r.grant.read)) refuse("root_permission");
    r!.check();
    return r!;
  }
  snapshot(rootId: string, relative: string, snapshotId: string): FileResult {
    const r = this.root(rootId, false);
    const path = this.validated(relative);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(snapshotId)) refuse("snapshot_id");
    const source = r.open(path, O_RDONLY | O_NONBLOCK, 0, "source_open");
    if (source.fd < 0) refuse("source_open");
    const fd = source.fd;
    try {
      const st = fstatSync(fd, { bigint: true });
      if (!st.isFile() || st.nlink !== 1n || st.dev !== r.dev || st.size < 0n || st.size > BigInt(SafeFiles.maximum))
        refuse("source_type_or_size");
      const data = readBounded(fd, SafeFiles.maximum + 1);
      if (BigInt(data.length) !== st.size) refuse("source_changed");
      const after = fstatSync(fd, { bigint: true });
      if (after.size !== st.size || after.mtimeNs !== st.mtimeNs) refuse("source_changed");
      const target = join(this.privatePath, snapshotId);
      let dest: number;
      try {
        dest = openSync(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      } catch {
        return refuse("snapshot_create");
      }
      let keep = false;
      try {
        if (data.length) writeSync(dest, data);
        fsyncSync(dest);
        const saved = fstatSync(dest, { bigint: true });
        syncDirectory(this.privatePath, "snapshot_directory_sync");
        keep = true;
        return {
          path: target,
          size: data.length,
          sha256: SafeFiles.digest(data),
          device: Number(saved.dev),
          inode: Number(saved.ino),
        };
      } catch (e) {
        if (e instanceof NativeRefusal) throw e;
        return refuse("snapshot_sync");
      } finally {
        closeSync(dest);
        if (!keep)
          try {
            unlinkSync(target);
          } catch {
            /* the snapshot directory is cleaned at startup */
          }
      }
    } finally {
      closeSync(fd);
    }
  }
  save(rootId: string, relative: string, bytes: Uint8Array, sha256: string, hooks: SaveHooks): FileResult {
    if (bytes.length > SafeFiles.maximum || SafeFiles.digest(bytes) !== sha256) refuse("digest_or_size");
    const r = this.root(rootId, true);
    const path = this.validated(relative);
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const temp = hooks.temporary ?? (parent ? parent + "/" : "") + ".zoho-mail-mcp-" + randomUUID();
    const tempParent = temp.includes("/") ? temp.slice(0, temp.lastIndexOf("/")) : "";
    if (tempParent !== parent || !TEMPORARY.test(temp.slice(temp.lastIndexOf("/") + 1))) refuse("temporary_path");
    const created = r.open(temp, O_WRONLY | O_CREAT | O_EXCL, 0o600, "temporary_create");
    if (created.fd < 0) refuse("temporary_create");
    const fd = created.fd;
    // Failed temporaries are retained for journal recovery: the path may now name a replacement inode.
    let expected: FileResult;
    try {
      const made = fstatSync(fd, { bigint: true });
      hooks.afterCreate?.({
        path: temp,
        size: bytes.length,
        sha256,
        device: Number(made.dev),
        inode: Number(made.ino),
      });
      try {
        if (bytes.length) writeSync(fd, bytes);
        fsyncSync(fd);
      } catch {
        refuse("file_sync");
      }
      const st = fstatSync(fd, { bigint: true });
      expected = { path, size: bytes.length, sha256, device: Number(st.dev), inode: Number(st.ino) };
      hooks.beforePublish?.(expected);
    } finally {
      closeSync(fd);
    }
    // Journal callbacks may yield to another process: revalidate the named temporary first.
    this.verifyFile(r, temp, expected);
    r.check();
    const full = join(r.path, path);
    if (!r.beneath(path)) refuse("publish");
    // link() fails with EEXIST when the destination exists: the no-overwrite guarantee rename lacks.
    try {
      linkSync(join(r.path, temp), full);
    } catch {
      refuse("publish");
    }
    try {
      unlinkSync(join(r.path, temp));
    } catch {
      refuse("publication_unknown");
    }
    syncDirectory(dirname(full), "directory_sync");
    // A replacement racing the publish must never produce an acknowledgable receipt.
    this.verify(rootId, path, expected);
    return expected;
  }
  private verifyFile(r: Root, path: string, expected: FileResult): void {
    const opened = r.open(path, O_RDONLY | O_NONBLOCK, 0, "publication_unknown");
    if (opened.fd < 0) refuse("publication_unknown");
    const fd = opened.fd;
    try {
      const before = fstatSync(fd, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        Number(before.dev) !== expected.device ||
        Number(before.ino) !== expected.inode ||
        Number(before.size) !== expected.size
      )
        refuse("publication_unknown");
      const bytes = readBounded(fd, SafeFiles.maximum + 1);
      const after = fstatSync(fd, { bigint: true });
      if (
        bytes.length !== expected.size ||
        SafeFiles.digest(bytes) !== expected.sha256 ||
        after.size !== before.size ||
        after.nlink !== 1n ||
        !sameTime(after, before)
      )
        refuse("publication_unknown");
    } finally {
      closeSync(fd);
    }
  }
  verify(rootId: string, relative: string, expected: FileResult): void {
    const r = this.root(rootId, true);
    const path = this.validated(relative);
    this.verifyFile(r, path, expected);
    r.check();
    if (!r.beneath(path)) refuse("publication_unknown");
    syncDirectory(dirname(join(r.path, path)), "publication_unknown");
  }
  /** Only ENOENT establishes absence; every other failure is unknown, never a guess that frees a charge. */
  temporaryPresence(rootId: string, path: string): TemporaryPresence {
    let r: Root;
    try {
      r = this.root(rootId, true);
    } catch {
      return "unknown";
    }
    const leaf = path.slice(path.lastIndexOf("/") + 1);
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!TEMPORARY.test(leaf)) return "unknown";
    if (parent) {
      try {
        this.validated(parent);
      } catch {
        return "unknown";
      }
    }
    let opened;
    try {
      opened = r.open(path, O_RDONLY | O_NONBLOCK, 0, "temporary_unknown");
    } catch {
      return "unknown";
    }
    if (opened.fd < 0) return opened.errno === "ENOENT" ? "absent" : "unknown";
    closeSync(opened.fd);
    return "present";
  }
  discardTemporary(rootId: string, path: string, expected: FileResult | null | undefined): boolean {
    const r = this.root(rootId, true);
    const leaf = path.slice(path.lastIndexOf("/") + 1);
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!TEMPORARY.test(leaf)) refuse("temporary_path");
    if (parent) this.validated(parent);
    const opened = r.open(path, O_RDONLY | O_NONBLOCK, 0, "publication_unknown");
    if (opened.fd < 0) {
      if (opened.errno === "ENOENT") return false;
      refuse("publication_unknown");
    }
    try {
      const st = fstatSync(opened.fd, { bigint: true });
      if (
        !expected ||
        Number(st.dev) !== expected.device ||
        Number(st.ino) !== expected.inode ||
        !st.isFile() ||
        st.nlink !== 1n
      )
        refuse("publication_unknown");
    } finally {
      closeSync(opened.fd);
    }
    if (!r.beneath(path)) refuse("temporary_cleanup");
    try {
      unlinkSync(join(r.path, path));
    } catch {
      refuse("temporary_cleanup");
    }
    syncDirectory(dirname(join(r.path, path)), "temporary_cleanup");
    return true;
  }
}

import {
  constants,
  closeSync,
  fstatSync,
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
    // fstat on the descriptor we read from, not the path, so a swap between the two cannot pass.
    const st = fstatSync(fd);
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

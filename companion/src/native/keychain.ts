import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { NativeRefusal } from "./config.ts";
import type { Journal } from "./journal.ts";

const refuse = (code: string): never => {
  throw new NativeRefusal(code);
};
export interface CredentialStore {
  read(account: string): Buffer | null;
  write(account: string, data: Buffer): void;
  delete(account: string): void;
}
export const KEYCHAIN_SERVICE = "au.com.sarabisfinerugs.mail-mcp.companion.oauth.v1";
const SECURITY = "/usr/bin/security";
const NOT_FOUND = 44;
const plain = /^[A-Za-z0-9._-]{1,128}$/;
/**
 * `security -i` truncates an input line at about 4 KB without failing (measured on macOS 27: values
 * over ~3,940 base64 characters came back cut at 4,016). 2,048 raw bytes encode to 2,732 characters,
 * leaving room for the command, account and service. A bound credential is about 600 bytes.
 */
export const KEYCHAIN_MAX_BYTES = 2048;

/**
 * macOS Keychain through the built-in `security` command (no compiled helper). Writes go through
 * `security -i` on stdin, so the credential never appears in a process's argument list. Values are
 * stored as base64 and read back after every write: interactive mode exits 0 even when a command fails.
 */
export class KeychainCredentials implements CredentialStore {
  private readonly service: string;
  constructor(service = KEYCHAIN_SERVICE) {
    if (!plain.test(service)) refuse("keychain_write");
    this.service = service;
  }
  read(account: string): Buffer | null {
    if (!plain.test(account)) refuse("keychain_read");
    const r = spawnSync(SECURITY, ["find-generic-password", "-a", account, "-s", this.service, "-w"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
      timeout: 30_000,
    });
    if (r.status === NOT_FOUND) return null;
    const value = (r.stdout ?? "").trim();
    if (r.status !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) refuse("keychain_read");
    return Buffer.from(value, "base64");
  }
  write(account: string, data: Buffer): void {
    if (data.length > KEYCHAIN_MAX_BYTES) refuse("credential_size");
    if (!plain.test(account)) refuse("keychain_write");
    const encoded = data.toString("base64");
    try {
      execFileSync(SECURITY, ["-i"], {
        input: `add-generic-password -a ${account} -s ${this.service} -w ${encoded} -U\n`,
        stdio: ["pipe", "ignore", "ignore"],
        env: { PATH: "/usr/bin:/bin" },
        timeout: 30_000,
      });
    } catch {
      refuse("keychain_write");
    }
    const back = this.read(account);
    if (!back || !back.equals(data)) refuse("keychain_write");
  }
  delete(account: string): void {
    if (!plain.test(account)) refuse("keychain_delete");
    const r = spawnSync(SECURITY, ["delete-generic-password", "-a", account, "-s", this.service], {
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin" },
      timeout: 30_000,
    });
    if (r.status !== 0 && r.status !== NOT_FOUND) refuse("keychain_delete");
  }
}
/** A credential store over a Map, for tests and for callers that pass one. */
export function mapCredentials(map: Map<string, Buffer>): CredentialStore {
  return {
    read: (account) => map.get(account) ?? null,
    write: (account, data) => {
      if (data.length > KEYCHAIN_MAX_BYTES) refuse("credential_size");
      map.set(account, Buffer.from(data));
    },
    delete: (account) => {
      map.delete(account);
    },
  };
}

/** Port of AuthState (Auth.swift). The caller holds the process lock, including across an HTTP refresh. */
export class AuthState {
  private readonly journal: Journal;
  private readonly store: CredentialStore;
  constructor(journal: Journal, store: CredentialStore) {
    this.journal = journal;
    this.store = store;
  }
  epoch(account: string): string {
    const old = this.journal.get("auth_epoch", account);
    if (old) return old.payload;
    const value = randomUUID();
    this.journal.put("auth_epoch", account, account, value);
    return value;
  }
  read(account: string): Buffer | null {
    const raw = this.store.read(account);
    if (!raw) return null;
    let bound: { epoch?: unknown; data?: unknown };
    try {
      bound = JSON.parse(raw.toString("utf8")) as { epoch?: unknown; data?: unknown };
    } catch {
      return refuse("keychain_read");
    }
    if (typeof bound.epoch !== "string" || typeof bound.data !== "string") refuse("keychain_read");
    if (bound.epoch !== this.epoch(account)) return null;
    return Buffer.from(bound.data as string, "base64");
  }
  commit(account: string, expected: string, data: Buffer): void {
    if (this.epoch(account) !== expected) refuse("auth_epoch_changed");
    this.store.write(account, Buffer.from(JSON.stringify({ epoch: expected, data: data.toString("base64") })));
  }
  logout(account: string): void {
    // Persist the fence first; a failed credential deletion cannot permit an older login.
    this.journal.put("auth_epoch", account, account, randomUUID());
    this.store.delete(account);
  }
}

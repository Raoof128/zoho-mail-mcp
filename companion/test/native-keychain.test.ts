import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Journal } from "../src/native/journal.ts";
import { AuthState, KEYCHAIN_MAX_BYTES, KeychainCredentials, mapCredentials } from "../src/native/keychain.ts";

const journal = () => new Journal(join(mkdtempSync(join(tmpdir(), "zmk-")), "journal.sqlite"));

it("binds credentials to an epoch: a commit under a stale epoch is refused and logout fences older logins", () => {
  const auth = new AuthState(journal(), mapCredentials(new Map()));
  const epoch = auth.epoch("acct");
  expect(auth.epoch("acct")).toBe(epoch);
  expect(auth.read("acct")).toBeNull();
  auth.commit("acct", epoch, Buffer.from("token"));
  expect(auth.read("acct")!.toString()).toBe("token");
  auth.logout("acct");
  expect(auth.read("acct")).toBeNull();
  expect(() => auth.commit("acct", epoch, Buffer.from("old"))).toThrow("auth_epoch_changed");
});

it.runIf(process.platform === "darwin" && process.env.ZMC_KEYCHAIN_TESTS === "1")(
  "writes, reads back and deletes a generic password through security without the secret in argv",
  () => {
    const store = new KeychainCredentials("au.com.sarabisfinerugs.mail-mcp.companion.oauth.v1.test");
    const account = "zmc-test-" + randomBytes(8).toString("hex");
    const data = randomBytes(KEYCHAIN_MAX_BYTES);
    try {
      expect(store.read(account)).toBeNull();
      store.write(account, data);
      expect(store.read(account)).toEqual(data);
      store.write(account, Buffer.from("second"));
      expect(store.read(account)!.toString()).toBe("second");
      store.delete(account);
      expect(store.read(account)).toBeNull();
      store.delete(account);
    } finally {
      store.delete(account);
    }
    expect(() => store.write(account, Buffer.alloc(KEYCHAIN_MAX_BYTES + 1))).toThrow("credential_size");
  },
);

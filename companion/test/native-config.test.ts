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

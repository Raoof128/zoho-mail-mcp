import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync, readdirSync } from "node:fs";
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
it("refuses a symlinked directory between the root and the file, for reading and for saving (D15 beneath check)", () => {
  const { base, docs, out, files } = world();
  const outside = join(base, "outside");
  mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(outside, "secret.txt"), "s");
  symlinkSync(outside, join(docs, "via"));
  symlinkSync(outside, join(out, "via"));
  expect(() => files.snapshot("documents", "via/secret.txt", "tr_" + "v".repeat(43))).toThrow("source_open");
  const bytes = Buffer.from("x");
  expect(() => files.save("attachments", "via/x.txt", bytes, SafeFiles.digest(bytes), {})).toThrow("temporary_create");
  expect(readdirSync(outside)).toEqual(["secret.txt"]);
});
it("verifies a saved file by identity and digest, and discards only the temporary recorded at creation", () => {
  const { out, files } = world();
  const bytes = Buffer.from("payload");
  const sha = SafeFiles.digest(bytes);
  const r = files.save("attachments", "p.txt", bytes, sha, {});
  files.verify("attachments", "p.txt", r);
  writeFileSync(join(out, "p.txt"), "changed");
  expect(() => files.verify("attachments", "p.txt", r)).toThrow("publication_unknown");
  let created: { device: number; inode: number } | undefined;
  const temporary = ".zoho-mail-mcp-" + "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12);
  expect(() =>
    files.save("attachments", "p.txt", bytes, sha, {
      temporary,
      afterCreate: (f) => {
        created = f;
      },
    }),
  ).toThrow("publish");
  expect(files.temporaryPresence("attachments", temporary)).toBe("present");
  expect(() =>
    files.discardTemporary("attachments", temporary, { ...r, device: created!.device, inode: created!.inode + 1 }),
  ).toThrow("publication_unknown");
  expect(
    files.discardTemporary("attachments", temporary, { ...r, device: created!.device, inode: created!.inode }),
  ).toBe(true);
  expect(files.temporaryPresence("attachments", temporary)).toBe("absent");
  expect(files.discardTemporary("attachments", temporary, null)).toBe(false);
});

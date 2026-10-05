import { it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("bundles the companion into one file, packs it, and writes a matching sha256", { timeout: 120_000 }, () => {
  execFileSync("node", ["companion/scripts/bundle.mjs"], { cwd: new URL("../..", import.meta.url), stdio: "pipe" });
  const root = new URL("../../worker/public/", import.meta.url);
  const tgz = readFileSync(new URL("companion.tgz", root));
  const sha = readFileSync(new URL("companion.sha256", root), "utf8").split(/\s+/)[0];
  expect(createHash("sha256").update(tgz).digest("hex")).toBe(sha);
  expect(readFileSync(new URL("companion.version", root), "utf8")).toMatch(/^\d+\.\d+\.\d+\n$/);
  expect(existsSync(new URL("install.sh", root))).toBe(true);
  const listing = execFileSync("tar", ["-tzf", new URL("companion.tgz", root).pathname]).toString();
  expect(listing).toContain("package/dist/companion.mjs");
  expect(listing).toContain("package/bin/companion");
  expect(listing).not.toContain("node_modules/");
  // The bundle must run: a duplicate shebang or an unresolved workspace import fails here, not on the client's Mac.
  const out = mkdtempSync(join(tmpdir(), "zmb-"));
  execFileSync("tar", ["-xzf", new URL("companion.tgz", root).pathname, "-C", out]);
  const direct = spawnSync("node", [join(out, "package", "dist", "companion.mjs"), "nope"], { encoding: "utf8" });
  expect(direct.stdout + direct.stderr).toContain("Usage");
  // npm links bin/companion into node_modules/.bin and the installer links that again: run it through a symlink.
  const link = join(out, "companion-link");
  symlinkSync(join(out, "package", "bin", "companion"), link);
  const linked = spawnSync(link, ["nope"], { encoding: "utf8" });
  expect(linked.stdout + linked.stderr).toContain("Usage");
  expect(linked.stderr).not.toContain("ExperimentalWarning");
});

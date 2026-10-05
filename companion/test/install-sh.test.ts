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
  // Pinned to the current LTS from nodejs.org SHASUMS256 and the Apple signature's exact signer.
  expect(text).toContain(`NODE_VERSION="24.21.0"`);
  expect(text).toContain("9831a74b04c270a429bd5a240e37712c4fe229b02b032e18ff2e0702c17c20fd");
  expect(text).toContain("Developer ID Installer: Node.js Foundation (HX7739G8FX)");
  // bin/companion is a written wrapper with an absolute node, never a symlink chain (Claude Desktop has a minimal PATH).
  expect(text).not.toContain("ln -s");
  // A login that failed on the first run is retried on the next run, not skipped with the init (final review I1).
  const initBlock = text.slice(text.indexOf("if [ ! -f"), text.indexOf("\nfi\n", text.indexOf("if [ ! -f")));
  expect(initBlock).not.toContain("login");
  expect(text).toMatch(/if [^\n]*! "\$COMPANION" status[^\n]*; then\n[^\n]*\n\s*"\$COMPANION" login\n/);
  // G20 seam: a scratch HOME has no default Keychain, so the gate skips only the interactive sign-in.
  expect(text).toContain('[ "${ZMC_SKIP_LOGIN:-}" != 1 ]');
  expect(text).toContain(
    `printf '#!/bin/sh\\nexec "%s" --no-warnings=ExperimentalWarning "%s" "$@"\\n' "$NODE" "$ENTRY"`,
  );
});

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
// A JS entry, not a sh shim: npm links bin/companion into node_modules/.bin and the installer links
// that again, and node resolves this import from the real file, where "$(dirname "$0")" would not.
// The installer's own wrapper passes an absolute node; this shebang serves direct runs.
writeFileSync(
  new URL("bin/companion", stage),
  '#!/usr/bin/env -S node --no-warnings=ExperimentalWarning\nimport "../dist/companion.mjs";\n',
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

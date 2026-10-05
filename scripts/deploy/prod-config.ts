#!/usr/bin/env node
// Usage: node scripts/deploy/prod-config.ts <d1-uuid> <kv-id> <build-id>
// Writes worker/wrangler.prod.jsonc (gitignored: it names the client's real resources).
import { readFileSync, writeFileSync } from "node:fs";
import { prodConfig } from "./lib.ts";

const [dbId = "", kvId = "", buildId = ""] = process.argv.slice(2);
const worker = new URL("../../worker/", import.meta.url);
const config = prodConfig(readFileSync(new URL("wrangler.jsonc", worker), "utf8"), { dbId, kvId, buildId });
writeFileSync(new URL("wrangler.prod.jsonc", worker), JSON.stringify(config, null, 2) + "\n");
process.stdout.write("wrote worker/wrangler.prod.jsonc\n");

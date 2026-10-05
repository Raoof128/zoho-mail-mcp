#!/usr/bin/env node
// Prints one .env value for a shell variable assignment, e.g. TOKEN="$(node env-get.ts ZOHO_MCP_CF_TOKEN)".
import { readEnvFile } from "./env-file.ts";

const key = process.argv[2] ?? "";
const value = readEnvFile()[key];
if (!value) throw new Error(`missing ${key} in .env`);
process.stdout.write(value);

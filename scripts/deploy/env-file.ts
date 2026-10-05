// Reads the Haji .env (mode 600 required) for the deploy CLIs. Never prints a value.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "./lib.ts";

export const ENV_FILE = process.env.ENV_FILE ?? join(homedir(), "Desktop", "Job_Projects", "Haji", ".env");
export function readEnvFile(): Record<string, string> {
  if ((statSync(ENV_FILE).mode & 0o077) !== 0) throw new Error(`${ENV_FILE} must be mode 600`);
  return parseEnv(readFileSync(ENV_FILE, "utf8"));
}

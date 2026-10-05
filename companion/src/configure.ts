import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export type Runner = (command: string, args: string[]) => { status: number | null; missing: boolean };
export type ServerEntry = { command: string; args: string[] };
export const REMOTE_NAME = "zoho-mail";
export const COMPANION_NAME = "zoho-mail-companion";

/** argv only, never a shell string. A CLI that is not installed is reported, not fatal. */
export const runCommand: Runner = (command, args) => {
  const r = spawnSync(command, args, { stdio: "ignore", timeout: 60_000 });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return { status: r.status, missing };
};
const companion = (appDir: string) => join(appDir, "bin", "companion");

export function configureClaudeCode(appDir: string, host: string, run: Runner = runCommand): string[] {
  const wanted: [string, string[]][] = [
    [REMOTE_NAME, ["--transport", "http", REMOTE_NAME, `https://${host}/mcp`]],
    [COMPANION_NAME, [COMPANION_NAME, "--", companion(appDir), "serve"]],
  ];
  const lines: string[] = [];
  for (const [name, add] of wanted) {
    const got = run("claude", ["mcp", "get", name]);
    if (got.missing) return ["Claude Code: not installed, skipped."];
    if (got.status === 0) {
      lines.push(`Claude Code: ${name} already set up.`);
      continue;
    }
    const r = run("claude", ["mcp", "add", "--scope", "user", ...add]);
    lines.push(r.status === 0 ? `Claude Code: added ${name}.` : `Claude Code: could not add ${name}.`);
  }
  return lines;
}

export function configureCodex(appDir: string, host: string, run: Runner = runCommand): string[] {
  const wanted: [string, string[]][] = [
    [REMOTE_NAME, [REMOTE_NAME, "--url", `https://${host}/mcp`]],
    [COMPANION_NAME, [COMPANION_NAME, "--", companion(appDir), "serve"]],
  ];
  const lines: string[] = [];
  for (const [name, add] of wanted) {
    const got = run("codex", ["mcp", "get", name]);
    if (got.missing) return ["Codex: not installed, skipped."];
    if (got.status === 0) {
      lines.push(`Codex: ${name} already set up.`);
      continue;
    }
    const r = run("codex", ["mcp", "add", ...add]);
    lines.push(r.status === 0 ? `Codex: added ${name}.` : `Codex: could not add ${name}.`);
  }
  return lines;
}

const sameEntry = (a: unknown, b: ServerEntry) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Adds the companion to Claude Desktop's config without disturbing anything else in it. A file that
 * does not parse is left exactly as it is and reported; a change writes a timestamped backup first,
 * then a temporary file in the same directory, renamed into place.
 */
export function mergeClaudeDesktopConfig(
  path: string,
  entry: ServerEntry,
): { changed: boolean; backup: string | null } {
  let config: Record<string, unknown> = {};
  let original: string | null = null;
  if (existsSync(path)) {
    original = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(original);
    } catch {
      throw new Error("desktop_config_unparseable");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("desktop_config_unparseable");
    config = parsed as Record<string, unknown>;
  }
  const servers = config.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers)))
    throw new Error("desktop_config_unparseable");
  const current = (servers ?? {}) as Record<string, unknown>;
  if (sameEntry(current[COMPANION_NAME], entry)) return { changed: false, backup: null };
  const next = { ...config, mcpServers: { ...current, [COMPANION_NAME]: entry } };
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (original !== null) {
    backup = `${path}.bak-${new Date().toISOString().replace(/[-:.]/g, "")}`;
    copyFileSync(path, backup);
  }
  const temp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
  return { changed: true, backup };
}

export function desktopConnectorInstructions(host: string): string {
  return [
    "Claude Desktop and claude.ai: add the mail connector once.",
    "  Open Settings, then Connectors, then Add custom connector, and paste:",
    `  https://${host}/mcp`,
  ].join("\n");
}

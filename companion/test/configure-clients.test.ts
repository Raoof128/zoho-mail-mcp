import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeClaudeDesktopConfig, configureClaudeCode, configureCodex, type Runner } from "../src/configure.ts";

it("merges one entry into an existing hand-edited config, keeps other servers, writes a backup (Review Focus 5)", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcd-"));
  const file = join(dir, "claude_desktop_config.json");
  writeFileSync(
    file,
    '{\n  "mcpServers": {\n    "other": { "command": "x", "args": ["y"] }\n  },\n  "theme": "dark"\n}\n   \n',
  );
  const r = mergeClaudeDesktopConfig(file, { command: "/app/bin/companion", args: ["serve"] });
  expect(r.changed).toBe(true);
  expect(r.backup).not.toBeNull();
  const after = JSON.parse(readFileSync(file, "utf8"));
  expect(after.theme).toBe("dark");
  expect(after.mcpServers.other).toEqual({ command: "x", args: ["y"] });
  expect(after.mcpServers["zoho-mail-companion"]).toEqual({ command: "/app/bin/companion", args: ["serve"] });
  expect(readdirSync(dir).some((f) => f.startsWith("claude_desktop_config.json.bak-"))).toBe(true);
  expect(mergeClaudeDesktopConfig(file, { command: "/app/bin/companion", args: ["serve"] }).changed).toBe(false);
});
it("creates the file when absent and refuses to touch one that does not parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcd-"));
  const file = join(dir, "claude_desktop_config.json");
  expect(mergeClaudeDesktopConfig(file, { command: "c", args: [] }).changed).toBe(true);
  expect(existsSync(file)).toBe(true);
  writeFileSync(file, "{ not json");
  expect(() => mergeClaudeDesktopConfig(file, { command: "c", args: [] })).toThrow("desktop_config_unparseable");
  expect(readFileSync(file, "utf8")).toBe("{ not json");
});

function recorder(existing: Set<string>, missing = false) {
  const calls: string[][] = [];
  const run: Runner = (command, args) => {
    calls.push([command, ...args]);
    if (missing) return { status: null, missing: true };
    if (args[0] === "mcp" && args[1] === "get") return { status: existing.has(args[2]!) ? 0 : 1, missing: false };
    return { status: 0, missing: false };
  };
  return { calls, run };
}
it("registers both servers with Claude Code at user scope, and skips any already registered", () => {
  const { calls, run } = recorder(new Set(["zoho-mail"]));
  const lines = configureClaudeCode("/app", "mail-mcp.example.test", run);
  expect(calls).toEqual([
    ["claude", "mcp", "get", "zoho-mail"],
    ["claude", "mcp", "get", "zoho-mail-companion"],
    ["claude", "mcp", "add", "--scope", "user", "zoho-mail-companion", "--", "/app/bin/companion", "serve"],
  ]);
  expect(lines.join("\n")).toContain("already");
  const fresh = recorder(new Set());
  configureClaudeCode("/app", "mail-mcp.example.test", fresh.run);
  expect(fresh.calls).toContainEqual([
    "claude",
    "mcp",
    "add",
    "--scope",
    "user",
    "--transport",
    "http",
    "zoho-mail",
    "https://mail-mcp.example.test/mcp",
  ]);
});
it("registers both servers with Codex, and reports a missing CLI instead of failing", () => {
  const { calls, run } = recorder(new Set());
  configureCodex("/app", "mail-mcp.example.test", run);
  expect(calls).toEqual([
    ["codex", "mcp", "get", "zoho-mail"],
    ["codex", "mcp", "add", "zoho-mail", "--url", "https://mail-mcp.example.test/mcp"],
    ["codex", "mcp", "get", "zoho-mail-companion"],
    ["codex", "mcp", "add", "zoho-mail-companion", "--", "/app/bin/companion", "serve"],
  ]);
  const missing = recorder(new Set(), true);
  expect(configureCodex("/app", "mail-mcp.example.test", missing.run).join("\n")).toContain("not installed");
  expect(missing.calls).toHaveLength(1);
});

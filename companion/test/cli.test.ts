import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";

it("launches the CLI directly in Node and lists tools without accessing credentials", async () => {
  const child = spawn(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname, "serve"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cli-test", version: "1" } },
      }) + "\n",
    );
    // The default poll budget is one second. Measured on this machine, spawn to initialize reply
    // sits at a 260ms median and a 350ms median under load, but its tail crosses one second at
    // roughly one run in forty: reproduced at run 12 of 40 with the worker and qualification
    // suites running alongside, failing on exactly this line. The assertion is unchanged and a
    // reply that never arrives still fails; what changes is that the test stops asserting a
    // deadline it was never trying to measure.
    await expect
      .poll(() => stdout.includes('"id":1'), { timeout: 15_000, interval: 50 })
      .toBe(true)
      .catch(() => {
        throw new Error(`no initialize reply.\nstdout: ${stdout}\nstderr: ${stderr}`);
      });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await expect
      .poll(() => stdout.includes('"id":2'), { timeout: 15_000, interval: 50 })
      .toBe(true)
      .catch(() => {
        throw new Error(`no tools/list reply.\nstdout: ${stdout}\nstderr: ${stderr}`);
      });
    const reply = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((row) => row.id === 2);
    expect(reply.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "list_roots",
      "save_attachment",
      "stage_file",
    ]);
    expect(stderr).toBe("");
  } finally {
    child.kill();
  }
});

// Hermetic: the companion resolves its state from $HOME, so a temporary HOME gives it a private
// configuration, journal and roots without any override inside the native port.
it("debt lists charged debt and refuses a handle that is not there", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const home = mkdtempSync(join(tmpdir(), "zmh-"));
  const env = { ...process.env, HOME: home };
  const init = spawnSync(
    process.execPath,
    [cli, "init", "--origin", "https://mail-mcp.example.test", "--client-id", "cid"],
    { encoding: "utf8", timeout: 60_000, env },
  );
  expect(init.status, init.stderr).toBe(0);
  // A second companion waits for the process lock, so never spawn it without a timeout.
  const list = spawnSync(process.execPath, [cli, "debt"], { encoding: "utf8", timeout: 60_000, env });
  expect(list.error).toBeUndefined();
  expect(list.status).toBe(0);
  expect(list.stdout).toBe("No charged save debt.\n");

  const bogus = spawnSync(process.execPath, [cli, "debt", "--scope", "nosuchscope", "--release", "nosuchhandle"], {
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
  expect(bogus.error).toBeUndefined();
  expect(bogus.stdout).toBe("No such receipt.\n");

  // --release without --scope is a mistyped command, not a refusal from the helper. Found by an
  // end-to-end run: the check used to sit inside the branch's own catch and printed
  // "Refused: usage" on stdout.
  const noScope = spawnSync(process.execPath, [cli, "debt", "--release", "sh_whatever"], {
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
  expect(noScope.stdout).toBe("");
  expect(noScope.stderr).toContain("Usage: zoho-mail-mcp-companion");
  expect(noScope.status).toBe(1);
});

it("init creates the Received and To Send folders and configures the default roots that exist", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const home = mkdtempSync(join(tmpdir(), "zmi-"));
  mkdirSync(join(home, "Documents"));
  const env = { ...process.env, HOME: home };
  const init = spawnSync(
    process.execPath,
    [cli, "init", "--server", "https://mail-mcp.example.test", "--client-id", "cid"],
    { encoding: "utf8", timeout: 60_000, env },
  );
  expect(init.status, init.stderr).toBe(0);
  expect(init.stdout).not.toMatch(new RegExp("\\u2014"));
  const config = JSON.parse(readFileSync(join(home, ".config", "zoho-mail-mcp", "config.json"), "utf8")) as {
    roots: Record<string, { path: string; read: boolean; write: boolean }>;
  };
  expect(Object.keys(config.roots).sort()).toEqual(["attachments", "documents", "outbox"]);
  expect(config.roots.outbox).toMatchObject({ read: true, write: false });
  expect(config.roots.outbox!.path.endsWith(join("Downloads", "Mail", "To Send"))).toBe(true);
  expect(config.roots.attachments).toMatchObject({ read: false, write: true });
  expect(config.roots.attachments!.path.endsWith(join("Downloads", "Mail", "Received"))).toBe(true);
  const again = spawnSync(
    process.execPath,
    [cli, "init", "--server", "https://mail-mcp.example.test", "--client-id", "cid"],
    { encoding: "utf8", timeout: 60_000, env },
  );
  expect(again.status).toBe(1);
  expect(again.stdout + again.stderr).toContain("configuration_exists");
});

it("configure-clients adds the companion to Claude Desktop, keeps other servers, and is a no-op the second time", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const home = mkdtempSync(join(tmpdir(), "zmc-"));
  const desktop = join(home, "Library", "Application Support", "Claude");
  mkdirSync(desktop, { recursive: true });
  writeFileSync(join(desktop, "claude_desktop_config.json"), '{"mcpServers":{"other":{"command":"x","args":[]}}}');
  // No claude or codex on this PATH: both are reported as not installed rather than failing the run.
  const env = { ...process.env, HOME: home, PATH: "/usr/bin:/bin" };
  const run = () =>
    spawnSync(process.execPath, [cli, "configure-clients", "--host", "mail-mcp.example.test"], {
      encoding: "utf8",
      timeout: 60_000,
      env,
    });
  const first = run();
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout).toContain("Claude Code: not installed, skipped.");
  expect(first.stdout).toContain("Codex: not installed, skipped.");
  expect(first.stdout).toContain("Claude Desktop: added zoho-mail-companion");
  expect(first.stdout).toContain("https://mail-mcp.example.test/mcp");
  expect(first.stdout).not.toMatch(new RegExp("\\u2014"));
  const config = JSON.parse(readFileSync(join(desktop, "claude_desktop_config.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  expect(config.mcpServers.other).toEqual({ command: "x", args: [] });
  expect(config.mcpServers["zoho-mail-companion"]!.args).toEqual(["serve"]);
  expect(run().stdout).toContain("Claude Desktop: zoho-mail-companion already set up.");
});

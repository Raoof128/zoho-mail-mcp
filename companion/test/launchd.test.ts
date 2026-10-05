import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchdPlist, installAgent } from "../src/launchd.ts";
import { readFileSync, existsSync } from "node:fs";

it("emits a plist that plutil accepts, with RunAtLoad and KeepAlive on the serve command", () => {
  const xml = launchdPlist({
    label: "au.com.sarabisfinerugs.mail-mcp.companion",
    program: "/usr/local/bin/node",
    args: ["/Users/x/Library/Application Support/zoho-mail-mcp/bin/companion", "serve"],
    logPath: "/Users/x/Library/Logs/zoho-mail-mcp.log",
  });
  expect(xml).toContain("<key>RunAtLoad</key><true/>");
  expect(xml).toContain("<string>serve</string>");
  if (process.platform === "darwin") {
    const f = join(mkdtempSync(join(tmpdir(), "zpl-")), "a.plist");
    writeFileSync(f, xml);
    expect(execFileSync("/usr/bin/plutil", ["-lint", f]).toString()).toContain("OK");
  }
});

it("install-agent writes a one-shot login agent for recover and reloads it with launchctl", () => {
  const home = mkdtempSync(join(tmpdir(), "zpa-"));
  const calls: string[][] = [];
  const plist = installAgent({
    home,
    uid: 501,
    program: "/Users/x/Library/Application Support/zoho-mail-mcp/bin/companion",
    run: (argv) => {
      calls.push(argv);
      if (argv[1] === "bootout") throw new Error("not loaded");
    },
  });
  expect(plist).toBe(join(home, "Library", "LaunchAgents", "au.com.sarabisfinerugs.mail-mcp.companion.plist"));
  const xml = readFileSync(plist, "utf8");
  expect(xml).toContain("<string>recover</string>");
  expect(xml).not.toContain("KeepAlive");
  expect(xml).toContain(join(home, "Library", "Logs", "zoho-mail-mcp.log"));
  expect(calls).toEqual([
    ["/bin/launchctl", "bootout", "gui/501/au.com.sarabisfinerugs.mail-mcp.companion"],
    ["/bin/launchctl", "bootstrap", "gui/501", plist],
  ]);
  expect(existsSync(plist + ".tmp")).toBe(false);
});

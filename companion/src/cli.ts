#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { NativeProcess } from "./native.ts";
import { login, logout } from "./auth.ts";
import { buildCompanionServer } from "./server.ts";
import { installAgent } from "./launchd.ts";
import {
  COMPANION_NAME,
  configureClaudeCode,
  configureCodex,
  desktopConnectorInstructions,
  mergeClaudeDesktopConfig,
} from "./configure.ts";
import { Paths } from "./native/config.ts";

const USAGE =
  "Usage: zoho-mail-mcp-companion init --server https://HOST --client-id ID [--write-root PATH] [--read-root ID=PATH] | login | logout | status | serve | recover | install-agent | configure-clients --host HOST | debt [--scope SCOPE --release HANDLE]\n";
/** What a refusal means, in one plain line for the owner. Codes not listed print as they are. */
const PLAIN: Record<string, string> = {
  configuration_exists: "The companion is already set up on this Mac.",
  run_init: "The companion is not set up yet. Run the install line again.",
  login_required: "The companion is not signed in. Run: companion login",
  lock_busy: "Another companion task is still running. Try again in a minute.",
  root_overlap: "Two of the folders the companion uses sit inside each other.",
  private_overlap: "A shared folder sits inside the companion's private folder.",
  unsupported_volume: "A folder is on a drive the companion cannot use safely (it must be this Mac's own disk).",
};
type DebtRow = {
  scope: string;
  handle: string;
  state: string;
  root: string;
  relative: string;
  bytes: number;
  temporary: string;
  releasable: boolean;
};
async function main() {
  const command = process.argv[2] ?? "serve";
  if (command === "serve") {
    serveStdio((ctx) => buildCompanionServer(ctx.era === "modern"));
    return;
  }
  if (command === "login") {
    await login();
    process.stderr.write("Companion login saved in Keychain.\n");
    return;
  }
  if (command === "logout") {
    const revoked = await logout();
    process.stderr.write(
      revoked
        ? "Logged out; remote revocation confirmed.\n"
        : "Logged out locally; remote revocation is unconfirmed.\n",
    );
    return;
  }
  if (command === "init") {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        server: { type: "string" },
        origin: { type: "string" },
        "client-id": { type: "string" },
        "read-root": { type: "string", multiple: true },
        "write-root": { type: "string" },
      },
    });
    const origin = values.server ?? values.origin;
    if (!origin || !values["client-id"]) throw new Error("usage");
    const home = homedir();
    // Siblings, never nested: the native port refuses roots inside one another. The outbox is the
    // one root the Worker stages from without asking (M5), so files to send go in "To Send".
    const received = resolve(values["write-root"] ?? join(home, "Downloads", "Mail", "Received"));
    const outbox = join(home, "Downloads", "Mail", "To Send");
    mkdirSync(received, { recursive: true, mode: 0o700 });
    mkdirSync(outbox, { recursive: true, mode: 0o700 });
    const roots: Record<string, { path: string; read: boolean; write: boolean }> = {
      attachments: { path: received, read: false, write: true },
      outbox: { path: outbox, read: true, write: false },
    };
    for (const [id, dir] of [
      ["desktop", join(home, "Desktop")],
      ["documents", join(home, "Documents")],
    ] as const)
      if (existsSync(dir)) roots[id] = { path: dir, read: true, write: false };
    for (const item of values["read-root"] ?? []) {
      const split = item.indexOf("=");
      if (split < 1) throw new Error("usage");
      const id = item.slice(0, split);
      if (roots[id]) throw new Error("duplicate_root");
      roots[id] = { path: resolve(item.slice(split + 1)), read: true, write: false };
    }
    const native = new NativeProcess({ initialize: true });
    try {
      await native.call({ origin, client_id: values["client-id"], roots });
    } finally {
      native.close();
    }
    process.stdout.write(`Companion set up. Put files to send in: ${outbox}\n`);
    return;
  }
  if (command === "status") {
    // Exit 0 signed in, 3 not signed in: the installer retries login on 3 (final review I1).
    const native = new NativeProcess();
    try {
      const begin = await native.call({ op: "auth.begin" });
      const signedIn = begin.body.length > 0;
      process.stdout.write(signedIn ? "Signed in.\n" : "Not signed in.\n");
      if (!signedIn) process.exitCode = 3;
    } finally {
      native.close();
    }
    return;
  }
  if (command === "recover") {
    // Opening the native port runs startup recovery: expired snapshots, interrupted saves, retention.
    const native = new NativeProcess();
    try {
      await native.call({ op: "roots" });
    } finally {
      native.close();
    }
    process.stdout.write(`${new Date().toISOString()} companion recovery done\n`);
    return;
  }
  if (command === "install-agent") {
    const plist = installAgent({
      home: homedir(),
      uid: process.getuid!(),
      program: join(Paths.stateDir, "bin", "companion"),
      // Gate G20 points this at a recording stub so a scratch HOME never registers with the real launchd.
      ...(process.env.ZMC_LAUNCHCTL ? { launchctl: process.env.ZMC_LAUNCHCTL } : {}),
      run: (argv) => {
        execFileSync(argv[0]!, argv.slice(1), { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
      },
    });
    process.stdout.write(`Login agent installed: ${plist}\n`);
    return;
  }
  if (command === "configure-clients") {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { host: { type: "string" } } });
    const host = values.host;
    if (!host || !/^[a-z0-9.-]+$/.test(host)) throw new Error("usage");
    const appDir = Paths.stateDir;
    const lines = [...configureClaudeCode(appDir, host), ...configureCodex(appDir, host)];
    const desktop = join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    try {
      const r = mergeClaudeDesktopConfig(desktop, { command: join(appDir, "bin", "companion"), args: ["serve"] });
      lines.push(
        r.changed
          ? `Claude Desktop: added ${COMPANION_NAME}${r.backup ? ` (backup: ${r.backup})` : ""}.`
          : `Claude Desktop: ${COMPANION_NAME} already set up.`,
      );
    } catch {
      lines.push(`Claude Desktop: left unchanged, its settings file could not be read (${desktop}).`);
    }
    process.stdout.write(lines.join("\n") + "\n" + desktopConnectorInstructions(host) + "\n");
    return;
  }
  if (command === "debt") {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: { release: { type: "string" }, scope: { type: "string" } },
    });
    // The reservation id is a digest of scope and handle and cannot be inverted, so the scope has
    // to be named. It is never a constant: it is a hash of origin, client and owner. This check
    // sits outside the try on purpose: inside it, the branch's own catch turns a usage error into
    // "Refused: usage", which reads like a refusal from the helper rather than a mistyped command.
    if (values.release !== undefined && !values.scope) throw new Error("usage");
    const native = new NativeProcess();
    try {
      if (values.release !== undefined) {
        const { outcome } = (await native.call({ op: "debt.release", scope: values.scope, handle: values.release }))
          .meta as { outcome: string };
        process.stdout.write(
          { released: "Released.\n", no_such_receipt: "No such receipt.\n", not_charged: "Nothing charged.\n" }[
            outcome
          ] ?? `Unexpected outcome: ${outcome}\n`,
        );
        return;
      }
      const { rows } = (await native.call({ op: "debt.list" })).meta as { rows: DebtRow[] };
      if (rows.length === 0) {
        process.stdout.write("No charged save debt.\n");
        return;
      }
      for (const row of rows) {
        // A collectable temporary never reaches this listing. recoverStartup runs on every helper
        // start, including the one answering this command, so anything the collector could clear
        // is already cleared. A temporary that survives to be printed is one the collector
        // refused, which is why the remedy here is not "start the companion".
        const remedy = row.releasable
          ? `run: zoho-mail-mcp-companion debt --scope ${row.scope} --release ${row.handle}`
          : row.temporary === "present"
            ? "not collected: the helper ran with this listing and left it. Its temporary exists but does not match the identity recorded at creation, so nothing may remove it safely. Report this rather than deleting anything by hand."
            : `not clearable: state ${row.state}, temporary ${row.temporary}`;
        process.stdout.write(
          `${row.handle}  ${row.state}  ${row.bytes} bytes  ${row.root}/${row.relative}\n  ${remedy}\n`,
        );
      }
    } catch (error) {
      // A refusal carries the native code. Without this it reaches the owner as the generic
      // "check configuration, permissions, login and the native build", which is the wrong
      // sentence for the one case they most need to understand.
      const code = error instanceof Error ? error.message : "native_failed";
      if (!/^[a-z_]+$/.test(code)) throw error;
      process.stdout.write(`Refused: ${code}\n`);
      process.exitCode = 1;
    } finally {
      native.close();
    }
    return;
  }
  throw new Error("usage");
}
main().catch((error: unknown) => {
  const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : undefined;
  if (code && code !== "usage") process.stderr.write(`${PLAIN[code] ?? "The companion refused."} (${code})\n`);
  else if (!code) process.stderr.write("Companion command failed. Check configuration, permissions and login.\n");
  process.stderr.write(USAGE);
  process.exitCode = 1;
});

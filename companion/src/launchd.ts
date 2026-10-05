import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_LABEL = "au.com.sarabisfinerugs.mail-mcp.companion";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(o: {
  label: string;
  program: string;
  args: string[];
  logPath: string;
  keepAlive?: boolean;
}): string {
  const keepAlive = o.keepAlive === false ? "" : "\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${esc(o.label)}</string>
<key>ProgramArguments</key><array>${[o.program, ...o.args].map((a) => `<string>${esc(a)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>${keepAlive}
<key>StandardOutPath</key><string>${esc(o.logPath)}</string>
<key>StandardErrorPath</key><string>${esc(o.logPath)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin</string></dict>
</dict></plist>
`;
}

/**
 * A login agent that runs `companion recover` once: it opens the native port, which clears expired
 * snapshots and recovers interrupted saves, then exits. A `serve` under launchd would read an empty
 * stdin, exit 0 and never be restarted; the MCP clients start their own `serve` processes.
 */
export function installAgent(o: {
  home: string;
  uid: number;
  program: string;
  run: (argv: string[]) => void;
  launchctl?: string;
}): string {
  const launchctl = o.launchctl ?? "/bin/launchctl";
  const dir = join(o.home, "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(o.home, "Library", "Logs"), { recursive: true });
  const plist = join(dir, `${AGENT_LABEL}.plist`);
  writeFileSync(
    plist + ".tmp",
    launchdPlist({
      label: AGENT_LABEL,
      program: o.program,
      args: ["recover"],
      logPath: join(o.home, "Library", "Logs", "zoho-mail-mcp.log"),
      keepAlive: false,
    }),
    { mode: 0o644 },
  );
  renameSync(plist + ".tmp", plist);
  try {
    o.run([launchctl, "bootout", `gui/${o.uid}/${AGENT_LABEL}`]);
  } catch {
    // Not loaded yet: the first install.
  }
  o.run([launchctl, "bootstrap", `gui/${o.uid}`, plist]);
  return plist;
}

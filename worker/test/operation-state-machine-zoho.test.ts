import { describe, it, expect } from "vitest";
import { createWorker } from "../src/index";
import { FakeZoho } from "./fake-zoho";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { setPolicy } from "../src/policy/engine";

// Moved from operation-state-machine.test.ts in M3 Task 3.3 when send_message moved to Zoho; the Gmail draft and label
// cases there move here as M3 Task 3.4 and M4 port their tools.
const U = "owner-sub";

let seq = 0;
async function rig() {
  const e = testEnv();
  const z = await FakeZoho.create();
  const n = ++seq;
  const accountId = `osmz${n}`;
  const Z = `194000${n}`;
  const seen: { id: string; state: string }[][] = [];
  const zohoFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).hostname === "mail.zoho.com.au" && req.method !== "GET") {
      const rows = await e.DB.prepare("SELECT id, state FROM operations WHERE user_id = ? AND account_id = ?")
        .bind(U, accountId)
        .all<{ id: string; state: string }>();
      seen.push(rows.results);
    }
    return z.fetch(req);
  };
  const worker = createWorker(testDeps(z, { zohoFetch }));
  await e.DB.prepare("UPDATE accounts SET alias = 'old-' || id, is_default = 0 WHERE user_id = ? AND alias = 'sarabi'")
    .bind(U)
    .run();
  await seedUserAndAccount(e.DB, {
    userId: U,
    accountId,
    alias: "sarabi",
    slot: "sarabi",
    zohoAccountId: Z,
    email: "sarabi@example.test",
    isDefault: true,
  });
  z.accounts.set(`sub-${accountId}`, { accountId: Z, primaryEmail: "sarabi@example.test", sendAs: [] });
  await seedAccessToken(e, { userId: U, accountId, access: z.directToken(Z) });
  const token = (await mintToken(worker, e, z as never, { scope: "mcp" })).accessToken;
  return {
    e,
    accountId,
    seen,
    call: (name: string, args: Record<string, unknown>) => callTool(worker, e, token, name, args),
  };
}
const neverClaimed = (seen: { id: string; state: string }[][]) => {
  expect(seen.length).toBeGreaterThan(0);
  for (const snapshot of seen) for (const row of snapshot) expect(row.state).not.toBe("claimed");
  expect(seen[0]!.some((row) => row.state === "executing")).toBe(true);
};

describe("claimed means no external mutation could have happened (Zoho)", () => {
  it("a journaled send is executing, never claimed, when Zoho first sees a mutating request", async () => {
    const r = await rig();
    await setPolicy(r.e.DB, { userId: U, accountId: r.accountId, action: "send.message", level: "allow" });
    const out = await r.call("send_message", {
      account: "sarabi",
      to: ["sarabi@example.test"],
      subject: "state machine",
      body: "b",
    });
    expect(out.result).toMatchObject({ status: "executed" });
    neverClaimed(r.seen);
  });
  it("a journaled draft is executing too, because it shares the send pipeline", async () => {
    const r = await rig();
    const out = await r.call("create_draft", {
      account: "sarabi",
      to: ["sarabi@example.test"],
      subject: "d",
      body: "b",
    });
    expect(out.result).toMatchObject({ status: "executed" });
    neverClaimed(r.seen);
  });
});

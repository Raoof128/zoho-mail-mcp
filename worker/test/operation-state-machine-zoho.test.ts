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

describe("claimed means no external mutation could have happened (Zoho)", () => {
  it("a journaled send is executing, never claimed, when Zoho first sees a mutating request", async () => {
    const e = testEnv();
    const z = await FakeZoho.create();
    const seen: { id: string; state: string }[][] = [];
    const zohoFetch: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).hostname === "mail.zoho.com.au" && req.method !== "GET") {
        const rows = await e.DB.prepare("SELECT id, state FROM operations WHERE user_id = ? AND account_id = 'osmz'")
          .bind(U)
          .all<{ id: string; state: string }>();
        seen.push(rows.results);
      }
      return z.fetch(req);
    };
    const worker = createWorker(testDeps(z, { zohoFetch }));
    await seedUserAndAccount(e.DB, {
      userId: U,
      accountId: "osmz",
      alias: "sarabi",
      slot: "sarabi",
      zohoAccountId: "1940001",
      email: "sarabi@example.test",
      isDefault: true,
    });
    z.accounts.set("sub-osmz", { accountId: "1940001", primaryEmail: "sarabi@example.test", sendAs: [] });
    await seedAccessToken(e, { userId: U, accountId: "osmz", access: z.directToken("1940001") });
    await setPolicy(e.DB, { userId: U, accountId: "osmz", action: "send.message", level: "allow" });
    const token = (await mintToken(worker, e, z as never, { scope: "mcp" })).accessToken;
    const r = await callTool(worker, e, token, "send_message", {
      account: "sarabi",
      to: ["sarabi@example.test"],
      subject: "state machine",
      body: "b",
    });
    expect(r.result).toMatchObject({ status: "executed" });
    expect(seen.length).toBeGreaterThan(0);
    for (const snapshot of seen) for (const row of snapshot) expect(row.state).not.toBe("claimed");
    expect(seen[0]!.some((row) => row.state === "executing")).toBe(true);
  });
});

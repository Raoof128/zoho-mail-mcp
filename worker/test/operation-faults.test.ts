import { describe, it, expect } from "vitest";
import { createWorker } from "../src/index";
import { FakeZoho } from "./fake-zoho";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken, retireSlot } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { approvePending } from "../src/approval/pending";

// Ported to Zoho in M3 Task 3.3: the send tools no longer reach Gmail. Same invariants, settlement protocol 1.
const U = "owner-sub";
let seq = 0;

type Rig = {
  worker: ReturnType<typeof createWorker>;
  e: ReturnType<typeof testEnv>;
  z: FakeZoho;
  token: string;
  account: string;
  counts: { mutations: number; total: number };
};

/** A Zoho send or upload is the only mutating request a send makes. */
const isMutation = (req: Request) => {
  const u = new URL(req.url);
  return u.hostname === "mail.zoho.com.au" && req.method === "POST" && /\/messages(\/attachments)?$/.test(u.pathname);
};

async function rig(account: string, intercept: (req: Request, pass: () => Promise<Response>) => Promise<Response>) {
  const e = testEnv();
  const z = await FakeZoho.create();
  const Z = `19300${++seq}`;
  const counts = { mutations: 0, total: 0 };
  const zohoFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    counts.total++;
    if (isMutation(request)) counts.mutations++;
    return intercept(request, () => z.fetch(request));
  };
  const worker = createWorker(testDeps(z, { zohoFetch }));
  await retireSlot(e.DB, U, "sarabi");
  await seedUserAndAccount(e.DB, {
    userId: U,
    accountId: account,
    alias: account,
    slot: "sarabi",
    zohoAccountId: Z,
    email: "sarabi@example.test",
  });
  z.accounts.set(`sub-${account}`, { accountId: Z, primaryEmail: "sarabi@example.test", sendAs: [] });
  await seedAccessToken(e, { userId: U, accountId: account, access: z.directToken(Z) });
  const token = (await mintToken(worker, e, z as never, { scope: "mcp" })).accessToken;
  return { worker, e, z, token, account, counts };
}

const send = (r: Rig, extra: Record<string, unknown> = {}) =>
  callTool(r.worker, r.e, r.token, "send_message", {
    account: r.account,
    to: ["someone@external.test"],
    subject: "fault",
    body: "b",
    ...extra,
  });

const opsOf = (r: Rig) =>
  r.e.DB.prepare("SELECT id, state FROM operations WHERE user_id = ? AND account_id = ?")
    .bind(U, r.account)
    .all<{ id: string; state: string }>();
const auditOf = (r: Rig) =>
  r.e.DB.prepare("SELECT phase, decision FROM audit_log WHERE user_id = ? AND account_id = ?")
    .bind(U, r.account)
    .all<{ phase: string; decision: string }>();

// The transport is the earliest point a fault can be injected, and beginOperation already ran by then. Once the body
// was handed to the transport, a thrown fetch is indistinguishable from a commit whose response was lost, so the honest
// outcome is unknown (executing, then delivery_unknown by the cron), never failed_safe and never executed.
describe("the transport dies at the first mutating request", () => {
  it("leaves Zoho untouched, records no executed outcome, and is never failed_safe", async () => {
    const r = await rig("flt-pre", async (req, pass) => {
      if (isMutation(req)) throw new Error("network down before any mutation");
      return pass();
    });
    const asked = await send(r);
    const id = (asked.result as { action_id?: string } | null)?.action_id;
    expect(id).toBeTruthy();
    expect(await approvePending(r.e.DB, { id: id!, userId: U, via: "browser" })).toBe(true);
    const done = await callTool(r.worker, r.e, r.token, "execute_pending", { action_id: id });

    expect(r.counts.total).toBeGreaterThan(0);
    expect(r.counts.mutations).toBe(1);
    expect(r.z.mail.sent.length).toBe(0);
    const rows = await opsOf(r);
    expect(rows.results.length).toBe(1);
    expect(["executing", "delivery_unknown"]).toContain(rows.results[0]!.state);
    const audit = await auditOf(r);
    expect(audit.results.length).toBeGreaterThan(0);
    expect(audit.results.some((a) => a.decision === "executed")).toBe(false);
    expect(JSON.stringify(done.result)).toMatch(/delivery_unknown/);
  });
});

describe("a provider commit whose response is lost", () => {
  it("never becomes failed_safe, sends exactly one body, and holds the idempotency key", async () => {
    let committed = 0;
    const r = await rig("flt-lost", async (req, pass) => {
      const response = await pass();
      if (isMutation(req)) {
        committed++;
        return new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("response lost after commit"));
            },
          }),
        );
      }
      return response;
    });
    const asked = await send(r, { idempotency_key: "lost-response-key" });
    const id = (asked.result as { action_id?: string }).action_id;
    expect(id).toBeTruthy();
    expect(await approvePending(r.e.DB, { id: id!, userId: U, via: "browser" })).toBe(true);
    const done = await callTool(r.worker, r.e, r.token, "execute_pending", { action_id: id });

    expect(committed).toBe(1);
    expect(r.z.mail.sent.length).toBe(1);
    expect(JSON.stringify(done.result)).toMatch(/delivery_unknown/);
    const rows = await opsOf(r);
    expect(rows.results.length).toBe(1);
    expect(rows.results[0]!.state).not.toBe("failed_safe");
    expect(["executing", "delivery_unknown"]).toContain(rows.results[0]!.state);

    const replay = await send(r, { idempotency_key: "lost-response-key" });
    expect(r.z.mail.sent.length).toBe(1);
    expect(r.counts.mutations).toBe(1);
    expect(JSON.stringify(replay.result)).toMatch(/delivery_unknown|operation/);
    const audit = await auditOf(r);
    expect(audit.results.filter((a) => a.decision === "executed").length).toBe(0);
  });
});

describe("two contenders for one approved action", () => {
  it("produce one external mutation, one terminal result and one executed audit", async () => {
    const r = await rig("flt-race", async (_req, pass) => pass());
    const asked = await send(r);
    const id = (asked.result as { action_id?: string }).action_id;
    expect(id).toBeTruthy();
    expect(await approvePending(r.e.DB, { id: id!, userId: U, via: "browser" })).toBe(true);
    const both = await Promise.all([
      callTool(r.worker, r.e, r.token, "execute_pending", { action_id: id }),
      callTool(r.worker, r.e, r.token, "execute_pending", { action_id: id }),
    ]);
    expect(r.counts.mutations).toBe(1);
    expect(r.z.mail.sent.length).toBe(1);
    const texts = both.map((b) => JSON.stringify(b.result));
    expect(texts.filter((t) => /"status"\s*:\s*"executed"/.test(t)).length).toBe(1);
    expect(texts.filter((t) => /replay|pending_replayed|not_approved/.test(t)).length).toBe(1);
    const ops = await opsOf(r);
    expect(ops.results.length).toBe(1);
    expect(ops.results[0]!.state).toBe("executed");
    const audit = await auditOf(r);
    expect(audit.results.filter((a) => a.decision === "executed").length).toBe(1);
  });
});

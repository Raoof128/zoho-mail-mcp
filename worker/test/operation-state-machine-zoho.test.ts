import { describe, it, expect } from "vitest";
import { createWorker } from "../src/index";
import { FakeZoho } from "./fake-zoho";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken, retireSlot } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { setPolicy } from "../src/policy/engine";
import { approvePending } from "../src/approval/pending";

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
  await retireSlot(e.DB, U, "sarabi");
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
  const token = (await mintToken(worker, e, z, { scope: "mcp" })).accessToken;
  return {
    e,
    z,
    Z,
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

// Moved from the Gmail operation-state-machine file in M4 Task 4.1, when the organising tools moved to Zoho.
describe("organising tools and the journal (Zoho)", () => {
  const opsFor = async (r: Awaited<ReturnType<typeof rig>>, action: string) =>
    (await r.e.DB.prepare("SELECT count(*) AS n FROM operations WHERE user_id = ? AND account_id = ? AND action = ?")
      .bind(U, r.accountId, action)
      .first<{ n: number }>())!.n;

  it("label_message opens no operation row and still reports executed", async () => {
    const r = await rig();
    const m = r.z.mail.seedMessage(r.Z, {
      folder: "Inbox",
      from: "a@x.test",
      to: ["sarabi@example.test"],
      subject: "s",
      content: "t",
    });
    const l = r.z.mail.seedLabel(r.Z, "Keep");
    const out = await r.call("label_message", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      label_ids: [l.labelId],
    });
    expect(out.result).toMatchObject({ status: "executed" });
    expect(await opsFor(r, "label.apply")).toBe(0);
  });

  it("trash_message on the approval path is executing before the mutation, and a replay does nothing", async () => {
    const r = await rig();
    const m = r.z.mail.seedMessage(r.Z, {
      folder: "Inbox",
      from: "a@x.test",
      to: ["sarabi@example.test"],
      subject: "s",
      content: "t",
    });
    const asked = await r.call("trash_message", { account: "sarabi", message_id: m.messageId, folder_id: m.folderId });
    expect((asked.result as { status: string }).status).toBe("pending_approval");
    const id = (asked.result as { action_id: string }).action_id;
    expect(await approvePending(r.e.DB, { id, userId: U, via: "browser" })).toBe(true);
    r.seen.length = 0;
    const done = await r.call("execute_pending", { action_id: id });
    expect(done.result).toMatchObject({ status: "executed" });
    expect(r.z.mail.get(r.Z, m.messageId)!.folderId).toBe(r.z.mail.folderId(r.Z, "Trash"));
    expect(await opsFor(r, "trash.move")).toBe(1);
    neverClaimed(r.seen);
    const replay = await r.call("execute_pending", { action_id: id });
    expect(JSON.stringify(replay.result)).toMatch(/pending_replayed|replay/i);
    expect(await opsFor(r, "trash.move")).toBe(1);
  });

  it("untrash on the direct allow path opens no operation at all", async () => {
    const r = await rig();
    const m = r.z.mail.seedMessage(r.Z, {
      folder: "Trash",
      from: "a@x.test",
      to: ["sarabi@example.test"],
      subject: "s",
      content: "t",
    });
    const out = await r.call("untrash_message", { account: "sarabi", message_id: m.messageId, folder_id: m.folderId });
    expect(out.result).toMatchObject({ status: "executed" });
    expect(await opsFor(r, "trash.restore")).toBe(0);
  });

  it("every operation row belongs to a journalled action or to an approval claim", async () => {
    const r = await rig();
    const rows = await r.e.DB.prepare("SELECT DISTINCT action FROM operations WHERE user_id = ?")
      .bind(U)
      .all<{ action: string }>();
    const journalled = new Set([
      "send.message",
      "send.draft",
      "send.forward",
      "draft.write",
      "trash.move",
      "attachment.stage_upload",
    ]);
    const claimable = await r.e.DB.prepare("SELECT DISTINCT action FROM pending_actions WHERE user_id = ?")
      .bind(U)
      .all<{ action: string }>();
    const approved = new Set(claimable.results.map((x) => x.action));
    for (const x of rows.results) expect(journalled.has(x.action) || approved.has(x.action)).toBe(true);
  });
});

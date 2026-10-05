import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { FakeZoho } from "./fake-zoho";
import { Browser, csrfFrom, mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool, modernCall } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { getPending } from "../src/approval/pending";

const e = testEnv({ OWNER_ZOHO_SUBS: "owner-sub,other-sub" });
let z: FakeZoho;
const Z = "1960001";
let worker: ReturnType<typeof createWorker>;
let token: string;
let otherToken: string;
let browser: Browser;
const URL_CAPS = { elicitation: { url: {} } };
const FORM_CAPS = { elicitation: { form: {} } };
const pendingCount = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM pending_actions WHERE user_id = 'owner-sub'").first<any>())
    .n as number;

beforeAll(async () => {
  z = await FakeZoho.create();
  worker = createWorker(testDeps(z));
  // Ported to Zoho in M4 Task 4.1 (trash_message is the approval vehicle and is Zoho-backed now).
  await seedUserAndAccount(env.DB, {
    userId: "owner-sub",
    accountId: "ea",
    alias: "personal",
    slot: "sarabi",
    zohoAccountId: Z,
    email: "sarabi@example.test",
    isDefault: true,
  });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "eb", alias: "cold", slot: "rcp" });
  await seedUserAndAccount(env.DB, {
    userId: "other-sub",
    accountId: "ec",
    alias: "personal",
    slot: "sarabi",
    isDefault: true,
  });
  z.accounts.set("sub-ea", { accountId: Z, primaryEmail: "sarabi@example.test", sendAs: [] });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "ea", access: z.directToken(Z) });
  const minted = await mintToken(worker, e, z, { scope: "mcp" });
  token = minted.accessToken;
  browser = minted.browser;
  otherToken = (await mintToken(worker, e, z, { scope: "mcp", sub: "other-sub", email: "other@example.test" }))
    .accessToken;
});

const seed = () =>
  z.mail.seedMessage(Z, {
    folder: "Inbox",
    from: "a@x.test",
    to: ["sarabi@example.test"],
    subject: "el",
    content: "t",
  });

describe("legacy era", () => {
  it("returns the approval URL as text and never an input_required result", async () => {
    const m = seed();
    const r = await callTool(worker, e, token, "trash_message", { account: "personal", message_id: m.messageId });
    expect(r.result).toMatchObject({ status: "pending_approval", approval: { mode: "url" } });
    expect(r.json.result.resultType).toBeUndefined();
  });
});

describe("modern era with elicitation.url", () => {
  it("answers input_required with the approval URL and a signed requestState; the accepted retry waits and executes", async () => {
    const m = seed();
    const first = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.messageId },
      { capabilities: URL_CAPS },
    );
    expect(first.status).toBe(200);
    expect(first.inputRequired).toMatchObject({
      resultType: "input_required",
      inputRequests: { approval: { method: "elicitation/create", params: { mode: "url" } } },
    });
    const url: string = first.inputRequired.inputRequests.approval.params.url;
    const id = url.split("/approve/")[1]!;
    expect(url).toBe(`https://zoho-mail-mcp.example.workers.dev/approve/${id}`);
    const state: string = first.inputRequired.requestState;
    expect(state).toMatch(/^v1\./);
    expect((await getPending(env.DB, id, "owner-sub"))!.state).toBe("pending");
    const page = await browser.get(`/approve/${id}`);
    const csrf = csrfFrom(await page.text(), `/approve/${id}`);
    setTimeout(() => void browser.post(`/approve/${id}`, { decision: "approve", csrf }), 20);
    const retry = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.messageId },
      { capabilities: URL_CAPS, inputResponses: { approval: { action: "accept" } }, requestState: state },
    );
    expect(retry.result).toMatchObject({ status: "executed", action_id: id, updated: [m.messageId] });
    expect(z.mail.get(Z, m.messageId)!.folderId).toBe(z.mail.folderId(Z, "Trash"));
    expect((await getPending(env.DB, id, "owner-sub"))!).toMatchObject({
      state: "executed",
      approved_via: "browser",
      payload_json: null,
    });
  });
  it("without the url capability the modern era gets the URL as text", async () => {
    const m = seed();
    const r = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.messageId },
      { capabilities: FORM_CAPS },
    );
    expect(r.result).toMatchObject({ status: "pending_approval" });
    expect(r.inputRequired).toBeNull();
  });
  it("the deadline returns pending_approval and the owner can finish with execute_pending", async () => {
    const m = seed();
    const first = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.messageId },
      { capabilities: URL_CAPS },
    );
    const state: string = first.inputRequired.requestState;
    const id = first.inputRequired.inputRequests.approval.params.url.split("/approve/")[1];
    const waited = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.messageId },
      { capabilities: URL_CAPS, inputResponses: { approval: { action: "accept" } }, requestState: state },
    );
    expect(waited.result).toMatchObject({ status: "pending_approval", action_id: id });
    await env.DB.prepare(
      "UPDATE pending_actions SET state = 'approved', approved_at = ?, approved_via = 'browser' WHERE id = ?",
    )
      .bind(Date.now(), id)
      .run();
    const done = await callTool(worker, e, token, "execute_pending", { action_id: id });
    expect(done.result).toMatchObject({ status: "executed", action_id: id });
    expect((await callTool(worker, e, token, "execute_pending", { action_id: id })).result.error).toBe(
      "pending_replayed",
    );
  });
  // The inline round-trip case moved to elicitation-zoho.test.ts (M3 Task 3.3).
});

describe("adversarial (spec 4.7)", () => {
  async function pendingWithState() {
    const m = seed();
    const first = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.messageId },
      { capabilities: URL_CAPS },
    );
    return {
      m,
      id: first.inputRequired.inputRequests.approval.params.url.split("/approve/")[1] as string,
      state: first.inputRequired.requestState as string,
    };
  }
  it("the routing headers are required and cross-checked: missing or mismatched Mcp-Method or Mcp-Name is refused before any handler", async () => {
    const m = seed();
    const requests = z.mail.requests.length;
    const pending = await pendingCount();
    for (const headers of [
      { "mcp-method": null },
      { "mcp-method": "tools/list" },
      { "mcp-name": null },
      { "mcp-name": "mark_message_spam" },
    ]) {
      const r = await modernCall(
        worker,
        e,
        token,
        "trash_message",
        { account: "personal", message_id: m.messageId },
        { capabilities: URL_CAPS, headers },
      );
      expect(r.status).toBe(400);
      // Measured: the SDK answers -32020 for a header/body mismatch, not the -32602 the plan predicted.
      expect(r.error?.code).toBe(-32020);
    }
    expect(z.mail.requests.length).toBe(requests);
    expect(await pendingCount()).toBe(pending);
  });
  it("requestState tampered one field at a time is refused before the handler runs", async () => {
    const { m, id, state } = await pendingWithState();
    const [v, body, mac] = state.split(".");
    const decode = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    const encode = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payload = decode(body!);
    const variants = [
      `${v}.${encode({ ...payload, p: { ...payload.p, pending_id: "pa_" + "Z".repeat(22) } })}.${mac}`,
      `${v}.${encode({ ...payload, p: { ...payload.p, account_id: "eb" } })}.${mac}`,
      `${v}.${encode({ ...payload, p: { ...payload.p, intent_hash: "0".repeat(64) } })}.${mac}`,
      `${v}.${encode({ ...payload, p: { ...payload.p, tool: "mark_message_spam" } })}.${mac}`,
      `${v}.${encode({ ...payload, exp: payload.exp + 100_000 })}.${mac}`,
      `${v}.${body}.${mac!.slice(0, -2)}AA`,
      `v0.${body}.${mac}`,
      "garbage",
    ];
    for (const bad of variants) {
      const r = await modernCall(
        worker,
        e,
        token,
        "trash_message",
        { account: "personal", message_id: m.messageId },
        { capabilities: URL_CAPS, inputResponses: { approval: { action: "accept" } }, requestState: bad },
      );
      expect(r.error).toMatchObject({ code: -32602, message: "Invalid or expired requestState" });
    }
    expect((await getPending(env.DB, id, "owner-sub"))!.state).toBe("pending");
    expect(z.mail.get(Z, m.messageId)!.folderId).not.toBe(z.mail.folderId(Z, "Trash"));
  });
  it("a valid requestState presented by another owner's token is refused by the binding", async () => {
    const { m, state } = await pendingWithState();
    const r = await modernCall(
      worker,
      e,
      otherToken,
      "trash_message",
      { account: "personal", message_id: m.messageId },
      { capabilities: URL_CAPS, inputResponses: { approval: { action: "accept" } }, requestState: state },
    );
    expect(r.error).toMatchObject({ code: -32602 });
  });
  it("a retried elicitation call with changed arguments is denied and audited, and the row stays pending", async () => {
    const { m, id, state } = await pendingWithState();
    const other = seed();
    const r = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: other.messageId },
      { capabilities: URL_CAPS, inputResponses: { approval: { action: "accept" } }, requestState: state },
    );
    expect(r.result).toMatchObject({ error: "payload_mismatch" });
    const row = await env.DB.prepare(
      "SELECT decision, pending_id FROM audit_log WHERE user_id='owner-sub' AND decision='payload_mismatch' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(row).toEqual({ decision: "payload_mismatch", pending_id: id });
    expect((await getPending(env.DB, id, "owner-sub"))!.state).toBe("pending");
    expect(z.mail.get(Z, m.messageId)!.folderId).not.toBe(z.mail.folderId(Z, "Trash"));
    expect(z.mail.get(Z, other.messageId)!.folderId).not.toBe(z.mail.folderId(Z, "Trash"));
  });
  it("a requestState for one tool cannot resume a different tool, even with matching arguments", async () => {
    const { m, state } = await pendingWithState();
    const r = await modernCall(
      worker,
      e,
      token,
      "mark_message_spam",
      { account: "personal", message_id: m.messageId },
      { capabilities: URL_CAPS, inputResponses: { approval: { action: "accept" } }, requestState: state },
    );
    expect(r.result).toMatchObject({ error: "payload_mismatch" });
  });
  it("a decline cancels; execute_pending under another owner is unknown; the approval page under another session is refused", async () => {
    const { m, id, state } = await pendingWithState();
    const other = new Browser(worker, e);
    await other.login(z, { sub: "other-sub", email: "other@example.test" });
    expect((await other.get(`/approve/${id}`)).status).toBe(404);
    expect((await callTool(worker, e, otherToken, "execute_pending", { action_id: id })).result.error).toBe(
      "pending_not_approved",
    );
    const r = await modernCall(
      worker,
      e,
      token,
      "trash_message",
      { account: "personal", message_id: m.messageId },
      { capabilities: URL_CAPS, inputResponses: { approval: { action: "decline" } }, requestState: state },
    );
    expect(r.result).toMatchObject({ error: "pending_not_approved" });
    expect((await getPending(env.DB, id, "owner-sub"))!.state).toBe("cancelled");
  });
});

describe("needs_reconnect and connect_account", () => {
  it("a needs_reconnect account answers a URL elicitation on the modern era and connect_required text otherwise", async () => {
    await env.DB.prepare("UPDATE accounts SET status = 'needs_reconnect' WHERE id = 'ea'").run();
    const modern = await modernCall(
      worker,
      e,
      token,
      "list_labels",
      { account: "personal" },
      { capabilities: URL_CAPS },
    );
    expect(modern.inputRequired).toMatchObject({ inputRequests: { connect: { params: { mode: "url" } } } });
    expect(modern.inputRequired.inputRequests.connect.params.url).toMatch(/\/connect\?slot=sarabi&e=/);
    const legacy = await callTool(worker, e, token, "list_labels", { account: "personal" });
    expect(legacy.result).toMatchObject({ status: "connect_required", account: "personal" });
    await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = 'ea'").run();
  });
  it("connect_account is an elicitation on the modern era and a URL otherwise", async () => {
    const modern = await modernCall(worker, e, token, "connect_account", { slot: "rcp" }, { capabilities: URL_CAPS });
    expect(modern.inputRequired.inputRequests.connect.params.url).toMatch(/\/connect\?slot=rcp&e=/);
    const legacy = await callTool(worker, e, token, "connect_account", { slot: "rcp" });
    expect(legacy.result).toMatchObject({ status: "connect_required", account: "rcp" });
  });
});

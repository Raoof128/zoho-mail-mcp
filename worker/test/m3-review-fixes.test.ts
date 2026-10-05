import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { approvePending, callTool } from "./zoho-helpers";
import { insertOperation } from "./fixtures";
import { setPolicy } from "../src/policy/engine";
import { probeDeliveries } from "../src/operations/probe";
import { hashCanonical } from "../src/crypto/canonical";
import { bodyDigestText } from "../src/operations/zoho-send";
import { accountStub } from "../src/zoho/account-do";
import { zohoJson } from "../src/zoho/client";

// Final review of M3 (2026-10-05), Important findings 1 to 8. Each test failed before its fix.
describe("I1: what policy checked is what is sent", () => {
  it("a recipient string hiding a second address is sent as the one address policy saw", async () => {
    const { z, e, d } = await zohoFixture();
    const r = await callTool(e, d, "u", "send_message", {
      account: "sarabi",
      to: ["evil@ext.example;<rcp@example.test>"],
      subject: "s",
      body: "b",
    });
    expect(r.status).toBe("executed");
    expect(z.mail.sent.at(-1)!.body.toAddress).toBe("rcp@example.test");
  });
});

describe("I2: quoted display names from Zoho do not break replies or drafts", () => {
  it("reply_all to a message whose recipients carry quoted names", async () => {
    const { z, e, d, Z, accountId } = await zohoFixture();
    await e.DB.prepare("INSERT INTO contact_allowlist (user_id, account_id, pattern) VALUES ('u', ?, '@example.org')")
      .bind(accountId)
      .run();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: '"Carla" <c@example.org>',
      to: ["sarabi@example.test", '"Doe, Jane" <j@example.org>'],
      subject: "Q",
      content: "q",
    });
    const r = await callTool(e, d, "u", "reply", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      reply_all: true,
      body: "ok",
    });
    expect(r.status).toBe("executed");
    expect(String(z.mail.sent.at(-1)!.body.toAddress).split(",").sort()).toEqual(["c@example.org", "j@example.org"]);
  });
  it("send_draft and update_draft on a draft with a quoted name", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Drafts",
      from: "sarabi@example.test",
      to: ['"R C P" <rcp@example.test>'],
      subject: "d",
      content: "x",
    });
    const u = await callTool(e, d, "u", "update_draft", { account: "sarabi", draft_id: m.messageId, subject: "d2" });
    expect(u.status).toBe("executed");
    const s = await callTool(e, d, "u", "send_draft", { account: "sarabi", draft_id: u.draft_id });
    expect(s.status).toBe("executed");
  });
});

describe("I3 and I4: the probe credits a Sent message to one operation only, by readable content", () => {
  it("a Sent message already attributed to another operation never settles a second one", async () => {
    const { z, e, d, Z, accountId } = await zohoFixture();
    const sent = z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "Same",
      content: "x",
    });
    await insertOperation(e.DB, "opA", "u", accountId, "executed");
    await e.DB.prepare("UPDATE operations SET provider_result_id = ? WHERE id = 'opA'").bind(sent.messageId).run();
    await insertOperation(e.DB, "opB", "u", accountId, "delivery_unknown");
    await e.DB.prepare("UPDATE operations SET settlement_context_json = ? WHERE id = 'opB'")
      .bind(
        JSON.stringify({
          from: "sarabi@example.test",
          to: ["c@example.org"],
          cc: [],
          subject: "Same",
          startedAt: Date.now() - 1000,
          attachmentCount: 0,
          attachmentNames: [],
          bodySha256: null,
        }),
      )
      .run();
    await probeDeliveries(e, d, Date.now());
    expect(
      (await e.DB.prepare("SELECT state FROM operations WHERE id = 'opB'").first<{ state: string }>())!.state,
    ).toBe("delivery_unknown");
  });
  it("a plain-text send matches the HTML Zoho stores for it", async () => {
    const { z, e, d, Z, accountId } = await zohoFixture();
    z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "Wrapped",
      content: "<div>Invoice&nbsp;12 is   attached</div>",
    });
    await insertOperation(e.DB, "opW", "u", accountId, "delivery_unknown");
    await e.DB.prepare("UPDATE operations SET settlement_context_json = ? WHERE id = 'opW'")
      .bind(
        JSON.stringify({
          from: "sarabi@example.test",
          to: ["c@example.org"],
          cc: [],
          subject: "Wrapped",
          startedAt: Date.now() - 1000,
          attachmentCount: 0,
          attachmentNames: [],
          bodySha256: await hashCanonical(bodyDigestText("Invoice 12 is attached")),
        }),
      )
      .run();
    await probeDeliveries(e, d, Date.now());
    expect(
      (await e.DB.prepare("SELECT state FROM operations WHERE id = 'opW'").first<{ state: string }>())!.state,
    ).toBe("executed");
  });
});

describe("I5: a failure after a successful draft save is reported as success with cleanup pending", () => {
  it("update_draft whose folder lookup fails after the save", async () => {
    const { z, e, d, Z, accountId } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Drafts",
      from: "sarabi@example.test",
      to: ["rcp@example.test"],
      subject: "d",
      content: "x",
    });
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "draft.write", level: "ask" });
    const pending = await callTool(e, d, "u", "update_draft", {
      account: "sarabi",
      draft_id: m.messageId,
      subject: "d2",
    });
    expect(pending.status).toBe("pending_approval");
    await accountStub(e, accountId).setCache("folders", "x", -1); // cold cache at execution
    z.mail.faults.push(
      { status: 503, errorCode: "DOWN", pathRe: /^\/folders$/ },
      { status: 503, errorCode: "DOWN", pathRe: /^\/folders$/ },
      { status: 503, errorCode: "DOWN", pathRe: /^\/folders$/ },
    );
    const r = await approvePending(e, d, "u", pending);
    expect(r.status).toBe("executed");
    expect(r.old_draft_cleanup).toBe("pending");
    await setPolicy(e.DB, { userId: "u", accountId: null, action: "draft.write", level: "allow" }); // policies persist across cases
  });
});

describe("I6: a refusal before the request is opened is failed_safe, not delivery_unknown", () => {
  it("the account bucket refusing the send", async () => {
    const { e, d, acct, accountId } = await zohoFixture();
    for (let i = 0; i < 25; i++)
      await zohoJson(e, d, { ...acct, toolCallId: `fill${i}` }, { method: "GET", path: "folders", retry: "safe" });
    await expect(
      callTool(e, d, "u", "send_message", {
        account: "sarabi",
        to: ["rcp@example.test"],
        subject: "bucket",
        body: "b",
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    const row = await e.DB.prepare("SELECT state FROM operations WHERE account_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(accountId)
      .first<{ state: string }>();
    expect(row!.state).toBe("failed_safe");
  });
});

describe("I7: the owner is told a draft's Bcc is not carried", () => {
  it("send_draft's approval summary says so", async () => {
    const { e, d } = await zohoFixture();
    const c = await callTool(e, d, "u", "create_draft", {
      account: "sarabi",
      to: ["outside@else.example"],
      subject: "s",
      body: "x",
    });
    const p = await callTool(e, d, "u", "send_draft", { account: "sarabi", draft_id: c.draft_id });
    expect(p.summary).toMatch(/Bcc on the draft is not carried/);
  });
});

describe("I8: forward keeps the quoted original and the blocked list", () => {
  it("refuses html_body on forward and refuses a blocked original attachment", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "f",
      content: "c",
      attachments: [{ name: "run.exe", bytes: new Uint8Array([1]), mime: "application/octet-stream" }],
    });
    await expect(
      callTool(e, d, "u", "forward", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        to: ["rcp@example.test"],
        html_body: "<b>x</b>",
      }),
    ).rejects.toThrow();
    await expect(
      callTool(e, d, "u", "forward", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        to: ["rcp@example.test"],
        include_original_attachments: true,
      }),
    ).rejects.toMatchObject({ code: "blocked_extension" });
  });
});

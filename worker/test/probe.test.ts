import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { insertOperation } from "./fixtures";
import { probeDeliveries } from "../src/operations/probe";

const ctx = (subject: string) =>
  JSON.stringify({
    from: "sarabi@example.test",
    to: ["c@example.org"],
    cc: [],
    subject,
    startedAt: Date.now() - 60_000,
    attachmentCount: 0,
    attachmentNames: [],
    bodySha256: null,
  });

describe("positive-only recovery (5.5, G18)", () => {
  it("exactly one full match settles sent; zero stays unknown; two stay unknown", async () => {
    const { z, e, d, Z, accountId } = await zohoFixture();
    for (const [id, subject] of [
      ["one", "Invoice A"],
      ["zero", "Never sent"],
      ["two", "Dup"],
    ] as const) {
      await insertOperation(e.DB, id, "u", accountId, "delivery_unknown");
      await e.DB.prepare("UPDATE operations SET settlement_context_json=? WHERE id=?").bind(ctx(subject), id).run();
    }
    z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "Invoice A",
      content: "x",
    });
    z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "Dup",
      content: "x",
    });
    z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "Dup",
      content: "y",
    });
    const r = await probeDeliveries(e, d, Date.now());
    expect(r.settled).toBe(1);
    const states = Object.fromEntries(
      (
        await e.DB.prepare("SELECT id, state FROM operations WHERE id IN ('one','zero','two')").all<{
          id: string;
          state: string;
        }>()
      ).results.map((x) => [x.id, x.state]),
    );
    expect(states).toEqual({ one: "executed", zero: "delivery_unknown", two: "delivery_unknown" });
  });
  it("a search error leaves the operation unknown and never retries the send", async () => {
    const { z, e, d, accountId } = await zohoFixture();
    await insertOperation(e.DB, "err", "u", accountId, "delivery_unknown");
    await e.DB.prepare("UPDATE operations SET settlement_context_json=? WHERE id=?").bind(ctx("E"), "err").run();
    z.mail.faults.push({ status: 500, errorCode: "DOWN" });
    const r = await probeDeliveries(e, d, Date.now());
    expect(r.settled).toBe(0); // other cases' unknown rows may still be present in this D1; only ours matters
    expect((await e.DB.prepare("SELECT state FROM operations WHERE id='err'").first<{ state: string }>())!.state).toBe(
      "delivery_unknown",
    );
    expect(z.mail.sent).toHaveLength(0);
  });
});

describe("close as not sent (5.5): the only path from delivery_unknown to failed_safe", () => {
  it("the operations page lists the unknown send and the owner closes it, audited; without the form token it is refused", async () => {
    const { createWorker } = await import("../src/index");
    const { loginAs } = await import("./zoho-helpers");
    const { csrfFrom } = await import("./browser");
    const { z, e, d, accountId } = await zohoFixture();
    await insertOperation(e.DB, "unk1", "u", accountId, "delivery_unknown");
    const w = createWorker(d);
    const b = await loginAs(w, e, z, { sub: "u", email: "u@example.test" });
    const html = await (await b.get("/audit")).text();
    expect(html).toContain("unk1");
    const forged = await b.post("/audit/close", { operation_id: "unk1", csrf: "nope" });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect((await e.DB.prepare("SELECT state FROM operations WHERE id='unk1'").first<{ state: string }>())!.state).toBe(
      "delivery_unknown",
    );
    const ok = await b.post("/audit/close", { operation_id: "unk1", csrf: csrfFrom(html, "/audit/close") });
    expect(ok.status).toBeLessThan(400);
    expect((await e.DB.prepare("SELECT state FROM operations WHERE id='unk1'").first<{ state: string }>())!.state).toBe(
      "failed_safe",
    );
    const audit = await e.DB.prepare("SELECT decision FROM audit_log WHERE operation_id='unk1'").all<{
      decision: string;
    }>();
    expect(audit.results.map((r) => r.decision)).toContain("closed_not_sent");
  });
});

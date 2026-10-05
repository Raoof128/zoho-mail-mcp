import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { insertOperation } from "./fixtures";
import { executeZohoSend } from "../src/operations/zoho-send";

describe("executeZohoSend", () => {
  it("moves claimed to executing to executed and records the Zoho message id", async () => {
    const { z, e, d, acct, Z } = await zohoFixture();
    await insertOperation(e.DB, "op1", "u", acct.accountId, "claimed");
    const r = await executeZohoSend(e, d, {
      ...acct,
      operationId: "op1",
      kind: "send",
      body: { fromAddress: "sarabi@example.test", toAddress: "c@example.org", subject: "S", content: "b" },
    });
    expect(r.message_id).toBe(z.mail.sent[0]!.messageId);
    const row = await e.DB.prepare("SELECT state, provider_result_id FROM operations WHERE id='op1'").first<{
      state: string;
      provider_result_id: string;
    }>();
    expect(row).toEqual({ state: "executed", provider_result_id: r.message_id });
    expect(z.mail.sent[0]!.accountId).toBe(Z);
  });
  it("leaves the row executing when the response is lost, and claimed when refused before the request", async () => {
    const { z, e, d, acct } = await zohoFixture();
    await insertOperation(e.DB, "op2", "u", acct.accountId, "claimed");
    z.mail.faults.push({ status: 503, errorCode: "DOWN", pathRe: /^\/messages$/ });
    await expect(
      executeZohoSend(e, d, {
        ...acct,
        operationId: "op2",
        kind: "send",
        body: { fromAddress: "sarabi@example.test", toAddress: "c@example.org" },
      }),
    ).rejects.toBeTruthy();
    expect((await e.DB.prepare("SELECT state FROM operations WHERE id='op2'").first<{ state: string }>())!.state).toBe(
      "executing",
    );
    await insertOperation(e.DB, "op3", "u", acct.accountId, "claimed");
    await expect(
      executeZohoSend(e, d, {
        ...acct,
        operationId: "op3",
        kind: "send",
        body: { fromAddress: "nobody@example.test", toAddress: "c@example.org" },
      }),
    ).rejects.toMatchObject({ code: "invalid_address" });
    expect((await e.DB.prepare("SELECT state FROM operations WHERE id='op3'").first<{ state: string }>())!.state).toBe(
      "claimed",
    );
  });
});

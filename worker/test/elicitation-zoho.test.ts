import { describe, it, expect } from "vitest";
import { createWorker } from "../src/index";
import { FakeZoho } from "./fake-zoho";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { modernCall } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";

// Moved from elicitation.test.ts in M3 Task 3.3 when send_message moved to Zoho.
const URL_CAPS = { elicitation: { url: {} } };

describe("inline attachments through an elicited approval (Zoho)", () => {
  it("an inline attachment survives the round trip: the accepted retry hashes to the same intent and uploads nothing twice", async () => {
    const e = testEnv();
    const z = await FakeZoho.create();
    const worker = createWorker(testDeps(z));
    await seedUserAndAccount(e.DB, {
      userId: "owner-sub",
      accountId: "eaz",
      alias: "sarabi",
      slot: "sarabi",
      zohoAccountId: "1950001",
      email: "sarabi@example.test",
      isDefault: true,
    });
    z.accounts.set("sub-eaz", { accountId: "1950001", primaryEmail: "sarabi@example.test", sendAs: [] });
    await seedAccessToken(e, { userId: "owner-sub", accountId: "eaz", access: z.directToken("1950001") });
    const token = (await mintToken(worker, e, z, { scope: "mcp" })).accessToken;
    const args = {
      account: "sarabi",
      to: ["someone@else.test"],
      subject: "inline",
      body: "b",
      inline_attachments: [{ filename: "i.txt", mime: "text/plain", content_base64: btoa("inline") }],
    };
    const first = await modernCall(worker, e, token, "send_message", args, { capabilities: URL_CAPS });
    expect(first.inputRequired).toMatchObject({ resultType: "input_required" });
    expect(z.mail.uploads.size).toBe(1);
    const id = first.inputRequired.inputRequests.approval.params.url.split("/approve/")[1];
    await e.DB.prepare(
      "UPDATE pending_actions SET state = 'approved', approved_at = ?, approved_via = 'browser' WHERE id = ?",
    )
      .bind(Date.now(), id)
      .run();
    const retry = await modernCall(worker, e, token, "send_message", args, {
      capabilities: URL_CAPS,
      inputResponses: { approval: { action: "accept" } },
      requestState: first.inputRequired.requestState,
    });
    expect(retry.result).toMatchObject({ status: "executed", action_id: id });
    expect(z.mail.uploads.size).toBe(1);
    expect((z.mail.sent.at(-1)!.body.attachments as { attachmentName: string }[]).map((a) => a.attachmentName)).toEqual(
      ["i.txt"],
    );
  });
});

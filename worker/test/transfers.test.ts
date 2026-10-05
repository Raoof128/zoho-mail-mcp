import { zohoFixture } from "./zoho-mail.test";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { ensureTransfer } from "../src/staging/transfers";
beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: "transfer-owner", accountId: "transfer-account", alias: "work" });
  await seedUserAndAccount(env.DB, { userId: "other-owner", accountId: "other-account", alias: "work" });
});
describe("transfer persistence", () => {
  it("enforces owner/account pairing in the database", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO upload_transfers (user_id,id,account_id,account_alias,metadata_json,intent_hash,state,created_at,authority_until,retain_until) VALUES (?,?,?,?,?,?,'authorized',0,100,200)",
      )
        .bind("transfer-owner", "tr_bad", "other-account", "work", "{}", "hash")
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
  it("allows only one active generation per transfer", async () => {
    await env.DB.prepare(
      "INSERT INTO upload_transfers (user_id,id,account_id,account_alias,metadata_json,intent_hash,state,created_at,authority_until,retain_until) VALUES (?,?,?,?,?,?,'authorized',0,100,200)",
    )
      .bind("transfer-owner", "tr_one", "transfer-account", "work", "{}", "hash")
      .run();
    const add = (n: number) =>
      env.DB.prepare(
        "INSERT INTO upload_generations (user_id,transfer_id,account_id,generation,ticket_id,state,issued_until,provider_ref,reserved_bytes,created_at) VALUES (?,?,?,?,?,'issued',100,?,0,0)",
      )
        .bind("transfer-owner", "tr_one", "transfer-account", n, `ticket_${n}`, `stg/test/${n}`)
        .run();
    await add(1);
    await expect(add(2)).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare("UPDATE upload_generations SET state='expired' WHERE transfer_id='tr_one'").run();
    await add(2);
  });
});

it("staging from the outbox root is allowed; from any other root it asks with +outside_outbox", async () => {
  const { e } = await zohoFixture();
  const principal = { userId: "u", email: "u@example.test", scope: "staging" as const };
  const meta = { filename: "a.pdf", size: 3, mime: "application/pdf", sha256: "0".repeat(64) };
  const ok = await ensureTransfer(e, principal, {
    mode: "ensure",
    transfer_id: "tr_" + "a".repeat(43),
    account: "sarabi",
    metadata: { ...meta, root: "outbox" },
  });
  // Allowed: the upload ticket is issued at once (the plan expected "authorized"; this API answers "issued").
  expect(ok.state).toBe("issued");
  const ask = await ensureTransfer(e, principal, {
    mode: "ensure",
    transfer_id: "tr_" + "b".repeat(43),
    account: "sarabi",
    metadata: { ...meta, root: "documents" },
  });
  expect(ask.state).toBe("awaiting_approval");
  expect(ask.approval_url).toBeDefined();
});

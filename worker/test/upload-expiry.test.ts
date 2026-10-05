import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedUserAndAccount, insertOperation } from "./fixtures";
import { testEnv } from "./test-env";
import { runCron } from "../src/cron";

// Background security review of 421a605 (2026-10-05): removing the R2 upload recovery also removed the expiry of
// stale tickets, stuck uploads and lapsed transfers, so they held their caps forever. This failed first.
describe("the cron expires stale upload state (no bytes to delete since M5)", () => {
  it("abandons a stuck upload, expires its lapsed transfer and fails its operation safe", async () => {
    await seedUserAndAccount(env.DB, { userId: "ux", accountId: "ax", alias: "sarabi", slot: "sarabi" });
    await insertOperation(env.DB, "op_up", "ux", "ax", "executing");
    await env.DB.prepare("UPDATE operations SET action = 'attachment.stage_upload' WHERE id = 'op_up'").run();
    const past = Date.now() - 3_600_000;
    await env.DB.prepare(
      `INSERT INTO upload_transfers (user_id,id,account_id,account_alias,metadata_json,intent_hash,state,operation_id,active_generation,created_at,authority_until,retain_until)
       VALUES ('ux','tr_x','ax','sarabi','{}','h','in_progress','op_up',1,?,?,?)`,
    )
      .bind(past, past, Date.now() + 86_400_000)
      .run();
    await env.DB.prepare(
      `INSERT INTO upload_generations (user_id,transfer_id,account_id,generation,ticket_id,state,issued_until,admitted_at,lease_until,provider_ref,reserved_bytes,created_at)
       VALUES ('ux','tr_x','ax',1,'ut_x','uploading',?,?,?,'',0,?)`,
    )
      .bind(past, past, past, past)
      .run();
    await runCron(testEnv(), Date.now());
    const g = await env.DB.prepare(
      "SELECT state, cleanup_state FROM upload_generations WHERE ticket_id = 'ut_x'",
    ).first();
    expect(g).toEqual({ state: "abandoned", cleanup_state: "released" });
    expect(await env.DB.prepare("SELECT state FROM upload_transfers WHERE id = 'tr_x'").first()).toEqual({
      state: "expired",
    });
    expect(await env.DB.prepare("SELECT state FROM operations WHERE id = 'op_up'").first()).toEqual({
      state: "failed_safe",
    });
  });
});

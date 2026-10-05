import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedUserAndAccount, insertOperation } from "./fixtures";
import {
  insertSealed,
  listUploadHandles,
  reserveStatements,
  consume,
  release,
  purgeExpiredSealed,
} from "../src/staging/sealed";

const H = (c: string) => "sh_" + c.repeat(43);
describe("sealed handles", () => {
  it("lists only unexpired, unconsumed uploads owned by the account; reserve, consume, release", async () => {
    await seedUserAndAccount(env.DB, { userId: "u", accountId: "a", alias: "sarabi", slot: "sarabi" });
    await insertOperation(env.DB, "op1", "u", "a", "claimed");
    const now = Date.now();
    await insertSealed(env.DB, {
      handle: H("a"),
      user_id: "u",
      account_id: "a",
      direction: "upload",
      provider_ref: JSON.stringify({ storeName: "s", attachmentPath: "p", attachmentName: "n" }),
      filename: "n",
      mime: "text/plain",
      size: 1,
      sha256: "0".repeat(64),
      created_at: now,
      expires_at: now + 60_000,
    });
    await insertSealed(env.DB, {
      handle: H("b"),
      user_id: "u",
      account_id: "a",
      direction: "upload",
      provider_ref: "{}",
      filename: "n",
      mime: "text/plain",
      size: 1,
      sha256: "0".repeat(64),
      created_at: now - 10,
      expires_at: now - 1,
    });
    expect(
      (await listUploadHandles(env.DB, { handles: [H("a")], userId: "u", accountId: "a" })).map((r) => r.handle),
    ).toEqual([H("a")]);
    await expect(listUploadHandles(env.DB, { handles: [H("b")], userId: "u", accountId: "a" })).rejects.toMatchObject({
      code: "handle_invalid",
    });
    await env.DB.batch(
      reserveStatements(env.DB, { operationId: "op1", handles: [H("a")], userId: "u", accountId: "a", now }),
    );
    await insertOperation(env.DB, "op2", "u", "a", "claimed");
    // Re-reserving for the same operation is idempotent; a different operation must be refused.
    await expect(
      env.DB.batch(
        reserveStatements(env.DB, { operationId: "op2", handles: [H("a")], userId: "u", accountId: "a", now }),
      ),
    ).rejects.toThrow(/CHECK/);
    await release(env.DB, "op1");
    await env.DB.batch(
      reserveStatements(env.DB, { operationId: "op1", handles: [H("a")], userId: "u", accountId: "a", now }),
    );
    await consume(env.DB, "op1");
    await expect(listUploadHandles(env.DB, { handles: [H("a")], userId: "u", accountId: "a" })).rejects.toMatchObject({
      code: "handle_invalid",
    });
    expect((await purgeExpiredSealed(env.DB, now + 1)).deleted).toBeGreaterThanOrEqual(1);
  });
});

describe("the cron sweep", () => {
  it("purges expired sealed handles (M3 Task 3.1)", async () => {
    const { runCron } = await import("../src/cron");
    const { testEnv } = await import("./test-env");
    await seedUserAndAccount(env.DB, { userId: "uc", accountId: "ac", alias: "rcp", slot: "rcp" });
    const now = Date.now();
    await insertSealed(env.DB, {
      handle: H("c"),
      user_id: "uc",
      account_id: "ac",
      direction: "upload",
      provider_ref: "{}",
      filename: "n",
      mime: "text/plain",
      size: 1,
      sha256: "0".repeat(64),
      created_at: now - 10,
      expires_at: now - 1,
    });
    await runCron(testEnv(), now);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM sealed_handles WHERE handle = ?")
      .bind(H("c"))
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});

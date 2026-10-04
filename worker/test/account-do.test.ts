import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { accountStub, BUCKET_CAPACITY, BUDGETS } from "../src/zoho/account-do";

describe("AccountDO", () => {
  it("admits 25 requests a minute per account and refuses the 26th with a retry_after", async () => {
    const stub = accountStub(env, "bucket-1");
    for (let i = 0; i < BUCKET_CAPACITY; i++) expect(await stub.admit(`c${i}`)).toEqual({ ok: true });
    const r = await stub.admit("c26");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retry_after_ms).toBeGreaterThan(0);
    const other = accountStub(env, "bucket-2");
    expect(await other.admit("x")).toEqual({ ok: true });
  });
  it("counts budgets per tool call and refuses past the cap", async () => {
    const stub = accountStub(env, "budget-1");
    for (let i = 0; i < BUDGETS.requests; i++) expect(await stub.budget("call-a", "requests", 1)).toBe(true);
    expect(await stub.budget("call-a", "requests", 1)).toBe(false);
    expect(await stub.budget("call-b", "requests", 1)).toBe(true);
    expect(await stub.budget("call-a", "bytes", BUDGETS.bytes)).toBe(true);
    expect(await stub.budget("call-a", "bytes", 1)).toBe(false);
  });
  it("hands the refresh lease to one holder at a time and expires it", async () => {
    const stub = accountStub(env, "lease-1");
    expect(await stub.acquireRefreshLease("h1", 50)).toBe("acquired");
    expect(await stub.acquireRefreshLease("h2", 50)).toBe("held");
    await new Promise((r) => setTimeout(r, 60));
    expect(await stub.acquireRefreshLease("h2", 50)).toBe("acquired");
    await stub.releaseRefreshLease("h2");
    expect(await stub.acquireRefreshLease("h3", 50)).toBe("acquired");
  });
  it("caches a value with a ttl", async () => {
    // Deterministic: no sleeping. A 50 ms ttl read back immediately failed under host load (M1 Task 1.6).
    const stub = accountStub(env, "cache-1");
    await stub.setCache("folders", JSON.stringify({ inbox: "1" }), 60_000);
    expect(await stub.getCache("folders")).toBe(JSON.stringify({ inbox: "1" }));
    await stub.setCache("folders", JSON.stringify({ inbox: "2" }), -1);
    expect(await stub.getCache("folders")).toBeNull();
    expect(await stub.getCache("never-set")).toBeNull();
  });
});

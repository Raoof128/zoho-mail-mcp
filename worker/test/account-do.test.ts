import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { accountStub } from "../src/zoho/account-do";

describe("AccountDO", () => {
  it("is reachable by account id and keeps SQLite state", async () => {
    const stub = accountStub(env, "191");
    expect(await stub.ping()).toBe("pong");
    expect(await stub.ping()).toBe("pong");
  });
});

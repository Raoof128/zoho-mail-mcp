import { describe, it, expect } from "vitest";
import { FakeZoho } from "./fake-zoho";
import { testEnv, testDeps } from "./test-env";
import { seedUserAndAccount } from "./fixtures";
import { callTool } from "./zoho-helpers";

describe("zoho test helpers", () => {
  it("mints a token for the user and calls a control tool", async () => {
    const z = await FakeZoho.create();
    const e = testEnv();
    await seedUserAndAccount(e.DB, { userId: "u", accountId: "a", alias: "sarabi", slot: "sarabi" });
    const r = await callTool(e, testDeps(z), "u", "list_accounts", {});
    expect(r.accounts.map((a: { alias: string }) => a.alias)).toEqual(["sarabi"]);
  });
  it("throws the error code of a refused call", async () => {
    const z = await FakeZoho.create();
    const e = testEnv();
    await expect(callTool(e, testDeps(z), "u", "get_policy", { account: "nope" })).rejects.toMatchObject({
      code: "account_not_found",
    });
  });
});

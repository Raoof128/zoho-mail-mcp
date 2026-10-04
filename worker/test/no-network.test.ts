import { describe, it, expect } from "vitest";
import { defaultDeps } from "../src/deps";

describe("tests never reach the network", () => {
  // A test that forgets to stub zohoFetch or googleFetch falls back to defaultDeps and would otherwise call the
  // real provider. Found in M1 Task 1.6: two recovery tests sent a refresh to the real accounts.zoho.com.au.
  it("refuses a real outbound fetch from defaultDeps", async () => {
    await expect(
      defaultDeps.zohoFetch("https://accounts.zoho.com.au/oauth/v2/token", { method: "POST" }),
    ).rejects.toThrow(/network disabled in tests/);
    await expect(defaultDeps.googleFetch("https://gmail.googleapis.com/gmail/v1/users/me/messages")).rejects.toThrow(
      /network disabled in tests/,
    );
  });
});

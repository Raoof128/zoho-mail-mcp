import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDeps } from "../src/deps";

// Security review of 8acf7e2: gmail.ts and the recovery probe now hold Zoho access tokens (zoho/tokens), so a live
// Gmail transport would hand a Zoho bearer token to gmail.googleapis.com. In production the seam must refuse.
describe("the retired Gmail transport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses every request in production and never reaches the network with a Zoho token", async () => {
    const net = vi.spyOn(globalThis, "fetch");
    await expect(
      defaultDeps.googleFetch("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
        headers: { authorization: "Bearer 1000.zoho-access-token" },
      }),
    ).rejects.toThrow(/Gmail transport is retired/);
    expect(net).not.toHaveBeenCalled();
  });
});

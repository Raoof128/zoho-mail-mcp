import { describe, it, expect } from "vitest";
import { ownerSubs, slots, orgDomains } from "../src/env";
import { testEnv, testDeps } from "./test-env";
import { FakeZoho } from "./fake-zoho";

describe("env", () => {
  it("reads owner subs from OWNER_ZOHO_SUBS and slots from SLOTS", () => {
    const e = testEnv({
      OWNER_ZOHO_SUBS: " 111 , 222 ",
      SLOTS: JSON.stringify({ sarabi: "info@sarabisfinerugs.com.au", rcp: "info@rugcleaningpro.com.au" }),
    });
    expect(ownerSubs(e)).toEqual(["111", "222"]);
    expect(slots(e)).toEqual({ sarabi: "info@sarabisfinerugs.com.au", rcp: "info@rugcleaningpro.com.au" });
    expect(orgDomains(testEnv({ ORG_DOMAINS: "sarabisfinerugs.com.au, rugcleaningpro.com.au" }))).toEqual([
      "sarabisfinerugs.com.au",
      "rugcleaningpro.com.au",
    ]);
  });
  it("refuses SLOTS that is not exactly the two known slots", () => {
    expect(() => slots(testEnv({ SLOTS: JSON.stringify({ sarabi: "a@b.c" }) }))).toThrow(/SLOTS/);
  });
  it("routes every outbound call through deps.zohoFetch", async () => {
    const z = await FakeZoho.create();
    const d = testDeps(z);
    expect(typeof d.zohoFetch).toBe("function");
  });
});

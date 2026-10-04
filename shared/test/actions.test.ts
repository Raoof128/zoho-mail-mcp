import { describe, it, expect } from "vitest";
import { ACTIONS, MODIFIERS, DEFAULT_POLICY, raise } from "../src/actions.ts";

describe("Zoho policy registry", () => {
  it("carries the four new actions and two new modifiers", () => {
    for (const a of ["folder.move", "flag.set", "read.mark", "archive.set"]) expect(ACTIONS).toContain(a);
    for (const m of ["+destructive", "+outside_outbox"]) expect(MODIFIERS).toContain(m);
  });
  it("defaults follow spec section 6: sends allow until a modifier raises them, forward/trash/spam ask", () => {
    expect(DEFAULT_POLICY["send.message"]).toBe("allow");
    expect(DEFAULT_POLICY["send.draft"]).toBe("allow");
    expect(DEFAULT_POLICY["send.forward"]).toBe("ask");
    expect(DEFAULT_POLICY["trash.move"]).toBe("ask");
    expect(DEFAULT_POLICY["spam.mark"]).toBe("ask");
    // Sequenced with their raising modifiers (security review of M0 Task 0.4): label.manage becomes allow in
    // M4 Task 4.1 together with +destructive on delete_label; attachment.stage_upload becomes allow in M5 Task 5.3
    // together with +outside_outbox. Until then an allow default would let a label delete, or staging from any
    // root, run without approval.
    expect(DEFAULT_POLICY["label.manage"]).toBe("ask");
    expect(DEFAULT_POLICY["attachment.stage_upload"]).toBe("ask");
    for (const a of ["folder.move", "flag.set", "read.mark", "archive.set"] as const)
      expect(DEFAULT_POLICY[a]).toBe("allow");
    expect(DEFAULT_POLICY["policy.edit"]).toBe("browser");
  });
  it("modifiers only raise", () => {
    expect(raise("allow")).toBe("ask");
    expect(raise("ask")).toBe("ask");
    expect(raise("deny")).toBe("deny");
  });
});

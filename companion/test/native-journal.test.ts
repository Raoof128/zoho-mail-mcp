import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/native/journal.ts";

it("stores records under scope and key, refuses a different request hash for the same key, and reserves bytes within a budget", () => {
  const j = new Journal(join(mkdtempSync(join(tmpdir(), "zmj-")), "journal.sqlite"));
  j.put("transfer:s", "k", "h1", "p1");
  expect(j.get("transfer:s", "k")).toEqual({ requestHash: "h1", payload: "p1" });
  expect(() => j.put("transfer:s", "k", "h2", "p2")).toThrow("idempotency_conflict");
  j.put("transfer:s", "k", "h1", "p3");
  expect(j.get("transfer:s", "k")!.payload).toBe("p3");
  j.reserve("tr_a", 1000, 2000, 2);
  j.reserve("tr_b", 1000, 2000, 2);
  expect(() => j.reserve("tr_c", 1, 2000, 2)).toThrow("spool_budget");
  j.release("tr_a");
  expect(j.reservedBytes("tr_a")).toBeNull();
  expect(j.snapshotReservations()).toEqual(["tr_b"]);
  expect(j.entries("transfer:")).toHaveLength(1);
});

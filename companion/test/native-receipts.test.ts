// Ported from the retired Swift helper's ReceiptTests and RestartTests (final review I4): the
// receipt-state and debt guarantees, pinned against the Node port.
import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/native/journal.ts";
import { SafeFiles } from "../src/native/safe-files.ts";
import { SaveReceipts } from "../src/native/receipts.ts";

const bytes = Buffer.from("payload");
const sha = SafeFiles.digest(bytes);
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "zmr-"));
  const root = join(base, "out");
  const priv = join(base, "private");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(priv, { mode: 0o700 });
  const files = new SafeFiles({ attachments: { path: root, read: false, write: true } }, priv);
  const journal = new Journal(join(priv, "journal.sqlite"));
  return { root, journal, saves: new SaveReceipts(files, journal) };
}
const temporaryIn = (root: string) => readdirSync(root).find((f) => f.startsWith(".zoho-mail-mcp-"))!;
/** The production route to a charged receipt: an occupied destination refuses the publish and leaves the temporary. */
function occupiedPublish(root: string, saves: SaveReceipts) {
  writeFileSync(join(root, "a.txt"), "occupied");
  expect(() => saves.publish("s", "h", "attachments", "a.txt", bytes, sha)).toThrow("publish");
  return temporaryIn(root);
}

it("keeps the save budget durable and frees it after a safe recovery", () => {
  const { saves } = fixture();
  saves.prepare("owner", "one", "attachments", "one.txt");
  expect(() => saves.prepare("owner", "two", "attachments", "two.txt")).toThrow("spool_budget");
  saves.recover("owner", "one", "attachments", "one.txt");
  expect(saves.prepare("owner", "two", "attachments", "two.txt").state).toBe("prepared");
});
it("never lets a changed destination become acknowledgable, and refuses a different path for the handle", () => {
  const { root, saves } = fixture();
  expect(() =>
    saves.publish("owner", "h", "attachments", "a.txt", bytes, sha, () => {
      throw new Error("crash");
    }),
  ).toThrow("crash");
  writeFileSync(join(root, "a.txt"), "different");
  expect(() => saves.recover("owner", "h", "attachments", "a.txt")).toThrow("publication_unknown");
  expect(() => saves.recover("owner", "h", "attachments", "b.txt")).toThrow("idempotency_conflict");
});
it("lists the charge a hand-deleted temporary leaves, and a release repairs accounting only", () => {
  const { root, journal, saves } = fixture();
  rmSync(join(root, occupiedPublish(root, saves)));
  expect(() => saves.recover("s", "h", "attachments", "a.txt")).toThrow("publication_unknown");
  expect(saves.unresolvedDebt()).toEqual([
    {
      scope: "s",
      handle: "h",
      state: "publication_unknown",
      root: "attachments",
      relative: "a.txt",
      bytes: SafeFiles.maximum,
      temporary: "absent",
      releasable: true,
    },
  ]);
  expect(saves.releaseDebt("s", "h")).toBe("released");
  expect(saves.unresolvedDebt()).toEqual([]);
  expect((JSON.parse(journal.get("save:s", "h")!.payload) as { state: string }).state).toBe("publication_unknown");
  expect(saves.releaseDebt("s", "h")).toBe("not_charged");
  expect(saves.releaseDebt("s", "absent")).toBe("no_such_receipt");
});
it("refuses to release a receipt the collector can still handle", () => {
  const { root, saves } = fixture();
  occupiedPublish(root, saves);
  const [row] = saves.unresolvedDebt();
  expect(row).toMatchObject({ state: "verified", temporary: "present", releasable: false });
  expect(() => saves.releaseDebt("s", "h")).toThrow("receipt_not_releasable");
});
it("refuses a release when something else now holds the temporary's name", () => {
  const { root, saves } = fixture();
  const temp = occupiedPublish(root, saves);
  rmSync(join(root, temp));
  expect(() => saves.recover("s", "h", "attachments", "a.txt")).toThrow("publication_unknown");
  writeFileSync(join(root, temp), "not ours");
  expect(() => saves.releaseDebt("s", "h")).toThrow("temporary_still_present");
});
it("collects its own temporary at startup, and leaves one whose inode no longer matches", () => {
  const { root, saves } = fixture();
  const temp = occupiedPublish(root, saves);
  saves.recoverStartup();
  expect(saves.unresolvedDebt()).toEqual([]);
  expect(existsSync(join(root, temp))).toBe(false);
});
it("never returns a published receipt to prepared when its destination was replaced", () => {
  const { root, saves } = fixture();
  expect(saves.publish("owner", "h", "attachments", "a.txt", bytes, sha).state).toBe("published");
  writeFileSync(join(root, "a.txt"), "someone else wrote here");
  for (let i = 0; i < 2; i++)
    expect(() => saves.recover("owner", "h", "attachments", "a.txt")).toThrow("publication_unknown");
  expect(() => saves.publish("owner", "h", "attachments", "a.txt", bytes, sha)).toThrow();
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("someone else wrote here");
});
it("never reopens an acknowledged receipt whose destination is missing", () => {
  const { root, saves } = fixture();
  saves.publish("owner", "h", "attachments", "a.txt", bytes, sha);
  expect(saves.acknowledge("owner", "h", "attachments", "a.txt").state).toBe("acknowledged");
  rmSync(join(root, "a.txt"));
  expect(() => saves.recover("owner", "h", "attachments", "a.txt")).toThrow("publication_unknown");
  expect(() => saves.acknowledge("owner", "h", "attachments", "a.txt")).toThrow();
});
it("does not treat a destination file without a receipt as success, and never overwrites it", () => {
  const { root, saves } = fixture();
  writeFileSync(join(root, "a.txt"), "pre-existing content");
  expect(saves.recover("owner", "h", "attachments", "a.txt")).toBeNull();
  expect(() => saves.publish("owner", "h", "attachments", "a.txt", bytes, sha)).toThrow();
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("pre-existing content");
});

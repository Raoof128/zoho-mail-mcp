import { randomUUID } from "node:crypto";
import { NativeRefusal } from "./config.ts";
import type { Journal } from "./journal.ts";
import { SafeFiles, type FileResult, type TemporaryPresence } from "./safe-files.ts";

export type SaveReceipt = {
  state: string;
  root: string;
  relative: string;
  file?: FileResult | null;
  temporary?: string | null;
  created?: FileResult | null;
};
export type DebtRow = {
  scope: string;
  handle: string;
  state: string;
  root: string;
  relative: string;
  bytes: number;
  temporary: TemporaryPresence;
  releasable: boolean;
};
export type DebtRelease = "released" | "no_such_receipt" | "not_charged";
const refuse = (code: string): never => {
  throw new NativeRefusal(code);
};
const parse = (payload: string): SaveReceipt => {
  const r = JSON.parse(payload) as SaveReceipt;
  if (typeof r.state !== "string" || typeof r.root !== "string" || typeof r.relative !== "string")
    refuse("journal_integrity");
  return r;
};

/** Port of SaveReceipts.swift. The caller holds the process lock through preparation, GET, publication and ACK. */
export class SaveReceipts {
  private readonly files: SafeFiles;
  private readonly journal: Journal;
  constructor(files: SafeFiles, journal: Journal) {
    this.files = files;
    this.journal = journal;
  }
  private requestHash(root: string, relative: string) {
    return SafeFiles.digest(Buffer.from(root + "\0" + relative));
  }
  private reservation(scope: string, handle: string) {
    return "save:" + SafeFiles.digest(Buffer.from(scope + "\0" + handle));
  }
  private persist(scope: string, handle: string, receipt: SaveReceipt) {
    this.journal.put(
      "save:" + scope,
      handle,
      this.requestHash(receipt.root, receipt.relative),
      JSON.stringify(receipt),
    );
  }
  recover(scope: string, handle: string, root: string, relative: string): SaveReceipt | null {
    const row = this.journal.get("save:" + scope, handle);
    if (!row) return null;
    if (row.requestHash !== this.requestHash(root, relative)) refuse("idempotency_conflict");
    const receipt = parse(row.payload);
    if (receipt.file) {
      try {
        this.files.verify(root, relative, receipt.file);
        if (receipt.state !== "acknowledged") {
          receipt.state = "published";
          this.persist(scope, handle, receipt);
        }
        this.journal.release(this.reservation(scope, handle));
        return receipt;
      } catch {
        // An established publication can never turn into permission to replace the destination.
        if (["published", "acknowledged", "publication_unknown"].includes(receipt.state)) {
          receipt.state = "publication_unknown";
          this.persist(scope, handle, receipt);
          refuse("publication_unknown");
        }
      }
    }
    // Before publication, remove only the inode recorded at creation. A file created just before a
    // crash without that identity remains charged for owner repair.
    const discarded = receipt.temporary ? this.files.discardTemporary(root, receipt.temporary, receipt.created) : false;
    if (receipt.file && !discarded) {
      receipt.state = "publication_unknown";
      this.persist(scope, handle, receipt);
      refuse("publication_unknown");
    }
    receipt.state = "prepared";
    receipt.created = null;
    receipt.file = null;
    this.persist(scope, handle, receipt);
    this.journal.release(this.reservation(scope, handle));
    return receipt;
  }
  prepare(scope: string, handle: string, root: string, relative: string): SaveReceipt {
    const old = this.recover(scope, handle, root, relative);
    if (old && old.state !== "prepared") return old;
    this.journal.reserve(this.reservation(scope, handle), SafeFiles.maximum, SafeFiles.maximum, 1, "save");
    const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
    const receipt: SaveReceipt = old ?? {
      state: "prepared",
      root,
      relative,
      file: null,
      temporary: (parent ? parent + "/" : "") + ".zoho-mail-mcp-" + randomUUID(),
      created: null,
    };
    this.persist(scope, handle, receipt);
    return receipt;
  }
  publish(
    scope: string,
    handle: string,
    root: string,
    relative: string,
    bytes: Uint8Array,
    sha256: string,
    afterPublish?: () => void,
  ): SaveReceipt {
    const receipt = this.prepare(scope, handle, root, relative);
    if (receipt.state !== "prepared") return receipt;
    const file = this.files.save(root, relative, bytes, sha256, {
      ...(receipt.temporary ? { temporary: receipt.temporary } : {}),
      afterCreate: (created) => {
        receipt.created = created;
        this.persist(scope, handle, receipt);
      },
      beforePublish: (verified) => {
        receipt.file = verified;
        receipt.state = "verified";
        this.persist(scope, handle, receipt);
      },
    });
    afterPublish?.();
    receipt.file = file;
    receipt.state = "published";
    this.persist(scope, handle, receipt);
    this.journal.release(this.reservation(scope, handle));
    return receipt;
  }
  acknowledge(scope: string, handle: string, root: string, relative: string): SaveReceipt {
    const receipt = this.recover(scope, handle, root, relative);
    if (!receipt || (receipt.state !== "published" && receipt.state !== "acknowledged"))
      return refuse("publication_unknown");
    receipt.state = "acknowledged";
    this.persist(scope, handle, receipt);
    return receipt;
  }
  /** Charged debt: a receipt short of acknowledged that still holds bytes against the save budget. */
  unresolvedDebt(): DebtRow[] {
    const rows: DebtRow[] = [];
    for (const item of this.journal.entries("save:")) {
      const receipt = parse(item.record.payload);
      if (receipt.state === "acknowledged") continue;
      const scope = item.scope.slice(5);
      const bytes = this.journal.reservedBytes(this.reservation(scope, item.key));
      if (bytes === null || bytes <= 0) continue;
      const presence = receipt.temporary ? this.files.temporaryPresence(receipt.root, receipt.temporary) : "absent";
      rows.push({
        scope,
        handle: item.key,
        state: receipt.state,
        root: receipt.root,
        relative: receipt.relative,
        bytes,
        temporary: presence,
        releasable: receipt.state === "publication_unknown" && presence === "absent",
      });
    }
    return rows;
  }
  /** The owner may clear a charge only for a publication_unknown receipt whose temporary is provably gone. */
  releaseDebt(scope: string, handle: string): DebtRelease {
    const row = this.journal.get("save:" + scope, handle);
    if (!row) return "no_such_receipt";
    const receipt = parse(row.payload);
    if (receipt.state !== "publication_unknown") refuse("receipt_not_releasable");
    const presence = receipt.temporary ? this.files.temporaryPresence(receipt.root, receipt.temporary) : "absent";
    if (presence === "present") refuse("temporary_still_present");
    if (presence === "unknown") refuse("temporary_unknown");
    const bytes = this.journal.reservedBytes(this.reservation(scope, handle));
    if (bytes === null || bytes <= 0) return "not_charged";
    this.journal.release(this.reservation(scope, handle));
    return "released";
  }
  recoverStartup(): void {
    for (const item of this.journal.entries("save:")) {
      const receipt = parse(item.record.payload);
      // Preserve unknown records and reservations; never free them on an unsuccessful inspection.
      try {
        this.recover(item.scope.slice(5), item.key, receipt.root, receipt.relative);
      } catch {
        /* left for the owner's debt listing */
      }
    }
  }
}

# M3: Compose, drafts, send, reply, forward, positive-only recovery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mail leaves the mailbox only through the gate, with destination-based policy, Zoho's JSON send body, non-destructive drafts, server-reconstructed reply-all, capped forwards, and a `delivery_unknown` state that is settled only by positive evidence.

**Architecture:** Sealed-handle reservation replaces the R2 staging reservation (same function names, new table). `operations/send.ts` becomes a thin Zoho executor on settlement protocol 1 (`claimed` to `executing` to `executed` or `delivery_unknown`). `tools/compose.ts` builds Zoho bodies. `tools/send.ts` and `tools/drafts.ts` are rewritten. `operations/reconcile.ts` becomes the positive-only Sent probe the cron runs. The Gmail resumable and protocol-2 recovery machinery is retired.

**Tech Stack:** as master.

**Spec:** D9, D12, D13, D14, D17, sections 5.3, 5.5, 6, gates G16, G17, G18.

**Master:** `2026-10-03-zoho-mail-mcp-00-master.md`.

## File map

| Path                                 | Responsibility                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `worker/src/staging/sealed.ts`       | sealed_handles reservation API (same names as the old store)                                                      |
| `worker/src/operations/send.ts`      | `executeZohoSend`                                                                                                 |
| `worker/src/tools/compose.ts`        | validation, sender, Zoho body, carry from message, reply-all reconstruction                                       |
| `worker/src/tools/send.ts`           | `send_message`, `reply`, `forward`                                                                                |
| `worker/src/tools/drafts.ts`         | `create_draft`, `update_draft`, `send_draft`                                                                      |
| `worker/src/operations/reconcile.ts` | positive-only probe; `probeDeliveries` for the cron                                                               |
| tests                                | `sealed.test.ts`, `send-tools.test.ts`, `drafts-tools.test.ts`, `reconcile.test.ts`, `policy-destination.test.ts` |

---

### Task 3.1: Sealed handle reservation API

**Files:**

- Create: `worker/src/staging/sealed.ts`
- Modify: `worker/src/tools/gate.ts` (import `reserveStatements`, `extendExpiryStatement` from `../staging/sealed`), `worker/src/tools/settle.ts` (`consume`, `release` from `../staging/sealed`)
- Test: `worker/test/sealed.test.ts`

**Interfaces:**

- Produces: `SealedRow`, `listUploadHandles(db, {handles, userId, accountId}): Promise<SealedRow[]>`, `reserveStatements(db, {operationId, handles, userId, accountId, now})`, `extendExpiryStatement(db, handles, userId, accountId, until)`, `consume(db, operationId)`, `release(db, operationId)`, `insertSealed(db, row)`, `purgeExpiredSealed(db, now, limit)`, `UPLOAD_HANDLE_TTL_MS = 30 * 60_000`.

- [ ] **Step 1: Failing test**

`worker/test/sealed.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedUserAndAccount, insertOperation } from "./fixtures";
import {
  insertSealed,
  listUploadHandles,
  reserveStatements,
  consume,
  release,
  purgeExpiredSealed,
} from "../src/staging/sealed";

const H = (c: string) => "sh_" + c.repeat(43);
describe("sealed handles", () => {
  it("lists only unexpired, unconsumed uploads owned by the account; reserve, consume, release", async () => {
    await seedUserAndAccount(env.DB, { userId: "u", accountId: "a", alias: "sarabi", slot: "sarabi" });
    await insertOperation(env.DB, "op1", "u", "a", "claimed");
    const now = Date.now();
    await insertSealed(env.DB, {
      handle: H("a"),
      user_id: "u",
      account_id: "a",
      direction: "upload",
      provider_ref: JSON.stringify({ storeName: "s", attachmentPath: "p", attachmentName: "n" }),
      filename: "n",
      mime: "text/plain",
      size: 1,
      sha256: "0".repeat(64),
      created_at: now,
      expires_at: now + 60_000,
    });
    await insertSealed(env.DB, {
      handle: H("b"),
      user_id: "u",
      account_id: "a",
      direction: "upload",
      provider_ref: "{}",
      filename: "n",
      mime: "text/plain",
      size: 1,
      sha256: "0".repeat(64),
      created_at: now - 10,
      expires_at: now - 1,
    });
    expect(
      (await listUploadHandles(env.DB, { handles: [H("a")], userId: "u", accountId: "a" })).map((r) => r.handle),
    ).toEqual([H("a")]);
    await expect(listUploadHandles(env.DB, { handles: [H("b")], userId: "u", accountId: "a" })).rejects.toMatchObject({
      code: "handle_invalid",
    });
    await env.DB.batch(
      reserveStatements(env.DB, { operationId: "op1", handles: [H("a")], userId: "u", accountId: "a", now }),
    );
    await insertOperation(env.DB, "op2", "u", "a", "claimed");
    // Re-reserving for the same operation is idempotent; a different operation must be refused.
    await expect(
      env.DB.batch(
        reserveStatements(env.DB, { operationId: "op2", handles: [H("a")], userId: "u", accountId: "a", now }),
      ),
    ).rejects.toThrow(/CHECK/);
    await release(env.DB, "op1");
    await env.DB.batch(
      reserveStatements(env.DB, { operationId: "op1", handles: [H("a")], userId: "u", accountId: "a", now }),
    );
    await consume(env.DB, "op1");
    await expect(listUploadHandles(env.DB, { handles: [H("a")], userId: "u", accountId: "a" })).rejects.toMatchObject({
      code: "handle_invalid",
    });
    expect((await purgeExpiredSealed(env.DB, now + 1)).deleted).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Implement** `worker/src/staging/sealed.ts` (whole file; the reservation functions are the Gmail store's with `staging_objects` renamed and the `cleanup_state` predicates dropped):

```ts
import { McpError } from "@zoho-mail-mcp/shared/errors";

export const UPLOAD_HANDLE_TTL_MS = 30 * 60_000;
export type SealedRow = {
  handle: string;
  user_id: string;
  account_id: string;
  direction: "download" | "upload";
  provider_ref: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  reserved_by_operation_id: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
};
export async function insertSealed(
  db: D1Database,
  r: Omit<SealedRow, "reserved_by_operation_id" | "consumed_at">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sealed_handles (handle, user_id, account_id, direction, provider_ref, filename, mime, size, sha256, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      r.handle,
      r.user_id,
      r.account_id,
      r.direction,
      r.provider_ref,
      r.filename,
      r.mime,
      r.size,
      r.sha256,
      r.created_at,
      r.expires_at,
    )
    .run();
}
export async function purgeExpiredSealed(db: D1Database, now: number, limit = 200): Promise<{ deleted: number }> {
  const res = await db
    .prepare(
      `DELETE FROM sealed_handles WHERE handle IN (SELECT handle FROM sealed_handles WHERE (expires_at <= ? OR consumed_at IS NOT NULL) AND reserved_by_operation_id IS NULL LIMIT ?)`,
    )
    .bind(now, limit)
    .run();
  return { deleted: res.meta.changes ?? 0 };
}

/** Holds referenced handles open while an approval is pending. Only ever raises the expiry. */
export async function extendExpiry(
  db: D1Database,
  handles: string[],
  userId: string,
  accountId: string,
  until: number,
): Promise<void> {
  const stmt = extendExpiryStatement(db, handles, userId, accountId, until);
  if (stmt) await stmt.run();
}

export function reserveStatements(
  db: D1Database,
  o: { operationId: string; handles: string[]; userId: string; accountId: string; now: number },
): D1PreparedStatement[] {
  if (o.handles.length === 0) return [];
  return [
    db
      .prepare(
        `UPDATE sealed_handles SET reserved_by_operation_id = ?
         WHERE handle IN (${o.handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ? AND direction = 'upload'
           AND consumed_at IS NULL AND reserved_by_operation_id IS NULL AND expires_at > ?`,
      )
      .bind(o.operationId, ...o.handles, o.userId, o.accountId, o.now),
    db
      .prepare(
        `INSERT INTO _assert (x) SELECT 1 WHERE (SELECT count(*) FROM sealed_handles WHERE reserved_by_operation_id = ?) != ?`,
      )
      .bind(o.operationId, o.handles.length),
  ];
}

export function extendExpiryStatement(
  db: D1Database,
  handles: string[],
  userId: string,
  accountId: string,
  until: number,
): D1PreparedStatement | null {
  if (handles.length === 0) return null;
  return db
    .prepare(
      `UPDATE sealed_handles SET expires_at = MAX(expires_at, ?) WHERE handle IN (${handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ?`,
    )
    .bind(until, ...handles, userId, accountId);
}

export async function listUploadHandles(
  db: D1Database,
  o: { handles: string[]; userId: string; accountId: string },
): Promise<SealedRow[]> {
  if (o.handles.length === 0) return [];
  const rows = await db
    .prepare(
      `SELECT * FROM sealed_handles WHERE handle IN (${o.handles.map(() => "?").join(",")}) AND user_id = ? AND account_id = ?
         AND direction = 'upload' AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(...o.handles, o.userId, o.accountId, Date.now())
    .all<SealedRow>();
  const found = new Set(rows.results.map((r) => r.handle));
  const missing = o.handles.filter((h) => !found.has(h));
  if (missing.length > 0)
    throw new McpError("handle_invalid", `handle_invalid: ${missing.join(", ")}`, { handles: missing });
  return o.handles.map((h) => rows.results.find((r) => r.handle === h)!);
}

/** Marks reserved uploads used and clears the reservation so the purge can collect them. */
export async function consume(db: D1Database, operationId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE sealed_handles SET consumed_at = ?, reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL",
    )
    .bind(Date.now(), operationId)
    .run();
}

/** Returns unconsumed reservations to the pool after an operation failed before its side effect. */
export async function release(db: D1Database, operationId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE sealed_handles SET reserved_by_operation_id = NULL WHERE reserved_by_operation_id = ? AND consumed_at IS NULL",
    )
    .bind(operationId)
    .run();
}
```

Point `gate.ts` and `settle.ts` imports at `../staging/sealed`. `cron.ts` calls `purgeExpiredSealed` in place of `purgeExpired` (the old store is deleted in M5).

- [ ] **Step 3: Run, verify, commit**

```bash
cd worker && npx vitest run test/sealed.test.ts test/gate.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(staging): sealed handle reservation over D1"
```

---

### Task 3.2: `operations/zoho-send.ts`, the Zoho executor

**Files:**

- Create: `worker/src/operations/zoho-send.ts` (a new module: `compose.ts`, `drafts.ts`, `send.ts` and `gate.ts` still import `messageIdFor`, `uploadDraft`, `sendDraft`, `sendMime` and `SendRecoveryContext` from the Gmail `operations/send.ts`, which Task 3.6 deletes; replacing it in place turned the typecheck red mid-milestone in gauntlet round 3)
- Test: `worker/test/send-pipeline.test.ts` (rewritten). `gate.ts` and `settle.ts` are switched to `ZohoApiError` and the Zoho executor in Task 3.3, together with the tool files that import them.

**Interfaces:**

- Produces: `executeZohoSend(env, deps, o: { userId; accountId; operationId: string; toolCallId: string; kind: "send" | "reply" | "draft"; messageId?: string; body: SendBody }): Promise<{ message_id: string; folder_id: string | null }>`; it transitions the operation `claimed` to `executing` before the call and to `executed` after a parsed 200; a thrown error after the request was sent leaves the row `executing`, which `settleUnknown` turns into `delivery_unknown`; a refusal before the request (budget, bucket, validation) leaves it `claimed`, which settles `failed_safe`.

- [ ] **Step 1: Failing test**

`worker/test/send-pipeline.test.ts` (replace):

```ts
import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { insertOperation } from "./fixtures";
import { executeZohoSend } from "../src/operations/zoho-send";

describe("executeZohoSend", () => {
  it("moves claimed to executing to executed and records the Zoho message id", async () => {
    const { z, e, d, acct, Z } = await zohoFixture();
    await insertOperation(e.DB, "op1", "u", acct.accountId, "claimed");
    const r = await executeZohoSend(e, d, {
      ...acct,
      operationId: "op1",
      kind: "send",
      body: { fromAddress: "sarabi@example.test", toAddress: "c@example.org", subject: "S", content: "b" },
    });
    expect(r.message_id).toBe(z.mail.sent[0]!.messageId);
    const row = await e.DB.prepare("SELECT state, provider_result_id FROM operations WHERE id='op1'").first<{
      state: string;
      provider_result_id: string;
    }>();
    expect(row).toEqual({ state: "executed", provider_result_id: r.message_id });
    expect(z.mail.sent[0]!.accountId).toBe(Z);
  });
  it("leaves the row executing when the response is lost, and claimed when refused before the request", async () => {
    const { z, e, d, acct } = await zohoFixture();
    await insertOperation(e.DB, "op2", "u", acct.accountId, "claimed");
    z.mail.faults.push({ status: 503, errorCode: "DOWN", pathRe: /^\/messages$/ });
    await expect(
      executeZohoSend(e, d, {
        ...acct,
        operationId: "op2",
        kind: "send",
        body: { fromAddress: "sarabi@example.test", toAddress: "c@example.org" },
      }),
    ).rejects.toBeTruthy();
    expect((await e.DB.prepare("SELECT state FROM operations WHERE id='op2'").first<{ state: string }>())!.state).toBe(
      "executing",
    );
    await insertOperation(e.DB, "op3", "u", acct.accountId, "claimed");
    await expect(
      executeZohoSend(e, d, {
        ...acct,
        operationId: "op3",
        kind: "send",
        body: { fromAddress: "nobody@example.test", toAddress: "c@example.org" },
      }),
    ).rejects.toMatchObject({ code: "invalid_address" });
    expect((await e.DB.prepare("SELECT state FROM operations WHERE id='op3'").first<{ state: string }>())!.state).toBe(
      "claimed",
    );
  });
});
```

- [ ] **Step 2: Implement**

`worker/src/operations/zoho-send.ts` (whole file; it writes the positive-only probe's expected-send context before the transition, see Task 3.5):

```ts
import { McpError } from "@zoho-mail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { replyMessage, saveDraft, sendMessage, type SendBody } from "../zoho/mail";
import { transition } from "./journal";
import { hashCanonical } from "../crypto/canonical";
import type { ExpectedSend } from "./probe";

export type SendKind = "send" | "reply" | "draft";
export type SendOutcome = { message_id: string; folder_id: string | null };

/**
 * Spec 5.5. Settlement protocol 1: the row moves to `executing` immediately before the one request
 * that has a side effect, and to `executed` only after a parsed success. Anything thrown after the
 * request was sent leaves `executing`, which the gate settles as `delivery_unknown`; anything thrown
 * before leaves `claimed`, which settles `failed_safe`. Nothing here retries.
 */
export async function executeZohoSend(
  env: Env,
  deps: Deps,
  o: {
    userId: string;
    accountId: string;
    toolCallId: string;
    operationId: string;
    kind: SendKind;
    messageId?: string;
    body: SendBody;
  },
): Promise<SendOutcome> {
  const acct = { userId: o.userId, accountId: o.accountId, toolCallId: o.toolCallId };
  const row = await env.DB.prepare(
    "SELECT zoho_email, send_as FROM accounts WHERE id=? AND user_id=? AND status='active'",
  )
    .bind(o.accountId, o.userId)
    .first<{ zoho_email: string; send_as: string }>();
  if (!row) throw new McpError("account_needs_reconnect", "account_needs_reconnect");
  const allowed = [row.zoho_email, ...(JSON.parse(row.send_as) as string[])].map((s) => s.toLowerCase());
  if (!allowed.includes(o.body.fromAddress.toLowerCase()))
    throw new McpError("invalid_address", `invalid_address: ${o.body.fromAddress} is not a sender on this account`);
  if (o.kind !== "draft" && !o.body.toAddress && !o.body.ccAddress && !o.body.bccAddress)
    throw new McpError("invalid_address", "invalid_address: at least one recipient is required");
  const expected: ExpectedSend = {
    from: o.body.fromAddress,
    to: (o.body.toAddress ?? "").split(",").filter(Boolean),
    cc: (o.body.ccAddress ?? "").split(",").filter(Boolean),
    subject: o.body.subject ?? "",
    startedAt: Date.now(),
    attachmentCount: o.body.attachments?.length ?? 0,
    attachmentNames: (o.body.attachments ?? []).map((a) => a.attachmentName),
    bodySha256: o.body.content ? await hashCanonical(o.body.content) : null,
  };
  await env.DB.prepare("UPDATE operations SET settlement_context_json=? WHERE id=? AND state='claimed'")
    .bind(JSON.stringify(expected), o.operationId)
    .run();
  await transition(env.DB, o.operationId, ["claimed"], "executing");
  const sent =
    o.kind === "reply"
      ? await replyMessage(env, deps, acct, o.messageId!, o.body)
      : o.kind === "draft"
        ? await saveDraft(env, deps, acct, o.body)
        : await sendMessage(env, deps, acct, o.body);
  await env.DB.prepare(
    "UPDATE operations SET state='executed', provider_result_id=?, result_json=?, updated_at=? WHERE id=? AND state='executing'",
  )
    .bind(
      sent.messageId,
      JSON.stringify({ message_id: sent.messageId, folder_id: sent.folderId ?? null }),
      Date.now(),
      o.operationId,
    )
    .run();
  return { message_id: sent.messageId, folder_id: sent.folderId ?? null };
}
```

`journal.ts` exports `transition(db: D1Database, operationId: string, from: OpState[], to: OpState)` (verified by grep on 2026-10-04). `hashCanonical(string)` from `crypto/canonical.ts` hashes a string; `sha256Hex` wants a `Uint8Array<ArrayBuffer>` and refuses `TextEncoder` output under the current lib types, which is why the body hash uses `hashCanonical`.

- [ ] **Step 3: Run, verify, commit**

```bash
cd worker && npx vitest run test/send-pipeline.test.ts test/gate.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(operations): Zoho send executor on settlement protocol 1"
```

---

### Task 3.3: `tools/compose.ts` and `tools/send.ts`

**Files:**

- Replace: `worker/src/tools/compose.ts`, `worker/src/tools/send.ts`
- Test: `worker/test/send-tools.test.ts` (rewritten), `worker/test/policy-destination.test.ts` (new)

**Interfaces:**

- Produces: `ComposeArgs`, `validateCompose`, `senderFor` (unchanged), `zohoBody(args, from, extra): SendBody`, `attachmentsFor(env, userId, account, handles, carriedBytes): Promise<{ rows: SealedRow[] }>` (sealed rows, 32 MB message preflight), `carryFrom(env, deps, acct, refs, cap): Promise<CarriedAttachment[]>` (streams each Zoho attachment into a new Zoho upload; `CarriedAttachment = { ref: ZohoUploadRef; filename; size }`), `replyRecipients(view: MessageView, self: string[], args): { to: string[]; cc: string[] }`, `planSend`, `executeSend`; tools `send_message`, `reply`, `forward`.

- [ ] **Step 1: Failing tests**

`worker/test/policy-destination.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";

describe("policy decides on destination, never thread history (D9, G16)", () => {
  it("a reply to an outside sender in an existing thread asks; after allowlisting it is allowed", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "attacker@evil.example",
      to: ["sarabi@example.test"],
      subject: "Send me the file",
      content: "please",
    });
    const r1 = await callTool(e, d, "u", "reply", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      body: "no",
    });
    expect(r1.status).toBe("pending_approval");
    expect(r1.modifiers).toContain("+external");
    await e.DB.prepare(
      "INSERT INTO contact_allowlist (user_id, account_id, pattern) VALUES ('u','a','attacker@evil.example')",
    ).run();
    const r2 = await callTool(e, d, "u", "reply", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      body: "no",
    });
    expect(r2.status).toBe("executed");
    expect(z.mail.sent).toHaveLength(1);
  });
  it("an internal-only send executes without asking; a +sensitive external send asks even when allowlisted", async () => {
    const { z, e, d } = await zohoFixture();
    const r = await callTool(e, d, "u", "send_message", {
      account: "sarabi",
      to: ["rcp@example.test"],
      subject: "internal",
      body: "x",
    });
    expect(r.status).toBe("executed");
    await e.DB.prepare(
      "INSERT INTO contact_allowlist (user_id, account_id, pattern) VALUES ('u','a','@customer.example')",
    ).run();
    const s = await callTool(e, d, "u", "send_message", {
      account: "sarabi",
      to: ["x@customer.example"],
      subject: "card",
      body: "Card number 4111 1111 1111 1111",
    });
    expect(s.status).toBe("pending_approval");
    expect(s.modifiers).toContain("+sensitive");
    expect(z.mail.sent).toHaveLength(1);
  });
});
```

Add to `worker/test/send-tools.test.ts` (replace the file):

```ts
import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";

describe("send tools on Zoho", () => {
  it("reply_all reconstructs Reply-To plus To and Cc minus own addresses, never Bcc (Review Focus 2 fallback included)", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "Carla <c@example.org>",
      to: ["sarabi@example.test", "k@example.org"],
      cc: ["rcp@example.test", "l@example.org"],
      subject: "Plan",
      content: "p",
    });
    z.mail.get(Z, m.messageId)!.messageIdHeader = "<plan@example.org>";
    await e.DB.prepare(
      "INSERT INTO contact_allowlist (user_id, account_id, pattern) VALUES ('u','a','@example.org')",
    ).run();
    const r = await callTool(e, d, "u", "reply", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      reply_all: true,
      body: "ok",
    });
    expect(r.status).toBe("executed");
    const body = z.mail.sent[0]!.body;
    expect(String(body.toAddress).split(",").sort()).toEqual(["c@example.org", "k@example.org"].sort());
    expect(String(body.ccAddress).split(",")).toEqual(["l@example.org"]);
    expect(body.bccAddress).toBeUndefined();
    expect(body.action).toBe("Reply");
    // A note to self: own addresses removed leaves nothing, fall back to original To, then to self.
    const self = z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["sarabi@example.test"],
      subject: "note",
      content: "n",
    });
    const r2 = await callTool(e, d, "u", "reply", {
      account: "sarabi",
      message_id: self.messageId,
      folder_id: self.folderId,
      body: "more",
    });
    expect(r2.status).toBe("executed");
    expect(z.mail.sent[1]!.body.toAddress).toBe("sarabi@example.test");
  });
  it("forward re-uploads at most 10 attachments and asks by default", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const atts = Array.from({ length: 12 }, (_, i) => ({
      name: `f${i}.txt`,
      bytes: new Uint8Array([i]),
      mime: "text/plain",
    }));
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "Docs",
      content: "see attached",
      attachments: atts,
    });
    const r = await callTool(e, d, "u", "forward", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      to: ["rcp@example.test"],
      include_original_attachments: true,
    });
    expect(r.status).toBe("pending_approval");
    expect(r.action).toBe("send.forward");
    await expect(
      callTool(e, d, "u", "forward", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        to: ["rcp@example.test"],
        attach_from_message: atts.slice(0, 11).map((a, i) => ({
          message_id: m.messageId,
          folder_id: m.folderId,
          attachment_id: z.mail.get(Z, m.messageId)!.attachments[i]!.attachmentId,
        })),
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
  });
  it("refuses a message whose attachments exceed 32 MB before any upload (D14)", async () => {
    const { e, d } = await zohoFixture();
    await expect(
      callTool(e, d, "u", "send_message", {
        account: "sarabi",
        to: ["rcp@example.test"],
        subject: "big",
        body: "x",
        attachments: ["sh_" + "z".repeat(43)],
      }),
    ).rejects.toMatchObject({ code: "handle_invalid" });
  });
});
```

- [ ] **Step 2: Implement `compose.ts`**

Keep `validateCompose`, `senderFor`, `decodeInline`, `recipientSummary`, `attachmentSummary`, `assertHeaderSafe` uses. Replace the Gmail parts with:

```ts
import { McpError } from "@zoho-mail-mcp/shared/errors";
import { CarriedAttachmentRef } from "@zoho-mail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { accountStub, BUDGETS } from "../zoho/account-do";
import type { ZohoAcct } from "../zoho/client";
import { attachmentInfo, attachmentStream, uploadAttachment, type SendBody, type ZohoUploadRef } from "../zoho/mail";
import type { MessageView } from "../zoho/messages";
import { parseAddress } from "../policy/recipients";
import { listUploadHandles, type SealedRow } from "../staging/sealed";
import type { AccountRef } from "./accounts";
import { resolveRef } from "./read";

export const MESSAGE_BYTES_CEILING = 32 * 1_000_000; // D14 preflight under Zoho's 40 MB
export type CarriedAttachment = { ref: ZohoUploadRef; filename: string; size: number };

/** Sealed upload rows for the handles named, and the D14 preflight on the whole message. */
export async function attachmentsFor(
  env: Env,
  userId: string,
  account: AccountRef,
  handles: string[],
  otherBytes: number,
): Promise<{ rows: SealedRow[] }> {
  const rows = await listUploadHandles(env.DB, { handles, userId, accountId: account.id });
  const total = rows.reduce((n, r) => n + r.size, 0) + otherBytes;
  if (total > MESSAGE_BYTES_CEILING)
    throw new McpError(
      "limit_exceeded",
      `limit_exceeded: attachments ${total} bytes exceed the ${MESSAGE_BYTES_CEILING} byte message ceiling`,
    );
  return { rows };
}

/** Streams a mailbox attachment back into a fresh Zoho upload. Counted against the attachments and bytes budgets. */
export async function carryFrom(
  env: Env,
  deps: Deps,
  a: ZohoAcct,
  refs: { message_id: string; folder_id?: string | undefined; attachment_id: string }[],
): Promise<CarriedAttachment[]> {
  if (refs.length === 0) return [];
  const stub = accountStub(env, a.accountId);
  if (!(await stub.budget(a.toolCallId, "attachments", refs.length)))
    throw new McpError(
      "budget_exceeded",
      `budget_exceeded: at most ${BUDGETS.attachments} attachments can be carried in one call`,
      { counter: "attachments" },
    );
  const out: CarriedAttachment[] = [];
  for (const r of refs) {
    const ref = await resolveRef(env, deps, a, r);
    const info = (await attachmentInfo(env, deps, a, ref.folderId, ref.messageId)).find(
      (x) => x.attachmentId === r.attachment_id,
    );
    if (!info)
      throw new McpError(
        "handle_invalid",
        `handle_invalid: no attachment ${r.attachment_id} on message ${r.message_id}`,
      );
    if (!(await stub.budget(a.toolCallId, "bytes", info.attachmentSize)))
      throw new McpError("limit_exceeded", `limit_exceeded: carried attachments exceed ${BUDGETS.bytes} bytes`);
    const res = await attachmentStream(env, deps, a, ref.folderId, ref.messageId, r.attachment_id);
    const up = await uploadAttachment(env, deps, a, info.attachmentName, res.body as ReadableStream<Uint8Array>);
    out.push({ ref: up, filename: info.attachmentName, size: info.attachmentSize });
  }
  return out;
}

export function zohoBody(
  args: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject?: string | undefined;
    body?: string | undefined;
    html_body?: string | undefined;
  },
  from: string,
  attachments: ZohoUploadRef[],
  extra: Partial<SendBody> = {},
): SendBody {
  const b: SendBody = { fromAddress: from, toAddress: args.to.join(","), encoding: "UTF-8", ...extra };
  if (args.cc.length) b.ccAddress = args.cc.join(",");
  if (args.bcc.length) b.bccAddress = args.bcc.join(",");
  if (args.subject !== undefined) b.subject = args.subject;
  if (args.html_body !== undefined) {
    b.content = args.html_body;
    b.mailFormat = "html";
  } else {
    b.content = args.body ?? "";
    b.mailFormat = "plaintext";
  }
  if (attachments.length) b.attachments = attachments;
  return b;
}

/** Spec 5.3: Reply-To if present else From; plus To and Cc on reply_all; minus own and send-as; de-duplicated; never Bcc. Fallbacks for notes to self. */
export function replyRecipients(
  view: MessageView,
  self: string[],
  args: { to: string[]; cc: string[]; reply_all: boolean },
): { to: string[]; cc: string[] } {
  const norm = (s: string) => parseAddress(s).normalized;
  const selfSet = new Set(self.map(norm));
  const dedupe = (list: string[], exclude = new Set<string>()) => {
    const seen = new Set(exclude);
    const out: string[] = [];
    for (const r of list) {
      const n = norm(r);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  };
  const primary = view.reply_to.length ? view.reply_to : view.from ? [view.from] : [];
  let to = dedupe([...primary, ...(args.reply_all ? view.to : []), ...args.to], selfSet);
  if (to.length === 0) to = dedupe(view.to, selfSet);
  if (to.length === 0) to = dedupe([...primary, ...view.to]);
  const cc = dedupe(args.reply_all ? [...view.cc, ...args.cc] : args.cc, new Set([...selfSet, ...to]));
  return { to, cc };
}
export { CarriedAttachmentRef };
```

In `shared/src/schemas.ts`, `CarriedAttachmentRef` becomes `z.strictObject({ message_id: ZohoId, folder_id: ZohoId.optional(), attachment_id: ZohoId })` (Zoho attachment ids are stable, unlike Gmail's).

- [ ] **Step 3: Implement `tools/send.ts`**

Keep the Gmail file's structure (`planSend`, `modifiersFor`, `registerSendTools`) and change:

- `modifiersFor` adds `"+sensitive"` when `/\b(?:\d[ -]?){13,19}\b/.test(args.body ?? "") || /\b\d{3}[ -]?\d{3}[ -]?\d{3}\b.*\bTFN\b/i.test(args.body ?? "")` (card numbers, tax file numbers). Modifiers: `+attachment`, `+external` (from `recipientModifiers` with `trustContext`), `+bulk`, `+sensitive`.
- `planSend` build: `const { rows } = await attachmentsFor(...)`; payload is `{ ...args, from, attachments: rows.map(r => r.handle), carry: extra.carry, kind, message_id?, in_reply_to?, references? }`.
- `executeSend`:

```ts
const executeSend: Executor = async (e, d, run) => {
  const p = run.payload as SendPayload;
  const a = { userId: run.userId, accountId: run.account.id, toolCallId: run.operationId! };
  const rows = await listUploadHandles(e.DB, {
    handles: p.attachments ?? [],
    userId: run.userId,
    accountId: run.account.id,
  });
  const refs = [...rows.map((r) => JSON.parse(r.provider_ref) as ZohoUploadRef), ...(p.carry ?? []).map((c) => c.ref)];
  if (rows.some((r) => r.expires_at <= Date.now()))
    throw new McpError("handle_expired", "handle_expired: stage the file again"); // Review Focus 4
  const body = zohoBody(
    p,
    p.from,
    refs,
    p.kind === "reply"
      ? {}
      : p.in_reply_to
        ? { inReplyTo: p.in_reply_to, refHeader: p.references ?? p.in_reply_to }
        : {},
  );
  const out = await executeZohoSend(e, d, {
    ...a,
    operationId: run.operationId!,
    kind: p.kind === "reply" ? "reply" : "send",
    messageId: p.message_id,
    body,
  });
  return { message_id: out.message_id, folder_id: out.folder_id, thread_id: p.thread_id ?? null };
};
```

- `reply` plan: `const view = await getMessage(e, t.deps, a, await resolveRef(e, t.deps, a, args), "METADATA_ONLY")`, `const { to, cc } = replyRecipients(view, [account.email, ...account.sendAs], args)`, then `planSend(... { ...args, to, cc, subject: view.subject ?? "" }, ..., { carry, message_id: view.id, folder_id: view.folder_id, thread_id: view.thread_id, kind: "reply" }, "Reply")`. Policy runs inside `planSend` on the reconstructed `to` and `cc`.
- `forward` plan: `const view = await getMessage(..., "FULL_CONTENT")`; carried = `include_original_attachments ? view.attachments.map(x => ({ message_id, folder_id, attachment_id: x.attachment_id })) : args.attach_from_message` passed to `carryFrom` (which enforces the cap of 10); body = `(args.forward_text ? args.forward_text + "\n\n" : "") + "---------- Forwarded message ----------\nFrom: " + view.from + "\nDate: " + view.date + "\nSubject: " + view.subject + "\nTo: " + view.to.join(", ") + "\n\n" + (view.plaintext_body ?? htmlToText(view.html_body ?? ""))`; subject `Fwd: ` + original; `action: "send.forward"`, `kind: "send"`.
- `send_message` plan as Gmail with `carryFrom(e, t.deps, a, args.attach_from_message)`.

- [ ] **Step 4: Run, verify, commit**

```bash
cd worker && npx vitest run test/send-tools.test.ts test/policy-destination.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(tools): send, reply and forward on Zoho with destination-based policy"
```

---

### Task 3.4: Drafts, non-destructive

**Files:**

- Replace: `worker/src/tools/drafts.ts`
- Test: `worker/test/drafts-tools.test.ts` (rewritten)

**Interfaces:**

- Produces: `create_draft` (`reply_to_message_id` plus optional `reply_to_folder_id` sets `inReplyTo` and `refHeader` from the parent's headers), `update_draft` (save new, verify by `messageDetails` in Drafts, then `moveMessage` old to Trash; result `{ draft_id, previous_draft_id, old_draft_cleanup: "done" | "pending" }`), `send_draft` (read the draft, refuse `draft_not_reconstructible` if `has_attachment`, journal a send with the snapshot's recipients, send, move the draft to Trash only when `executed`).

- [ ] **Step 1: Failing tests** (`worker/test/drafts-tools.test.ts`, replace):

```ts
import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";

describe("drafts on Zoho (D12, G17)", () => {
  it("update_draft saves the new draft before touching the old one; a failed save leaves the old draft", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const c = await callTool(e, d, "u", "create_draft", {
      account: "sarabi",
      to: ["rcp@example.test"],
      subject: "v1",
      body: "one",
    });
    const oldId = c.draft_id as string;
    z.mail.faults.push({ status: 500, errorCode: "DOWN", pathRe: /^\/messages$/ });
    await expect(
      callTool(e, d, "u", "update_draft", { account: "sarabi", draft_id: oldId, subject: "v2", body: "two" }),
    ).rejects.toBeTruthy();
    expect(z.mail.get(Z, oldId)!.folderId).toBe(z.mail.folderId(Z, "Drafts"));
    const u = await callTool(e, d, "u", "update_draft", {
      account: "sarabi",
      draft_id: oldId,
      subject: "v2",
      body: "two",
    });
    expect(u.previous_draft_id).toBe(oldId);
    expect(u.old_draft_cleanup).toBe("done");
    expect(z.mail.get(Z, oldId)!.folderId).toBe(z.mail.folderId(Z, "Trash"));
    expect(z.mail.get(Z, u.draft_id as string)!.subject).toBe("v2");
  });
  it("send_draft sends the snapshot and trashes the draft only on a confirmed send", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const c = await callTool(e, d, "u", "create_draft", {
      account: "sarabi",
      to: ["rcp@example.test"],
      subject: "go",
      body: "x",
    });
    z.mail.faults.push({ status: 503, errorCode: "DOWN", pathRe: /^\/messages$/ });
    const lost = await callTool(e, d, "u", "send_draft", { account: "sarabi", draft_id: c.draft_id });
    expect(lost.status).toBe("delivery_unknown");
    expect(z.mail.get(Z, c.draft_id as string)!.folderId).toBe(z.mail.folderId(Z, "Drafts"));
    const ok = await callTool(e, d, "u", "send_draft", {
      account: "sarabi",
      draft_id: c.draft_id,
      idempotency_key: "second",
    });
    expect(ok.status).toBe("executed");
    expect(z.mail.get(Z, c.draft_id as string)!.folderId).toBe(z.mail.folderId(Z, "Trash"));
  });
  it("send_draft fails closed on a draft with attachments it cannot reconstruct", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Drafts",
      from: "sarabi@example.test",
      to: ["rcp@example.test"],
      subject: "with file",
      content: "c",
      attachments: [{ name: "a.pdf", bytes: new Uint8Array([1]), mime: "application/pdf" }],
    });
    await expect(callTool(e, d, "u", "send_draft", { account: "sarabi", draft_id: m.messageId })).rejects.toMatchObject(
      { code: "draft_not_reconstructible" },
    );
    expect(z.mail.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Implement** `tools/drafts.ts` on `executeZohoSend(kind: "draft")` for create and update, `getMessage(... "FULL_CONTENT")` for the snapshot in `send_draft`, `systemFolders` for the Drafts and Trash ids, and `updateMessages(e, d, a, "moveMessage", [oldId], { destfolderId: sys.trash })` for the cleanup wrapped in `try { ...; cleanup = "done" } catch { cleanup = "pending" }`. `send_draft`'s plan evaluates policy on the snapshot's recipients via `planSend` with `kind: "send"` and `extra.draft_id`; its executor runs `executeSend` and then, only if the operation row reads `executed`, moves the draft to Trash. `create_draft` with `attachments` refuses with `draft_attachments_unsupported` until the probe result flips the constant `DRAFT_ATTACHMENTS_SUPPORTED` in `drafts.ts` (default `false`, documented at the top of the file with the probe reference).

- [ ] **Step 3: Run, verify, commit**

```bash
cd worker && npx vitest run test/drafts-tools.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(tools): non-destructive drafts on Zoho"
```

---

### Task 3.5: Positive-only recovery

**Files:**

- Create: `worker/src/operations/probe.ts` (new module; the Gmail `reconcile.ts` and `recovery-cron.ts` are still imported by the recovery tests until Task 3.6 deletes them)
- Modify: `worker/src/index.ts` (`scheduled` calls `probeDeliveries(env, deps, now)` after `recoverDeliveries`; Task 3.6 removes the latter), `worker/src/cron.ts` (promotion of stale `executing` to `delivery_unknown` stays)
- Test: `worker/test/probe.test.ts` (new)

**Interfaces:**

- Produces: `probeDeliveries(env, deps, now, limit = 50): Promise<{ settled: number; left: number }>`; `matchCandidate(expected: ExpectedSend, row: ZohoListRow, content?: string): boolean`; `ExpectedSend` stored in `operations.settlement_context_json` by `executeZohoSend` (Task 3.2's block already writes it before the transition; the column exists).

- [ ] **Step 1: Failing test** (`worker/test/probe.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { insertOperation } from "./fixtures";
import { probeDeliveries } from "../src/operations/probe";

const ctx = (subject: string) =>
  JSON.stringify({
    from: "sarabi@example.test",
    to: ["c@example.org"],
    cc: [],
    subject,
    startedAt: Date.now() - 60_000,
    attachmentCount: 0,
    attachmentNames: [],
    bodySha256: null,
  });

describe("positive-only recovery (5.5, G18)", () => {
  it("exactly one full match settles sent; zero stays unknown; two stay unknown", async () => {
    const { z, e, d, Z, accountId } = await zohoFixture();
    for (const [id, subject] of [
      ["one", "Invoice A"],
      ["zero", "Never sent"],
      ["two", "Dup"],
    ] as const) {
      await insertOperation(e.DB, id, "u", accountId, "delivery_unknown");
      await e.DB.prepare("UPDATE operations SET settlement_context_json=? WHERE id=?").bind(ctx(subject), id).run();
    }
    z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "Invoice A",
      content: "x",
    });
    z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "Dup",
      content: "x",
    });
    z.mail.seedMessage(Z, {
      folder: "Sent",
      from: "sarabi@example.test",
      to: ["c@example.org"],
      subject: "Dup",
      content: "y",
    });
    const r = await probeDeliveries(e, d, Date.now());
    expect(r.settled).toBe(1);
    const states = Object.fromEntries(
      (
        await e.DB.prepare("SELECT id, state FROM operations WHERE id IN ('one','zero','two')").all<{
          id: string;
          state: string;
        }>()
      ).results.map((x) => [x.id, x.state]),
    );
    expect(states).toEqual({ one: "executed", zero: "delivery_unknown", two: "delivery_unknown" });
  });
  it("a search error leaves the operation unknown and never retries the send", async () => {
    const { z, e, d, accountId } = await zohoFixture();
    await insertOperation(e.DB, "err", "u", accountId, "delivery_unknown");
    await e.DB.prepare("UPDATE operations SET settlement_context_json=? WHERE id=?").bind(ctx("E"), "err").run();
    z.mail.faults.push({ status: 500, errorCode: "DOWN" });
    const r = await probeDeliveries(e, d, Date.now());
    expect(r.settled).toBe(0); // other cases' unknown rows may still be present in this D1; only ours matters
    expect((await e.DB.prepare("SELECT state FROM operations WHERE id='err'").first<{ state: string }>())!.state).toBe(
      "delivery_unknown",
    );
    expect(z.mail.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Implement** `worker/src/operations/probe.ts`:

```ts
import { z } from "zod";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { hashCanonical } from "../crypto/canonical";
import { systemFolders } from "../zoho/folders";
import { listMessages, messageContent, type ZohoListRow } from "../zoho/mail";
import { splitAddressList } from "../zoho/messages";

export const ExpectedSend = z.object({
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  startedAt: z.number(),
  attachmentCount: z.number(),
  attachmentNames: z.array(z.string()),
  bodySha256: z.string().nullable(),
});
export type ExpectedSend = z.infer<typeof ExpectedSend>;
const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^.*<([^>]+)>.*$/, "$1");
const sameSet = (a: string[], b: string[]) => {
  const x = a.map(norm).sort(),
    y = b.map(norm).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Every field Zoho exposes must match; a field we cannot read is not a match. */
export function matchCandidate(exp: ExpectedSend, row: ZohoListRow, contentSha?: string | null): boolean {
  if (norm(row.fromAddress) !== norm(exp.from)) return false;
  if (!sameSet(splitAddressList(row.toAddress), exp.to)) return false;
  if (!sameSet(splitAddressList(row.ccAddress), exp.cc)) return false;
  if (row.subject.trim() !== exp.subject.trim()) return false;
  const t = row.sentDateInGMT || row.receivedTime;
  if (t < exp.startedAt - 120_000 || t > exp.startedAt + 86_400_000) return false;
  if ((row.hasAttachment ? 1 : 0) !== (exp.attachmentCount > 0 ? 1 : 0)) return false;
  if (exp.bodySha256 && contentSha !== undefined && contentSha !== exp.bodySha256) return false;
  return true;
}

export async function probeDeliveries(
  env: Env,
  deps: Deps,
  now: number,
  limit = 50,
): Promise<{ settled: number; left: number }> {
  const rows = (
    await env.DB.prepare(
      "SELECT id, user_id, account_id, settlement_context_json FROM operations WHERE state='delivery_unknown' AND settlement_context_json IS NOT NULL AND updated_at > ? ORDER BY updated_at LIMIT ?",
    )
      .bind(now - 7 * 86_400_000, limit)
      .all<{ id: string; user_id: string; account_id: string; settlement_context_json: string }>()
  ).results;
  let settled = 0;
  for (const op of rows) {
    const exp = ExpectedSend.safeParse(JSON.parse(op.settlement_context_json));
    if (!exp.success) continue;
    const acct = { userId: op.user_id, accountId: op.account_id, toolCallId: `probe:${op.id}:${now}` };
    try {
      const sys = await systemFolders(env, deps, acct);
      const sent = await listMessages(env, deps, acct, { folderId: sys.sent, limit: 200, includesent: true });
      const candidates = sent.filter((r) => matchCandidate(exp.data, r));
      if (candidates.length !== 1) continue; // zero or several: stays delivery_unknown
      const c = candidates[0]!;
      if (exp.data.bodySha256) {
        const sha = await hashCanonical((await messageContent(env, deps, acct, c.folderId, c.messageId)).content);
        if (sha !== exp.data.bodySha256) continue;
      }
      const res = await env.DB.prepare(
        "UPDATE operations SET state='executed', provider_result_id=?, result_json=?, updated_at=? WHERE id=? AND state='delivery_unknown'",
      )
        .bind(
          c.messageId,
          JSON.stringify({ message_id: c.messageId, folder_id: c.folderId, settled_by: "probe" }),
          now,
          op.id,
        )
        .run();
      settled += res.meta.changes ?? 0;
    } catch {
      continue; // a search error is not evidence of anything
    }
  }
  return { settled, left: rows.length - settled };
}
```

The operations page (`web/pages/audit.ts`) gains a "Close as not sent" button per `delivery_unknown` row that sets `failed_safe` with an audit row; it is the only path to `not_sent`.

- [ ] **Step 3: Run, verify, commit**

```bash
cd worker && npx vitest run test/probe.test.ts test/cron.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(operations): positive-only delivery probe on the Sent folder"
```

---

### Task 3.6: Retire the Gmail send and recovery machinery

> **Carried from M0 execution (2026-10-04):** also add `worker/migrations/0002_accounts_slot_unique.sql` (`CREATE UNIQUE INDEX accounts_user_slot ON accounts(user_id, slot);`) and turn the `it.todo` in `worker/test/schema.test.ts` into a real test that a second account in the same slot is refused. M0 left the constraint out because the Gmail-era corpus seeds several accounts per user. The recovery probe's `generated_search` rule in `google/recovery-http.ts` still names gmail.googleapis.com; rewrite it for Zoho here (the production Gmail transport already refuses, commit c4d2981).

**Files:**

- Delete: `worker/src/google/resumable.ts`, `google/recovery-http.ts`, `google/mutation-receipt.ts`, `worker/src/mime/build.ts`, `worker/src/operations/send.ts`, `reconcile.ts`, `recovery-admission.ts`, `recovery-cron.ts`, `recovery-state.ts`, `recovery-types.ts`, every `worker/test/recovery-*.test.ts`, `resumable.test.ts`, `send-receipt-bound.test.ts`, `mime.test.ts`, `operation-faults.test.ts`, `operation-state-machine.test.ts`
- Keep: `worker/src/mime/encode.ts` only if something still imports it (`grep -rn "mime/encode" worker/src`); otherwise delete it too.
- Modify: `worker/src/operations/installation.ts` stays (the `recovery_installation` row gate is harmless); `worker/src/tools/settle.ts` loses the protocol-2 branches.

- [ ] **Step 1: Delete, fix imports, verify, commit**

```bash
cd worker && git rm src/google/resumable.ts src/google/recovery-http.ts src/google/mutation-receipt.ts src/mime/build.ts src/operations/recovery-admission.ts src/operations/recovery-cron.ts src/operations/recovery-state.ts src/operations/recovery-types.ts test/recovery-*.test.ts test/resumable.test.ts test/send-receipt-bound.test.ts test/mime.test.ts test/operation-faults.test.ts test/operation-state-machine.test.ts
grep -rn "recovery-state\|recovery-types\|recovery-admission\|recovery-cron\|resumable\|mime/build\|mutation-receipt" src | cut -d: -f1 | sort -u
```

Fix each listed file (they are `gate.ts`, `settle.ts`, `index.ts`, `staging/*.ts` references to `settlement_operation_id`): the staging references go in M5; for `gate.ts` and `settle.ts` remove the protocol-2 branches so a send settles by reading `operations.state` (`executed`, `executing` which becomes `delivery_unknown`, or `claimed` which becomes `failed_safe`).

```bash
cd .. && npm run verify && git add -A && git commit -m "chore: retire Gmail resumable upload and protocol-2 recovery"
```

---

## M3 exit checklist

- [ ] G16 proven: external reply in-thread asks; allowlisted is allowed; `reply_all` reconstructed server-side; `+sensitive` external asks even when allowlisted.
- [ ] G17 proven: `update_draft` save-new-first; `send_draft` keeps the draft on `delivery_unknown`; fails closed on attachments.
- [ ] G18 proven: one match settles, zero and two stay unknown, a search error stays unknown and nothing is re-sent.
- [ ] D14 preflight refuses over 32 MB before any upload; forward cap of 10.
- [ ] `npm run verify` green; `grep -rn "gmail.googleapis" worker/src | wc -l` lists only `google/gmail.ts` (retired in M4).

# M5: Attachments without a byte store: streaming upload, streaming download, sealed handles, one-time links

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attachment bytes flow companion to Worker to Zoho and Zoho to Worker to companion with nothing stored in Cloudflare, every handle sealed in D1 with the bytes' hash, the same companion protocol as Gmail on the wire, and a one-time link for claude.ai.

**Architecture:** The companion's staging protocol (`POST /staging/intent`, `PUT /staging/{ticket}`, `GET /staging/{handle}`, `POST /staging/{handle}/ack`) is kept byte-for-byte so `companion/src/transfers.ts` does not change. Behind it, `staging/transfers.ts` still runs the transfer state machine in D1 (tickets, generations, approvals), but `staging/upload.ts` forwards the PUT body straight to Zoho's upload endpoint while hashing, then seals the handle; `staging/downloads.ts` streams Zoho's attachment to the companion. The R2 store, materialisations, ingests and byte quotas are deleted. `download_attachment` seals a download handle without touching bytes. A `GET /dl/{id}` route serves a one-time link for claude.ai.

**Spec:** D14, D16, D17, section 5.2 (`download_attachment`), section 6 (`+outside_outbox`), gate G13 (CPU, measured in M7).

**Master:** `2026-10-03-zoho-mail-mcp-00-master.md`.

---

### Task 5.1: Streaming upload to Zoho with a hashing tee

> **Carried from M3 execution (2026-10-05):** when the old R2 staging store is deleted in this milestone, delete `worker/src/staging/reserve.ts` too and point `gate.ts`, `approval/claim.ts`, `tools/settle.ts` and `cron.ts` at `staging/sealed.ts` alone (the interim module reserves, consumes and releases across both tables). `staging/settlement.ts` is already a plain batch.

> **Carried from M2 execution (2026-10-05):** `download_attachment` was unregistered in M2 Task 2.4. Restore it here with annotations readOnly false, destructive false, openWorld false; in `worker/test/mcp.test.ts` put it back in `ALL_TOOLS`, raise the count from 39 to 40, and restore the annotation assertion that M2 replaced with `toBeUndefined()`.

**Files:**

- Replace: `worker/src/staging/upload.ts`
- Create: `worker/src/zoho/attachments.ts`
- Delete: `worker/src/staging/store.ts`, `materialization.ts`, `settlement.ts`, `budgets.ts`, `recovery.ts`, `worker/test/staging.test.ts`, `materialization*.test.ts`, `upload-ceiling.test.ts`, `upload-race-matrix.test.ts`, `upload-recovery.test.ts`, `state-growth.test.ts`
- Modify: `worker/src/staging/transfers.ts` (drop `provider_ref`, `reserved_bytes`, byte quota and materialisation assertions; the ticket lifecycle stays), `worker/src/env.ts` (remove `STAGING`), both wrangler files (remove `r2_buckets`), `worker/src/cron.ts`
- Test: `worker/test/upload.test.ts` (rewritten), `worker/test/staging-api.test.ts` (rewritten)

**Interfaces:**

- Produces: `uploadToZoho(env, deps, acct, o: { fileName: string; size: number; body: ReadableStream<Uint8Array>; declaredSha256: string }): Promise<{ ref: ZohoUploadRef; sha256: string }>` which tees the body into SHA-256 and the Zoho request, refuses on length or digest mismatch after the fact with `handle_invalid` (the Zoho upload is then orphaned and expires on Zoho's side; nothing is sealed); `acceptUpload(env, deps, principal, ticket, request)` as before but ending in `insertSealed` with `direction: "upload"`, `provider_ref: JSON.stringify(ref)`, `expires_at: now + UPLOAD_HANDLE_TTL_MS`.

- [ ] **Step 1: Failing test** (`worker/test/upload.test.ts`, replace):

```ts
import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { uploadToZoho } from "../src/zoho/attachments";
import { hashCanonical } from "../src/crypto/canonical";

const stream = (bytes: Uint8Array) => new Response(bytes).body as ReadableStream<Uint8Array>;
describe("uploadToZoho", () => {
  it("streams to Zoho, hashes on the way, returns the store triple", async () => {
    const { z, e, d, acct } = await zohoFixture();
    const bytes = new TextEncoder().encode("hello zoho");
    const sha = await hashCanonical(new TextDecoder().decode(bytes));
    const r = await uploadToZoho(e, d, acct, {
      fileName: "h.txt",
      size: bytes.byteLength,
      body: stream(bytes),
      declaredSha256: sha,
    });
    expect(r.sha256).toBe(sha);
    expect(z.mail.uploads.get(r.ref.storeName)!.bytes).toEqual(bytes);
    expect(r.ref.attachmentSize).toBe(bytes.byteLength);
  });
  it("refuses a body whose digest differs from the declared one and seals nothing", async () => {
    const { e, d, acct } = await zohoFixture();
    const bytes = new TextEncoder().encode("tampered");
    await expect(
      uploadToZoho(e, d, acct, {
        fileName: "t.txt",
        size: bytes.byteLength,
        body: stream(bytes),
        declaredSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "handle_invalid" });
    expect((await e.DB.prepare("SELECT count(*) AS n FROM sealed_handles").first<{ n: number }>())!.n).toBe(0);
  });
  it("refuses a body longer than declared before Zoho sees the extra bytes", async () => {
    const { e, d, acct } = await zohoFixture();
    const bytes = new Uint8Array(10);
    await expect(
      uploadToZoho(e, d, acct, { fileName: "l.bin", size: 5, body: stream(bytes), declaredSha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});
```

- [ ] **Step 2: Implement** `worker/src/zoho/attachments.ts`:

```ts
import { McpError } from "@zoho-mail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import type { ZohoAcct } from "./client";
import { attachmentStream, uploadAttachment, type ZohoUploadRef } from "./mail";

const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Spec D16. The body is never materialised: one branch of the tee feeds Zoho, the other a running
 * SHA-256 and a length check. A length overrun aborts both branches before the extra bytes leave.
 */
export async function uploadToZoho(
  env: Env,
  deps: Deps,
  acct: ZohoAcct,
  o: { fileName: string; size: number; body: ReadableStream<Uint8Array>; declaredSha256: string },
): Promise<{ ref: ZohoUploadRef; sha256: string }> {
  const [toZoho, toHash] = o.body.tee();
  let seen = 0;
  const chunks: Uint8Array[] = []; // DigestStream is Cloudflare-specific; a running hash keeps the Worker portable under workerd tests.
  const hashing = (async () => {
    const reader = toHash.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > o.size) {
        await reader.cancel();
        await toZoho.cancel().catch(() => {});
        throw new McpError("limit_exceeded", `limit_exceeded: body longer than declared ${o.size}`);
      }
      chunks.push(value);
    }
    const all = new Uint8Array(seen);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.byteLength;
    }
    return toHex(await crypto.subtle.digest("SHA-256", all));
  })();
  const upload = uploadAttachment(env, deps, acct, o.fileName, toZoho);
  const [sha256, ref] = await Promise.all([hashing, upload]);
  if (seen !== o.size)
    throw new McpError("limit_exceeded", `limit_exceeded: body was ${seen} bytes, declared ${o.size}`);
  if (sha256 !== o.declaredSha256)
    throw new McpError(
      "handle_invalid",
      "handle_invalid: digest mismatch between the companion snapshot and the bytes received",
    );
  if (ref.attachmentSize !== o.size)
    throw new McpError("handle_invalid", `handle_invalid: zoho stored ${ref.attachmentSize} bytes, expected ${o.size}`);
  return { ref, sha256 };
}

/** Zoho's attachment body as a stream for the companion; the caller adds the sealed metadata headers. */
export async function streamFromZoho(
  env: Env,
  deps: Deps,
  acct: ZohoAcct,
  ref: { folderId: string; messageId: string; attachmentId: string },
): Promise<Response> {
  const res = await attachmentStream(env, deps, acct, ref.folderId, ref.messageId, ref.attachmentId);
  if (!res.body) throw new McpError("handle_invalid", "handle_invalid: empty attachment body");
  return res;
}
```

Note for G13: the hashing branch above buffers chunks to finish the digest after the stream ends, which keeps 25 MiB in memory at worst but costs no extra CPU beyond one `digest` call. If G13 shows CPU-limit terminations on the 25 MiB case, switch the branch to Cloudflare's `crypto.DigestStream` (`new crypto.DigestStream("SHA-256")`, pipe `toHash` into it, read `.digest`), which hashes incrementally in native code; the test above does not change.

`acceptUpload` in `staging/upload.ts`: keep the ticket and generation checks from Gmail up to the policy admission, then replace the R2 write with:

```ts
const { ref, sha256 } = await uploadToZoho(
  env,
  deps,
  { userId: t.user_id, accountId: t.account_id, toolCallId: `stage:${t.id}` },
  { fileName: m.filename, size: m.size, body: request.body as ReadableStream<Uint8Array>, declaredSha256: m.sha256 },
);
const handle = randomHandle();
await env.DB.batch([
  db
    .prepare(
      "INSERT INTO sealed_handles (handle, user_id, account_id, direction, provider_ref, filename, mime, size, sha256, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      handle,
      t.user_id,
      t.account_id,
      "upload",
      JSON.stringify(ref),
      m.filename,
      m.mime,
      m.size,
      sha256,
      now,
      now + UPLOAD_HANDLE_TTL_MS,
    ),
  db.prepare("UPDATE upload_generations SET state='completed' WHERE ticket_id=?").bind(ticket),
  db
    .prepare("UPDATE upload_transfers SET state='completed', handle=?, handle_expires_at=? WHERE user_id=? AND id=?")
    .bind(handle, now + UPLOAD_HANDLE_TTL_MS, t.user_id, t.id),
]);
return transferView(env, t.user_id, t.id);
```

`staging/transfers.ts`: delete `byteQuota`, the `staging_materializations` assertion, `provider_ref`/`reserved_bytes` on generations (keep the columns in the schema; write `''` and `0`), and the `recoverUploads` call from `cron.ts`. `stagingApiHandler` passes `deps` into `acceptUpload`.

- [ ] **Step 3: Run, verify, commit**

```bash
cd worker && npx vitest run test/upload.test.ts test/staging-api.test.ts test/transfers.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(staging): stream uploads to Zoho with a hashing tee; seal handles in D1; remove R2"
```

---

### Task 5.2: `download_attachment` and the streaming download route

**Files:**

- Create: `worker/src/tools/attachments.ts`
- Replace: `worker/src/staging/downloads.ts`
- Modify: `worker/src/staging/routes.ts` (`GET /staging/{handle}` streams through `streamFromZoho`), `worker/src/mcp/server.ts` (register), `worker/src/tools/send.ts` (Review Focus 4: expired handle refusal already in `executeSend`)
- Test: `worker/test/download.test.ts`, `worker/test/send-tools.test.ts` (add the expired-handle case)

**Interfaces:**

- Produces: tool `download_attachment { account, message_id, folder_id?, attachment_id }` returning `{ handle, filename, mime, size, sha256, expires_at }` where `sha256` is computed by streaming the attachment once through the Worker at seal time (one Zoho call, counted); `leasedDownload(env, deps, user, handle): Promise<{ row: SealedRow; body: ReadableStream }>`; `acknowledgeDownload` as before.

- [ ] **Step 1: Failing tests**

`worker/test/download.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool, stagingGet } from "./zoho-helpers";
import { hashCanonical } from "../src/crypto/canonical";

describe("download_attachment and the staging GET", () => {
  it("seals a handle with the real digest and streams the bytes to the companion with x-size and x-sha256", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const bytes = new TextEncoder().encode("%PDF-1.4 fake");
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "doc",
      content: "x",
      attachments: [{ name: "doc.pdf", bytes, mime: "application/pdf" }],
    });
    const att = z.mail.get(Z, m.messageId)!.attachments[0]!;
    const r = await callTool(e, d, "u", "download_attachment", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      attachment_id: att.attachmentId,
    });
    expect(r.sha256).toBe(await hashCanonical(new TextDecoder().decode(bytes)));
    expect(r.size).toBe(bytes.byteLength);
    const res = await stagingGet(e, d, "u", r.handle as string);
    expect(res.headers.get("x-size")).toBe(String(bytes.byteLength));
    expect(res.headers.get("x-sha256")).toBe(r.sha256);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(
      (await e.DB.prepare("SELECT count(*) AS n FROM sealed_handles WHERE direction='download'").first<{
        n: number;
      }>())!.n,
    ).toBe(1);
  });
  it("refuses an attachment over 25 MiB before any stream", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "big",
      content: "x",
      attachments: [{ name: "big.bin", bytes: new Uint8Array(1), mime: "application/octet-stream" }],
    });
    z.mail.get(Z, m.messageId)!.attachments[0]!.attachmentSize = 26 * 1024 * 1024;
    await expect(
      callTool(e, d, "u", "download_attachment", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        attachment_id: z.mail.get(Z, m.messageId)!.attachments[0]!.attachmentId,
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});
```

Add to `send-tools.test.ts`:

```ts
it("refuses to send with a sealed upload handle that expired (Review Focus 4)", async () => {
  const { e, d } = await zohoFixture();
  const h = "sh_" + "e".repeat(43);
  await e.DB.prepare(
    `INSERT INTO sealed_handles (handle, user_id, account_id, direction, provider_ref, filename, mime, size, sha256, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      h,
      "u",
      "a",
      "upload",
      JSON.stringify({ storeName: "s", attachmentPath: "p", attachmentName: "n" }),
      "n",
      "text/plain",
      1,
      "0".repeat(64),
      Date.now() - 100,
      Date.now() - 1,
    )
    .run();
  await expect(
    callTool(e, d, "u", "send_message", {
      account: "sarabi",
      to: ["rcp@example.test"],
      subject: "late",
      body: "x",
      attachments: [h],
    }),
  ).rejects.toMatchObject({ code: "handle_invalid" });
});
```

(The planning step's `listUploadHandles` already refuses expired rows with `handle_invalid`; the executor's `handle_expired` check covers a handle that expired between approval and execution, which `extendExpiryStatement` prevents in the ordinary case.)

- [ ] **Step 2: Implement** `worker/src/tools/attachments.ts`:

```ts
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { McpError } from "@zoho-mail-mcp/shared/errors";
import { STAGING_LIMITS } from "@zoho-mail-mcp/shared/staging";
import { AccountAlias, ZohoId } from "@zoho-mail-mcp/shared/schemas";
import { z } from "zod";
import type { Env } from "../env";
import { randomHandle } from "../crypto/random";
import { attachmentInfo } from "../zoho/mail";
import { streamFromZoho } from "../zoho/attachments";
import { insertSealed, UPLOAD_HANDLE_TTL_MS } from "../staging/sealed";
import { defineTool } from "./define";
import type { ExecRun, ToolContext } from "./gate";
import { resolveRef } from "./read";

const Input = z.object({
  account: AccountAlias.optional(),
  message_id: ZohoId,
  folder_id: ZohoId.optional(),
  attachment_id: ZohoId,
});
const acct = (run: ExecRun) => ({
  userId: run.userId,
  accountId: run.account.id,
  toolCallId: run.operationId ?? run.pendingId ?? crypto.randomUUID(),
});

export function registerAttachmentTools(
  server: McpServer,
  toolContext: (ctx: ServerContext) => ToolContext,
  env: Env,
): void {
  defineTool(server, toolContext, env, {
    name: "download_attachment",
    version: 1,
    description:
      "Seal a handle for one attachment so the local companion can save it with save_attachment. Bytes never enter the result. 25 MiB ceiling. From claude.ai, where no companion runs, use the one-time link the result carries instead.",
    input: Input,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    action: "read.attachment",
    journal: false,
    plan: (_e, _t, _a, args) =>
      Promise.resolve({
        modifiers: [],
        summary: `Download attachment ${args.attachment_id} of message ${args.message_id}`,
        facts: { ids: [args.message_id] },
        build: () =>
          Promise.resolve({
            payload: { message_id: args.message_id, folder_id: args.folder_id, attachment_id: args.attachment_id },
            handles: [],
          }),
      }),
    execute: async (e, d, run) => {
      const p = Input.omit({ account: true }).parse(run.payload);
      const a = acct(run);
      const ref = await resolveRef(e, d, a, p);
      const info = (await attachmentInfo(e, d, a, ref.folderId, ref.messageId)).find(
        (x) => x.attachmentId === p.attachment_id,
      );
      if (!info)
        throw new McpError(
          "handle_invalid",
          `handle_invalid: no attachment ${p.attachment_id} on message ${p.message_id}`,
        );
      if (info.attachmentSize > STAGING_LIMITS.fileBytes)
        throw new McpError(
          "limit_exceeded",
          `limit_exceeded: attachment is ${info.attachmentSize} bytes, ceiling ${STAGING_LIMITS.fileBytes}`,
        );
      // One pass to learn the true digest: the companion verifies bytes against it later.
      const res = await streamFromZoho(e, d, a, { ...ref, attachmentId: p.attachment_id });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength !== info.attachmentSize)
        throw new McpError("handle_invalid", "handle_invalid: zoho attachment size changed");
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      const now = Date.now();
      const handle = randomHandle();
      await insertSealed(e.DB, {
        handle,
        user_id: run.userId,
        account_id: run.account.id,
        direction: "download",
        provider_ref: JSON.stringify({
          folderId: ref.folderId,
          messageId: ref.messageId,
          attachmentId: p.attachment_id,
        }),
        filename: info.attachmentName,
        mime: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
        size: info.attachmentSize,
        sha256,
        created_at: now,
        expires_at: now + UPLOAD_HANDLE_TTL_MS,
      });
      const link = await oneTimeLink(e, run.userId, handle, now);
      return {
        handle,
        filename: info.attachmentName,
        mime: res.headers.get("content-type") ?? "application/octet-stream",
        size: info.attachmentSize,
        sha256,
        expires_at: new Date(now + UPLOAD_HANDLE_TTL_MS).toISOString(),
        one_time_link: link,
      };
    },
  });
}

export async function oneTimeLink(env: Env, userId: string, handle: string, now: number): Promise<string> {
  const id = randomHandle().replace(/^sh_/, "dl_");
  await env.DB.prepare("INSERT INTO download_links (id, user_id, handle, created_at, expires_at) VALUES (?,?,?,?,?)")
    .bind(id, userId, handle, now, now + 10 * 60_000)
    .run();
  return `https://${env.WORKER_HOSTNAME}/dl/${id}`;
}
```

The digest pass reads the attachment into memory once (25 MiB worst case); G13 measures it. The staging `GET /staging/{handle}` then streams a second time from Zoho through `leasedDownload`, which now is:

```ts
export async function leasedDownload(
  env: Env,
  deps: Deps,
  user: string,
  handle: string,
): Promise<{ row: SealedRow; body: ReadableStream<Uint8Array> }> {
  const row = await env.DB.prepare(
    "SELECT s.* FROM sealed_handles s JOIN accounts a ON a.id=s.account_id AND a.user_id=s.user_id WHERE s.handle=? AND s.user_id=? AND s.direction='download' AND s.consumed_at IS NULL AND a.status='active'",
  )
    .bind(handle, user)
    .first<SealedRow>();
  if (!row) throw new McpError("handle_invalid", "handle_invalid");
  if (row.expires_at <= Date.now()) throw new McpError("handle_expired", "handle_expired");
  const ref = JSON.parse(row.provider_ref) as { folderId: string; messageId: string; attachmentId: string };
  const res = await streamFromZoho(
    env,
    deps,
    { userId: user, accountId: row.account_id, toolCallId: `dl:${handle}` },
    ref,
  );
  return { row, body: res.body as ReadableStream<Uint8Array> };
}
```

The route sets `x-size`, `x-sha256`, `content-disposition` from the row as the Gmail route did (the companion verifies the digest, so a second stream that differs is refused on the Mac). `acknowledgeDownload` marks `consumed_at`.

`GET /dl/{id}` (new route in `staging/routes.ts`, no bearer; the id is the secret): `UPDATE download_links SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>? RETURNING handle, user_id`, then the same streaming response with `content-disposition: attachment`. A consumed or expired id answers 404.

- [ ] **Step 3: Run, verify, commit**

```bash
cd worker && npx vitest run test/download.test.ts test/send-tools.test.ts test/staging-api.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(attachments): sealed download handles, streaming GET, one-time links"
```

---

### Task 5.3: Outbox-only staging allow (`+outside_outbox`)

> **Carried from M0 execution (2026-10-04):** `attachment.stage_upload` stays at `ask` in the shared defaults (commit 88ce6ae). Set it to `allow` here only together with `+outside_outbox`, in the same commit.

**Files:**

- Modify: `worker/src/staging/transfers.ts` (`ensureTransfer` computes modifiers), `shared/src/staging.ts` (`UploadMetadata` gains `root: z.string()`), `companion/src/transfers.ts` (sends `root` in `metadata`; one line)
- Test: `worker/test/transfers.test.ts` (add case)

- [ ] **Step 1: Failing test** (append to `worker/test/transfers.test.ts`):

```ts
it("staging from the outbox root is allowed; from any other root it asks with +outside_outbox", async () => {
  const { e, d } = await zohoFixture();
  const principal = { userId: "u", email: "u@example.test", scope: "staging" as const };
  const meta = { filename: "a.pdf", size: 3, mime: "application/pdf", sha256: "0".repeat(64) };
  const ok = await ensureTransfer(e, principal, {
    mode: "ensure",
    transfer_id: "tr_" + "a".repeat(43),
    account: "sarabi",
    metadata: { ...meta, root: "outbox" },
  });
  expect(ok.state).toBe("authorized");
  const ask = await ensureTransfer(e, principal, {
    mode: "ensure",
    transfer_id: "tr_" + "b".repeat(43),
    account: "sarabi",
    metadata: { ...meta, root: "documents" },
  });
  expect(ask.state).toBe("awaiting_approval");
  expect(ask.approval_url).toBeDefined();
});
```

- [ ] **Step 2: Implement:** in `ensureTransfer`, where the policy decision is made (`decide(db, { ..., action: "attachment.stage_upload", modifiers })`), compute `modifiers = metadata.root === "outbox" ? [] : ["+outside_outbox"]`. The companion's `init` (M6) names the outbox root `outbox`.

- [ ] **Step 3: Run, verify, commit**

```bash
cd worker && npx vitest run test/transfers.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(policy): staging from the outbox is allowed, other roots ask"
```

---

### Task 5.4: Budget the whole attachment surface

**Files:**

- Modify: `worker/src/tools/compose.ts` (`attachmentsFor` also charges the `bytes` budget), `worker/src/tools/attachments.ts` (charges `bytes` by `attachmentSize`)
- Test: `worker/test/budgets.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";

describe("D17 budgets end to end (G19)", () => {
  it("a forward of a message with 100 attachments is refused before any upload", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const atts = Array.from({ length: 100 }, (_, i) => ({
      name: `f${i}`,
      bytes: new Uint8Array([1]),
      mime: "text/plain",
    }));
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "many",
      content: "x",
      attachments: atts,
    });
    const before = z.mail.uploads.size;
    await expect(
      callTool(e, d, "u", "forward", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        to: ["rcp@example.test"],
        include_original_attachments: true,
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(z.mail.uploads.size).toBe(before);
  });
});
```

- [ ] **Step 2: Implement, run, verify, commit**

```bash
cd worker && npx vitest run test/budgets.test.ts && cd .. && npm run verify
git add -A && git commit -m "feat(budgets): attachment counts and bytes charged before any upload"
```

---

### Task 5.5: Register and count

**Files:**

- Modify: `worker/src/mcp/server.ts` (`registerAttachmentTools`), `worker/test/mcp.test.ts` (47 tools), `worker/test/smoke.test.ts`

- [ ] **Step 1: Verify and commit**

```bash
npm run verify && git add -A && git commit -m "feat(mcp): register download_attachment; 47 tools"
```

## M5 exit checklist

- [ ] No `R2Bucket`, `STAGING` binding or `r2_buckets` anywhere; `grep -rn "R2\|STAGING" worker/src worker/wrangler*.jsonc | wc -l` is 0.
- [ ] Upload tee refuses digest and length mismatches and seals nothing on refusal.
- [ ] Download handle carries the true digest; the companion-facing GET streams with `x-size` and `x-sha256`; one-time links are single use.
- [ ] Outbox staging allowed, other roots ask; forward of 100 attachments refused before any upload.

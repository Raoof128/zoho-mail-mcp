import { recoveryBudget } from "./budgets";
import { STAGING_LIMITS as L, UploadMetadata, type TransferResult } from "@zoho-mail-mcp/shared/staging";
import { McpError } from "@zoho-mail-mcp/shared/errors";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { uploadToZoho } from "../zoho/attachments";
import { UPLOAD_HANDLE_TTL_MS } from "./sealed";
import type { Principal } from "../auth/principal";
import { randomHandle } from "../crypto/random";
import { assertNotBlocked } from "../policy/limits";
import { auditStatement } from "../audit/log";
import {
  terminalBeforeAdmission,
  accountAssert,
  assertion,
  auditFor,
  policyAssert,
  policySnapshot,
  readTransfer,
  transferView,
  type GenerationRow,
  type TransferRow,
} from "./transfers";

class UploadIntegrityError extends McpError {
  constructor() {
    super("handle_invalid", "handle_invalid: upload integrity");
  }
}
export async function acceptUpload(
  env: Env,
  deps: Deps,
  p: Principal,
  ticket: string,
  request: Request,
  hooks: { afterStored?: () => Promise<void> } = {},
): Promise<TransferResult> {
  const db = env.DB;
  const now = Date.now();
  const g = await db
    .prepare("SELECT * FROM upload_generations WHERE user_id=? AND ticket_id=?")
    .bind(p.userId, ticket)
    .first<GenerationRow>();
  if (!g || g.state !== "issued" || g.issued_until <= now)
    throw new McpError("handle_invalid", "handle_invalid: ticket unavailable");
  const t = (await readTransfer(db, p.userId, g.transfer_id))!;
  if (t.active_generation !== g.generation || t.authority_until <= now)
    throw new McpError("handle_invalid", "handle_invalid: stale ticket");
  const m = UploadMetadata.parse(JSON.parse(t.metadata_json));
  if (
    request.headers.get("content-length") !== String(m.size) ||
    request.headers.get("content-type") !== m.mime ||
    ![null, "identity"].includes(request.headers.get("content-encoding"))
  )
    throw new McpError("handle_invalid", "handle_invalid: upload headers");
  assertNotBlocked(m.filename);
  const policy = await policySnapshot(env, p.userId, t.account_id, m.root);
  if (policy.level === "deny") {
    await terminalBeforeAdmission(env, t, "denied", "policy_denied");
    throw new McpError("policy_denied", "policy_denied: upload admission");
  }
  if (policy.level === "ask") {
    const approved = t.pending_id
      ? await db
          .prepare(
            "SELECT 1 FROM pending_actions WHERE id=? AND user_id=? AND state='executing' AND operation_id=? AND action='attachment.stage_upload'",
          )
          .bind(t.pending_id, t.user_id, t.operation_id)
          .first()
      : null;
    if (!approved) {
      await db.batch([
        db
          .prepare(
            "UPDATE upload_generations SET state='expired',cleanup_state='released',writer_stopped=1 WHERE ticket_id=? AND state='issued'",
          )
          .bind(ticket),
        db
          .prepare(
            "UPDATE upload_transfers SET state='awaiting_approval' WHERE user_id=? AND id=? AND state!='completed'",
          )
          .bind(t.user_id, t.id),
      ]);
      throw new McpError("pending_not_approved", "pending_not_approved: policy now requires approval");
    }
  }
  const account = await db
    .prepare("SELECT credential_version FROM accounts WHERE user_id=? AND id=? AND status='active'")
    .bind(t.user_id, t.account_id)
    .first<{ credential_version: number }>();
  if (!account) {
    await terminalBeforeAdmission(env, t, "failed", "account_needs_reconnect");
    throw new McpError("account_needs_reconnect", "account_needs_reconnect: upload");
  }
  const until = now + L.leaseMs;
  try {
    await db.batch([
      policyAssert(db, policy.rev),
      accountAssert(db, t.user_id, t.account_id, account.credential_version),
      assertion(
        db,
        "(SELECT count(*) FROM upload_generations WHERE state IN ('uploading','stored') AND lease_until>?)<?",
        [now, L.uploadsGlobal],
      ),
      assertion(
        db,
        "EXISTS(SELECT 1 FROM upload_transfers WHERE user_id=? AND id=? AND active_generation=? AND state='in_progress')",
        [t.user_id, t.id, g.generation],
      ),
      db
        .prepare(
          "UPDATE upload_generations SET state='uploading',admitted_at=?,lease_until=?,credential_version=? WHERE ticket_id=? AND state='issued' AND issued_until>?",
        )
        .bind(now, until, account.credential_version, ticket, now),
      assertion(
        db,
        "EXISTS(SELECT 1 FROM upload_generations WHERE ticket_id=? AND state='uploading' AND admitted_at=? AND lease_until=?)",
        [ticket, now, until],
      ),
      db
        .prepare("UPDATE operations SET state='executing',updated_at=? WHERE id=? AND action='attachment.stage_upload'")
        .bind(now, t.operation_id),
    ]);
  } catch {
    throw new McpError("handle_invalid", "handle_invalid: upload admission lost or busy");
  }
  let sent = false;
  try {
    if (!request.body && m.size > 0) throw new UploadIntegrityError();
    // Spec D16: the body streams to Zoho through a hashing tee; nothing is stored in Cloudflare.
    sent = true;
    const { ref, sha256 } = await uploadToZoho(
      env,
      deps,
      { userId: t.user_id, accountId: t.account_id, toolCallId: `stage:${t.id}` },
      {
        fileName: m.filename,
        size: m.size,
        body: (request.body ?? new Response(new Uint8Array(0)).body) as ReadableStream<Uint8Array>,
        declaredSha256: m.sha256,
      },
    );
    if (Date.now() >= until) throw new McpError("handle_invalid", "handle_invalid: upload lease expired");
    await hooks.afterStored?.();
    const handle = randomHandle();
    const finished = Date.now();
    const expires = finished + UPLOAD_HANDLE_TTL_MS;
    const stmts = [
      ...recoveryBudget(db, t.user_id, "upload:" + t.id, 1, finished + L.retentionMs),
      accountAssert(db, t.user_id, t.account_id, account.credential_version),
      assertion(
        db,
        "EXISTS(SELECT 1 FROM upload_transfers WHERE user_id=? AND id=? AND active_generation=? AND state='in_progress')",
        [t.user_id, t.id, g.generation],
      ),
      assertion(
        db,
        "EXISTS(SELECT 1 FROM upload_generations WHERE ticket_id=? AND state='uploading' AND lease_until>?)",
        [ticket, finished],
      ),
      db
        .prepare(
          "INSERT INTO sealed_handles(handle,user_id,account_id,direction,provider_ref,filename,mime,size,sha256,created_at,expires_at) VALUES(?,?,?,'upload',?,?,?,?,?,?,?)",
        )
        .bind(
          handle,
          t.user_id,
          t.account_id,
          JSON.stringify(ref),
          m.filename,
          m.mime,
          m.size,
          sha256,
          finished,
          expires,
        ),
      db
        .prepare(
          "UPDATE upload_generations SET state='completed',cleanup_state='published',writer_stopped=1 WHERE ticket_id=?",
        )
        .bind(ticket),
      db
        .prepare(
          "UPDATE upload_transfers SET state='completed',handle=?,handle_expires_at=?,retain_until=? WHERE user_id=? AND id=?",
        )
        .bind(handle, expires, finished + L.retentionMs, t.user_id, t.id),
      db
        .prepare("UPDATE operations SET state='executed',updated_at=? WHERE id=? AND action='attachment.stage_upload'")
        .bind(finished, t.operation_id),
      auditStatement(db, "outcome", auditFor(t, "executed")),
    ];
    if (t.pending_id)
      stmts.push(
        db
          .prepare(
            "UPDATE pending_actions SET state='executed',executed_at=?,payload_json=NULL,summary='redacted' WHERE id=? AND state='executing' AND operation_id=?",
          )
          .bind(finished, t.pending_id, t.operation_id),
      );
    await db.batch(stmts);
    return transferView(env, (await readTransfer(db, t.user_id, t.id))!);
  } catch (e) {
    const latest = await readTransfer(db, t.user_id, t.id);
    if (latest?.state === "completed") return transferView(env, latest);
    const currentAccount = await db
      .prepare("SELECT 1 FROM accounts WHERE user_id=? AND id=? AND status='active' AND credential_version=?")
      .bind(t.user_id, t.account_id, account.credential_version)
      .first();
    // A digest or length mismatch is final. Anything else (Zoho down, lease lost) may be retried with a new
    // generation; an upload Zoho accepted but we did not seal is orphaned there and expires on Zoho's side.
    const final = e instanceof McpError && (e.code === "handle_invalid" || e.code === "limit_exceeded");
    const retryable = currentAccount !== null && !final && sent;
    await failUpload(env, t, g, retryable ? "abandoned" : "failed");
    throw e;
  }
}
async function failUpload(env: Env, t: TransferRow, g: GenerationRow, state: "failed" | "abandoned") {
  const db = env.DB;
  // Nothing was written to Cloudflare, so the generation is released at once.
  await db.batch([
    db
      .prepare(
        "UPDATE upload_generations SET state=?,cleanup_state='released',writer_stopped=1 WHERE ticket_id=? AND state IN ('uploading','stored','abandoned')",
      )
      .bind(state, g.ticket_id),
    ...(state === "failed"
      ? [
          db
            .prepare(
              "UPDATE upload_transfers SET state='failed',error='upload_failed' WHERE user_id=? AND id=? AND state!='completed'",
            )
            .bind(t.user_id, t.id),
          db
            .prepare(
              "UPDATE operations SET state='failed_safe',updated_at=? WHERE id=? AND action='attachment.stage_upload'",
            )
            .bind(Date.now(), t.operation_id),
        ]
      : []),
    ...(state === "failed" && t.pending_id
      ? [
          db
            .prepare(
              "UPDATE pending_actions SET state='failed',payload_json=NULL,summary='redacted',error='upload_failed' WHERE id=? AND state='executing' AND operation_id=?",
            )
            .bind(t.pending_id, t.operation_id),
        ]
      : []),
    auditStatement(db, "outcome", auditFor(t, state)),
  ]);
}

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { McpError } from "@zoho-mail-mcp/shared/errors";
import { CreateDraftInput, SendDraftInput, UpdateDraftInput } from "@zoho-mail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { canonicalize, hashCanonical } from "../crypto/canonical";
import { executeZohoSend } from "../operations/zoho-send";
import type { ZohoAcct } from "../zoho/client";
import { systemFolders } from "../zoho/folders";
import { messageDetails, updateMessages } from "../zoho/mail";
import type { MessageView } from "../zoho/messages";
import { addressOf } from "../policy/recipients";
import type { AccountRef } from "./accounts";
import { recipientSummary, senderFor, validateCompose, zohoBody } from "./compose";
import { defineTool, type Plan } from "./define";
import type { ExecRun, ToolContext } from "./gate";
import { getMessage, resolveRef } from "./read";
import { executeSend, planAcct, planSend, type SendPayload } from "./send";

/**
 * Spec D12. Zoho's API has no update-draft and no send-draft-by-id, so drafts are composed by the server:
 * update saves a new draft first and only then trashes the old one; send_draft sends the snapshot the owner approved
 * and trashes the draft only on a confirmed send.
 *
 * DRAFT_ATTACHMENTS_SUPPORTED stays false until the M0 conformance probe (scripts/probe) shows a draft saved with
 * uploaded attachments keeps them; until then create_draft and update_draft refuse attachments rather than save a
 * draft that silently lost its files.
 */
export const DRAFT_ATTACHMENTS_SUPPORTED = false;

const openWorld = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
type DraftPayload = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | undefined;
  body?: string | undefined;
  html_body?: string | undefined;
  from: string;
  in_reply_to?: string | undefined;
  references?: string | undefined;
  previous_draft_id?: string | undefined;
};

function refuseAttachments(args: { attachments?: string[] | undefined; inline_attachments?: unknown[] | undefined }) {
  if (
    !DRAFT_ATTACHMENTS_SUPPORTED &&
    ((args.attachments?.length ?? 0) > 0 || (args.inline_attachments?.length ?? 0) > 0)
  )
    throw new McpError(
      "draft_attachments_unsupported",
      "draft_attachments_unsupported: drafts with attachments are not supported yet; send the message with send_message instead",
    );
}

/**
 * The draft tools move "the draft" to Trash under draft.write and send.draft, so they must only ever act on a draft:
 * the folder Zoho reports for the message must be Drafts, not merely the folder in the request path (security review).
 */
async function assertDraft(env: Env, deps: Deps, a: ZohoAcct, draftId: string, folderId: string): Promise<void> {
  const sys = await systemFolders(env, deps, a);
  if (folderId !== sys.drafts)
    throw new McpError(
      "handle_invalid",
      `handle_invalid: ${draftId} is not a draft; the draft tools act only on Drafts`,
    );
}

async function readDraft(env: Env, deps: Deps, a: ZohoAcct, draftId: string): Promise<MessageView> {
  const sys = await systemFolders(env, deps, a);
  const v = await getMessage(env, deps, a, { folderId: sys.drafts, messageId: draftId }, "FULL_CONTENT", {
    bodyCharLimit: 600_000,
    includeBody: true,
  });
  await assertDraft(env, deps, a, draftId, v.folder_id);
  return v;
}

/** What the owner approves for send_draft; the same fields are re-read at execution and must still match. */
const snapshotOf = (v: MessageView) => ({
  to: v.to.map(addressOf),
  cc: v.cc.map(addressOf),
  subject: v.subject ?? "",
  html_body: v.html_body ?? "",
  has_attachment: v.has_attachment,
});

function draftPlan(account: AccountRef, p: DraftPayload, summaryVerb: string, ids: string[]): Plan {
  return {
    modifiers: [],
    summary: `${summaryVerb} · ${recipientSummary({ to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject })}`,
    facts: { recipients: p.to.length + p.cc.length + p.bcc.length, attachments: 0, ...(ids.length ? { ids } : {}) },
    build: () => Promise.resolve({ payload: p, handles: [] }),
  };
}

async function saveDraft(env: Env, deps: Deps, run: ExecRun) {
  const p = run.payload as unknown as DraftPayload;
  if (!run.operationId) throw new McpError("internal", "a draft write runs with an operation");
  const a: ZohoAcct = { userId: run.userId, accountId: run.account.id, toolCallId: run.operationId };
  const out = await executeZohoSend(env, deps, {
    ...a,
    operationId: run.operationId,
    kind: "draft",
    body: zohoBody(
      p,
      p.from,
      [],
      p.in_reply_to ? { inReplyTo: p.in_reply_to, refHeader: p.references ?? p.in_reply_to } : {},
    ),
  });
  return { a, out };
}

export function registerDraftTools(
  server: McpServer,
  toolContext: (ctx: ServerContext) => ToolContext,
  env: Env,
): void {
  defineTool(server, toolContext, env, {
    name: "create_draft",
    version: 1,
    description:
      "Save a new draft. For a reply, pass reply_to_message_id and reply_to_folder_id so the draft threads under it. Attachments on drafts are not supported yet.",
    input: CreateDraftInput,
    annotations: write,
    action: "draft.write",
    journal: true,
    plan: async (e, t, account, args) => {
      refuseAttachments(args);
      validateCompose(args);
      const from = senderFor(account, args.from);
      let threading: { in_reply_to?: string; references?: string } = {};
      if (args.reply_to_message_id) {
        const a = planAcct(t, account);
        const parent = await getMessage(
          e,
          t.deps,
          a,
          await resolveRef(e, t.deps, a, { message_id: args.reply_to_message_id, folder_id: args.reply_to_folder_id }),
          "METADATA_ONLY",
          { bodyCharLimit: 1, includeBody: false },
        );
        if (parent.message_id_header)
          threading = {
            in_reply_to: parent.message_id_header,
            references: [parent.references, parent.message_id_header].filter(Boolean).join(" "),
          };
      }
      return draftPlan(
        account,
        {
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          body: args.body,
          html_body: args.html_body,
          from,
          ...threading,
        },
        "Create draft",
        args.reply_to_message_id ? [args.reply_to_message_id] : [],
      );
    },
    execute: async (e, d, run) => {
      const { out } = await saveDraft(e, d, run);
      return { provider_result_id: out.message_id, draft_id: out.message_id, folder_id: out.folder_id };
    },
  });

  defineTool(server, toolContext, env, {
    name: "update_draft",
    version: 1,
    description:
      "Change a draft. Fields given replace the draft's; fields left out keep it. The new draft is saved and confirmed before the old one moves to Trash; if that cleanup fails, old_draft_cleanup is pending and the new draft_id is still returned.",
    input: UpdateDraftInput,
    annotations: write,
    action: "draft.write",
    journal: true,
    plan: async (e, t, account, args) => {
      refuseAttachments(args);
      const a = planAcct(t, account);
      const cur = await readDraft(e, t.deps, a, args.draft_id);
      if (cur.has_attachment && !DRAFT_ATTACHMENTS_SUPPORTED)
        throw new McpError(
          "draft_not_reconstructible",
          "draft_not_reconstructible: this draft has attachments the server cannot carry into a new draft",
        );
      const bodyGiven = args.body !== undefined || args.html_body !== undefined;
      const p: DraftPayload = {
        to: args.to ?? cur.to.map(addressOf),
        cc: args.cc ?? cur.cc.map(addressOf),
        bcc: args.bcc ?? [],
        subject: args.subject ?? cur.subject ?? undefined,
        ...(bodyGiven ? { body: args.body, html_body: args.html_body } : { html_body: cur.html_body ?? "" }),
        from: senderFor(account, args.from ?? (cur.from ? addressOf(cur.from) : undefined)),
        ...(cur.in_reply_to ? { in_reply_to: cur.in_reply_to, references: cur.references ?? cur.in_reply_to } : {}),
        previous_draft_id: args.draft_id,
      };
      validateCompose(p);
      return draftPlan(account, p, `Update draft ${args.draft_id}`, [args.draft_id]);
    },
    execute: async (e, d, run) => {
      const p = run.payload as unknown as DraftPayload;
      const { a, out } = await saveDraft(e, d, run);
      let cleanup: "done" | "pending" = "pending";
      try {
        const sys = await systemFolders(e, d, a);
        await messageDetails(e, d, a, sys.drafts, out.message_id); // the new draft exists before the old one goes
        const old = await messageDetails(e, d, a, sys.drafts, p.previous_draft_id!);
        await assertDraft(e, d, a, p.previous_draft_id!, old.folderId); // still a draft at the moment it is moved
        await updateMessages(e, d, a, "moveMessage", [p.previous_draft_id!], { destfolderId: sys.trash });
        cleanup = "done";
      } catch {
        // stays "pending": the new draft exists, the old one is left for the owner
      }
      return {
        provider_result_id: out.message_id,
        draft_id: out.message_id,
        folder_id: out.folder_id,
        previous_draft_id: p.previous_draft_id,
        old_draft_cleanup: cleanup,
      };
    },
  });

  defineTool(server, toolContext, env, {
    name: "send_draft",
    version: 1,
    description:
      "Send a draft as it is now. Bcc recipients on the draft are not carried (Zoho does not expose them). A draft with attachments is refused (draft_not_reconstructible); a draft edited after approval is refused (payload_mismatch). The draft moves to Trash only after a confirmed send.",
    input: SendDraftInput,
    annotations: openWorld,
    action: "send.draft",
    journal: true,
    plan: async (e, t, account, args) => {
      const a = planAcct(t, account);
      const v = await readDraft(e, t.deps, a, args.draft_id);
      if (v.has_attachment)
        throw new McpError(
          "draft_not_reconstructible",
          "draft_not_reconstructible: the draft carries attachments the server cannot re-upload faithfully; send it from Zoho Mail, or attach the files with send_message",
        );
      const snap = snapshotOf(v);
      return planSend(
        e,
        t.deps,
        a,
        account,
        {
          to: snap.to,
          cc: snap.cc,
          bcc: [],
          subject: snap.subject,
          html_body: snap.html_body,
          from: v.from ? addressOf(v.from) : undefined,
          idempotency_key: args.idempotency_key,
        },
        [],
        { carry: [], kind: "send", draft_id: args.draft_id, draft_sha: await hashCanonical(canonicalize(snap)) },
        `Send draft ${args.draft_id} (Bcc on the draft is not carried)`,
      );
    },
    execute: async (e, d, run) => {
      const p = run.payload as unknown as SendPayload;
      if (!run.operationId) throw new McpError("internal", "send.draft runs with an operation");
      const a: ZohoAcct = { userId: run.userId, accountId: run.account.id, toolCallId: run.operationId };
      // Spec 3.4, one approval covers one action: the draft must still be what the owner approved.
      const now = snapshotOf(await readDraft(e, d, a, p.draft_id!));
      if ((await hashCanonical(canonicalize(now))) !== p.draft_sha)
        throw new McpError(
          "payload_mismatch",
          "payload_mismatch: the draft changed after it was approved; nothing was sent",
        );
      const sent = await executeSend(e, d, run);
      // Only a confirmed send reaches here; delivery_unknown threw above and leaves the draft in place.
      let cleanup: "done" | "pending" = "pending";
      try {
        const sys = await systemFolders(e, d, a);
        await updateMessages(e, d, a, "moveMessage", [p.draft_id!], { destfolderId: sys.trash });
        cleanup = "done";
      } catch {
        // stays "pending": the new draft exists, the old one is left for the owner
      }
      return { ...sent, draft_id: p.draft_id, draft_cleanup: cleanup };
    },
  });
}

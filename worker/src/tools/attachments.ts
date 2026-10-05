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
/** One budget id per invocation (M2 ruling). */
const callIds = new WeakMap<ExecRun, string>();
const acct = (run: ExecRun) => {
  let id = callIds.get(run);
  if (!id) {
    id = run.operationId ?? run.pendingId ?? crypto.randomUUID();
    callIds.set(run, id);
  }
  return { userId: run.userId, accountId: run.account.id, toolCallId: id };
};

export function registerAttachmentTools(
  server: McpServer,
  toolContext: (ctx: ServerContext) => ToolContext,
  env: Env,
): void {
  defineTool(server, toolContext, env, {
    name: "download_attachment",
    version: 1,
    description:
      "Seal a handle for one attachment so the local companion can save it with save_attachment. Bytes never enter the result. 25 MiB ceiling. From claude.ai, where no companion runs, the owner opens the one-time link in their signed-in browser; it works once, for 10 minutes, and only for them.",
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
      // Streamed into an incremental digest, never held in memory (same rule as uploads, security review of 421a605).
      const digest = new crypto.DigestStream("SHA-256");
      let length = 0;
      await res
        .body!.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, c) {
              length += chunk.byteLength;
              if (length > STAGING_LIMITS.fileBytes)
                throw new McpError("limit_exceeded", "limit_exceeded: attachment too large");
              c.enqueue(chunk);
            },
          }),
        )
        .pipeTo(digest);
      if (length !== info.attachmentSize)
        throw new McpError("handle_invalid", "handle_invalid: zoho attachment size changed");
      const sha256 = [...new Uint8Array(await digest.digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
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

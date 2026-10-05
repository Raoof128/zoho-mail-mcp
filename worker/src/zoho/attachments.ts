import { McpError } from "@zoho-mail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import type { ZohoAcct } from "./client";
import { attachmentStream, uploadAttachment, type ZohoUploadRef } from "./mail";

const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Spec D16. The body is never materialised: it passes once through a transform that counts it, refuses it the moment
 * it runs past the declared size, and feeds an incremental SHA-256 (DigestStream) on its way to Zoho. Zoho's read
 * pace sets the pull rate, so nothing is buffered ahead of the upload (security review of 421a605: a tee plus a
 * buffered digest held up to the whole file, twice, under a slow Zoho).
 */
export async function uploadToZoho(
  env: Env,
  deps: Deps,
  acct: ZohoAcct,
  o: { fileName: string; size: number; body: ReadableStream<Uint8Array>; declaredSha256: string },
): Promise<{ ref: ZohoUploadRef; sha256: string }> {
  const digest = new crypto.DigestStream("SHA-256");
  const hash = digest.getWriter();
  let seen = 0;
  const failed: { overrun?: McpError } = {};
  const counted = o.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, c) {
        seen += chunk.byteLength;
        if (seen > o.size) {
          failed.overrun = new McpError("limit_exceeded", `limit_exceeded: body longer than declared ${o.size}`);
          throw failed.overrun;
        }
        await hash.write(chunk);
        c.enqueue(chunk);
      },
      async flush() {
        await hash.close();
      },
    }),
  );
  let ref: ZohoUploadRef;
  try {
    ref = await uploadAttachment(env, deps, acct, o.fileName, counted);
  } catch (e) {
    if (failed.overrun) throw failed.overrun;
    throw e;
  }
  if (failed.overrun) throw failed.overrun;
  if (seen !== o.size)
    throw new McpError("limit_exceeded", `limit_exceeded: body was ${seen} bytes, declared ${o.size}`);
  const sha256 = toHex(await digest.digest);
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

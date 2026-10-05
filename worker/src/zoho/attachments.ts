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

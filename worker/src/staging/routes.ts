import { McpError } from "@zoho-mail-mcp/shared/errors";
import { TransferIntent } from "@zoho-mail-mcp/shared/staging";
import { ZodError } from "zod";
import type { Deps } from "../deps";
import { requireScope } from "../auth/principal";
import { type FetchHandler, type Route, requireSession } from "../web/router";
import { acknowledgeDownload, leasedDownload } from "./downloads";
import { ensureTransfer } from "./transfers";
import { acceptUpload } from "./upload";
const HANDLE = /^\/staging\/(sh_[A-Za-z0-9_-]{43})(\/ack)?$/;
const TICKET = /^\/staging\/(ut_[A-Za-z0-9_-]{43})$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
async function readIntent(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new McpError("handle_invalid", "handle_invalid: JSON required");
  const reader = (request.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) throw new McpError("handle_invalid", "handle_invalid: missing intent");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpError("limit_exceeded", "limit_exceeded: intent timeout")), 30_000);
  });
  try {
    for (;;) {
      const p = await Promise.race([reader.read(), deadline]);
      if (p.done) break;
      size += p.value.length;
      if (size > 65536) throw new McpError("limit_exceeded", "limit_exceeded: intent body");
      chunks.push(p.value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return TransferIntent.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)));
}
export function stagingApiHandler(deps: Deps): FetchHandler {
  return {
    async fetch(request, env) {
      const principal = await requireScope(request, env, "staging");
      if (principal instanceof Response) return principal;
      const path = new URL(request.url).pathname;
      try {
        if (path === "/staging/identity" && request.method === "GET") return json({ user_id: principal.userId });
        if (path === "/staging/intent" && request.method === "POST")
          return json(await ensureTransfer(env, principal, await readIntent(request)));
        const ticket = TICKET.exec(path);
        if (ticket && request.method === "PUT")
          return json(await acceptUpload(env, deps, principal, ticket[1]!, request));
        const m = HANDLE.exec(path);
        if (!m) return json({ error: "not_found" }, 404);
        if (m[2] && request.method === "POST") {
          const out = await acknowledgeDownload(env, principal.userId, m[1]!);
          return out ? json(out) : json({ error: "handle_invalid" }, 404);
        }
        if (!m[2] && request.method === "GET") {
          const { row, body } = await leasedDownload(env, deps, principal.userId, m[1]!);
          return new Response(body, {
            headers: {
              "content-type": row.mime,
              "content-length": String(row.size),
              // The edge recomputes framing and drops content-length for a streamed body, so the
              // size also travels in a header nothing rewrites. Measured against the deployment:
              // the companion saw no content-length and refused the save.
              "x-size": String(row.size),
              "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
              "x-sha256": row.sha256,
              "cache-control": "no-store",
            },
          });
        }
        return json({ error: "method_not_allowed" }, 405);
      } catch (e) {
        if (e instanceof McpError) {
          const status =
            e.code === "policy_denied"
              ? 403
              : e.code === "handle_expired"
                ? 404
                : e.code === "rate_limited"
                  ? 429
                  : e.code === "idempotency_conflict"
                    ? 409
                    : 400;
          return json({ error: e.code }, status);
        }
        if (e instanceof ZodError || e instanceof SyntaxError || e instanceof TypeError)
          return json({ error: "invalid_request" }, 400);
        return json({ error: "internal" }, 500);
      }
    },
  };
}

/**
 * One-time download link for claude.ai, where no companion runs. The id alone is not enough: the owner's signed-in
 * browser session must match the link's owner, so a link an injected agent mails out gives nothing away. The body is
 * always a download (opaque type, nosniff, attachment) so an HTML attachment can never render on this origin.
 */
export function downloadLinkRoutes(deps: Deps): Route[] {
  return [
    {
      method: "GET",
      pattern: /^\/dl\/(dl_[A-Za-z0-9_-]{43})$/,
      handler: async ({ env, request, url }) => {
        const s = await requireSession(env, request);
        if (s instanceof Response) return s;
        const id = /^\/dl\/(dl_[A-Za-z0-9_-]{43})$/.exec(url.pathname)![1]!;
        const now = Date.now();
        // Admission first, then the single-use claim: a busy or failed admission must not spend the link
        // (final review of M5, I1). The UPDATE ... RETURNING still guarantees one use under a race.
        const pending = await env.DB.prepare(
          "SELECT handle FROM download_links WHERE id=? AND user_id=? AND consumed_at IS NULL AND expires_at>?",
        )
          .bind(id, s.userId, now)
          .first<{ handle: string }>();
        if (!pending) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
        let opened: Awaited<ReturnType<typeof leasedDownload>>;
        try {
          opened = await leasedDownload(env, deps, s.userId, pending.handle);
        } catch (e) {
          const busy = e instanceof McpError && e.code === "rate_limited";
          return new Response(busy ? "Busy: other downloads are running. Try again shortly." : "Not available", {
            status: busy ? 429 : 404,
            headers: { "cache-control": "no-store" },
          });
        }
        const claimed = await env.DB.prepare(
          "UPDATE download_links SET consumed_at=? WHERE id=? AND user_id=? AND consumed_at IS NULL RETURNING handle",
        )
          .bind(Date.now(), id, s.userId)
          .first<{ handle: string }>();
        if (!claimed) {
          await opened.body.cancel();
          return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
        }
        const { row, body } = opened;
        return new Response(body, {
          headers: {
            "content-type": "application/octet-stream",
            "x-content-type-options": "nosniff",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
            "content-length": String(row.size),
            "cache-control": "no-store",
          },
        });
      },
    },
  ];
}

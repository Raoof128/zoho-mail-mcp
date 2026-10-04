import { McpError } from "@zoho-mail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { accountStub } from "./account-do";
import { ZOHO } from "./oidc";
import { getAccessToken } from "./tokens";

export type ZohoAcct = { userId: string; accountId: string; toolCallId: string };
export type ZohoRequest = {
  method: "GET" | "POST" | "PUT";
  /** Relative to /api/accounts/{zohoAccountId}/ when scope is "account", to /api/ when "root". */
  path: string;
  scope?: "account" | "root";
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  body?: ReadableStream<Uint8Array> | Uint8Array;
  headers?: Record<string, string>;
  /** `safe` may be re-sent after a 5xx; `none` is sent once. A 401 retry after a refresh is always safe: Zoho refused before acting. */
  retry: "safe" | "none";
};

export class ZohoApiError extends McpError {
  constructor(
    public readonly status: number,
    public readonly zohoCode: string | null,
    message: string,
  ) {
    super("zoho_error", `zoho_error: ${status} ${zohoCode ?? ""} ${message}`.trim(), { status, zohoCode });
    this.name = "ZohoApiError";
  }
}

const MAX_TRIES = 3;
const BACKOFF_MS = [300, 900];

type ParsedError = { code: string | null; message: string };
/** Zoho answers auth failures as `[2, {errorCode, msg}]` and everything else as `{status:{code,description}, data?}`. Both are parsed. */
export function parseZohoError(body: unknown, fallback: string): ParsedError {
  if (Array.isArray(body)) {
    const o = body.find((x) => typeof x === "object" && x !== null) as { errorCode?: string; msg?: string } | undefined;
    return { code: o?.errorCode ?? null, message: o?.msg ?? fallback };
  }
  if (typeof body === "object" && body !== null) {
    const b = body as {
      status?: { description?: string; code?: number };
      data?: { errorCode?: string; moreInfo?: string };
    };
    return {
      code: b.data?.errorCode ?? b.status?.description ?? null,
      message: b.data?.moreInfo ?? b.status?.description ?? fallback,
    };
  }
  return { code: null, message: fallback };
}

async function accountRow(env: Env, acct: ZohoAcct): Promise<{ zoho_account_id: string; location: "au" }> {
  const row = await env.DB.prepare(
    "SELECT zoho_account_id, location FROM accounts WHERE id=? AND user_id=? AND status='active'",
  )
    .bind(acct.accountId, acct.userId)
    .first<{ zoho_account_id: string; location: "au" }>();
  if (!row) throw new McpError("account_needs_reconnect", "account_needs_reconnect");
  return row;
}

/**
 * Builds the request URL and refuses any path that would leave the account's base: another origin, an absolute
 * path, a backslash or a dot segment (plain or percent-encoded). From M2 paths carry ids taken from email, which
 * is attacker-controlled; the Zoho token must only ever reach mail.zoho.com.au under this account.
 */
function url(base: string, path: string, query?: ZohoRequest["query"]): string {
  const root = new URL(base.endsWith("/") ? base : base + "/");
  if (/^[a-z][a-z0-9+.-]*:|^[/\\]|\\|%2e|%2f|%5c|(^|\/)\.{1,2}(\/|$)/i.test(path))
    throw new McpError("forbidden", "forbidden: request path leaves the account");
  const u = new URL(path, root);
  if (u.origin !== root.origin || !u.pathname.startsWith(root.pathname))
    throw new McpError("forbidden", "forbidden: request path leaves the account");
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

/** One request's worth of the tool call's budget and the account's bucket. Every attempt pays, retries included. */
async function spend(stub: ReturnType<typeof accountStub>, acct: ZohoAcct): Promise<void> {
  if (!(await stub.budget(acct.toolCallId, "requests", 1)))
    throw new McpError("budget_exceeded", "budget_exceeded: more than 10 Zoho requests in one tool call", {
      counter: "requests",
    });
  const admitted = await stub.admit(acct.toolCallId);
  if (!admitted.ok)
    throw new McpError("rate_limited", "rate_limited: account bucket", { retry_after_ms: admitted.retry_after_ms });
}

/**
 * The one path to Zoho. Every attempt is admitted by the account DO. One refresh-and-retry on INVALID_OAUTHTOKEN and
 * bounded retries for safe requests, except that a streamed body is sent once only: it is consumed by the first send.
 */
export async function zohoFetch(env: Env, deps: Deps, acct: ZohoAcct, req: ZohoRequest): Promise<Response> {
  const stub = accountStub(env, acct.accountId);
  const row = await accountRow(env, acct);
  const base =
    req.scope === "root"
      ? ZOHO.mailBase(row.location)
      : `${ZOHO.mailBase(row.location)}/accounts/${row.zoho_account_id}`;
  const target = url(base, req.path, req.query);
  const isStream = req.body instanceof ReadableStream;
  let refreshed = false;
  let forceNext = false;
  for (let attempt = 1; ; attempt++) {
    await spend(stub, acct);
    const token = await getAccessToken(env, deps, acct.userId, acct.accountId, { forceRefresh: forceNext });
    forceNext = false;
    const headers = new Headers({ accept: "application/json", ...req.headers });
    headers.set("authorization", `Zoho-oauthtoken ${token}`);
    let body: BodyInit | undefined;
    if (req.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(req.json);
    } else if (req.body) body = req.body as BodyInit;
    const res = await deps.zohoFetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      ...(isStream ? { duplex: "half" } : {}),
    } as RequestInit);
    if (res.ok) return res;
    const parsed = parseZohoError(
      await res
        .clone()
        .json()
        .catch(() => null),
      res.statusText,
    );
    if (res.status === 401 && parsed.code === "INVALID_OAUTHTOKEN" && !refreshed) {
      refreshed = true;
      if (isStream) {
        // The stream is spent. Refresh now so the caller's next send works, and let the caller re-create the body.
        await getAccessToken(env, deps, acct.userId, acct.accountId, { forceRefresh: true });
        throw new ZohoApiError(401, parsed.code, "access token refreshed; send the stream again");
      }
      forceNext = true; // invalid_grant surfaces as account_needs_reconnect from tokens.ts
      continue;
    }
    if (res.status === 401 && parsed.code === "INVALID_OAUTHSCOPE")
      throw new McpError(
        "insufficient_scope",
        "insufficient_scope: reconnect the mailbox and accept every permission",
        { zohoCode: parsed.code },
      );
    if (res.status === 401)
      throw new McpError("account_needs_reconnect", `account_needs_reconnect: ${parsed.code ?? "401"}`);
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after") ?? "60");
      throw new McpError("rate_limited", "rate_limited: zoho", {
        retry_after_ms: (Number.isFinite(ra) ? ra : 60) * 1000,
        zohoCode: parsed.code,
      });
    }
    if (res.status >= 500 && req.retry === "safe" && !isStream && attempt < MAX_TRIES) {
      await deps.sleep(BACKOFF_MS[attempt - 1] ?? 900);
      continue;
    }
    throw new ZohoApiError(res.status, parsed.code, parsed.message);
  }
}

export async function zohoJson<T>(env: Env, deps: Deps, acct: ZohoAcct, req: ZohoRequest): Promise<T> {
  const res = await zohoFetch(env, deps, acct, req);
  const body = (await res.json().catch(() => null)) as { data?: T } | null;
  if (!body || !("data" in body)) throw new ZohoApiError(res.status, null, "response without data");
  return body.data;
}

/** For attachment bytes: the caller owns the stream. */
export async function zohoStream(env: Env, deps: Deps, acct: ZohoAcct, req: ZohoRequest): Promise<Response> {
  return zohoFetch(env, deps, acct, { ...req, headers: { ...req.headers, accept: "*/*" } });
}

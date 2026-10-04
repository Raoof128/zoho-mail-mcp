import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { McpError } from "@zoho-mail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";

const ACCOUNTS = "https://accounts.zoho.com.au";
export type Location = "au";
export const ZOHO = {
  issuer: ACCOUNTS,
  authUrl: `${ACCOUNTS}/oauth/v2/auth`,
  tokenUrl: `${ACCOUNTS}/oauth/v2/token`,
  jwksUrl: `${ACCOUNTS}/oauth/v2/keys`,
  revokeUrl: `${ACCOUNTS}/oauth/v2/token/revoke`,
  /** Spec D7: the Mail host comes from `location`, never from `api_domain`. Only AU is deployed. */
  mailBase(location: Location): string {
    if (location !== "au") throw new McpError("internal", `unsupported Zoho location ${String(location)}`);
    return "https://mail.zoho.com.au/api";
  },
} as const;

export const LOGIN_SCOPES = "openid,email,profile";
/** Spec D6: least privilege, no messages.DELETE, no folder writes. Comma separated, Zoho's separator. */
export const CONNECT_SCOPES =
  "openid,email,ZohoMail.messages.READ,ZohoMail.messages.CREATE,ZohoMail.messages.UPDATE,ZohoMail.folders.READ,ZohoMail.tags.ALL,ZohoMail.accounts.READ";

export function buildAuthUrl(
  env: Env,
  o: { redirectUri: string; scope: string; state: string; nonce: string; offline: boolean },
): string {
  const u = new URL(ZOHO.authUrl);
  u.searchParams.set("client_id", env.ZOHO_CLIENT_ID);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", o.scope);
  u.searchParams.set("state", o.state);
  u.searchParams.set("nonce", o.nonce);
  if (o.offline) {
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
  }
  return u.toString();
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((t) => t.toLowerCase() === "bearer"),
  expires_in: z.number().int().min(1).max(86_400),
  scope: z.string(),
  api_domain: z.string().optional(),
  /** Present only for multi-DC clients (verified live 2026-10-04: absent for the client's app). The deployment is AU-only. */
  location: z.literal("au").optional(),
  id_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;
const RefreshResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().int().min(1).max(86_400) });
/** Zoho answers token-endpoint failures with HTTP 200 and an `error` field (verified live 2026-10-04: invalid_code, invalid_client_secret). */
const TokenError = z.object({ error: z.string() });
function assertAuDomain(apiDomain: string | undefined): void {
  if (apiDomain !== undefined && !/\.com\.au$/.test(new URL(apiDomain).hostname))
    throw new McpError("internal", `zoho token belongs to another data centre: ${apiDomain}`);
}

async function tokenPost(env: Env, deps: Deps, form: Record<string, string>): Promise<Response> {
  return deps.zohoFetch(ZOHO.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.ZOHO_CLIENT_ID, client_secret: env.ZOHO_CLIENT_SECRET, ...form }),
    redirect: "manual",
  });
}

export async function exchangeCode(
  env: Env,
  deps: Deps,
  o: { code: string; redirectUri: string },
): Promise<TokenResponse> {
  const res = await tokenPost(env, deps, {
    grant_type: "authorization_code",
    code: o.code,
    redirect_uri: o.redirectUri,
  });
  const body: unknown = await res.json().catch(() => null);
  const err = TokenError.safeParse(body);
  if (err.success) throw new McpError("unauthorized", `zoho token endpoint refused: ${err.data.error}`);
  // Zoho has minted a grant once a refresh token is in the body. Any refusal from here on revokes it, so a bad answer
  // never leaves a live grant behind (final review of M1, finding 3).
  const minted = (body as { refresh_token?: unknown } | null)?.refresh_token;
  try {
    if (!res.ok) throw new McpError("internal", `zoho token endpoint ${res.status}`);
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success) throw new McpError("internal", "zoho token endpoint returned an unexpected body");
    assertAuDomain(parsed.data.api_domain);
    return parsed.data;
  } catch (e) {
    if (typeof minted === "string" && minted.length > 0) await revokeToken(deps, minted);
    if (e instanceof McpError) throw e;
    throw new McpError("internal", "zoho token endpoint returned an unexpected body");
  }
}

export async function refreshAccessToken(
  env: Env,
  deps: Deps,
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number } | "invalid_grant"> {
  const res = await tokenPost(env, deps, { grant_type: "refresh_token", refresh_token: refreshToken });
  const body: unknown = await res.json().catch(() => null);
  const err = TokenError.safeParse(body);
  // Zoho says 200 either way; the body decides. invalid_code is what a revoked or unknown refresh token gets.
  if (err.success) {
    if (["invalid_code", "invalid_grant", "invalid_token"].includes(err.data.error)) return "invalid_grant";
    throw new McpError("internal", `zoho refresh refused: ${err.data.error}`);
  }
  if (!res.ok) throw new McpError("internal", `zoho refresh ${res.status}`);
  const parsed = RefreshResponse.safeParse(body);
  if (!parsed.success) throw new McpError("internal", "zoho refresh returned an unexpected body");
  return parsed.data;
}

async function jwks(deps: Deps) {
  const res = await deps.zohoFetch(ZOHO.jwksUrl);
  if (!res.ok) throw new McpError("internal", `zoho jwks ${res.status}`);
  return createLocalJWKSet(await res.json<JSONWebKeySet>());
}

export async function verifyIdToken(
  env: Env,
  deps: Deps,
  idToken: string,
  o: { nonce: string },
): Promise<{ sub: string; email: string }> {
  try {
    const { payload } = await jwtVerify(idToken, await jwks(deps), {
      issuer: ZOHO.issuer,
      audience: env.ZOHO_CLIENT_ID,
      algorithms: ["RS256", "RS384"],
      requiredClaims: ["sub", "email", "iat", "exp", "nonce"],
      maxTokenAge: "10 minutes",
      clockTolerance: 60,
    });
    if (payload.nonce !== o.nonce) throw new Error("nonce");
    if (payload.email_verified !== true) throw new Error("email_verified");
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") throw new Error("claims");
    return { sub: payload.sub, email: payload.email.toLowerCase() };
  } catch (e) {
    throw new McpError("unauthorized", `id_token rejected: ${(e as Error).message}`);
  }
}

/** Zoho echoes Mail scopes as VirtualOffice.*; ALL covers every operation. */
export function hasScope(granted: string, needed: string): boolean {
  const [, resource, op] = needed.split(".");
  return granted.split(/[\s,]+/).some((g) => {
    const [svc, res, o] = g.split(".");
    return (svc === "ZohoMail" || svc === "VirtualOffice") && res === resource && (o === "ALL" || o === op);
  });
}

export type ZohoAccount = { accountId: string; primaryEmail: string; sendAs: string[] };
const AccountsResponse = z.object({
  data: z.array(
    z.object({
      accountId: z.string(),
      primaryEmailAddress: z.string(),
      sendMailDetails: z.array(z.object({ fromAddress: z.string() })).default([]),
    }),
  ),
});
export async function fetchZohoAccounts(deps: Deps, location: Location, accessToken: string): Promise<ZohoAccount[]> {
  const res = await deps.zohoFetch(`${ZOHO.mailBase(location)}/accounts`, {
    headers: { authorization: `Zoho-oauthtoken ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new McpError("internal", `zoho accounts ${res.status}`);
  const parsed = AccountsResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new McpError("internal", "zoho accounts returned an unexpected body");
  return parsed.data.data.map((a) => ({
    accountId: a.accountId,
    primaryEmail: a.primaryEmailAddress.toLowerCase(),
    sendAs: [...new Set(a.sendMailDetails.map((s) => s.fromAddress.toLowerCase()))],
  }));
}

export async function revokeToken(deps: Deps, token: string): Promise<void> {
  await deps
    .zohoFetch(`${ZOHO.revokeUrl}?token=${encodeURIComponent(token)}`, { method: "POST" })
    .catch(() => undefined);
}

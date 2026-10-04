import { z } from "zod";
import { SLOT_NAMES, orgDomains, slots, type Env, type Slot } from "../env";
import { auditIntent, auditOutcome } from "../audit/log";
import { signToken, verifyToken } from "../crypto/hmac";
import { Keyring } from "../crypto/keyring";
import { randomId } from "../crypto/random";
import { escapeHtml, htmlResponse, redirect } from "../web/html";
import { OIDC_TTL_MS, type OidcState } from "../web/login";
import { type Route, requireSession } from "../web/router";
import { consumeState, putState } from "../web/state";
import {
  CONNECT_SCOPES,
  buildAuthUrl,
  exchangeCode,
  fetchZohoAccounts,
  hasScope,
  revokeToken,
  verifyIdToken,
} from "./oidc";

const E_PURPOSE = "zoho-mail-mcp:connect:v1";
const E_TTL_MS = 15 * 60_000;
const SlotParam = z.enum(SLOT_NAMES);
/** Spec D6: every scope the tools need. Zoho may echo them as VirtualOffice.*, which hasScope accepts. */
const REQUIRED_SCOPES = [
  "ZohoMail.messages.READ",
  "ZohoMail.messages.CREATE",
  "ZohoMail.messages.UPDATE",
  "ZohoMail.folders.READ",
  "ZohoMail.tags.ALL",
  "ZohoMail.accounts.READ",
] as const;

type ConnectState = OidcState & { slot?: Slot };

export function connectRedirectUri(env: Env): string {
  return `https://${env.WORKER_HOSTNAME}/zoho/callback`;
}

/** Ties a connect link handed to the model to the owner and slot it was minted for. */
export function connectElicitationId(env: Env, userId: string, slot: string): Promise<string> {
  return signToken(env.STATE_HMAC_KEY, E_PURPOSE, [userId, slot], Date.now() + E_TTL_MS);
}

export async function connectUrl(env: Env, userId: string, slot: string): Promise<string> {
  const e = await connectElicitationId(env, userId, slot);
  return `https://${env.WORKER_HOSTNAME}/connect?slot=${encodeURIComponent(slot)}&e=${e}`;
}

/**
 * One row per slot. A reconnect of a slot replaces its credentials and its Zoho identity, because after the
 * Zoho org move the same mailbox comes back under a different Zoho user. credential_version moves so a
 * refresh that read the old tokens cannot write back.
 */
export async function upsertAccount(
  env: Env,
  o: {
    userId: string;
    slot: Slot;
    zohoSub: string;
    email: string;
    zohoAccountId: string;
    location: "au";
    sendAs: string[];
    scopes: string;
    refreshToken: string;
    accessToken: string;
    accessExpiresAt: number;
  },
): Promise<{ id: string; created: boolean }> {
  const ring = Keyring.fromEnv(env);
  const now = Date.now();
  const expected = slots(env)[o.slot];
  const existing = await env.DB.prepare("SELECT id FROM accounts WHERE user_id = ? AND slot = ?")
    .bind(o.userId, o.slot)
    .first<{ id: string }>();
  if (existing) {
    const rt = await ring.encrypt(o.refreshToken, { userId: o.userId, accountId: existing.id, field: "refresh_token" });
    const at = await ring.encrypt(o.accessToken, { userId: o.userId, accountId: existing.id, field: "access_token" });
    await env.DB.prepare(
      `UPDATE accounts SET zoho_sub = ?, zoho_email = ?, zoho_account_id = ?, location = ?, expected_primary_email = ?,
         send_as = ?, scopes = ?, status = 'active', credential_version = credential_version + 1,
         refresh_token_enc = ?, refresh_token_key_id = ?, access_token_enc = ?, access_token_key_id = ?, access_expires_at = ?,
         last_refresh_at = ?
       WHERE id = ? AND user_id = ?`,
    )
      .bind(
        o.zohoSub,
        o.email,
        o.zohoAccountId,
        o.location,
        expected,
        JSON.stringify(o.sendAs),
        o.scopes,
        rt.ciphertext,
        rt.keyId,
        at.ciphertext,
        at.keyId,
        o.accessExpiresAt,
        now,
        existing.id,
        o.userId,
      )
      .run();
    return { id: existing.id, created: false };
  }
  const id = randomId("acc");
  const rt = await ring.encrypt(o.refreshToken, { userId: o.userId, accountId: id, field: "refresh_token" });
  const at = await ring.encrypt(o.accessToken, { userId: o.userId, accountId: id, field: "access_token" });
  await env.DB.prepare(
    `INSERT INTO accounts (id, user_id, alias, slot, expected_primary_email, zoho_sub, zoho_email, zoho_account_id, location,
       send_as, org_domains, scopes, status, is_default,
       refresh_token_enc, refresh_token_key_id, access_token_enc, access_token_key_id, access_expires_at, created_at, last_refresh_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active',
       (SELECT CASE WHEN EXISTS (SELECT 1 FROM accounts WHERE user_id = ? AND is_default = 1) THEN 0 ELSE 1 END),
       ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      o.userId,
      o.slot,
      o.slot,
      expected,
      o.zohoSub,
      o.email,
      o.zohoAccountId,
      o.location,
      JSON.stringify(o.sendAs),
      JSON.stringify(orgDomains(env)),
      o.scopes,
      o.userId,
      rt.ciphertext,
      rt.keyId,
      at.ciphertext,
      at.keyId,
      o.accessExpiresAt,
      now,
      now,
    )
    .run();
  return { id, created: true };
}

export const connectRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/connect$/,
    handler: async ({ env, request, url }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const slot = SlotParam.safeParse(url.searchParams.get("slot"));
      if (!slot.success) return htmlResponse("Bad slot", "<p>A slot is sarabi or rcp.</p>", null, 400);
      const e = url.searchParams.get("e");
      if (e !== null && !(await verifyToken(env.STATE_HMAC_KEY, E_PURPOSE, [s.userId, slot.data], e))) {
        return htmlResponse(
          "Refused",
          "<p>This connect link was made for a different owner or has expired.</p>",
          null,
          403,
        );
      }
      const state = randomId("st");
      const nonce = randomId("nc");
      const rec: ConnectState = {
        nonce,
        returnTo: "/accounts",
        slot: slot.data,
        userId: s.userId,
        sessionIdHash: s.idHash,
      };
      await putState(env.DB, "connect", state, rec, OIDC_TTL_MS);
      const target = buildAuthUrl(env, {
        redirectUri: connectRedirectUri(env),
        scope: CONNECT_SCOPES,
        state,
        nonce,
        offline: true,
      });
      return new Response(null, { status: 303, headers: { location: target, "cache-control": "no-store" } });
    },
  },
  {
    method: "GET",
    pattern: /^\/zoho\/callback$/,
    handler: async ({ env, deps, request, url }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const st = await consumeState<ConnectState>(env.DB, "connect", url.searchParams.get("state"));
      if (!st || !st.slot) return htmlResponse("Connect failed", "<p>State missing or already used.</p>", null, 400);
      if (st.sessionIdHash !== s.idHash || st.userId !== s.userId) {
        return htmlResponse(
          "Refused",
          "<p>This connection was started from a different browser session.</p>",
          null,
          403,
        );
      }
      if (url.searchParams.get("error"))
        return htmlResponse(
          "Connect failed",
          `<p>Zoho refused: ${escapeHtml(url.searchParams.get("error")!)}</p>`,
          null,
          400,
        );
      const code = url.searchParams.get("code");
      if (!code) return htmlResponse("Connect failed", "<p>No code.</p>", null, 400);
      const tokens = await exchangeCode(env, deps, { code, redirectUri: connectRedirectUri(env) });
      const refreshToken = tokens.refresh_token;
      if (!refreshToken) {
        return htmlResponse(
          "No refresh token",
          "<p>Zoho did not return a refresh token. Remove this app under Zoho Accounts, Connected Apps, and connect again.</p>",
          null,
          400,
        );
      }
      // From here on a refresh token exists at Zoho. Any failure before it is stored revokes it, so a failed
      // connect leaves no live grant behind.
      const fail = async (title: string, body: string, status: number): Promise<Response> => {
        await revokeToken(deps, refreshToken);
        return htmlResponse(title, body, null, status);
      };
      // The try ends at the upsert: once the row holds the grant, a later failure must not revoke it (final review
      // of M1, finding 6).
      let result: { id: string; created: boolean };
      try {
        for (const needed of REQUIRED_SCOPES)
          if (!hasScope(tokens.scope, needed))
            return fail(
              "Scope refused",
              `<p>Zoho did not grant ${escapeHtml(needed)}. Connect again and accept every permission.</p>`,
              400,
            );
        // Spec D3: the slot binds to its expected address. A Zoho user who does not own it stores nothing.
        const expected = slots(env)[st.slot];
        const location = tokens.location ?? "au";
        const accounts = await fetchZohoAccounts(deps, location, tokens.access_token);
        const match = accounts.find((a) => a.primaryEmail === expected);
        if (!match) {
          return fail(
            "Wrong mailbox",
            `<p><code>account_mismatch</code>: this slot is for <strong>${escapeHtml(expected)}</strong>, but the Zoho user you signed in as owns ${
              accounts.length
                ? accounts.map((a) => `<code>${escapeHtml(a.primaryEmail)}</code>`).join(", ")
                : "no mailbox"
            }. Nothing was stored. Sign out of Zoho, sign in as the user who owns ${escapeHtml(expected)}, and connect again.</p>`,
            409,
          );
        }
        if (!tokens.id_token) return fail("Connect failed", "<p>Zoho returned no identity token.</p>", 400);
        // The Zoho user's stable id comes from the id_token's sub; the nonce ties it to this flow.
        const id = await verifyIdToken(env, deps, tokens.id_token, { nonce: st.nonce });
        await auditIntent(env.DB, {
          userId: s.userId,
          accountId: null,
          tool: "connect_page",
          action: "account.connect",
          modifiers: [],
          decision: "browser",
          facts: {},
        });
        result = await upsertAccount(env, {
          userId: s.userId,
          slot: st.slot,
          zohoSub: id.sub,
          email: match.primaryEmail,
          zohoAccountId: match.accountId,
          location,
          sendAs: match.sendAs,
          scopes: tokens.scope,
          refreshToken,
          accessToken: tokens.access_token,
          accessExpiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
        });
      } catch (e) {
        await revokeToken(deps, refreshToken);
        throw e;
      }
      await auditOutcome(env.DB, {
        userId: s.userId,
        accountId: result.id,
        tool: "connect_page",
        action: "account.connect",
        modifiers: [],
        decision: "connected",
        facts: { ids: [result.id] },
      });
      return redirect("/accounts");
    },
  },
];

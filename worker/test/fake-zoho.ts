import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { FakeZohoMail } from "./fake-zoho-mail";
import { FakeGoogle } from "./fake-google"; // removed in M1 Task 1.6

export type ZohoAccountSeed = { accountId: string; primaryEmail: string; sendAs: string[] };
type CodeRecord = { sub: string; email: string; nonce: string; refresh: string; scope: string };
const field = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};
const ISSUER = "https://accounts.zoho.com.au";
/** Zoho echoes Mail scopes as VirtualOffice.*; the fake does the same so the scope check is exercised. */
const echoScope = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim().replace(/^ZohoMail\./, "VirtualOffice."))
    .join(" ");

export class FakeZoho {
  private priv!: CryptoKey;
  private jwks!: { keys: unknown[] };
  readonly codes = new Map<string, CodeRecord>();
  readonly refreshTokens = new Map<string, { state: "ok" | "invalid_grant"; sub: string; scope: string }>();
  readonly tokens = new Map<string, { sub: string; scope: string; expiresAt: number }>();
  readonly accounts = new Map<string, ZohoAccountSeed>(); // by sub
  readonly revoked = new Set<string>();
  readonly mail = new FakeZohoMail();
  readonly google = new FakeGoogle(); // removed in M1 Task 1.6
  tokenCalls = 0;
  /** Live Zoho omits `location` unless multi-DC is enabled on the API client. Default off, as the client's app is. */
  multiDc = false;
  private accessCounter = 0;
  beforeRefresh: (() => Promise<void>) | null = null;
  static async create(): Promise<FakeZoho> {
    const z = new FakeZoho();
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    z.priv = privateKey;
    const jwk = await exportJWK(publicKey);
    z.jwks = { keys: [{ ...jwk, kid: "k-test", alg: "RS256", use: "sig" }] };
    Object.assign(z.google, await FakeGoogle.create());
    return z;
  }
  issue(o: {
    sub: string;
    email: string;
    nonce: string;
    aud?: string;
    iss?: string;
    expSeconds?: number;
    emailVerified?: boolean;
  }) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ email: o.email, email_verified: o.emailVerified ?? true, nonce: o.nonce })
      .setProtectedHeader({ alg: "RS256", kid: "k-test" })
      .setIssuer(o.iss ?? ISSUER)
      .setAudience(o.aud ?? "1000.ZOHOTEST")
      .setSubject(o.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + (o.expSeconds ?? 300))
      .sign(this.priv);
  }
  grantCode(o: { sub: string; email: string; nonce: string; scope?: string }): string {
    const code = `code-${this.codes.size + 1}-${o.sub}`;
    const refresh = `rt-${code}`;
    const scope =
      o.scope ??
      "openid,email,ZohoMail.messages.READ,ZohoMail.messages.CREATE,ZohoMail.messages.UPDATE,ZohoMail.folders.READ,ZohoMail.tags.ALL,ZohoMail.accounts.READ";
    this.refreshTokens.set(refresh, { state: "ok", sub: o.sub, scope });
    this.codes.set(code, { ...o, refresh, scope });
    return code;
  }
  /** A ready access token for a seeded account, for tests that never run the connect flow. */
  directToken(accountId: string, scope?: string): string {
    const sub = [...this.accounts.entries()].find(([, a]) => a.accountId === accountId)?.[0] ?? `sub-${accountId}`;
    if (!this.accounts.has(sub))
      this.accounts.set(sub, {
        accountId,
        primaryEmail: `${accountId}@example.test`,
        sendAs: [`${accountId}@example.test`],
      });
    const t = `at-direct-${++this.accessCounter}`;
    this.tokens.set(t, {
      sub,
      scope: scope ?? "ZohoMail.messages.ALL,ZohoMail.folders.ALL,ZohoMail.tags.ALL,ZohoMail.accounts.READ",
      expiresAt: Date.now() + 3_600_000,
    });
    return t;
  }
  private mint(sub: string, scope: string) {
    const t = `at-${++this.accessCounter}`;
    this.tokens.set(t, { sub, scope, expiresAt: Date.now() + 3_600_000 });
    return t;
  }
  private has(scope: string, need: string) {
    const parts = scope.split(/[ ,]/);
    const [svc, res, op] = need.split(".");
    return parts.some((p) => {
      const [s, r, o] = p.split(".");
      return (s === svc || (svc === "ZohoMail" && s === "VirtualOffice")) && r === res && (o === "ALL" || o === op);
    });
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname.endsWith("google.com") || url.hostname.endsWith("googleapis.com")) return this.google.fetch(req);
    if (url.href === `${ISSUER}/.well-known/openid-configuration`)
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/v2/auth`,
        token_endpoint: `${ISSUER}/oauth/v2/token`,
        userinfo_endpoint: `${ISSUER}/oauth/v2/userinfo`,
        jwks_uri: `${ISSUER}/oauth/v2/keys`,
        scopes_supported: ["email", "profile", "openid", "phone"],
        code_challenge_methods_supported: ["plain", "S256"],
        id_token_signing_alg_values_supported: ["RS256", "RS384"],
      });
    if (url.href === `${ISSUER}/oauth/v2/keys`) return Response.json(this.jwks);
    if (url.href === `${ISSUER}/oauth/v2/token`) {
      this.tokenCalls++;
      const form = await req.formData();
      if (field(form, "client_id") !== "1000.ZOHOTEST" || field(form, "client_secret") !== "zsecret")
        return Response.json({ error: "invalid_client_secret" });
      if (field(form, "grant_type") === "authorization_code") {
        const rec = this.codes.get(field(form, "code"));
        if (!rec) return Response.json({ error: "invalid_code" });
        this.codes.delete(field(form, "code"));
        return Response.json({
          access_token: this.mint(rec.sub, rec.scope),
          refresh_token: rec.refresh,
          expires_in: 3600,
          token_type: "Bearer",
          scope: echoScope(rec.scope),
          api_domain: "https://www.zohoapis.com.au",
          ...(this.multiDc ? { location: "au" } : {}),
          ...(rec.scope.includes("openid")
            ? { id_token: await this.issue({ sub: rec.sub, email: rec.email, nonce: rec.nonce }) }
            : {}),
        });
      }
      if (field(form, "grant_type") === "refresh_token") {
        if (this.beforeRefresh) await this.beforeRefresh();
        const r = this.refreshTokens.get(field(form, "refresh_token"));
        if (!r || r.state !== "ok") return Response.json({ error: "invalid_code" });
        return Response.json({
          access_token: this.mint(r.sub, r.scope),
          expires_in: 3600,
          token_type: "Bearer",
          scope: echoScope(r.scope),
          api_domain: "https://www.zohoapis.com.au",
        });
      }
      return Response.json({ error: "unsupported_grant_type" });
    }
    // Zoho takes the token as a query parameter (`POST /oauth/v2/token/revoke?token=...`), not a form body.
    if (url.origin === ISSUER && url.pathname === "/oauth/v2/token/revoke") {
      const token = url.searchParams.get("token") ?? "";
      this.revoked.add(token);
      this.refreshTokens.delete(token);
      return Response.json({ status: "success" });
    }
    if (url.hostname === "mail.zoho.com.au") {
      const auth = req.headers.get("authorization") ?? "";
      const tok = this.tokens.get(auth.replace(/^Zoho-oauthtoken /, ""));
      const unauth = (code: string) =>
        Response.json([2, { msg: "Error while processing!", errorCode: code, authFail: "true", status: "401" }], {
          status: 401,
        });
      if (!tok || tok.expiresAt < Date.now()) return unauth("INVALID_OAUTHTOKEN");
      if (url.pathname === "/api/accounts") {
        if (!this.has(tok.scope, "ZohoMail.accounts.READ")) return unauth("INVALID_OAUTHSCOPE");
        const a = this.accounts.get(tok.sub);
        return Response.json({
          status: { code: 200, description: "success" },
          data: a
            ? [
                {
                  accountId: a.accountId,
                  primaryEmailAddress: a.primaryEmail,
                  type: "ZOHO_ACCOUNT",
                  emailAddress: [{ mailId: a.primaryEmail, isPrimary: true, isAlias: false, isConfirmed: true }],
                  sendMailDetails: a.sendAs.map((e) => ({ fromAddress: e, displayName: e })),
                },
              ]
            : [],
        });
      }
      const m = /^\/api\/accounts\/(\d+)(\/.*)$/.exec(url.pathname);
      if (!m) return Response.json({ error: "not_found" }, { status: 404 });
      const [, accountId, path] = m;
      const owner = this.accounts.get(tok.sub);
      if (!owner || owner.accountId !== accountId) return unauth("INVALID_OAUTHTOKEN");
      const need =
        req.method === "GET"
          ? path!.startsWith("/folders") && !path!.includes("/messages/")
            ? "ZohoMail.folders.READ"
            : path!.startsWith("/labels")
              ? "ZohoMail.tags.READ"
              : "ZohoMail.messages.READ"
          : req.method === "POST"
            ? path!.startsWith("/labels")
              ? "ZohoMail.tags.CREATE"
              : "ZohoMail.messages.CREATE"
            : req.method === "PUT"
              ? path!.startsWith("/labels")
                ? "ZohoMail.tags.UPDATE"
                : "ZohoMail.messages.UPDATE"
              : "ZohoMail.messages.DELETE";
      if (!this.has(tok.scope, need)) return unauth("INVALID_OAUTHSCOPE");
      return this.mail.fetch(req, accountId, path!);
    }
    return new Response("unexpected host " + url.hostname, { status: 500 });
  };
}

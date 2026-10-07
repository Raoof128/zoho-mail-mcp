// Deploy helpers for the client's production Worker (M7). Pure functions; the CLIs beside this file
// do the I/O. Nothing here prints a secret.
import { randomBytes } from "node:crypto";

export const PROD = {
  name: "zoho-mail-mcp",
  host: "mail-mcp.sarabisfinerugs.com.au",
  database: "zoho-mail-mcp",
  // Must equal the recovery_installation row seeded after the first migration, or /healthz stays in maintenance.
  restoreGeneration: "prod-1",
  ownerEmails: "info@sarabisfinerugs.com.au",
  slots: { sarabi: "info@sarabisfinerugs.com.au", rcp: "info@rugcleaningpro.com.au" },
  orgDomains: "sarabisfinerugs.com.au,sarabisfinerugs.com,rugcleaningpro.com.au",
} as const;

/** KEY=VALUE lines only; values are taken verbatim after the first "=", never evaluated by a shell. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** wrangler.jsonc carries full-line comments and trailing commas; strip both, then parse. */
function parseJsonc(text: string): Record<string, unknown> {
  const body = text
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(body) as Record<string, unknown>;
}

export function prodConfig(
  devJsonc: string,
  ids: { dbId: string; kvId: string; buildId: string },
): Record<string, unknown> {
  if (!/^[0-9a-f-]{8,}$/i.test(ids.dbId)) throw new Error("prod config: database id missing or malformed");
  if (!/^[0-9a-f-]{8,}$/i.test(ids.kvId)) throw new Error("prod config: kv namespace id missing or malformed");
  // BUILD_ID sits in vars, not on the deploy command line: a deploy that forgot --var would drop it and
  // assertInstallation would hold the Worker in maintenance.
  if (!/^[0-9a-f]{7,40}$/.test(ids.buildId)) throw new Error("prod config: build id missing or malformed");
  const dev = parseJsonc(devJsonc);
  return {
    ...dev,
    name: PROD.name,
    vars: {
      WORKER_HOSTNAME: PROD.host,
      RECOVERY_PROFILE: "normal",
      RESTORE_GENERATION: PROD.restoreGeneration,
      BUILD_ID: ids.buildId,
    },
    d1_databases: [
      { binding: "DB", database_name: PROD.database, database_id: ids.dbId, migrations_dir: "migrations" },
    ],
    kv_namespaces: [{ binding: "OAUTH_KV", id: ids.kvId }],
    routes: [{ pattern: PROD.host, custom_domain: true }],
    // The custom domain is the only address: a workers.dev or preview URL would answer outside WORKER_HOSTNAME.
    workers_dev: false,
    preview_urls: false,
  };
}

const need = (env: Record<string, string>, key: string): string => {
  const v = env[key];
  if (!v) throw new Error(`missing ${key} in .env`);
  return v;
};

/** The Worker's secrets, from .env. Generated keys live in .env as ZMC_* so every redeploy reuses them. */
export function workerSecrets(env: Record<string, string>): Record<string, string> {
  return {
    ZOHO_CLIENT_ID: need(env, "ZOHO_MCP_CLIENT_ID"),
    ZOHO_CLIENT_SECRET: need(env, "ZOHO_MCP_CLIENT_SECRET"),
    TOKEN_KEKS: JSON.stringify({ k1: need(env, "ZMC_TOKEN_KEK_K1") }),
    TOKEN_KEK_CURRENT: "k1",
    STATE_HMAC_KEY: need(env, "ZMC_STATE_HMAC_KEY"),
    CSRF_HMAC_KEY: need(env, "ZMC_CSRF_HMAC_KEY"),
    // Empty until the owner's first login shows their Zoho sub on the bootstrap page.
    OWNER_ZOHO_SUBS: env.ZMC_OWNER_ZOHO_SUBS ?? "",
    OWNER_EMAILS: env.ZMC_OWNER_EMAILS || PROD.ownerEmails,
    SLOTS: JSON.stringify(PROD.slots),
    ORG_DOMAINS: PROD.orgDomains,
  };
}

const GENERATED = ["ZMC_TOKEN_KEK_K1", "ZMC_STATE_HMAC_KEY", "ZMC_CSRF_HMAC_KEY"] as const;
/** Lines to append to .env for keys it does not have yet: 32 random bytes each, base64. */
export function generatedKeyLines(env: Record<string, string>): string[] {
  return GENERATED.filter((k) => !env[k]).map((k) => `${k}=${randomBytes(32).toString("base64")}`);
}

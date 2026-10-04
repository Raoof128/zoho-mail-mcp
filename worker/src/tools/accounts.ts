import { McpError } from "@zoho-mail-mcp/shared/errors";
import type { Env, Slot } from "../env";
import type { TrustContext } from "../policy/recipients";

export type AccountRef = {
  id: string;
  alias: string;
  slot: Slot;
  zohoAccountId: string;
  location: "au";
  email: string;
  sendAs: string[];
  orgDomains: string[];
  sendLimitBytes: number;
};
type Row = {
  id: string;
  alias: string;
  zoho_email: string;
  slot: Slot;
  zoho_account_id: string;
  location: "au";
  send_as: string;
  org_domains: string | null;
  send_limit_bytes: number;
  status: string;
};

function toRef(row: Row): AccountRef {
  if (row.status !== "active") {
    throw new McpError("account_needs_reconnect", `account_needs_reconnect: ${row.alias} is ${row.status}`, {
      alias: row.alias,
    });
  }
  return {
    id: row.id,
    alias: row.alias,
    email: row.zoho_email,
    slot: row.slot,
    zohoAccountId: row.zoho_account_id,
    location: row.location,
    sendAs: JSON.parse(row.send_as) as string[],
    orgDomains: JSON.parse(row.org_domains ?? "[]") as string[],
    sendLimitBytes: row.send_limit_bytes,
  };
}

const COLS = "id, alias, slot, zoho_email, zoho_account_id, location, send_as, org_domains, send_limit_bytes, status";

/** Explicit alias, or the default. Ownership is in the query. */
export async function resolveAccount(env: Env, userId: string, alias?: string): Promise<AccountRef> {
  const row = alias
    ? await env.DB.prepare(`SELECT ${COLS} FROM accounts WHERE user_id = ? AND alias = ?`)
        .bind(userId, alias)
        .first<Row>()
    : await env.DB.prepare(`SELECT ${COLS} FROM accounts WHERE user_id = ? AND is_default = 1`)
        .bind(userId)
        .first<Row>();
  if (!row)
    throw new McpError(
      "account_not_found",
      alias ? `account_not_found: ${alias}` : "account_not_found: no default account",
    );
  return toRef(row);
}

export async function accountById(env: Env, userId: string, accountId: string): Promise<AccountRef> {
  const row = await env.DB.prepare(`SELECT ${COLS} FROM accounts WHERE user_id = ? AND id = ?`)
    .bind(userId, accountId)
    .first<Row>();
  if (!row) throw new McpError("account_not_found", "account_not_found");
  return toRef(row);
}

/** Spec 2.8: self addresses, the allowlist, and (Workspace only) the organisation domains. */
export async function trustContext(env: Env, userId: string, acct: AccountRef): Promise<TrustContext> {
  const rows = await env.DB.prepare("SELECT pattern FROM contact_allowlist WHERE user_id = ? AND account_id = ?")
    .bind(userId, acct.id)
    .all<{ pattern: string }>();
  return {
    selfAddresses: [acct.email, ...acct.sendAs],
    allowlist: rows.results.map((r) => r.pattern),
    orgDomains: acct.orgDomains,
  };
}

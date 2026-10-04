import type { Env } from "../src/env";
import { Keyring } from "../src/crypto/keyring";

export async function seedUserAndAccount(
  db: D1Database,
  o: {
    userId: string;
    accountId: string;
    alias: string;
    slot?: "sarabi" | "rcp";
    isDefault?: boolean;
    orgDomains?: string[];
    sendAs?: string[];
    email?: string;
    /** Zoho account ids are numeric and the fake routes on `/api/accounts/(\d+)/`; a non-numeric id 404s (gauntlet round 2). */
    zohoAccountId?: string;
  },
): Promise<void> {
  const now = Date.now();
  const email = o.email ?? `${o.alias}@example.test`;
  const zohoAccountId = o.zohoAccountId ?? `191000${o.accountId.replace(/\D/g, "") || "1"}`;
  // Gmail-era tests name arbitrary aliases ("personal", "work"); the schema allows only the two slots, so a
  // test that names none takes the user's first free one (M0 Task 0.2 ruling).
  const taken = await db.prepare("SELECT slot FROM accounts WHERE user_id = ?").bind(o.userId).all<{ slot: string }>();
  const slot = o.slot ?? (taken.results.some((r) => r.slot === "sarabi") ? "rcp" : "sarabi");
  await db
    .prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind(o.userId, `${o.userId}@example.test`, now)
    .run();
  await db
    .prepare(
      `INSERT INTO accounts (id, user_id, alias, slot, expected_primary_email, zoho_sub, zoho_email, zoho_account_id, location,
         send_as, org_domains, scopes, status, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'au', ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(
      o.accountId,
      o.userId,
      o.alias,
      slot,
      email,
      `sub-${o.accountId}`,
      email,
      zohoAccountId,
      JSON.stringify(o.sendAs ?? []),
      o.orgDomains ? JSON.stringify(o.orgDomains) : null,
      "ZohoMail.messages.READ,ZohoMail.messages.CREATE,ZohoMail.messages.UPDATE,ZohoMail.folders.READ,ZohoMail.tags.ALL,ZohoMail.accounts.READ",
      o.isDefault ? 1 : 0,
      now,
    )
    .run();
}

export async function insertOperation(
  db: D1Database,
  id: string,
  userId: string,
  accountId: string,
  state: string,
  updatedAt = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO operations (id, user_id, account_id, action, state, payload_hash, created_at, updated_at) VALUES (?, ?, ?, 'send.message', ?, 'h', ?, ?)`,
    )
    .bind(id, userId, accountId, state, updatedAt, updatedAt)
    .run();
}

/** Stores an already-valid access token so tool tests never need the token endpoint. */
export async function seedAccessToken(
  e: Env,
  o: { userId: string; accountId: string; access?: string; refresh?: string; expiresInMs?: number },
): Promise<void> {
  const ring = Keyring.fromEnv(e);
  const at = await ring.encrypt(o.access ?? "at-seeded", {
    userId: o.userId,
    accountId: o.accountId,
    field: "access_token",
  });
  const rt = await ring.encrypt(o.refresh ?? "rt-seeded", {
    userId: o.userId,
    accountId: o.accountId,
    field: "refresh_token",
  });
  await e.DB.prepare(
    `UPDATE accounts SET status = 'active', access_token_enc = ?, access_token_key_id = ?, access_expires_at = ?,
       refresh_token_enc = ?, refresh_token_key_id = ? WHERE id = ? AND user_id = ?`,
  )
    .bind(
      at.ciphertext,
      at.keyId,
      Date.now() + (o.expiresInMs ?? 3_600_000),
      rt.ciphertext,
      rt.keyId,
      o.accountId,
      o.userId,
    )
    .run();
}

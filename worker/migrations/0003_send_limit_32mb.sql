-- Raouf, 2026-10-05: raise the per-message send limit to 32 MB (spec D14), from the Gmail-era 25 MiB cap.
-- SQLite cannot alter a CHECK, so the table is rebuilt. Thirteen tables reference accounts by name;
-- deferred foreign keys let the old table go and the new one take its name inside this migration.
PRAGMA defer_foreign_keys = on;
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 32 AND alias NOT GLOB '*[^a-z0-9_-]*'),
  slot TEXT NOT NULL CHECK (slot IN ('sarabi','rcp')),
  expected_primary_email TEXT NOT NULL,
  zoho_account_id TEXT NOT NULL,
  location TEXT NOT NULL CHECK (location IN ('au')),
  zoho_sub TEXT NOT NULL,
  zoho_email TEXT NOT NULL,
  send_as TEXT NOT NULL DEFAULT '[]',
  org_domains TEXT,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','needs_reconnect','revoked')),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  send_limit_bytes INTEGER NOT NULL DEFAULT 32000000 CHECK (send_limit_bytes BETWEEN 1 AND 32000000),
  refresh_token_enc BLOB, refresh_token_key_id TEXT,
  access_token_enc BLOB, access_token_key_id TEXT, access_expires_at INTEGER,
  created_at INTEGER NOT NULL, last_refresh_at INTEGER,
  credential_version INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, id),
  UNIQUE (user_id, alias),
  UNIQUE (user_id, zoho_sub)
);
INSERT INTO accounts_new(id,user_id,alias,slot,expected_primary_email,zoho_account_id,location,zoho_sub,zoho_email,send_as,org_domains,scopes,status,is_default,send_limit_bytes,refresh_token_enc,refresh_token_key_id,access_token_enc,access_token_key_id,access_expires_at,created_at,last_refresh_at,credential_version)
  SELECT id,user_id,alias,slot,expected_primary_email,zoho_account_id,location,zoho_sub,zoho_email,send_as,org_domains,scopes,status,is_default,CASE WHEN send_limit_bytes = 26214400 THEN 32000000 ELSE send_limit_bytes END,refresh_token_enc,refresh_token_key_id,access_token_enc,access_token_key_id,access_expires_at,created_at,last_refresh_at,credential_version FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
CREATE UNIQUE INDEX accounts_one_default ON accounts(user_id) WHERE is_default = 1;
CREATE UNIQUE INDEX accounts_user_slot_live ON accounts(user_id, slot) WHERE status != 'revoked';

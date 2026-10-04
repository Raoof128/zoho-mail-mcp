#!/usr/bin/env python3
"""Concatenate migrations 0001..0005 into one Zoho schema. Run once, commit the output, delete the inputs."""
import pathlib, re, sys
root = pathlib.Path(__file__).resolve().parents[2] / "worker" / "migrations"
parts = [root / f for f in ("0001_init.sql", "0002_identity.sql", "0003_intent.sql", "0004_transfers.sql", "0005_operation_recovery.sql")]
sql = "\n\n".join(p.read_text() for p in parts)

subs = [
    (r"google_sub", "zoho_sub"),
    (r"google_email", "zoho_email"),
    (r"gmail_result_id", "provider_result_id"),
    (r"CHECK\(kind IN \('gmail','refresh'\)\)", "CHECK(kind IN ('zoho','refresh'))"),
    (r"r2_key", "provider_ref"),  # every occurrence, including the UNIQUE ones in 0004
    # Spec 3.3: a slot per account, with the address the connect callback must see.
    (r"  alias TEXT NOT NULL CHECK \(length\(alias\) BETWEEN 1 AND 32 AND alias NOT GLOB '\*\[\^a-z0-9_-\]\*'\),",
     "  alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 32 AND alias NOT GLOB '*[^a-z0-9_-]*'),\n"
     "  slot TEXT NOT NULL CHECK (slot IN ('sarabi','rcp')),\n"
     "  expected_primary_email TEXT NOT NULL,\n"
     "  zoho_account_id TEXT NOT NULL,\n"
     "  location TEXT NOT NULL CHECK (location IN ('au')),"),
    # UNIQUE(user_id, slot) is deliberately NOT here: the Gmail-era test corpus seeds many accounts per owner
    # until M3 Task 3.6 deletes it; that task adds the index in its own migration (M0 Task 0.2 ruling).
]
for pat, rep in subs:
    sql, n = re.subn(pat, rep, sql)
    if n == 0:
        sys.exit(f"pattern not found: {pat}")

sql += """

-- Spec D16: no byte store in Cloudflare. A sealed handle names bytes Zoho holds (upload) or can
-- stream (download). provider_ref is JSON: {storeName, attachmentPath, attachmentName} for uploads,
-- {folderId, messageId, attachmentId} for downloads.
CREATE TABLE sealed_handles (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('download','upload')),
  provider_ref TEXT NOT NULL CHECK (json_valid(provider_ref)),
  filename TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size BETWEEN 0 AND 26214400), sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  reserved_by_operation_id TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, account_id, reserved_by_operation_id) REFERENCES operations(user_id, account_id, id)
);
CREATE INDEX sealed_handles_expires ON sealed_handles(expires_at);

-- One-time download links for claude.ai (spec section 0 table). Consumed by UPDATE ... RETURNING.
CREATE TABLE download_links (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, handle TEXT NOT NULL REFERENCES sealed_handles(handle),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
"""
out = root / "0001_init.sql"
out.write_text(sql)
for p in parts[1:]:
    p.unlink()
print(f"wrote {out} ({len(sql.splitlines())} lines); removed 0002..0005")

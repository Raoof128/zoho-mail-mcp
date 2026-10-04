CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE accounts (
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
  send_limit_bytes INTEGER NOT NULL DEFAULT 26214400 CHECK (send_limit_bytes BETWEEN 1 AND 26214400),
  refresh_token_enc BLOB, refresh_token_key_id TEXT,
  access_token_enc BLOB, access_token_key_id TEXT, access_expires_at INTEGER,
  created_at INTEGER NOT NULL, last_refresh_at INTEGER,
  UNIQUE (user_id, id),
  UNIQUE (user_id, alias),
  UNIQUE (user_id, zoho_sub)
);
CREATE UNIQUE INDEX accounts_one_default ON accounts(user_id) WHERE is_default = 1;

CREATE TABLE policies (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT,
  action TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('allow','ask','deny')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE UNIQUE INDEX policies_global_unique  ON policies(user_id, action) WHERE account_id IS NULL;
CREATE UNIQUE INDEX policies_account_unique ON policies(user_id, account_id, action) WHERE account_id IS NOT NULL;

CREATE TABLE contact_allowlist (
  user_id TEXT NOT NULL, account_id TEXT NOT NULL, pattern TEXT NOT NULL,
  PRIMARY KEY (account_id, pattern),
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  action TEXT NOT NULL,
  idempotency_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed','executing','delivery_unknown','executed','failed_safe')),
  payload_hash TEXT NOT NULL,
  rfc822_message_id TEXT,
  provider_result_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (user_id, account_id, id),
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE UNIQUE INDEX operations_idempotency
  ON operations(user_id, account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  action TEXT NOT NULL, modifiers TEXT NOT NULL,
  payload_json TEXT,
  payload_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','executing','executed','failed','denied','cancelled','expired')),
  operation_id TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  approved_at INTEGER, approved_via TEXT,
  execution_started_at INTEGER, executed_at INTEGER, error TEXT,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, account_id, operation_id) REFERENCES operations(user_id, account_id, id)
);

CREATE TABLE staging_objects (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('download','upload')),
  provider_ref TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  source_message_id TEXT, source_attachment_id TEXT,
  reserved_by_operation_id TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, account_id, reserved_by_operation_id) REFERENCES operations(user_id, account_id, id)
);

CREATE TABLE _assert (x INTEGER NOT NULL CHECK (x = 0));

CREATE TABLE web_sessions (
  id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, authenticated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL, user_id TEXT, account_id TEXT,
  tool TEXT, action TEXT, modifiers TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('intent','outcome')),
  decision TEXT,
  pending_id TEXT, operation_id TEXT, provider_result_id TEXT,
  summary TEXT,
  client_hint TEXT
);
CREATE INDEX audit_log_ts ON audit_log(ts);
CREATE INDEX pending_actions_state_expires ON pending_actions(state, expires_at);
CREATE INDEX operations_state_updated ON operations(state, updated_at);
CREATE INDEX staging_objects_expires ON staging_objects(expires_at);


-- Owner-level key/value state that is not per account. First use: the client id the OAuth provider
-- generated for the pre-registered companion client, because createClient() does not accept a chosen id.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One-use OAuth state: OIDC login and connect state (with the nonce), and pending consent requests.
-- Consumed by a single UPDATE ... RETURNING, so two callbacks carrying the same state can never both
-- succeed. KV was rejected for this because it is eventually consistent and get-then-delete races.
CREATE TABLE oauth_states (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('login','reauth','connect','authreq')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX oauth_states_expires ON oauth_states(expires_at);

-- Incremented by every reconnect and revocation. A refresh that started before the bump cannot write
-- its result back, which is what stops a stale refresh from repopulating a revoked account.
ALTER TABLE accounts ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0;


-- Idempotency keyed on the client's intent (spec 3.5), recorded before staging and before the
-- allow/ask fork so a key means the same thing on every path. A key follows its pending action or
-- operation; a failed_safe operation or a dead pending action releases it for a fresh attempt.
CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL, account_id TEXT NOT NULL, key TEXT NOT NULL,
  tool TEXT NOT NULL, intent_hash TEXT NOT NULL,
  pending_id TEXT, operation_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, account_id, key),
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, account_id, operation_id) REFERENCES operations(user_id, account_id, id)
);
-- The hash of the client's arguments, which is what an elicitation resume compares. payload_hash
-- stays the hash of the execution payload, which is what the claim and the approval page bind to.
ALTER TABLE pending_actions ADD COLUMN intent_hash TEXT;
ALTER TABLE pending_actions ADD COLUMN idempotency_key TEXT;
-- Ids only (message id, thread id, label id), so a replayed key can answer with the original result.
ALTER TABLE operations ADD COLUMN result_json TEXT;


-- Transfer identity outlives any individual HTTP request or ticket generation.
CREATE TABLE upload_transfers (
  user_id TEXT NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL, account_alias TEXT NOT NULL,
  metadata_json TEXT NOT NULL, intent_hash TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1 CHECK(payload_version = 1),
  state TEXT NOT NULL CHECK(state IN ('awaiting_approval','authorized','in_progress','completed','failed','expired','denied')),
  pending_id TEXT, operation_id TEXT, active_generation INTEGER NOT NULL DEFAULT 0,
  handle TEXT, handle_expires_at INTEGER, error TEXT,
  created_at INTEGER NOT NULL, authority_until INTEGER NOT NULL, retain_until INTEGER NOT NULL,
  PRIMARY KEY(user_id,id), UNIQUE(user_id,account_id,id),
  FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id),
  FOREIGN KEY(pending_id) REFERENCES pending_actions(id),
  FOREIGN KEY(user_id,account_id,operation_id) REFERENCES operations(user_id,account_id,id)
);
CREATE TABLE upload_generations (
  user_id TEXT NOT NULL, transfer_id TEXT NOT NULL, account_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 3), ticket_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('issued','uploading','stored','completed','expired','abandoned','failed')),
  issued_until INTEGER NOT NULL, admitted_at INTEGER, lease_until INTEGER,
  credential_version INTEGER, provider_ref TEXT NOT NULL UNIQUE, reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
  cleanup_state TEXT NOT NULL DEFAULT 'reserved' CHECK(cleanup_state IN ('reserved','debt','deleting','released','published')),
  writer_stopped INTEGER NOT NULL DEFAULT 0 CHECK(writer_stopped IN (0,1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,transfer_id,generation),
  FOREIGN KEY(user_id,account_id,transfer_id) REFERENCES upload_transfers(user_id,account_id,id)
);
CREATE UNIQUE INDEX upload_one_active ON upload_generations(user_id,transfer_id)
 WHERE state IN ('issued','uploading','stored');
CREATE INDEX upload_lease_expiry ON upload_generations(state,lease_until);
CREATE TABLE upload_retry_requests (
 user_id TEXT NOT NULL, transfer_id TEXT NOT NULL, retry_id TEXT NOT NULL,
 expected_generation INTEGER NOT NULL, result_generation INTEGER NOT NULL,
 PRIMARY KEY(user_id,transfer_id,retry_id),
 FOREIGN KEY(user_id,transfer_id,result_generation) REFERENCES upload_generations(user_id,transfer_id,generation)
);
-- Policy revision is asserted inside admission batches; a zero-row CAS must trigger _assert.
CREATE TABLE policy_revision (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT INTO policy_revision VALUES (1,0);
CREATE TRIGGER policy_revision_insert AFTER INSERT ON policies BEGIN UPDATE policy_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER policy_revision_update AFTER UPDATE ON policies BEGIN UPDATE policy_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER policy_revision_delete AFTER DELETE ON policies BEGIN UPDATE policy_revision SET version=version+1 WHERE id=1; END;
ALTER TABLE staging_objects ADD COLUMN cleanup_state TEXT NOT NULL DEFAULT 'available' CHECK(cleanup_state IN ('available','deleting'));
ALTER TABLE staging_objects ADD COLUMN download_lease_until INTEGER;
CREATE TABLE download_admissions (
 user_id TEXT NOT NULL, handle TEXT NOT NULL, account_id TEXT NOT NULL,
 admitted_at INTEGER NOT NULL, lease_until INTEGER NOT NULL, retain_until INTEGER NOT NULL,
 PRIMARY KEY(user_id,handle),
 FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id)
);
CREATE TABLE staging_acknowledgements (
 user_id TEXT NOT NULL, handle TEXT NOT NULL, account_id TEXT NOT NULL,
 acknowledged_at INTEGER NOT NULL, retain_until INTEGER NOT NULL,
 PRIMARY KEY(user_id,handle),
 FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id)
);
CREATE TABLE download_streams (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, handle TEXT NOT NULL, lease_until INTEGER NOT NULL,
 FOREIGN KEY(user_id,handle) REFERENCES download_admissions(user_id,handle)
);
CREATE TABLE staging_materializations(id TEXT PRIMARY KEY, lease_until INTEGER NOT NULL,user_id TEXT,account_id TEXT,reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id));
CREATE TABLE staging_ingests(
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_id TEXT NOT NULL,provider_ref TEXT NOT NULL UNIQUE,
 reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),lease_until INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','debt','released','published')),
 writer_stopped INTEGER NOT NULL DEFAULT 0 CHECK(writer_stopped IN (0,1)),
 FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id)
);
CREATE TABLE staging_recovery_slots(
 user_id TEXT NOT NULL,key TEXT NOT NULL,units INTEGER NOT NULL CHECK(units BETWEEN 1 AND 2),retain_until INTEGER NOT NULL,
 PRIMARY KEY(user_id,key),FOREIGN KEY(user_id) REFERENCES users(id)
);


-- Plan 5: compatibility guards precede protocol-2 writers. Existing rows stay legacy.
ALTER TABLE operations ADD COLUMN settlement_protocol INTEGER NOT NULL DEFAULT 1 CHECK(settlement_protocol IN (1,2));
ALTER TABLE operations ADD COLUMN result_identity TEXT;
ALTER TABLE operations ADD COLUMN settlement_context_json TEXT CHECK(settlement_context_json IS NULL OR
 (json_valid(settlement_context_json) AND length(CAST(settlement_context_json AS BLOB))<=2048));
ALTER TABLE operations ADD COLUMN byte_admitted INTEGER NOT NULL DEFAULT 0 CHECK(byte_admitted IN (0,1));
CREATE TABLE recovery_installation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema_version INTEGER NOT NULL CHECK(schema_version=5),
  restore_generation TEXT NOT NULL, mutation_state TEXT NOT NULL CHECK(mutation_state IN ('frozen','active'))
);
-- No default active row: trusted installation must bind the external generation first.
CREATE TABLE recovery_control (
  origin TEXT NOT NULL, build_id TEXT NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('generated_search','send_session_status')),
  state TEXT NOT NULL CHECK(state IN ('probe','enabled','disabled')), epoch TEXT NOT NULL CHECK(length(epoch)=46 AND epoch GLOB 'qe_*'),
  expires_at INTEGER NOT NULL, evidence_hash TEXT NOT NULL, probe_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(probe_ids)),
  PRIMARY KEY(origin,build_id,user_id,account_id,credential_version,mode),
  FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id)
);
CREATE TABLE operation_recovery (
  operation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL, binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  state TEXT NOT NULL CHECK(state IN ('active','manual','suspended','completed')),
  started_at INTEGER NOT NULL, deadline INTEGER NOT NULL CHECK(deadline=started_at+86400000),
  retain_until INTEGER NOT NULL CHECK(retain_until=started_at+604800000),
  next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 288),
  last_window INTEGER, lease_token TEXT, lease_until INTEGER,
  session_enc BLOB, session_key_id TEXT, session_digest TEXT,
  mime_length INTEGER CHECK(mime_length BETWEEN 0 AND 36700160),
  confirmed_offset INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_offset>=0),
  CHECK((session_enc IS NULL)=(session_key_id IS NULL)),
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK(mime_length IS NULL OR confirmed_offset<=mime_length),
  CHECK(COALESCE(length(session_enc),0)<=4124),
  CHECK(length(CAST(binding_json AS BLOB))+COALESCE(length(session_enc),0)<=8192),
  FOREIGN KEY(user_id,account_id,operation_id) REFERENCES operations(user_id,account_id,id)
);
CREATE INDEX recovery_due ON operation_recovery(state,next_attempt_at,started_at,operation_id);
CREATE TABLE recovery_attempts (
  window_id INTEGER NOT NULL, operation_id TEXT NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL, PRIMARY KEY(window_id,operation_id),
  FOREIGN KEY(user_id,account_id,operation_id) REFERENCES operations(user_id,account_id,id)
);
CREATE TABLE recovery_requests (
  id TEXT PRIMARY KEY, window_id INTEGER NOT NULL, operation_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('zoho','refresh')),
  FOREIGN KEY(operation_id) REFERENCES operations(id)
);
CREATE INDEX recovery_requests_time ON recovery_requests(admitted_at);
CREATE TABLE settlement_permits (
  operation_id TEXT PRIMARY KEY, token TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('begin','success','unknown','failed_safe','storage')),
  operation_writes INTEGER NOT NULL DEFAULT 0 CHECK(operation_writes BETWEEN 0 AND 1),
  audit_writes INTEGER NOT NULL DEFAULT 0 CHECK(audit_writes BETWEEN 0 AND 1),
  FOREIGN KEY(operation_id) REFERENCES operations(id)
);
CREATE TRIGGER protocol2_no_downgrade BEFORE UPDATE OF settlement_protocol ON operations
WHEN OLD.settlement_protocol=2 AND NEW.settlement_protocol!=2
BEGIN SELECT RAISE(ABORT,'protocol downgrade refused'); END;
CREATE TRIGGER protocol2_update_permit BEFORE UPDATE ON operations
WHEN (OLD.settlement_protocol=2 OR NEW.settlement_protocol=2) AND NOT EXISTS(
 SELECT 1 FROM settlement_permits p WHERE p.operation_id=OLD.id AND p.operation_writes=0
 AND OLD.id=NEW.id AND OLD.user_id=NEW.user_id AND OLD.account_id=NEW.account_id
 AND ((p.purpose='begin' AND OLD.settlement_protocol=1 AND OLD.state='claimed'
       AND NEW.settlement_protocol=2 AND NEW.state='executing' AND NEW.byte_admitted=1)
   OR (OLD.settlement_protocol=2 AND NEW.settlement_protocol=2
      AND NEW.settlement_context_json IS OLD.settlement_context_json
      AND NEW.rfc822_message_id IS OLD.rfc822_message_id
      AND NEW.idempotency_key IS OLD.idempotency_key AND
      ((p.purpose='success' AND OLD.state IN ('executing','delivery_unknown') AND NEW.state='executed')
       OR (p.purpose='unknown' AND OLD.state='executing' AND NEW.state='delivery_unknown')
       OR (p.purpose='failed_safe' AND OLD.state='claimed' AND OLD.byte_admitted=0 AND NEW.state='failed_safe')))))
BEGIN SELECT RAISE(ABORT,'settlement transition permit required'); END;
CREATE TRIGGER protocol2_count_update AFTER UPDATE ON operations
WHEN NEW.settlement_protocol=2
BEGIN UPDATE settlement_permits SET operation_writes=operation_writes+1 WHERE operation_id=NEW.id; END;
CREATE TRIGGER protocol2_delete_refused BEFORE DELETE ON operations WHEN OLD.settlement_protocol=2
BEGIN SELECT RAISE(ABORT,'retained operation required'); END;
CREATE TRIGGER protocol2_insert_refused BEFORE INSERT ON operations WHEN NEW.settlement_protocol=2
BEGIN SELECT RAISE(ABORT,'begin transaction required'); END;
CREATE TRIGGER protocol2_audit_permit BEFORE INSERT ON audit_log
WHEN NEW.phase='outcome' AND EXISTS(SELECT 1 FROM operations o WHERE (o.id=NEW.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=NEW.pending_id)) AND o.settlement_protocol=2)
 AND NOT EXISTS(SELECT 1 FROM settlement_permits p JOIN operations o ON o.id=p.operation_id
 WHERE p.operation_id=NEW.operation_id AND p.operation_writes=1 AND p.audit_writes=0
 AND NEW.user_id=o.user_id AND NEW.account_id=o.account_id
 AND ((p.purpose='success' AND NEW.decision='executed' AND o.state='executed')
   OR (p.purpose='unknown' AND NEW.decision='delivery_unknown' AND o.state='delivery_unknown')
   OR (p.purpose='failed_safe' AND NEW.decision='failed_safe' AND o.state='failed_safe')))
BEGIN SELECT RAISE(ABORT,'outcome transition permit required'); END;
CREATE TRIGGER protocol2_count_audit AFTER INSERT ON audit_log
WHEN NEW.phase='outcome' AND EXISTS(SELECT 1 FROM operations o WHERE (o.id=NEW.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=NEW.pending_id)) AND o.settlement_protocol=2)
BEGIN UPDATE settlement_permits SET audit_writes=audit_writes+1 WHERE operation_id=NEW.operation_id; END;
CREATE TRIGGER protocol2_pending_update BEFORE UPDATE ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id IN (OLD.operation_id,NEW.operation_id) AND o.settlement_protocol=2
 AND NOT EXISTS(SELECT 1 FROM settlement_permits p WHERE p.operation_id=o.id AND p.purpose IN ('success','unknown','failed_safe')))
BEGIN SELECT RAISE(ABORT,'pending settlement permit required'); END;
CREATE TRIGGER protocol2_pending_binding BEFORE UPDATE ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=OLD.operation_id AND o.settlement_protocol=2)
 AND (NEW.operation_id IS NOT OLD.operation_id OR NEW.id!=OLD.id)
BEGIN SELECT RAISE(ABORT,'pending binding immutable'); END;
CREATE TRIGGER protocol2_pending_insert BEFORE INSERT ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=NEW.operation_id AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'pending must precede begin'); END;
CREATE TRIGGER protocol2_pending_delete BEFORE DELETE ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=OLD.operation_id AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'retained pending binding required'); END;
ALTER TABLE staging_objects ADD COLUMN settlement_operation_id TEXT REFERENCES operations(id);
CREATE TRIGGER protocol2_staging_update BEFORE UPDATE ON staging_objects
WHEN EXISTS(SELECT 1 FROM operations o
 WHERE o.id IN (OLD.reserved_by_operation_id,NEW.reserved_by_operation_id,OLD.settlement_operation_id,NEW.settlement_operation_id)
 AND o.settlement_protocol=2 AND NOT EXISTS(SELECT 1 FROM settlement_permits p
 WHERE p.operation_id=o.id AND p.purpose IN ('begin','success','failed_safe','storage')))
BEGIN SELECT RAISE(ABORT,'staging settlement permit required'); END;
CREATE TRIGGER protocol2_staging_owner BEFORE UPDATE ON staging_objects
WHEN NEW.settlement_operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations o
 WHERE o.id=NEW.settlement_operation_id AND o.user_id=NEW.user_id AND o.account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'staging owner mismatch'); END;
CREATE TRIGGER protocol2_staging_insert BEFORE INSERT ON staging_objects
WHEN NEW.settlement_operation_id IS NOT NULL OR EXISTS(SELECT 1 FROM operations o
 WHERE o.id=NEW.reserved_by_operation_id AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'staging must precede begin'); END;
CREATE TRIGGER protocol2_staging_binding BEFORE UPDATE ON staging_objects
WHEN OLD.settlement_operation_id IS NOT NULL AND NEW.settlement_operation_id IS NOT OLD.settlement_operation_id
BEGIN SELECT RAISE(ABORT,'staging binding immutable'); END;
CREATE TRIGGER protocol2_staging_delete BEFORE DELETE ON staging_objects
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id IN (OLD.reserved_by_operation_id,OLD.settlement_operation_id)
 AND o.settlement_protocol=2 AND NOT EXISTS(SELECT 1 FROM settlement_permits p WHERE p.operation_id=o.id AND p.purpose='storage'))
BEGIN SELECT RAISE(ABORT,'storage cleanup permit required'); END;
CREATE TRIGGER protocol2_key_update BEFORE UPDATE ON idempotency_keys
WHEN EXISTS(SELECT 1 FROM operations o WHERE (o.id=OLD.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=OLD.pending_id)) AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'retained idempotency binding required'); END;
CREATE TRIGGER protocol2_key_delete BEFORE DELETE ON idempotency_keys
WHEN EXISTS(SELECT 1 FROM operations o WHERE (o.id=OLD.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=OLD.pending_id)) AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'retained idempotency binding required'); END;


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

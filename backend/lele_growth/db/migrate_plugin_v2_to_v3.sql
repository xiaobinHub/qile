-- Add private plugin platform state. Additive only; no existing plugin data is rewritten.
CREATE TABLE IF NOT EXISTS lele.plugin_private_records (
 child_id text NOT NULL, plugin_id text NOT NULL, collection text NOT NULL, record_id text NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(child_id,plugin_id,collection,record_id),
 FOREIGN KEY(child_id,plugin_id) REFERENCES lele.child_plugins(child_id,plugin_id)
);
CREATE INDEX IF NOT EXISTS plugin_private_records_expiry ON lele.plugin_private_records(expires_at);
CREATE TABLE IF NOT EXISTS lele.plugin_credentials (
 id text PRIMARY KEY, child_id text NOT NULL, plugin_id text NOT NULL, provider text NOT NULL,
 key_id text NOT NULL, nonce text NOT NULL, ciphertext text NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 expires_at timestamptz, masked_account text NOT NULL DEFAULT '', state text NOT NULL CHECK(state IN ('candidate','active','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(child_id,plugin_id) REFERENCES lele.child_plugins(child_id,plugin_id)
);
CREATE INDEX IF NOT EXISTS plugin_credentials_state ON lele.plugin_credentials(child_id,plugin_id,state,expires_at);
CREATE TABLE IF NOT EXISTS lele.plugin_external_operations (
 operation_id uuid PRIMARY KEY, child_id text NOT NULL, plugin_id text NOT NULL, actor_id text NOT NULL REFERENCES lele.users(id),
 binding_revision bigint NOT NULL DEFAULT 0, credential_id text, credential_revision bigint,
 remote_fingerprint text NOT NULL, kind text NOT NULL, request_hash text NOT NULL, hash_key_id text NOT NULL,
 resource_keys jsonb NOT NULL DEFAULT '[]', state text NOT NULL CHECK(state IN ('prepared','dispatching','succeeded','failed','uncertain','partially_succeeded','needs_repair','cancelled')),
 stage text NOT NULL, stage_version bigint NOT NULL DEFAULT 1 CHECK(stage_version>0),
 sanitized_request jsonb NOT NULL DEFAULT '{}', baseline jsonb NOT NULL DEFAULT '{}', result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 FOREIGN KEY(child_id,plugin_id) REFERENCES lele.child_plugins(child_id,plugin_id)
);
CREATE INDEX IF NOT EXISTS plugin_external_operations_scope ON lele.plugin_external_operations(child_id,plugin_id,state,updated_at);
CREATE TABLE IF NOT EXISTS lele.plugin_external_leases (
 plugin_id text NOT NULL REFERENCES lele.plugin_catalog(id), remote_fingerprint text NOT NULL,
 operation_id uuid NOT NULL REFERENCES lele.plugin_external_operations(operation_id), lease_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(plugin_id,remote_fingerprint)
);
CREATE TABLE IF NOT EXISTS lele.plugin_resource_tickets (
 ticket text PRIMARY KEY, child_id text NOT NULL, plugin_id text NOT NULL,
 credential_id text, credential_revision bigint, binding_revision bigint NOT NULL DEFAULT 0,
 installation_generation bigint NOT NULL, upstream_url text NOT NULL, purpose text NOT NULL,
 mime text, filename text, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(child_id,plugin_id) REFERENCES lele.child_plugins(child_id,plugin_id)
);
CREATE INDEX IF NOT EXISTS plugin_resource_tickets_expiry ON lele.plugin_resource_tickets(expires_at);
ALTER TABLE lele.plugin_platform_versions
 DROP CONSTRAINT plugin_platform_versions_version_check;
ALTER TABLE lele.plugin_platform_versions
 ADD CONSTRAINT plugin_platform_versions_version_check CHECK(version IN (1,2,3));

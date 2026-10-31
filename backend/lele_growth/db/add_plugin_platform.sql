-- Explicit, transactional plugin platform migration. Never run during web startup.
CREATE TABLE IF NOT EXISTS lele.plugin_platform_versions (
 version integer PRIMARY KEY CHECK(version=1), source_sha256 text NOT NULL,
 installed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lele.plugin_catalog (
 id text PRIMARY KEY CHECK(id ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
 type text NOT NULL CHECK(type IN ('page','service')),
 name text NOT NULL, description text NOT NULL DEFAULT '', instructions text NOT NULL DEFAULT '', icon text NOT NULL DEFAULT '',
 publication_status text NOT NULL DEFAULT 'pending' CHECK(publication_status IN ('pending','published','unpublished')),
 scope_mode text NOT NULL DEFAULT 'all' CHECK(scope_mode IN ('all','children')),
 sort_order integer NOT NULL DEFAULT 0, active_release_id text,
 operation_state text NOT NULL DEFAULT 'ready' CHECK(operation_state IN ('ready','updating','failed')),
 policy_revision bigint NOT NULL DEFAULT 1 CHECK(policy_revision>0),
 release_epoch bigint NOT NULL DEFAULT 1 CHECK(release_epoch>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lele.plugin_releases (
 release_id text PRIMARY KEY, plugin_id text NOT NULL REFERENCES lele.plugin_catalog(id),
 version text NOT NULL CHECK(version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'), manifest jsonb NOT NULL,
 artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'), source_commit text NOT NULL,
 config_schema jsonb NOT NULL DEFAULT '{"type":"object","properties":{},"required":[]}',
 data_schema_version integer NOT NULL DEFAULT 1 CHECK(data_schema_version>0),
 validation_result jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(plugin_id,version), UNIQUE(plugin_id,release_id)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='plugin_active_release_fk' AND conrelid='lele.plugin_catalog'::regclass) THEN
  ALTER TABLE lele.plugin_catalog ADD CONSTRAINT plugin_active_release_fk FOREIGN KEY(id,active_release_id)
   REFERENCES lele.plugin_releases(plugin_id,release_id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS lele.plugin_scope_children (
 plugin_id text NOT NULL REFERENCES lele.plugin_catalog(id), child_id text NOT NULL REFERENCES lele.children(id),
 PRIMARY KEY(plugin_id,child_id)
);
CREATE TABLE IF NOT EXISTS lele.child_plugins (
 child_id text NOT NULL REFERENCES lele.children(id), plugin_id text NOT NULL REFERENCES lele.plugin_catalog(id),
 installed boolean NOT NULL DEFAULT false, enabled boolean NOT NULL DEFAULT false, requires_reenable boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 installed_by text REFERENCES lele.users(id), updated_by text REFERENCES lele.users(id),
 installed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(child_id,plugin_id), CHECK(NOT enabled OR installed)
);
CREATE TABLE IF NOT EXISTS lele.child_plugin_configs (
 child_id text NOT NULL, plugin_id text NOT NULL, config jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(config)='object'),
 config_schema_version integer NOT NULL DEFAULT 1, config_revision bigint NOT NULL DEFAULT 0 CHECK(config_revision>=0),
 updated_by text REFERENCES lele.users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(child_id,plugin_id), FOREIGN KEY(child_id,plugin_id) REFERENCES lele.child_plugins(child_id,plugin_id)
);
CREATE TABLE IF NOT EXISTS lele.child_plugin_records (
 child_id text NOT NULL, plugin_id text NOT NULL, collection text NOT NULL, record_id text NOT NULL,
 payload jsonb NOT NULL, data_schema_version integer NOT NULL DEFAULT 1,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(child_id,plugin_id,collection,record_id), FOREIGN KEY(child_id,plugin_id) REFERENCES lele.child_plugins(child_id,plugin_id)
);
CREATE TABLE IF NOT EXISTS lele.plugin_operations (
 child_id text NOT NULL, plugin_id text NOT NULL, operation_id text NOT NULL, actor_id text NOT NULL REFERENCES lele.users(id),
 payload_sha256 text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(child_id,plugin_id,operation_id), FOREIGN KEY(child_id,plugin_id) REFERENCES lele.child_plugins(child_id,plugin_id)
);
CREATE TABLE IF NOT EXISTS lele.plugin_jobs (
 id text PRIMARY KEY, plugin_id text NOT NULL, child_id text NOT NULL, task_id text NOT NULL, occurrence_key text NOT NULL,
 due_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','retry','succeeded','failed','cancelled','skipped','uncertain')),
 payload jsonb NOT NULL DEFAULT '{}', result jsonb, lease_owner text, lease_until timestamptz, attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
 generation bigint NOT NULL, config_revision bigint NOT NULL, release_epoch bigint NOT NULL, release_id text,
 cancel_requested boolean NOT NULL DEFAULT false, last_error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(plugin_id,child_id,task_id,occurrence_key), FOREIGN KEY(child_id,plugin_id) REFERENCES lele.child_plugins(child_id,plugin_id)
);
CREATE INDEX IF NOT EXISTS plugin_jobs_due ON lele.plugin_jobs(status,due_at);
CREATE TABLE IF NOT EXISTS lele.plugin_event_outbox (
 event_id text PRIMARY KEY, child_id text NOT NULL REFERENCES lele.children(id), event_type text NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}', source_revision bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lele.plugin_event_deliveries (
 event_id text NOT NULL REFERENCES lele.plugin_event_outbox(event_id), plugin_id text NOT NULL REFERENCES lele.plugin_catalog(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','retry','succeeded','failed','cancelled','skipped','uncertain')),
 lease_owner text, lease_until timestamptz, attempt integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 generation bigint, config_revision bigint, release_epoch bigint, release_id text,
 cancel_requested boolean NOT NULL DEFAULT false, last_error_code text, result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(event_id,plugin_id)
);
CREATE INDEX IF NOT EXISTS plugin_events_pending ON lele.plugin_event_deliveries(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS lele.plugin_effects (
 plugin_id text NOT NULL, child_id text NOT NULL, effect_key text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','running','succeeded','failed','uncertain')), result jsonb, external_id text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(plugin_id,child_id,effect_key), FOREIGN KEY(child_id,plugin_id) REFERENCES lele.child_plugins(child_id,plugin_id)
);
CREATE TABLE IF NOT EXISTS lele.plugin_deployments (
 id text PRIMARY KEY, plugin_id text NOT NULL REFERENCES lele.plugin_catalog(id), actor text NOT NULL,
 old_release_id text REFERENCES lele.plugin_releases(release_id), new_release_id text REFERENCES lele.plugin_releases(release_id),
 phase text NOT NULL, status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed','rolled_back')),
 lease_owner text, lease_until timestamptz, checks jsonb NOT NULL DEFAULT '{}', result jsonb NOT NULL DEFAULT '{}', error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_deployment_active ON lele.plugin_deployments(plugin_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS child_plugins_enabled ON lele.child_plugins(plugin_id,child_id) WHERE installed AND enabled;

-- Archive/restore is no longer public, but legacy maintenance can still update
-- this column. Revocation must persist even when archive and restore occur
-- before any plugin request. No catalog lock is taken after the child lock.
CREATE OR REPLACE FUNCTION lele.revoke_archived_child_plugins()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE lele.child_plugins SET requires_reenable=true,revision=revision+1,generation=generation+1,updated_at=now()
 WHERE child_id=NEW.id AND installed;
 UPDATE lele.plugin_jobs SET status=CASE WHEN status='running' THEN status ELSE 'cancelled' END,
 cancel_requested=true,updated_at=now()
 WHERE child_id=NEW.id AND status IN ('pending','retry','running');
 UPDATE lele.plugin_event_deliveries d SET status=CASE WHEN d.status='running' THEN d.status ELSE 'cancelled' END,
 cancel_requested=true,updated_at=now()
 FROM lele.plugin_event_outbox o WHERE o.event_id=d.event_id AND o.child_id=NEW.id AND d.status IN ('pending','retry','running');
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS plugin_child_archive_revoke ON lele.children;
CREATE TRIGGER plugin_child_archive_revoke AFTER UPDATE OF archived ON lele.children
FOR EACH ROW WHEN (NEW.archived AND NOT OLD.archived)
EXECUTE FUNCTION lele.revoke_archived_child_plugins();

-- Metadata only; inline image migration is a separate checked operator action.
CREATE TABLE lele.media_assets (
 id text PRIMARY KEY,
 child_id text NOT NULL REFERENCES lele.children(id),
 uploaded_by text NOT NULL REFERENCES lele.users(id),
 upload_id text NOT NULL CHECK (upload_id ~ '^[A-Za-z0-9._:-]{8,100}$'),
 membership_version text NOT NULL,
 object_key text NOT NULL,
 content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
 mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
 byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 184320),
 width integer NOT NULL CHECK (width BETWEEN 1 AND 8192),
 height integer NOT NULL CHECK (height BETWEEN 1 AND 8192),
 state text NOT NULL CHECK (state IN ('uploading','staged','attached','failed','deleted')),
 lease_token text,
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 attached_at timestamptz,
 UNIQUE(child_id,uploaded_by,upload_id)
);
CREATE INDEX media_assets_child_key ON lele.media_assets(child_id,object_key);
CREATE INDEX media_assets_cleanup ON lele.media_assets(created_at) WHERE state IN ('uploading','staged','failed');
ALTER TABLE lele.app_metadata DROP CONSTRAINT app_metadata_db_schema_version_check;
ALTER TABLE lele.app_metadata ALTER COLUMN db_schema_version SET DEFAULT 4;
UPDATE lele.app_metadata SET db_schema_version=4;
ALTER TABLE lele.app_metadata ADD CONSTRAINT app_metadata_db_schema_version_check CHECK (db_schema_version=4);
ALTER TABLE lele.migration_runs DROP CONSTRAINT migration_runs_db_schema_version_check;
ALTER TABLE lele.migration_runs ADD CONSTRAINT migration_runs_db_schema_version_check CHECK (db_schema_version IN (2,3,4));
ALTER TABLE lele.schema_versions DROP CONSTRAINT schema_versions_version_check;
UPDATE lele.schema_versions SET version=4;
ALTER TABLE lele.schema_versions ADD CONSTRAINT schema_versions_version_check CHECK (version=4);

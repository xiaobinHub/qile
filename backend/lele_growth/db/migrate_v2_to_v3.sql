-- Logical child deletion. Run through child_service's guarded local upgrade CLI.
ALTER TABLE lele.children
 ADD COLUMN deleted_at timestamptz,
 ADD COLUMN deleted_by text REFERENCES lele.users(id),
 ADD CONSTRAINT child_deletion_complete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

ALTER TABLE lele.app_metadata DROP CONSTRAINT app_metadata_db_schema_version_check;
ALTER TABLE lele.app_metadata ALTER COLUMN db_schema_version SET DEFAULT 3;
UPDATE lele.app_metadata SET db_schema_version=3;
ALTER TABLE lele.app_metadata ADD CONSTRAINT app_metadata_db_schema_version_check CHECK (db_schema_version=3);

-- Historical migration reports keep their original version.
ALTER TABLE lele.migration_runs DROP CONSTRAINT migration_runs_db_schema_version_check;
ALTER TABLE lele.migration_runs ADD CONSTRAINT migration_runs_db_schema_version_check CHECK (db_schema_version IN (2,3));
ALTER TABLE lele.schema_versions DROP CONSTRAINT schema_versions_version_check;
UPDATE lele.schema_versions SET version=3;
ALTER TABLE lele.schema_versions ADD CONSTRAINT schema_versions_version_check CHECK (version=3);

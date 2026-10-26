-- Account appearance only. Child business data and its v4 mapping stay unchanged.
ALTER TABLE lele.users ADD COLUMN avatar_id text NOT NULL DEFAULT 'father'
 CHECK (avatar_id IN ('father','mother','grandfather','grandmother'));
ALTER TABLE lele.schema_versions DROP CONSTRAINT schema_versions_version_check;
UPDATE lele.schema_versions SET version=5;
ALTER TABLE lele.schema_versions ADD CONSTRAINT schema_versions_version_check CHECK (version=5);

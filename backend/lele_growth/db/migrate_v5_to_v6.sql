-- Family relationship is separate from access role and account appearance.
-- Existing accounts remain unspecified; never infer relationships from avatars.
ALTER TABLE lele.users ADD COLUMN family_role text
 CHECK (family_role IN ('father','mother','grandfather','grandmother'));
ALTER TABLE lele.schema_versions DROP CONSTRAINT schema_versions_version_check;
UPDATE lele.schema_versions SET version=6;
ALTER TABLE lele.schema_versions ADD CONSTRAINT schema_versions_version_check CHECK (version=6);

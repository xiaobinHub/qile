-- Explicit additive upgrade. Historical events have no proven recipients.
ALTER TABLE lele.plugin_platform_versions
 DROP CONSTRAINT plugin_platform_versions_version_check;
ALTER TABLE lele.plugin_platform_versions
 ADD CONSTRAINT plugin_platform_versions_version_check CHECK(version IN (1,2));
ALTER TABLE lele.plugin_event_outbox
 ADD COLUMN recipients jsonb NOT NULL DEFAULT '[]'::jsonb
 CHECK(jsonb_typeof(recipients)='array');

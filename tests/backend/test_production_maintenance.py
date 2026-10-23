"""Production semantics on disposable lele_test* DBs; all OSS I/O is replaced."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

import psycopg
from psycopg import sql

from lele_growth.child_service import ChildService, ApiError, initialize, bootstrap
from lele_growth.maintenance import schema_sources
from lele_growth.media_migration import cleanup
from lele_growth.object_storage import ObjectStorage, storage_config
from lele_growth.postgres_store import PostgresStore
from lele_growth.production_maintenance import production_service, target_details, execute
from lele_growth.storage import StoreError

CONFIG = os.environ.get('LELE_TEST_CONFIG')
PASSWORD = 'Isolated-test-123!'


@unittest.skipUnless(CONFIG, 'Set LELE_TEST_CONFIG to an isolated local test database')
class ProductionMaintenanceTests(unittest.TestCase):
    def setUp(self):
        base = ChildService(CONFIG).config
        self.assertEqual(base['environment'], 'development')
        self.assertTrue(base['_connect']['dbname'].startswith('lele_test'))
        self.name = 'lele_test_production_ops_' + uuid.uuid4().hex[:12]
        self.admin = {**base['_connect'], 'dbname': 'postgres'}
        with psycopg.connect(**self.admin, autocommit=True) as db:
            db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(self.name)))
        self.addCleanup(self.drop_database)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = {k: copy.deepcopy(v) for k, v in base.items()
                       if not k.startswith('_') and not k.endswith('_trusted_origins') and k != 'object_storage'}
        self.config.update(environment='production', parent_origin='https://parent.example.invalid',
                           admin_origin='https://admin.example.invalid')
        self.config['database']['dbname'] = self.name
        self.path = self.root / 'production.json'
        self.write_config()
        self.service = production_service(self.path)
        self.target = target_details(self.service)['targetId']

    def drop_database(self):
        with psycopg.connect(**self.admin, autocommit=True) as db:
            db.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(self.name)))

    def write_config(self):
        self.path.write_text(json.dumps(self.config))
        self.path.chmod(0o600)

    def apply(self, action, **kwargs):
        return execute(self.service, action, apply=True, confirm=self.target, **kwargs)

    def initialize(self):
        return self.apply('initialize')

    def events(self, action):
        def read(cur):
            cur.execute('SELECT detail FROM lele.audit_events WHERE action=%s', (action,))
            return [row[0] for row in cur.fetchall()]
        return self.service.transaction(read)

    def test_preview_confirm_initialize_idempotency_bootstrap_and_secret_absence(self):
        preview = execute(self.service, 'initialize')
        self.assertEqual(preview['schema'], {'version': None, 'users': 0})
        with patch('psycopg.connect') as connect, self.assertRaises(ApiError):
            execute(self.service, 'initialize', apply=True, confirm='wrong-target')
        connect.assert_not_called()
        self.assertTrue(self.initialize()['initialized'])
        self.assertFalse(self.initialize()['initialized'])
        self.assertEqual(len(self.events('maintenance.schema.initialize')), 1)
        self.assertEqual(execute(self.service, 'bootstrap-admin')['schema']['users'], 0)
        with patch.object(self.service, 'audit', side_effect=ApiError(503, '隔离审计故障')), self.assertRaises(ApiError):
            self.apply('bootstrap-admin', login_name='operator', nickname='管理', password=PASSWORD)
        self.assertEqual(execute(self.service, 'bootstrap-admin')['schema']['users'], 0)
        result = self.apply('bootstrap-admin', login_name='operator', nickname='管理', password=PASSWORD)
        self.assertEqual(result['user']['role'], 'admin')
        self.assertTrue(result['user']['mustChangePassword'])
        with self.assertRaises(ApiError):
            self.apply('bootstrap-admin', login_name='other', nickname='管理', password=PASSWORD)
        self.assertEqual(len(self.events('bootstrap.admin')), 1)
        self.assertNotIn(PASSWORD, json.dumps(result))
        self.assertNotIn(self.config['database'].get('password', 'never-disclosed'), json.dumps(preview))
        with self.assertRaises(ApiError): initialize(self.path)
        with self.assertRaises(ApiError): bootstrap(self.path, 'other', '管理', PASSWORD)
        with self.assertRaises(ApiError): cleanup(self.path, apply=True)

    def test_private_files_environment_and_production_storage_guards(self):
        self.path.chmod(0o644)
        with self.assertRaises(ApiError): production_service(self.path)
        self.path.chmod(0o600)
        linked = self.root / 'link.json'
        linked.symlink_to(self.path)
        with self.assertRaises(ApiError): production_service(linked)
        with self.assertRaises(ApiError): production_service(CONFIG)
        with self.assertRaises(ValueError):
            storage_config({'provider': 'test-filesystem', 'root': str(self.root)}, self.path, 'production', self.name)
        self.initialize()
        with self.assertRaises(ApiError): execute(self.service, 'cleanup-staged')

    def test_upgrade_requires_existing_schema_and_refuses_unknown_structure(self):
        with self.assertRaises(ApiError): execute(self.service, 'upgrade')
        self.initialize()
        self.service.transaction(lambda cur: cur.execute('ALTER TABLE lele.children ADD COLUMN unknown text'))
        with self.assertRaises(ApiError): execute(self.service, 'upgrade')
        with self.assertRaises(ApiError): self.apply('upgrade')
        self.assertEqual(self.service.transaction(lambda cur: cur.execute('SELECT version FROM lele.schema_versions').fetchone()), (4,))

    def test_v2_and_v3_upgrade_previews_and_audits(self):
        source, migration, _, hashes = schema_sources()
        for version in (2, 3):
            with self.subTest(version=version):
                def fixture(cur):
                    cur.execute('DROP SCHEMA IF EXISTS lele CASCADE')
                    cur.execute(source)
                    if version == 3: cur.execute(migration)
                    marker = f'lele-schema-v{version}:{hashes[version]}:{PostgresStore._catalog(cur)}'
                    cur.execute(sql.SQL('COMMENT ON SCHEMA lele IS {}').format(sql.Literal(marker)))
                self.service.transaction(fixture, exclusive=True, schema_check=False)
                self.assertEqual(execute(self.service, 'upgrade')['schema']['version'], version)
                with patch.object(self.service, 'audit', side_effect=ApiError(503, '隔离事务故障')), self.assertRaises(ApiError):
                    self.apply('upgrade')
                self.assertEqual(execute(self.service, 'upgrade')['schema']['version'], version)
                self.assertTrue(self.apply('upgrade')['upgraded'])
                self.assertFalse(self.apply('upgrade')['upgraded'])
                events = self.events('maintenance.schema.upgrade')
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]['fromVersion'], version)

    def enable_objects(self):
        credentials = self.root / 'fake-credentials.json'
        credentials.write_text(json.dumps({'access_key_id': 'test-key-id-unused', 'access_key_secret': 'test-secret-unused'}))
        credentials.chmod(0o600)
        self.config['object_storage'] = dict(provider='oss', bucket='test-bucket-unused',
            endpoint='https://oss-cn-shenzhen.aliyuncs.com', region='cn-shenzhen',
            prefix='production/tests/unused', credentials_file=str(credentials))
        self.write_config()
        objects = ObjectStorage({'provider': 'test-filesystem', 'root': str(self.root / 'objects')})
        with patch('lele_growth.object_storage.ObjectStorage', return_value=objects):
            self.service = production_service(self.path)
        self.target = target_details(self.service)['targetId']
        return objects

    def prepare_objects(self):
        self.initialize()
        objects = self.enable_objects()
        def fixture(cur):
            cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES('owner','owner','测试','unused','parent','active')")
            child = self.service.create_child(cur, 'owner', '隔离清理')
            ids = []
            for i, state in enumerate(('staged', 'staged', 'attached')):
                asset = str(uuid.uuid4())
                key = 'production/tests/unused/' + asset + '.png'
                path = objects._path(key)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'test')
                cur.execute("INSERT INTO lele.media_assets(id,child_id,uploaded_by,upload_id,membership_version,object_key,content_sha256,mime_type,byte_size,width,height,state,created_at) VALUES(%s,%s,'owner',%s,%s,%s,%s,'image/png',4,1,1,%s,now()-interval '2 days')",
                            (asset, child['id'], 'isolated:'+asset, child['membershipVersion'], key, hashlib.sha256(b'test').hexdigest(), state))
                ids.append((asset, key))
            # Historical/audit references protect even erroneously staged metadata.
            self.service.audit(cur, 'owner', 'test.reference', child['id'], {'imageAssetId': ids[1][0]})
            return ids
        return objects, self.service.transaction(fixture)

    def test_cleanup_preview_reference_protection_audit_and_retry_after_failure(self):
        objects, ids = self.prepare_objects()
        self.assertEqual(execute(self.service, 'cleanup-staged')['assets'], 1)
        self.assertTrue(objects._path(ids[0][1]).exists())
        with patch.object(objects, 'delete', side_effect=StoreError(503, '隔离故障')), self.assertRaises(StoreError):
            self.apply('cleanup-staged')
        self.assertEqual(len(self.events('maintenance.media.cleanup.failed')), 1)
        def state(cur):
            cur.execute('SELECT state,lease_token FROM lele.media_assets WHERE id=%s', (ids[0][0],))
            return cur.fetchone()
        self.assertEqual(self.service.transaction(state)[0], 'deleted')
        self.assertIsNotNone(self.service.transaction(state)[1])
        self.assertEqual(self.apply('cleanup-staged')['assets'], 1)
        self.assertEqual(self.apply('cleanup-staged')['assets'], 0)
        self.assertFalse(objects._path(ids[0][1]).exists())
        for _, key in ids[1:]: self.assertTrue(objects._path(key).exists())
        self.assertEqual(len(self.events('maintenance.media.cleanup.complete')), 2)

    def test_legacy_migration_is_lossless_idempotent_and_does_not_import_old_snapshots(self):
        from lele_growth.legacy_migration import migrate_record, read_source
        from lele_growth.business_operations import default_data, apply_operation
        from lele_growth.postgres_store import canonical_sha256
        self.initialize()
        objects = self.enable_objects()
        self.service.transaction(lambda cur:cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES('owner','owner','正式家长','unused','parent','active')"))
        import base64, io
        from PIL import Image
        encoded = io.BytesIO();Image.new('RGB',(2,2),'green').save(encoded,format='PNG')
        image='data:image/png;base64,'+base64.b64encode(encoded.getvalue()).decode()
        data=apply_operation(default_data('原生产孩子'),'gift.save',{'gift':{'name':'历史礼物','points':20,'imageData':image}},actor_id='legacy',revision=317,now='2026-10-21T01:00:00Z')
        record=dict(format='lele-task-manager-store',version=1,revision=317,updatedAt='2026-10-21T01:00:00Z',data=data)
        digest=canonical_sha256(record)
        source=self.root/'legacy-source.json';source.write_text(json.dumps(record));source.chmod(0o600)
        self.assertEqual(read_source(source,digest),record)
        source.chmod(0o644)
        with self.assertRaises(ApiError):read_source(source,digest)
        source.chmod(0o600)
        with self.assertRaises(ApiError):read_source(source,'wrong')
        preview=migrate_record(self.service,record,'owner',expected_sha256=digest)
        self.assertTrue(preview['dryRun']);self.assertFalse(preview['alreadyImported'])
        self.assertFalse((self.root/'objects').exists())
        with patch.object(self.service,'audit',side_effect=ApiError(503,'隔离故障')),self.assertRaises(ApiError):
            migrate_record(self.service,record,'owner',expected_sha256=digest,apply=True,confirm=self.target)
        self.assertFalse(self.service.transaction(lambda cur:cur.execute('SELECT EXISTS(SELECT 1 FROM lele.children)').fetchone()[0]))
        result=migrate_record(self.service,record,'owner',expected_sha256=digest,apply=True,confirm=self.target)
        self.assertTrue(result['verified']);self.assertTrue(result['imported'])
        rebuilt=self.service.transaction(lambda cur:self.service.store.read(cur,result['childId']))
        self.assertEqual(rebuilt['revision'],317);self.assertEqual(rebuilt['updatedAt'],record['updatedAt'])
        self.assertNotIn('imageData',rebuilt['data']['gifts'][0]);self.assertEqual(result['counts']['gifts'],1)
        self.assertEqual(canonical_sha256(rebuilt),result['normalizedSha256'])
        self.assertEqual(len(self.events('migration.production.legacy')),1)
        self.assertFalse(migrate_record(self.service,record,'owner',expected_sha256=digest,apply=True,confirm=self.target)['imported'])
        self.assertEqual(len(self.events('migration.production.legacy')),1)
        self.assertEqual(self.service.transaction(lambda cur:cur.execute('SELECT count(*) FROM lele.data_snapshots').fetchone()[0]),0)
        def change(cur):cur.execute('UPDATE lele.app_metadata SET revision=318')
        self.service.transaction(change)
        with self.assertRaises(ApiError):migrate_record(self.service,record,'owner',expected_sha256=digest,apply=True,confirm=self.target)

    def test_legacy_migration_rejects_wrong_target_owner_source_and_nonempty_database(self):
        from lele_growth.legacy_migration import migrate_record
        from lele_growth.business_operations import default_data
        from lele_growth.postgres_store import canonical_sha256
        self.initialize();self.enable_objects()
        record=dict(format='lele-task-manager-store',version=1,revision=317,updatedAt='2026-10-21T01:00:00Z',data=default_data('原孩子'))
        digest=canonical_sha256(record)
        with patch.object(self.service.media.objects,'put') as put:
            with self.assertRaises(ApiError):migrate_record(self.service,record,'owner',expected_sha256=digest,apply=True,confirm='wrong')
            with self.assertRaises(ApiError):migrate_record(self.service,record,'owner',expected_sha256='wrong')
            with self.assertRaises(ApiError):migrate_record(self.service,record,'owner',expected_sha256=digest)
            put.assert_not_called()
        def existing(cur):
            cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES('owner','owner','家长','unused','parent','active')")
            self.service.create_child(cur,'owner','已有孩子')
        self.service.transaction(existing)
        with self.assertRaises(ApiError):migrate_record(self.service,record,'owner',expected_sha256=digest,apply=True,confirm=self.target)

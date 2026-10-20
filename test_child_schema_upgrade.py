"""Upgrade verification in a disposable local lele_test_upgrade_* database."""
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
from child_service import ChildService, initialize, ApiError
from business_operations import default_data
from child_store import ChildStore
from postgres_store import PostgresStore

CONFIG = os.environ.get('LELE_TEST_CONFIG')


@unittest.skipUnless(CONFIG, 'Set LELE_TEST_CONFIG to an isolated local test database')
class ChildSchemaUpgradeTests(unittest.TestCase):
    def test_populated_v2_upgrade_is_lossless_repeatable_and_guarded(self):
        base = ChildService(CONFIG).config
        self.assertEqual(base['environment'], 'development')
        self.assertTrue(base['_connect']['dbname'].startswith('lele_test'))
        name = 'lele_test_upgrade_' + uuid.uuid4().hex[:12]
        admin = {**base['_connect'], 'dbname': 'postgres'}
        with psycopg.connect(**admin, autocommit=True) as db:
            db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        try:
            with tempfile.TemporaryDirectory() as temp:
                config = copy.deepcopy({k:v for k,v in base.items() if k != '_connect'})
                config['database']['dbname'] = name
                config_path = Path(temp)/'config.json'
                config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
                service = ChildService(config_path)
                source = Path('db/schema_v2.sql').read_text()
                source_hash = hashlib.sha256(source.encode()).hexdigest()
                record = dict(format='lele-task-manager-store',version=1,revision=87,updatedAt='2026-10-19T01:02:03Z',data=default_data('升级校验'))
                def old_schema(cur):
                    cur.execute(source)
                    cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES('owner','owner','Owner','unused','parent','active')")
                    cur.execute("INSERT INTO lele.children(id,name,owner_id,archived) VALUES('child','升级校验','owner',true)")
                    cur.execute("INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES('child','owner','membership')")
                    store = ChildStore()
                    with patch('child_store.DB_SCHEMA_VERSION', 2):
                        store.replace(cur,'child',record['data']); store.metadata(cur,'child',record,insert=True)
                    marker = f'lele-schema-v2:{source_hash}:{PostgresStore._catalog(cur)}'
                    cur.execute(sql.SQL('COMMENT ON SCHEMA lele IS {}').format(sql.Literal(marker)))
                service.transaction(old_schema,exclusive=True,schema_check=False)
                self.assertEqual(initialize(config_path,upgrade_only=True),{'initialized':False,'upgraded':True,'version':3})
                self.assertEqual(service.transaction(lambda cur:service.store.read(cur,'child')),record)
                def state(cur):
                    cur.execute("SELECT archived,deleted_at,deleted_by FROM lele.children WHERE id='child'")
                    return cur.fetchone()
                self.assertEqual(service.transaction(state),(True,None,None))
                self.assertEqual(initialize(config_path),{'initialized':False,'upgraded':False,'version':3})
                self.assertEqual(initialize(config_path,upgrade_only=True),{'initialized':False,'upgraded':False,'version':3})
                service.transaction(lambda cur:cur.execute('ALTER TABLE lele.children ADD COLUMN unexpected text'))
                with self.assertRaises(ApiError) as failure:
                    initialize(config_path,upgrade_only=True)
                self.assertEqual(failure.exception.status,409)
        finally:
            with psycopg.connect(**admin,autocommit=True) as db:
                db.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))

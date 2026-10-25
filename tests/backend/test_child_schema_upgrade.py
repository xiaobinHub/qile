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
from lele_growth.child_service import ChildService, initialize, ApiError
from lele_growth.business_operations import default_data
from lele_growth.child_store import ChildStore
from lele_growth.postgres_store import PostgresStore
from lele_growth.maintenance import schema_sources, inspect_schema

CONFIG = os.environ.get('LELE_TEST_CONFIG')


@unittest.skipUnless(CONFIG, 'Set LELE_TEST_CONFIG to an isolated local test database')
class ChildSchemaUpgradeTests(unittest.TestCase):
    def test_existing_v6_gender_field_addition_preserves_child_and_business_rows(self):
        base=ChildService(CONFIG).config
        self.assertEqual(base['environment'],'development')
        self.assertTrue(base['_connect']['dbname'].startswith('lele_test'))
        name='lele_test_upgrade_'+uuid.uuid4().hex[:12]
        admin={**base['_connect'],'dbname':'postgres'}
        with psycopg.connect(**admin,autocommit=True) as db:
            db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        try:
            with tempfile.TemporaryDirectory() as temp:
                config=copy.deepcopy({k:v for k,v in base.items() if not k.startswith('_')})
                config['database']['dbname']=name
                path=Path(temp)/'config.json';path.write_text(json.dumps(config));path.chmod(0o600)
                initialize(path);service=ChildService(path)
                def fixture(cur):
                    cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES('owner','owner','Owner','unused','parent','active')")
                    child=service.create_child(cur,'owner','历史儿童',gender='girl')
                    record=service.store.read(cur,child['id'])
                    cur.execute('SET CONSTRAINTS ALL IMMEDIATE')
                    cur.execute('ALTER TABLE lele.children DROP COLUMN gender')
                    row=cur.execute('SELECT to_jsonb(c) FROM lele.children c WHERE id=%s',(child['id'],)).fetchone()[0]
                    table_id=cur.execute("SELECT 'lele.children'::regclass::oid").fetchone()[0]
                    marker=f'lele-schema-v6:{schema_sources(include_child_gender=False)[3][6]}:{PostgresStore._catalog(cur)}'
                    cur.execute(sql.SQL('COMMENT ON SCHEMA lele IS {}').format(sql.Literal(marker)))
                    return child['id'],row,record,table_id
                child_id,row,record,table_id=service.transaction(fixture,exclusive=True)
                self.assertEqual(inspect_schema(service)['pendingTableChanges'],['children.gender'])
                self.assertEqual(initialize(path,upgrade_only=True),{'initialized':False,'upgraded':True,'version':6})
                def verify(cur):
                    self.assertEqual(cur.execute('SELECT current_database()').fetchone()[0],name)
                    self.assertEqual(cur.execute("SELECT 'lele.children'::regclass::oid").fetchone()[0],table_id)
                    self.assertEqual(cur.execute("SELECT to_jsonb(c)-'gender',gender FROM lele.children c WHERE id=%s",(child_id,)).fetchone(),(row,None))
                    self.assertEqual(service.store.read(cur,child_id),record)
                service.transaction(verify)
                self.assertEqual(inspect_schema(service)['pendingTableChanges'],[])
                self.assertEqual(initialize(path),{'initialized':False,'upgraded':False,'version':6})
        finally:
            with psycopg.connect(**admin,autocommit=True) as db:
                db.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))

    def test_existing_v6_table_addition_keeps_database_rows_and_revision(self):
        from psycopg.types.json import Jsonb
        base = ChildService(CONFIG).config
        self.assertEqual(base['environment'], 'development')
        self.assertTrue(base['_connect']['dbname'].startswith('lele_test'))
        name = 'lele_test_upgrade_' + uuid.uuid4().hex[:12]
        admin = {**base['_connect'], 'dbname': 'postgres'}
        with psycopg.connect(**admin, autocommit=True) as db:
            db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        try:
            with tempfile.TemporaryDirectory() as temp:
                config = copy.deepcopy({k:v for k,v in base.items() if not k.startswith('_')})
                config['database']['dbname'] = name
                config_path = Path(temp)/'config.json'
                config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
                initialize(config_path)
                service = ChildService(config_path)
                old_ledger = dict(id='historical',kind='task-complete',amount=7,date='2026-10-18',createdAt='2026-10-18T01:00:00Z',occurrenceKey='old-task@2026-10-15',taskDate='2026-10-17')
                def fixture(cur):
                    cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES('owner','owner','Owner','unused','parent','active')")
                    child=service.create_child(cur,'owner','测试')
                    cur.execute('ALTER TABLE lele.points_ledger DROP COLUMN task_date')
                    cur.execute("INSERT INTO lele.points_ledger(child_id,record_json,sort_order,business_date,created_at) VALUES(%s,%s,0,'2026-10-18','2026-10-18T01:00:00Z')",(child['id'],Jsonb(old_ledger)))
                    marker=f'lele-schema-v6:{schema_sources(include_ledger_date=False, include_child_gender=False)[3][6]}:{PostgresStore._catalog(cur)}'
                    cur.execute(sql.SQL('COMMENT ON SCHEMA lele IS {}').format(sql.Literal(marker)))
                    return child['id'],cur.execute('SELECT revision FROM lele.app_metadata WHERE child_id=%s',(child['id'],)).fetchone()[0]
                child_id,revision=service.transaction(fixture,exclusive=True)
                self.assertEqual(inspect_schema(service)['pendingTableChanges'],['points_ledger.task_date'])
                with self.assertRaises(ApiError) as failure:
                    service.transaction(lambda cur:cur.execute('SELECT 1'))
                self.assertEqual(failure.exception.status,503)
                self.assertEqual(initialize(config_path,upgrade_only=True),{'initialized':False,'upgraded':True,'version':6})
                self.assertEqual(inspect_schema(service)['pendingTableChanges'],[])
                def verify(cur):
                    self.assertEqual(cur.execute('SELECT current_database()').fetchone()[0],name)
                    self.assertEqual(cur.execute('SELECT version FROM lele.schema_versions').fetchone()[0],6)
                    self.assertEqual(cur.execute('SELECT record_json,task_date,amount FROM lele.points_ledger WHERE child_id=%s',(child_id,)).fetchone(),(old_ledger,None,7))
                    self.assertEqual(cur.execute('SELECT revision FROM lele.app_metadata WHERE child_id=%s',(child_id,)).fetchone()[0],revision)
                    self.assertNotIn('taskDate',service.store.read(cur,child_id)['data']['ledger'][0])
                service.transaction(verify)
                self.assertEqual(initialize(config_path),{'initialized':False,'upgraded':False,'version':6})
        finally:
            with psycopg.connect(**admin,autocommit=True) as db:
                db.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))

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
                config = copy.deepcopy({k:v for k,v in base.items() if not k.startswith('_')})
                config['database']['dbname'] = name
                config_path = Path(temp)/'config.json'
                config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
                service = ChildService(config_path)
                source = Path('backend/lele_growth/db/schema_v2.sql').read_text()
                source_hash = hashlib.sha256(source.encode()).hexdigest()
                record = dict(format='lele-task-manager-store',version=1,revision=87,updatedAt='2026-10-19T01:02:03Z',data=default_data('升级校验'))
                def old_schema(cur):
                    cur.execute(source)
                    cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES('owner','owner','Owner','unused','parent','active')")
                    cur.execute("INSERT INTO lele.children(id,name,owner_id,archived) VALUES('child','升级校验','owner',true)")
                    cur.execute("INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES('child','owner','membership')")
                    store = ChildStore()
                    with patch('lele_growth.child_store.DB_SCHEMA_VERSION', 2):
                        store.replace(cur,'child',record['data']); store.metadata(cur,'child',record,insert=True)
                    marker = f'lele-schema-v2:{source_hash}:{PostgresStore._catalog(cur)}'
                    cur.execute(sql.SQL('COMMENT ON SCHEMA lele IS {}').format(sql.Literal(marker)))
                service.transaction(old_schema,exclusive=True,schema_check=False)
                self.assertEqual(initialize(config_path,upgrade_only=True),{'initialized':False,'upgraded':True,'version':6})
                self.assertEqual(service.transaction(lambda cur:service.store.read(cur,'child')),record)
                def state(cur):
                    cur.execute("SELECT archived,deleted_at,deleted_by FROM lele.children WHERE id='child'")
                    return cur.fetchone()
                self.assertEqual(service.transaction(state),(True,None,None))
                self.assertEqual(initialize(config_path),{'initialized':False,'upgraded':False,'version':6})
                self.assertEqual(initialize(config_path,upgrade_only=True),{'initialized':False,'upgraded':False,'version':6})
                service.transaction(lambda cur:cur.execute('ALTER TABLE lele.children ADD COLUMN unexpected text'))
                with self.assertRaises(ApiError) as failure:
                    initialize(config_path,upgrade_only=True)
                self.assertEqual(failure.exception.status,409)
        finally:
            with psycopg.connect(**admin,autocommit=True) as db:
                db.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))

    def test_populated_v3_upgrade_is_lossless_repeatable_and_guarded(self):
        base = ChildService(CONFIG).config
        self.assertEqual(base['environment'], 'development')
        self.assertTrue(base['_connect']['dbname'].startswith('lele_test'))
        name = 'lele_test_upgrade_' + uuid.uuid4().hex[:12]
        admin = {**base['_connect'], 'dbname': 'postgres'}
        with psycopg.connect(**admin, autocommit=True) as db:
            db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        try:
            with tempfile.TemporaryDirectory() as temp:
                config = copy.deepcopy({k:v for k,v in base.items() if not k.startswith('_')})
                config['database']['dbname'] = name
                config_path = Path(temp)/'config.json'
                config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
                service = ChildService(config_path)
                source = Path('backend/lele_growth/db/schema_v2.sql').read_text()
                migration_v3 = Path('backend/lele_growth/db/migrate_v2_to_v3.sql').read_text()
                source_hash = hashlib.sha256((source+'\n'+migration_v3).encode()).hexdigest()
                record = dict(format='lele-task-manager-store',version=1,revision=87,updatedAt='2026-10-19T01:02:03Z',data=default_data('升级校验'))
                def old_schema(cur):
                    cur.execute(source)
                    cur.execute(migration_v3)
                    cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES('owner','owner','Owner','unused','parent','active')")
                    cur.execute("INSERT INTO lele.children(id,name,owner_id,archived) VALUES('child','升级校验','owner',true)")
                    cur.execute("INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES('child','owner','membership')")
                    store = ChildStore()
                    with patch('lele_growth.child_store.DB_SCHEMA_VERSION', 3):
                        store.replace(cur,'child',record['data']); store.metadata(cur,'child',record,insert=True)
                    marker = f'lele-schema-v3:{source_hash}:{PostgresStore._catalog(cur)}'
                    cur.execute(sql.SQL('COMMENT ON SCHEMA lele IS {}').format(sql.Literal(marker)))
                service.transaction(old_schema,exclusive=True,schema_check=False)
                self.assertEqual(initialize(config_path,upgrade_only=True),{'initialized':False,'upgraded':True,'version':6})
                self.assertEqual(service.transaction(lambda cur:service.store.read(cur,'child')),record)
                def state(cur):
                    cur.execute("SELECT archived,deleted_at,deleted_by FROM lele.children WHERE id='child'")
                    return cur.fetchone()
                self.assertEqual(service.transaction(state),(True,None,None))
                self.assertEqual(initialize(config_path),{'initialized':False,'upgraded':False,'version':6})
                self.assertEqual(initialize(config_path,upgrade_only=True),{'initialized':False,'upgraded':False,'version':6})
                service.transaction(lambda cur:cur.execute('ALTER TABLE lele.children ADD COLUMN unexpected text'))
                with self.assertRaises(ApiError) as failure:
                    initialize(config_path,upgrade_only=True)
                self.assertEqual(failure.exception.status,409)
        finally:
            with psycopg.connect(**admin,autocommit=True) as db:
                db.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))

    def test_populated_v4_upgrade_is_lossless_repeatable_and_guarded(self):
        base = ChildService(CONFIG).config
        self.assertEqual(base['environment'], 'development')
        self.assertTrue(base['_connect']['dbname'].startswith('lele_test'))
        name = 'lele_test_upgrade_' + uuid.uuid4().hex[:12]
        admin = {**base['_connect'], 'dbname': 'postgres'}
        with psycopg.connect(**admin, autocommit=True) as db:
            db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        try:
            with tempfile.TemporaryDirectory() as temp:
                config = copy.deepcopy({k:v for k,v in base.items() if not k.startswith('_')})
                config['database']['dbname'] = name
                config_path = Path(temp)/'config.json'
                config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
                service = ChildService(config_path)
                source = Path('backend/lele_growth/db/schema_v2.sql').read_text()
                migration_v3 = Path('backend/lele_growth/db/migrate_v2_to_v3.sql').read_text()
                migration_v4 = Path('backend/lele_growth/db/migrate_v3_to_v4.sql').read_text()
                source_hash = hashlib.sha256((source+'\n'+migration_v3+'\n'+migration_v4).encode()).hexdigest()
                record = dict(format='lele-task-manager-store',version=1,revision=87,updatedAt='2026-10-19T01:02:03Z',data=default_data('升级校验'))
                def old_schema(cur):
                    cur.execute(source)
                    cur.execute(migration_v3)
                    cur.execute(migration_v4)
                    cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES('owner','owner','Owner','unused','parent','active')")
                    cur.execute("INSERT INTO lele.children(id,name,owner_id,archived) VALUES('child','升级校验','owner',true)")
                    cur.execute("INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES('child','owner','membership')")
                    store = ChildStore()
                    with patch('lele_growth.child_store.DB_SCHEMA_VERSION', 4):
                        store.replace(cur,'child',record['data']); store.metadata(cur,'child',record,insert=True)
                    marker = f'lele-schema-v4:{source_hash}:{PostgresStore._catalog(cur)}'
                    cur.execute(sql.SQL('COMMENT ON SCHEMA lele IS {}').format(sql.Literal(marker)))
                service.transaction(old_schema,exclusive=True,schema_check=False)
                self.assertEqual(initialize(config_path,upgrade_only=True),{'initialized':False,'upgraded':True,'version':6})
                self.assertEqual(service.transaction(lambda cur:service.store.read(cur,'child')),record)
                def state(cur):
                    cur.execute("SELECT archived,deleted_at,deleted_by FROM lele.children WHERE id='child'")
                    return cur.fetchone()
                self.assertEqual(service.transaction(state),(True,None,None))
                self.assertEqual(initialize(config_path),{'initialized':False,'upgraded':False,'version':6})
                self.assertEqual(initialize(config_path,upgrade_only=True),{'initialized':False,'upgraded':False,'version':6})
                service.transaction(lambda cur:cur.execute('ALTER TABLE lele.children ADD COLUMN unexpected text'))
                with self.assertRaises(ApiError) as failure:
                    initialize(config_path,upgrade_only=True)
                self.assertEqual(failure.exception.status,409)
        finally:
            with psycopg.connect(**admin,autocommit=True) as db:
                db.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))

    def test_populated_v5_upgrade_is_lossless_repeatable_and_guarded(self):
        base = ChildService(CONFIG).config
        self.assertEqual(base['environment'], 'development')
        self.assertTrue(base['_connect']['dbname'].startswith('lele_test'))
        name = 'lele_test_upgrade_' + uuid.uuid4().hex[:12]
        admin = {**base['_connect'], 'dbname': 'postgres'}
        with psycopg.connect(**admin, autocommit=True) as db:
            db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        try:
            with tempfile.TemporaryDirectory() as temp:
                config = copy.deepcopy({k:v for k,v in base.items() if not k.startswith('_')})
                config['database']['dbname'] = name
                config_path = Path(temp)/'config.json'
                config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
                service = ChildService(config_path)
                source = Path('backend/lele_growth/db/schema_v2.sql').read_text()
                migration_v3 = Path('backend/lele_growth/db/migrate_v2_to_v3.sql').read_text()
                migration_v4 = Path('backend/lele_growth/db/migrate_v3_to_v4.sql').read_text()
                migration_v5 = Path('backend/lele_growth/db/migrate_v4_to_v5.sql').read_text()
                source_hash = hashlib.sha256((source+'\n'+migration_v3+'\n'+migration_v4+'\n'+migration_v5).encode()).hexdigest()
                record = dict(format='lele-task-manager-store',version=1,revision=87,updatedAt='2026-10-19T01:02:03Z',data=default_data('升级校验'))
                def old_schema(cur):
                    cur.execute(source)
                    cur.execute(migration_v3)
                    cur.execute(migration_v4)
                    cur.execute(migration_v5)
                    cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES('owner','owner','Owner','unused','parent','active')")
                    cur.execute("INSERT INTO lele.children(id,name,owner_id,archived) VALUES('child','升级校验','owner',true)")
                    cur.execute("INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES('child','owner','membership')")
                    store = ChildStore()
                    with patch('lele_growth.child_store.DB_SCHEMA_VERSION', 4):
                        store.replace(cur,'child',record['data']); store.metadata(cur,'child',record,insert=True)
                    marker = f'lele-schema-v5:{source_hash}:{PostgresStore._catalog(cur)}'
                    cur.execute(sql.SQL('COMMENT ON SCHEMA lele IS {}').format(sql.Literal(marker)))
                service.transaction(old_schema,exclusive=True,schema_check=False)
                self.assertEqual(initialize(config_path,upgrade_only=True),{'initialized':False,'upgraded':True,'version':6})
                self.assertEqual(service.transaction(lambda cur:service.store.read(cur,'child')),record)
                self.assertEqual(service.transaction(lambda cur:cur.execute("SELECT avatar_id,family_role FROM lele.users WHERE id='owner'").fetchone()),('father',None))
                def state(cur):
                    cur.execute("SELECT archived,deleted_at,deleted_by FROM lele.children WHERE id='child'")
                    return cur.fetchone()
                self.assertEqual(service.transaction(state),(True,None,None))
                self.assertEqual(initialize(config_path),{'initialized':False,'upgraded':False,'version':6})
                self.assertEqual(initialize(config_path,upgrade_only=True),{'initialized':False,'upgraded':False,'version':6})
                service.transaction(lambda cur:cur.execute('ALTER TABLE lele.children ADD COLUMN unexpected text'))
                with self.assertRaises(ApiError) as failure:
                    initialize(config_path,upgrade_only=True)
                self.assertEqual(failure.exception.status,409)
        finally:
            with psycopg.connect(**admin,autocommit=True) as db:
                db.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))

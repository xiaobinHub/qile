"""Plugin migrations and uniqueness in owned disposable databases only."""
import copy
from contextlib import contextmanager
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

import psycopg
from psycopg import sql

from lele_growth.child_service import ChildService, initialize, ApiError
from lele_growth.maintenance import initialize_plugin_platform, initialize_service, inspect_plugin_platform, inspect_schema, schema_sources
from lele_growth.postgres_store import PostgresStore
from lele_growth.production_maintenance import execute, target_details
from tests.backend.test_plugin_lifecycle import PluginDatabaseCase


class PluginSchemaTests(PluginDatabaseCase):
    @contextmanager
    def fresh_service(self):
        name='lele_test_plugin_upgrade_'+uuid.uuid4().hex[:12]
        with psycopg.connect(**self.admin_db,autocommit=True) as db:
            db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        try:
            with tempfile.TemporaryDirectory() as temp:
                cfg=json.loads(self.path.read_text()); cfg['database']['dbname']=name
                path=Path(temp)/'config.json'; path.write_text(json.dumps(cfg)); path.chmod(0o600)
                initialize(path)
                yield ChildService(path)
        finally:
            with psycopg.connect(**self.admin_db,autocommit=True) as db:
                db.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))

    def test_explicit_idempotent_addition_preserves_core_snapshot_oids_and_fingerprint(self):
        with self.fresh_service() as service:
            self.assertIsNone(inspect_plugin_platform(service)['version'])
            # Constructing services and using core-only routes cannot migrate plugins.
            ChildService(service.config.get('config_path',self.path))
            self.assertIsNone(inspect_plugin_platform(service)['version'])
            def fixture(cur):
                cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES('owner','owner','Owner','unused','parent','active')")
                child=service.create_child(cur,'owner','旧儿童',gender='boy')
                cur.execute("SELECT 'lele.children'::regclass::oid,'lele.task_series'::regclass::oid")
                return child['id'],service.store.read(cur,child['id']),cur.execute("SELECT 'lele.children'::regclass::oid,'lele.task_series'::regclass::oid").fetchone()
            child_id,before,oids=service.transaction(fixture)
            status_before=inspect_schema(service)
            self.assertEqual(initialize_plugin_platform(service),{'initialized':True,'version':1})
            self.assertEqual(initialize_plugin_platform(service),{'initialized':False,'version':1})
            self.assertEqual(inspect_plugin_platform(service),{'version':1,'pendingTables':[]})
            self.assertEqual(inspect_schema(service),status_before)
            self.assertEqual(service.transaction(lambda cur:service.store.read(cur,child_id)),before)
            self.assertEqual(service.transaction(lambda cur:cur.execute("SELECT 'lele.children'::regclass::oid,'lele.task_series'::regclass::oid").fetchone()),oids)
            self.assertEqual(service.transaction(lambda cur:cur.execute('SELECT count(*) FROM lele.plugin_catalog').fetchone()[0]),0)

    def test_migration_failure_rolls_back_all_tables_and_core_marker(self):
        with self.fresh_service() as service:
            before=inspect_schema(service)
            with patch.object(service,'audit',side_effect=ApiError(503,'injected failure')):
                with self.assertRaises(ApiError): initialize_plugin_platform(service,audit_detail={'test':True})
            self.assertEqual(inspect_schema(service),before)
            self.assertIsNone(inspect_plugin_platform(service)['version'])
            self.assertEqual(initialize_plugin_platform(service)['version'],1)

    def test_legacy_v6_refuses_plugin_ddl_until_core_additive_upgrades_are_complete(self):
        variants=[(False,False,False),(True,False,False),(True,True,False)]
        for ledger_date,gender,creation_request in variants:
            with self.subTest(ledger_date=ledger_date,gender=gender,creation_request=creation_request),self.fresh_service() as service:
                def raw_state(cur):
                    cur.execute("SELECT obj_description(oid,'pg_namespace') FROM pg_namespace WHERE nspname='lele'")
                    state={'marker':cur.fetchone()[0]}
                    for table in ('users','children','app_metadata','app_settings','task_categories','points_ledger','idempotency_records'):
                        cur.execute(sql.SQL('SELECT to_jsonb(r) FROM lele.{} r ORDER BY to_jsonb(r)::text').format(sql.Identifier(table)))
                        state[table]=cur.fetchall()
                    cur.execute("SELECT tablename FROM pg_tables WHERE schemaname='lele' AND tablename LIKE 'plugin_%'")
                    state['plugin_tables']=cur.fetchall()
                    return state
                def legacy(cur):
                    cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES('owner','owner','Owner','unused','parent','active')")
                    child=service.create_child(cur,'owner','旧儿童',gender='boy')
                    record=service.store.read(cur,child['id'])
                    data=copy.deepcopy(record['data'])
                    data['ledger'].append(dict(id='legacy-ledger',kind='manual',amount=7,date='2026-10-30',createdAt='2026-10-30T01:00:00Z',source='手动调整',reason='保留历史'))
                    record=service.save(cur,child['id'],record,data)
                    cur.execute("INSERT INTO lele.idempotency_records(child_id,operation_id,actor_id,membership_version,payload_sha256,result_revision) VALUES(%s,'legacy-operation','owner',%s,'old-hash',%s)",(child['id'],child['membershipVersion'],record['revision']))
                    cur.execute('SET CONSTRAINTS ALL IMMEDIATE')
                    for present,table,column in ((ledger_date,'points_ledger','task_date'),(gender,'children','gender'),(creation_request,'idempotency_records','creation_request_id')):
                        if not present:
                            cur.execute(sql.SQL('ALTER TABLE lele.{} DROP COLUMN {}').format(sql.Identifier(table),sql.Identifier(column)))
                    source_hash=schema_sources(include_ledger_date=ledger_date,include_child_gender=gender,include_child_creation=creation_request)[3][6]
                    marker=f'lele-schema-v6:{source_hash}:{PostgresStore._catalog(cur)}'
                    cur.execute(sql.SQL('COMMENT ON SCHEMA lele IS {}').format(sql.Literal(marker)))
                    return child['id'],record,raw_state(cur)
                child_id,record,before=service.transaction(legacy)
                with patch('lele_growth.maintenance.plugin_schema_source',side_effect=AssertionError('Plugin DDL must not be read')):
                    with self.assertRaises(ApiError) as refused:initialize_plugin_platform(service)
                self.assertEqual((refused.exception.status,refused.exception.kind),(409,'plugin_core_upgrade_required'))
                self.assertEqual(service.transaction(raw_state,schema_check=False),before)
                self.assertTrue(inspect_schema(service)['pendingTableChanges'])
                self.assertEqual(initialize_service(service,upgrade_only=True),{'initialized':False,'upgraded':True,'version':6})
                self.assertEqual(inspect_schema(service)['pendingTableChanges'],[])
                self.assertEqual(service.transaction(lambda cur:service.store.read(cur,child_id)),record)
                self.assertEqual(initialize_plugin_platform(service),{'initialized':True,'version':1})
                self.assertEqual(initialize_plugin_platform(service),{'initialized':False,'version':1})

    def test_uniqueness_constraints_cover_installation_occurrence_event_and_deployment(self):
        self.publish(); self.install()
        release=self.register()
        def constraints(cur):
            def duplicate(statement,params):
                with self.assertRaises(psycopg.errors.UniqueViolation):
                    with cur.connection.transaction():cur.execute(statement,params)
            duplicate('INSERT INTO lele.child_plugins(child_id,plugin_id) VALUES(%s,%s)',(self.a['id'],self.plugin_id))
            job="INSERT INTO lele.plugin_jobs(id,plugin_id,child_id,task_id,occurrence_key,due_at,generation,config_revision,release_epoch) VALUES(%s,%s,%s,'daily','once',now(),1,0,1)"
            cur.execute(job,(str(uuid.uuid4()),self.plugin_id,self.a['id']))
            duplicate(job,(str(uuid.uuid4()),self.plugin_id,self.a['id']))
            event=str(uuid.uuid4())
            cur.execute("INSERT INTO lele.plugin_event_outbox(event_id,child_id,event_type,source_revision) VALUES(%s,%s,'task.completed',1)",(event,self.a['id']))
            delivery='INSERT INTO lele.plugin_event_deliveries(event_id,plugin_id) VALUES(%s,%s)'
            cur.execute(delivery,(event,self.plugin_id)); duplicate(delivery,(event,self.plugin_id))
            deploy="INSERT INTO lele.plugin_deployments(id,plugin_id,actor,phase,new_release_id) VALUES(%s,%s,'tester','prepare',%s)"
            cur.execute(deploy,(str(uuid.uuid4()),self.plugin_id,release['release_id']))
            duplicate(deploy,(str(uuid.uuid4()),self.plugin_id,release['release_id']))
        self.service.transaction(constraints)

    def test_production_maintenance_preview_confirms_local_test_target_and_never_auto_registers(self):
        with self.fresh_service() as service:
            service.config['environment']='production' # Semantics only; connection remains the disposable local DB.
            preview=execute(service,'upgrade-plugins')
            self.assertTrue(preview['dryRun']); self.assertIsNone(preview['plugins']['version'])
            with self.assertRaises(ApiError):execute(service,'upgrade-plugins',apply=True,confirm='wrong')
            self.assertIsNone(inspect_plugin_platform(service)['version'])
            result=execute(service,'upgrade-plugins',apply=True,confirm=target_details(service)['targetId'])
            self.assertTrue(result['initialized'])
            self.assertFalse(execute(service,'upgrade-plugins',apply=True,confirm=target_details(service)['targetId'])['initialized'])

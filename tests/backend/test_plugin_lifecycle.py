"""Disposable per-class PostgreSQL databases; never truncate the configured DB."""
import concurrent.futures
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

import psycopg
from psycopg import sql

from lele_growth.child_service import ChildService, initialize, ApiError, PASSWORDS
from lele_growth.maintenance import initialize_plugin_platform
from lele_growth.plugins.catalog import register_release, set_publication
from lele_growth.plugins.policy import active_context, assert_fences
from lele_growth.plugins import state_store
from tests.backend.test_plugin_manifest import manifest

CONFIG=os.environ.get('LELE_TEST_CONFIG')


class PluginDatabaseCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not CONFIG: raise unittest.SkipTest('Set LELE_TEST_CONFIG to a local isolated test database')
        base=ChildService(CONFIG).config
        if base['environment']!='development' or not base['_connect']['dbname'].startswith('lele_test'):
            raise RuntimeError('Plugin tests require an explicit local lele_test* configuration')
        cls.database='lele_test_plugin_core_'+uuid.uuid4().hex[:12]
        cls.admin_db={**base['_connect'],'dbname':'postgres'}
        with psycopg.connect(**cls.admin_db,autocommit=True) as db:
            db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(cls.database)))
        cls.addClassCleanup(cls.drop_database)
        cls.temp=tempfile.TemporaryDirectory(); cls.addClassCleanup(cls.temp.cleanup)
        cfg=copy.deepcopy({k:v for k,v in base.items() if not k.startswith('_')})
        cfg['database']['dbname']=cls.database
        cls.path=Path(cls.temp.name)/'config.json'; cls.path.write_text(json.dumps(cfg)); cls.path.chmod(0o600)
        initialize(cls.path); cls.service=ChildService(cls.path)
        initialize_plugin_platform(cls.service)
        encoded=PASSWORDS.hash('Plugin123')
        def users(cur):
            for name,role in (('owner','parent'),('member','parent'),('outsider','parent'),('admin','admin')):
                cur.execute('INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status,must_change_password) VALUES(%s,%s,%s,%s,%s,\'active\',false)',(name,name,name,encoded,role))
        cls.service.transaction(users,exclusive=True)
        cls.sessions={}
        for name in ('owner','member','outsider','admin'):
            surface='admin' if name=='admin' else 'parent'
            result=cls.service.request('POST','auth/login',{'loginName':name,'password':'Plugin123'},None,None,cls.service.config[surface+'_origin'],surface,'127.0.0.1')
            cls.sessions[name]=(result['_cookie'],result['csrfToken'],surface)

    @classmethod
    def drop_database(cls):
        with psycopg.connect(**cls.admin_db,autocommit=True) as db:
            db.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(cls.database)))

    def setUp(self):
        def fixture(cur):
            a=self.service.create_child(cur,'owner','测试甲',gender='boy')
            b=self.service.create_child(cur,'owner','测试乙',gender='girl')
            cur.execute('INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES(%s,\'member\',%s)',(a['id'],str(uuid.uuid4())))
            return a,b
        self.a,self.b=self.service.transaction(fixture)
        self.plugin_id='plugin-'+uuid.uuid4().hex[:12]
        self.register()

    def register(self,schema=None,*,version='1.0.0',activate=True):
        value=manifest(self.plugin_id); value['version']=version
        return self.service.transaction(lambda cur: register_release(cur,value,artifact_sha256='a'*64,source_commit='test-commit',config_schema=schema,activate=activate),exclusive=True)

    def call(self,method,path,body=None,*,actor='owner'):
        token,csrf,surface=self.sessions[actor]
        return self.service.request(method,path.removeprefix('/api/'),body or {},token,csrf,self.service.config[surface+'_origin'],surface,'127.0.0.1')

    def publish(self):
        revision=self.admin_plugin()['revision']
        return self.service.transaction(lambda cur:set_publication(cur,self.plugin_id,True,revision),exclusive=True)

    def admin_plugin(self):
        return next(p for p in self.call('GET','admin/plugins',actor='admin')['plugins'] if p['id']==self.plugin_id)

    def ppath(self,action=None,child=None):
        return 'children/'+(child or self.a)['id']+'/plugins'+('/'+self.plugin_id+'/'+action if action else '')

    def install(self,*,child=None):
        return self.call('POST',self.ppath('install',child),{'operationId':str(uuid.uuid4()),'expectedRevision':0})['plugin']

    def action(self,action,plugin=None,*,child=None):
        if plugin is None:
            plugin=next(p for p in self.call('GET',self.ppath(child=child),{'view':'installed'})['plugins'] if p['id']==self.plugin_id)
        return self.call('DELETE' if action=='installation' else 'POST',self.ppath(action,child),{'operationId':str(uuid.uuid4()),'expectedRevision':plugin['revision']})['plugin']

    def assert_kind(self,kind,callback,status=None):
        with self.assertRaises(ApiError) as caught: callback()
        self.assertEqual(caught.exception.kind,kind)
        if status is not None: self.assertEqual(caught.exception.status,status)


class PluginLifecycleTests(PluginDatabaseCase):
    def core_command(self,kind,payload,*,operation_id=None):
        state=self.call('GET','children/'+self.a['id']+'/data')
        body=dict(expectedRevision=state['revision'],membershipVersion=state['context']['membershipVersion'],
                  operationId=operation_id or str(uuid.uuid4()),kind=kind,payload=payload)
        return body,self.call('POST','children/'+self.a['id']+'/operations',body)

    def task_occurrence(self):
        state=self.call('GET','children/'+self.a['id']+'/data')
        task=dict(title='插件事件测试',startDate='2026-10-30',startTime='18:00',endTime='18:30',
                  categoryId=state['data']['categories'][0]['id'],points=7,note='',recurrence=None)
        _,created=self.core_command('task.create',{'task':task})
        return created['data']['series'][-1]['id']+'@2026-10-30'

    def events(self):
        return self.service.transaction(lambda cur:cur.execute('SELECT event_id,payload,source_revision FROM lele.plugin_event_outbox WHERE child_id=%s ORDER BY source_revision',(self.a['id'],)).fetchall())

    def test_install_shared_configuration_and_owner_management(self):
        self.publish(); plugin=self.install(); self.assertTrue(plugin['effectiveEnabled'])
        schema={'type':'object','properties':{'message':{'type':'string','default':'hello'}},'required':[]}
        self.register(schema,version='1.0.1')
        config=self.call('GET',self.ppath('config'))
        saved=self.call('PUT',self.ppath('config'),{'config':{'message':'共同配置'},'expectedRevision':config['revision'],'operationId':str(uuid.uuid4())})
        self.assertEqual(self.call('GET',self.ppath('config'),actor='member')['config'],saved['config'])
        self.assertEqual(self.call('GET',self.ppath(child=self.b),{'view':'installed'})['plugins'],[])
        with self.assertRaises(ApiError) as denied:
            self.call('PUT',self.ppath('config'),{'config':{},'expectedRevision':saved['revision'],'operationId':str(uuid.uuid4())},actor='member')
        self.assertEqual(denied.exception.status,403)
        self.assert_kind('membership_revoked',lambda:self.call('GET',self.ppath('config'),actor='outsider'),403)

    def test_required_configuration_installs_disabled_then_explicit_enable(self):
        self.register({'type':'object','properties':{'message':{'type':'string'}},'required':['message']},version='1.0.1')
        self.publish(); plugin=self.install(); self.assertTrue(plugin['configRequired']); self.assertFalse(plugin['enabled'])
        self.assert_kind('plugin_config_required',lambda:self.action('enable',plugin))
        result=self.call('PUT',self.ppath('config'),{'config':{'message':'ready'},'expectedRevision':0,'operationId':str(uuid.uuid4())})
        self.assertFalse(result['plugin']['enabled'])
        self.assertTrue(self.action('enable',result['plugin'])['effectiveEnabled'])

    def test_retries_conflicts_and_configuration_revision_are_independent(self):
        self.publish()
        body={'expectedRevision':0,'operationId':str(uuid.uuid4())}
        installed=self.call('POST',self.ppath('install'),body)
        self.assertEqual(self.call('POST',self.ppath('install'),body),installed)
        self.assert_kind('plugin_operation_conflict',lambda:self.call('POST',self.ppath('disable'),body),409)
        config_body={'config':{},'expectedRevision':0,'operationId':str(uuid.uuid4())}
        saved=self.call('PUT',self.ppath('config'),config_body)
        self.assertEqual(saved['revision'],1)
        self.assertEqual(self.call('PUT',self.ppath('config'),config_body),saved)
        self.assert_kind('plugin_revision_conflict',lambda:self.call('PUT',self.ppath('config'),{**config_body,'operationId':str(uuid.uuid4())}),409)
        self.assert_kind('plugin_revision_conflict',lambda:self.action('disable',installed['plugin']),409)

    def test_disable_uninstall_reinstall_preserve_records_config_and_revoke_fences(self):
        self.publish(); self.install()
        context=self.service.transaction(lambda cur:active_context(cur,self.plugin_id,self.a['id']))
        before=self.service.transaction(lambda cur:self.service.store.read(cur,self.a['id']))
        self.service.transaction(lambda cur:state_store.put_record(cur,context,'notes','note-1',{'text':'保存记录'}))
        disabled=self.action('disable')
        self.assertFalse(disabled['effectiveEnabled'])
        self.assert_kind('plugin_disabled',lambda:self.service.transaction(lambda cur:state_store.put_record(cur,context,'notes','late',{})))
        uninstalled=self.action('installation',disabled); self.assertFalse(uninstalled['installed'])
        reinstalled=self.call('POST',self.ppath('install'),{'operationId':str(uuid.uuid4()),'expectedRevision':uninstalled['revision']})['plugin']
        self.assertFalse(reinstalled['enabled'])
        self.action('enable',reinstalled)
        new=self.service.transaction(lambda cur:active_context(cur,self.plugin_id,self.a['id']))
        self.assert_kind('plugin_context_revoked',lambda:assert_fences(new,context))
        records=self.service.transaction(lambda cur:state_store.list_records(cur,new,'notes'))
        self.assertEqual(len(records['records']),1)
        self.assertEqual(self.service.transaction(lambda cur:self.service.store.read(cur,self.a['id'])),before)

    def test_final_effect_deduplication_and_child_namespace_isolation(self):
        self.publish(); self.install(); self.install(child=self.b)
        context=self.service.transaction(lambda cur:active_context(cur,self.plugin_id,self.a['id']))
        effect=[{'collection':'notes','id':'once','payload':{'n':1}}]
        one=self.service.transaction(lambda cur:state_store.apply_effects(cur,context,effect,effect_key='job:one'))
        two=self.service.transaction(lambda cur:state_store.apply_effects(cur,context,effect,effect_key='job:one'))
        self.assertEqual(one,two)
        other=self.service.transaction(lambda cur:active_context(cur,self.plugin_id,self.b['id']))
        self.assertEqual(self.service.transaction(lambda cur:state_store.list_records(cur,other,'notes'))['records'],[])

    def test_concurrent_same_revision_one_wins_and_retry_is_durable(self):
        self.publish(); plugin=self.install()
        bodies=[{'expectedRevision':plugin['revision'],'operationId':str(uuid.uuid4())} for _ in range(2)]
        def write(body):
            try: return self.call('POST',self.ppath('disable'),body)
            except ApiError as error:return error
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(write,bodies))
        self.assertEqual(sum(isinstance(r,dict) for r in results),1)
        failures=[r for r in results if isinstance(r,ApiError)]
        self.assertEqual([r.kind for r in failures],['plugin_revision_conflict'])

    def test_csrf_surface_and_entry_are_guarded(self):
        self.publish(); self.install()
        token,_,_=self.sessions['owner']
        with self.assertRaises(ApiError) as denied:
            self.service.request('POST',self.ppath('disable'),{'expectedRevision':1,'operationId':str(uuid.uuid4())},token,'bad',self.service.config['parent_origin'],'parent','127.0.0.1')
        self.assertEqual(denied.exception.status,403)
        with self.assertRaises(ApiError): self.call('GET',self.ppath('entry'),actor='admin')
        entry=self.call('GET',self.ppath('entry')); self.assertIn('/plugin-assets/'+self.plugin_id+'/',entry['entry'])
        self.action('disable'); self.assert_kind('plugin_disabled',lambda:self.call('GET',self.ppath('entry')))

    def test_multiselect_shared_config_roundtrip_rejects_duplicates_unknowns_and_conflicts(self):
        schema={'type':'object','properties':{'topics':{'type':'array','items':{'type':'string','enum':['reading','sport']},'uniqueItems':True,'maxItems':2,'default':[],'group':'偏好'}},'required':[]}
        self.register(schema,version='1.0.1'); self.publish(); self.install()
        initial=self.call('GET',self.ppath('config')); self.assertEqual(initial['config'],{'topics':[]})
        self.assertEqual(initial['schema'],schema)
        for values in (['reading','reading'],['unknown']):
            self.assert_kind('plugin_invalid_config',lambda values=values:self.call('PUT',self.ppath('config'),{'config':{'topics':values},'expectedRevision':0,'operationId':str(uuid.uuid4())}))
        self.assertEqual(self.call('GET',self.ppath('config'))['revision'],0)
        saved=self.call('PUT',self.ppath('config'),{'config':{'topics':['sport']},'expectedRevision':0,'operationId':str(uuid.uuid4())})
        self.assertEqual(self.call('GET',self.ppath('config'),actor='member')['config'],{'topics':['sport']})
        self.assert_kind('plugin_revision_conflict',lambda:self.call('PUT',self.ppath('config'),{'config':{'topics':[]},'expectedRevision':0,'operationId':str(uuid.uuid4())}))
        self.assertEqual(saved['revision'],1)

    def test_concurrent_final_effects_are_serial_and_deduplicated_without_lock_upgrade(self):
        self.publish(); self.install()
        context=self.service.transaction(lambda cur:active_context(cur,self.plugin_id,self.a['id']))
        effect=[{'collection':'executions','id':'once','payload':{'result':'recorded'}}]
        def write(_):
            return self.service.transaction(lambda cur:state_store.apply_effects(cur,context,effect,effect_key='job:shared-occurrence'))
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures=[pool.submit(write,i) for i in range(4)]
            results=[future.result(timeout=10) for future in futures]
        self.assertTrue(all(result==results[0] for result in results))
        self.assertEqual(results[0]['records'][0]['revision'],1)
        self.assertEqual(len(self.service.transaction(lambda cur:state_store.list_records(cur,context,'executions'))['records']),1)

    def test_child_delete_revokes_installation_and_pending_jobs_but_retains_history(self):
        self.publish(); self.install()
        context=self.service.transaction(lambda cur:active_context(cur,self.plugin_id,self.a['id']))
        self.service.transaction(lambda cur:state_store.put_record(cur,context,'notes','keep',{'text':'history'}))
        def fixture(cur):
            cur.execute("INSERT INTO lele.plugin_jobs(id,plugin_id,child_id,task_id,occurrence_key,due_at,generation,config_revision,release_epoch) VALUES(%s,%s,%s,'daily','once',now(),%s,%s,%s)",(str(uuid.uuid4()),self.plugin_id,self.a['id'],context['generation'],context['config_revision'],context['release_epoch']))
        self.service.transaction(fixture)
        self.assertEqual(self.call('DELETE','children/'+self.a['id']),{'ok':True})
        self.assert_kind('child_unavailable',lambda:self.service.transaction(lambda cur:active_context(cur,self.plugin_id,self.a['id'])))
        def check(cur):
            cur.execute('SELECT requires_reenable,generation FROM lele.child_plugins WHERE child_id=%s AND plugin_id=%s',(self.a['id'],self.plugin_id)); installed=cur.fetchone()
            cur.execute('SELECT status,cancel_requested FROM lele.plugin_jobs WHERE child_id=%s',(self.a['id'],)); job=cur.fetchone()
            cur.execute('SELECT count(*) FROM lele.child_plugin_records WHERE child_id=%s',(self.a['id'],)); records=cur.fetchone()[0]
            return installed,job,records
        installed,job,records=self.service.transaction(check)
        self.assertTrue(installed[0]); self.assertGreater(installed[1],context['generation'])
        self.assertEqual(job,('cancelled',True)); self.assertEqual(records,1)
        self.assertEqual(self.call('DELETE','children/'+self.a['id']),{'ok':True})
        self.assertEqual(self.service.transaction(check)[0],installed)

    def test_task_completed_outbox_only_emits_real_transitions_and_not_replays_or_reversals(self):
        key=self.task_occurrence(); self.assertEqual(self.events(),[])
        body,completed=self.core_command('completion.set',{'occurrenceKey':key,'completed':True})
        events=self.events(); self.assertEqual(len(events),1)
        self.assertEqual(events[0][1],{'occurrenceKey':key,'seriesId':key.split('@')[0],'date':'2026-10-30','title':'插件事件测试','points':7})
        self.assertEqual(events[0][2],completed['revision'])
        self.call('POST','children/'+self.a['id']+'/operations',body)
        self.core_command('completion.set',{'occurrenceKey':key,'completed':True})
        self.core_command('completion.set',{'occurrenceKey':key,'completed':False})
        self.assertEqual(self.events(),events)
        self.core_command('completion.set',{'occurrenceKey':key,'completed':True})
        self.assertEqual(len(self.events()),2)

    def test_outbox_failure_rolls_back_completion_ledger_revision_and_operation_receipt(self):
        key=self.task_occurrence()
        before=self.call('GET','children/'+self.a['id']+'/data')
        operation_id=str(uuid.uuid4())
        with patch('lele_growth.plugins.events.emit_task_completed',side_effect=ApiError(503,'injected outbox failure')):
            with self.assertRaises(ApiError):self.core_command('completion.set',{'occurrenceKey':key,'completed':True},operation_id=operation_id)
        self.assertEqual(self.call('GET','children/'+self.a['id']+'/data'),before)
        self.assertEqual(self.events(),[])
        receipt=self.service.transaction(lambda cur:cur.execute('SELECT count(*) FROM lele.idempotency_records WHERE child_id=%s AND operation_id=%s',(self.a['id'],operation_id)).fetchone()[0])
        self.assertEqual(receipt,0)
        self.core_command('completion.set',{'occurrenceKey':key,'completed':True},operation_id=operation_id)
        self.assertEqual(len(self.events()),1)

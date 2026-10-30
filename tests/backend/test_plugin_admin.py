"""Administrator publication/scope tests against disposable PostgreSQL databases."""
import uuid
from datetime import datetime, timezone

from lele_growth.child_service import ApiError
from lele_growth.plugins.catalog import register_release
from lele_growth.plugins.policy import active_context
from tests.backend.test_plugin_manifest import manifest
from tests.backend.test_plugin_lifecycle import PluginDatabaseCase


class PluginAdminTests(PluginDatabaseCase):
    def admin_action(self,action,body=None,method='POST'):
        return self.call(method,'admin/plugins/'+self.plugin_id+'/'+action,body or {'expectedRevision':self.admin_plugin()['revision']},actor='admin')['plugin']

    def test_child_picker_searches_exact_child_identifier(self):
        children=self.call('GET','admin/plugin-children',{'q':self.a['id']},actor='admin')['children']
        self.assertEqual([child['id'] for child in children],[self.a['id']])

    def test_registration_pending_is_idempotent_immutable_and_never_auto_installs(self):
        pending=self.admin_plugin(); self.assertEqual(pending['publicationStatus'],'pending')
        self.assertNotIn(self.plugin_id,[p['id'] for p in self.call('GET',self.ppath())['plugins']])
        self.assertEqual(self.register()['release_id'],self.register()['release_id'])
        self.assertEqual(pending['revision'],self.admin_plugin()['revision'])
        value=manifest(self.plugin_id)
        with self.assertRaises(ApiError) as conflict:
            self.service.transaction(lambda cur:register_release(cur,value,artifact_sha256='b'*64,source_commit='changed'),exclusive=True)
        self.assertEqual(conflict.exception.kind,'plugin_version_exists')
        edited=self.call('PATCH','admin/plugins/'+self.plugin_id,{'name':'运营名称','description':'运营简介','instructions':'运营说明','sortOrder':42,'expectedRevision':pending['revision']},actor='admin')['plugin']
        self.admin_action('scope',{'scopeMode':'children','childIds':[self.a['id']],'expectedRevision':edited['revision']},method='PUT')
        self.publish(); self.register(version='1.0.1')
        current=self.admin_plugin()
        self.assertEqual((current['name'],current['sortOrder'],current['publicationStatus'],current['childIds']),('运营名称',42,'published',[self.a['id']]))
        self.assertFalse(next(p for p in self.call('GET',self.ppath())['plugins'] if p['id']==self.plugin_id)['installed'])
        self.assertEqual(self.call('GET',self.ppath(),{'view':'installed'})['plugins'],[])

    def test_icon_selection_only_accepts_current_release_urls_and_stores_relative_path(self):
        value=manifest(self.plugin_id); value['version']='1.0.1'; value['icons']=['assets/one.png','assets/two.png']
        self.service.transaction(lambda cur:register_release(cur,value,artifact_sha256='b'*64,source_commit='icons',activate=True),exclusive=True)
        prefix='/plugin-assets/'+self.plugin_id+'/1.0.1/'
        details=self.admin_plugin(); self.assertEqual(details['icons'],[prefix+'assets/one.png',prefix+'assets/two.png'])
        for icon in ('https://example.invalid/icon.png','assets/one.png',prefix+'assets/../one.png',prefix+'assets/three.png',prefix+'assets/one.png?x=1','/plugin-assets/other/1.0.1/assets/one.png'):
            with self.subTest(icon=icon):
                self.assert_kind('plugin_invalid_icon',lambda icon=icon:self.call('PATCH','admin/plugins/'+self.plugin_id,{'icon':icon,'expectedRevision':details['revision']},actor='admin'))
        selected=self.call('PATCH','admin/plugins/'+self.plugin_id,{'icon':prefix+'assets/two.png','expectedRevision':details['revision']},actor='admin')['plugin']
        self.assertEqual(selected['icon'],prefix+'assets/two.png')
        stored=self.service.transaction(lambda cur:cur.execute('SELECT icon FROM lele.plugin_catalog WHERE id=%s',(self.plugin_id,)).fetchone()[0])
        self.assertEqual(stored,'assets/two.png')
        self.publish()
        parent=next(p for p in self.call('GET',self.ppath())['plugins'] if p['id']==self.plugin_id)
        self.assertEqual(parent['icon'],selected['icon'])
        cleared=self.call('PATCH','admin/plugins/'+self.plugin_id,{'icon':'','expectedRevision':self.admin_plugin()['revision']},actor='admin')['plugin']
        self.assertEqual(cleared['icon'],'')

    def test_scope_denies_discovery_install_entry_and_forces_explicit_reenable(self):
        self.publish(); a=self.install(); self.install(child=self.b)
        scoped=self.admin_action('scope',{'scopeMode':'children','childIds':[self.a['id']],'expectedRevision':self.admin_plugin()['revision']},method='PUT')
        self.assertNotIn(self.plugin_id,[p['id'] for p in self.call('GET',self.ppath(child=self.b))['plugins']])
        unavailable=next(p for p in self.call('GET',self.ppath(child=self.b),{'view':'installed'})['plugins'] if p['id']==self.plugin_id)
        self.assertEqual(unavailable['reason'],'plugin_out_of_scope'); self.assertTrue(unavailable['requiresReenable'])
        self.assert_kind('plugin_out_of_scope',lambda:self.action('enable',unavailable,child=self.b))
        self.assert_kind('plugin_out_of_scope',lambda:self.call('GET',self.ppath('entry',self.b)))
        self.assertTrue(self.call('GET',self.ppath('entry',self.a))['releaseId'])
        self.admin_action('scope',{'scopeMode':'all','childIds':[],'expectedRevision':scoped['revision']},method='PUT')
        self.assert_kind('plugin_requires_reenable',lambda:self.call('GET',self.ppath('entry',self.b)))
        self.assertTrue(self.action('enable',child=self.b)['effectiveEnabled'])

    def test_unpublish_cancels_pending_jobs_preserves_config_and_requires_owner_enable(self):
        self.publish(); plugin=self.install()
        context=self.service.transaction(lambda cur:active_context(cur,self.plugin_id,self.a['id']))
        def job(cur):
            cur.execute("INSERT INTO lele.plugin_jobs(id,plugin_id,child_id,task_id,occurrence_key,due_at,generation,config_revision,release_epoch) VALUES(%s,%s,%s,'task','once',now(),%s,%s,%s)",(str(uuid.uuid4()),self.plugin_id,self.a['id'],context['generation'],context['config_revision'],context['release_epoch']))
        self.service.transaction(job)
        self.admin_action('unpublish')
        self.assert_kind('plugin_unpublished',lambda:self.call('GET',self.ppath('entry')))
        self.assertEqual(self.call('GET',self.ppath('config'))['config'],{})
        self.assert_kind('plugin_unpublished',lambda:self.call('PUT',self.ppath('config'),{'config':{},'expectedRevision':0,'operationId':str(uuid.uuid4())}))
        def stopped(cur):
            cur.execute('SELECT status,cancel_requested FROM lele.plugin_jobs WHERE plugin_id=%s',(self.plugin_id,)); return cur.fetchone()
        self.assertEqual(self.service.transaction(stopped),('cancelled',True))
        self.publish()
        self.assert_kind('plugin_requires_reenable',lambda:self.call('GET',self.ppath('entry')))
        self.assertTrue(self.action('enable')['effectiveEnabled'])
        self.admin_action('unpublish')
        self.assertFalse(self.action('installation')['installed'])

    def test_update_gates_enabling_config_publication_scope_expansion_but_allows_revocation(self):
        self.publish(); plugin=self.install()
        self.service.transaction(lambda cur:cur.execute("UPDATE lele.plugin_catalog SET operation_state='updating',release_epoch=release_epoch+1 WHERE id=%s",(self.plugin_id,)))
        self.assert_kind('plugin_updating',lambda:self.call('GET',self.ppath('entry')),503)
        self.assert_kind('plugin_updating',lambda:self.call('PUT',self.ppath('config'),{'config':{},'expectedRevision':0,'operationId':str(uuid.uuid4())}),503)
        disabled=self.action('disable',plugin); self.assertFalse(disabled['enabled'])
        self.assert_kind('plugin_updating',lambda:self.action('enable',disabled),503)
        self.admin_action('scope',{'scopeMode':'children','childIds':[self.a['id']],'expectedRevision':self.admin_plugin()['revision']},method='PUT')
        self.assert_kind('plugin_updating',lambda:self.admin_action('scope',{'scopeMode':'all','childIds':[],'expectedRevision':self.admin_plugin()['revision']},method='PUT'),409)
        self.admin_action('unpublish')
        self.assertFalse(self.action('installation')['installed'])

    def test_child_picker_admin_authorization_counts_and_query_body(self):
        self.publish(); self.install()
        plugins=self.call('GET',self.ppath(),{'view':'installed','q':'测试'})['plugins']
        self.assertEqual([p['id'] for p in plugins],[self.plugin_id])
        self.assertEqual(self.call('GET',self.ppath(),{'view':'installed','q':'does-not-match'})['plugins'],[])
        details=self.admin_plugin(); self.assertEqual((details['installedCount'],details['enabledCount']),(1,1))
        picker=self.call('GET','admin/plugin-children',{'q':'测试甲'},actor='admin')['children']
        self.assertTrue(any(c['id']==self.a['id'] for c in picker))
        self.assertTrue(all(set(c)=={'id','name','ownerName'} for c in picker))
        self.assertEqual(self.call('GET','admin/plugins/'+self.plugin_id+'/deployments',actor='admin'),{'deployments':[]})
        with self.assertRaises(ApiError) as denied:self.call('GET','admin/plugins')
        self.assertEqual(denied.exception.status,403)
        with self.assertRaises(ApiError) as denied:self.call('DELETE','admin/plugins/'+self.plugin_id,actor='admin')
        self.assertEqual(denied.exception.status,405)

    def test_revision_checks_reject_lost_admin_updates_and_child_recovery_requires_reenable(self):
        self.publish(); self.install()
        old=self.admin_plugin()
        self.call('PATCH','admin/plugins/'+self.plugin_id,{'name':'新名字','expectedRevision':old['revision']},actor='admin')
        self.assert_kind('plugin_revision_conflict',lambda:self.admin_action('unpublish',{'expectedRevision':old['revision']}),409)
        def archive(cur):
            cur.execute('UPDATE lele.children SET archived=true WHERE id=%s',(self.a['id'],))
        self.service.transaction(archive)
        self.assert_kind('child_unavailable',lambda:self.service.transaction(lambda cur:active_context(cur,self.plugin_id,self.a['id'])))
        self.service.transaction(lambda cur:cur.execute('UPDATE lele.children SET archived=false WHERE id=%s',(self.a['id'],)))
        self.assert_kind('plugin_requires_reenable',lambda:self.call('GET',self.ppath('entry')))
        self.assertTrue(self.action('enable')['effectiveEnabled'])

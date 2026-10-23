"""Integration tests require an explicit isolated local PostgreSQL app config.

LELE_TEST_CONFIG=data/testing/backend/config.json PYTHONPATH=backend .venv/bin/python -m unittest tests.backend.test_child_backend -v
The suite refuses any database not named lele_test*. Never uses production config.
"""
import concurrent.futures
import copy
import os
import json
import re
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from lele_growth.accounts_app import create_app
from lele_growth.child_service import ChildService, initialize, bootstrap, import_child, ApiError, canonical_bytes, password_value

CONFIG=os.environ.get('LELE_TEST_CONFIG')
PASSWORD='Local-test-password-123!'
NEW_PASSWORD='Local-new-password-456!'

class PasswordPolicyTests(unittest.TestCase):
    def test_accepts_six_characters_and_optional_symbols(self):
        for value in ('abc123', 'A1b2C3', 'A1!234', 'A1'+'x'*126):
            with self.subTest(value=value):
                self.assertEqual(password_value(value), value)

    def test_rejects_short_or_missing_letters_or_digits(self):
        for value in ('ab123', 'abcdef', '123456', 'abc!@#', '123!@#', '中文密码12', 'A1'+'x'*127, '', None, 123456):
            with self.subTest(value=value):
                with self.assertRaises(ApiError):
                    password_value(value)

@unittest.skipUnless(CONFIG,'Set LELE_TEST_CONFIG to an isolated local test database')
class ChildBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service=ChildService(CONFIG)
        if cls.service.config['environment']!='development' or not cls.service.config['_connect']['dbname'].startswith('lele_test'):
            raise RuntimeError('Test database must be explicit local lele_test*')
        initialize(CONFIG)
        cls.service.transaction(lambda c:c.execute('TRUNCATE lele.users,lele.login_limits CASCADE'),exclusive=True)
        bootstrap(CONFIG,'testadmin','Admin',PASSWORD)
        cls.parent_app=create_app(CONFIG,'parent'); cls.admin_app=create_app(CONFIG,'admin')
        cls.admin=TestClient(cls.admin_app,base_url=cls.service.config['admin_origin'])
        cls.login(cls.admin,'testadmin',PASSWORD)
        cls.call(cls.admin,'POST','/api/account/password',{'currentPassword':PASSWORD,'newPassword':NEW_PASSWORD})
        cls.login(cls.admin,'testadmin',NEW_PASSWORD)
        cls.a,cls.au=cls.new_parent('parenta')
        cls.b,cls.bu=cls.new_parent('parentb')
        cls.outsider,cls.ou=cls.new_parent('outsider')

    @classmethod
    def login(cls,client,login,password):
        r=client.post('/api/auth/login',json={'loginName':login,'password':password},headers={'Origin':str(client.base_url).rstrip('/')})
        if r.status_code==200: client.headers['X-CSRF-Token']=r.json()['csrfToken']
        return r

    @classmethod
    def call(cls,client,method,path,body=None):
        return client.request(method,path,json=body,headers={'Origin':str(client.base_url).rstrip('/')})

    @classmethod
    def new_parent(cls,name):
        r=cls.call(cls.admin,'POST','/api/admin/users',{'loginName':name,'nickname':name,'password':PASSWORD})
        assert r.status_code==200,r.text
        user=r.json()['user']
        client=TestClient(cls.parent_app,base_url=cls.service.config['parent_origin'])
        assert cls.login(client,name,PASSWORD).status_code==200
        assert cls.call(client,'POST','/api/account/password',{'currentPassword':PASSWORD,'newPassword':NEW_PASSWORD}).status_code==200
        assert cls.login(client,name,NEW_PASSWORD).status_code==200
        return client,user

    def child(self):
        r=self.call(self.a,'POST','/api/children',{'name':'测试孩子'})
        self.assertEqual(r.status_code,200,r.text)
        return r.json()['child']

    def archive_fixture(self,child,archived):
        # Compatibility fixture only: the public archive/restore API is removed.
        self.service.transaction(lambda cur:cur.execute('UPDATE lele.children SET archived=%s WHERE id=%s',(archived,child['id'])))

    def data(self,child,client=None):
        r=(client or self.a).get('/api/children/'+child['id']+'/data')
        self.assertEqual(r.status_code,200,r.text)
        return r.json()

    def raw(self,child):
        return self.service.transaction(lambda cur:self.service.store.read(cur,child['id']))

    def operation(self,child,data=None,operation_id=None):
        data=data or self.data(child)
        return dict(expectedRevision=data['revision'],membershipVersion=data['context']['membershipVersion'],operationId=operation_id or str(uuid.uuid4()),kind='ledger.manual',payload={'amount':1,'reason':'test','date':'2026-10-15'})

    def invite(self,child,client=None,target='parentb'):
        r=self.call(client or self.a,'POST','/api/children/'+child['id']+'/invitations',{'loginName':target})
        self.assertEqual(r.status_code,200,r.text)
        return r.json()['invitation']['id']

    def join(self,child):
        invite=self.invite(child)
        r=self.call(self.b,'POST','/api/invitations/'+invite+'/accept',{})
        self.assertEqual(r.status_code,200,r.text)

    def test_access_isolation_and_admin_separation(self):
        child=self.child()
        self.assertEqual(self.outsider.get('/api/children/'+child['id']+'/data').status_code,403)
        self.assertEqual(self.admin.get('/api/children').status_code,403)
        self.assertEqual(self.a.get('/api/admin/users').status_code,403)
        self.assertEqual(self.a.get('/data/development/config.json').status_code,404)
        self.assertEqual(self.a.put('/api/data',json={}).status_code,403)
        unauth=TestClient(self.parent_app)
        self.assertEqual(unauth.get('/api/children').status_code,401)

    def test_admin_built_assets_are_surface_scoped(self):
        parent_page=self.a.get('/')
        self.assertEqual(parent_page.status_code,200)
        for pattern,content_type in ((r'src="(/parent-assets/[^"/]+\.js)"','javascript'),(r'href="(/parent-assets/[^"/]+\.css)"','text/css')):
            asset=re.search(pattern,parent_page.text)
            self.assertIsNotNone(asset,'Parent must serve locally built assets')
            served=self.a.get(asset.group(1))
            self.assertEqual(served.status_code,200)
            self.assertIn(content_type,served.headers['content-type'])
            self.assertEqual(self.admin.get(asset.group(1)).status_code,404)
        for path in ('/static/parent.js','/static/parent-ui.js','/parent-assets/index.html','/parent-assets/%2e%2e%2fchild_service.py','/parent-assets/index.js.map','/parent-ui/src/App.tsx','/shared-ui/src/theme.css'):
            self.assertEqual(self.a.get(path).status_code,404)
        from pathlib import Path
        for surface,client,other in [('parent',self.a,self.admin),('admin',self.admin,self.a)]:
            font_files=list((Path(__file__).resolve().parents[2]/'web'/(surface+'-dist')).glob('*.woff2'))
            self.assertTrue(font_files,'Inter must be bundled locally')
            font_path='/'+surface+'-assets/'+font_files[0].name
            font=client.get(font_path)
            self.assertEqual(font.status_code,200)
            self.assertEqual(font.content,font_files[0].read_bytes())
            self.assertIn('font/',font.headers['content-type'])
            self.assertEqual(other.get(font_path).status_code,404)
        response=self.admin.get('/')
        self.assertEqual(response.status_code,200)
        script=re.search(r'src="(/admin-assets/[^"/]+\.js)"',response.text)
        stylesheet=re.search(r'href="(/admin-assets/[^"/]+\.css)"',response.text)
        self.assertIsNotNone(script,'Admin must serve its locally built JavaScript')
        self.assertIsNotNone(stylesheet,'Admin must serve its locally built stylesheet')
        for asset,content_type in ((script.group(1),'javascript'),(stylesheet.group(1),'text/css')):
            served=self.admin.get(asset)
            self.assertEqual(served.status_code,200)
            self.assertIn(content_type,served.headers['content-type'])
            self.assertEqual(self.a.get(asset).status_code,404)
        for path in ('/admin-assets/index.html','/admin-assets/../child_service.py','/admin-assets/%2e%2e%2fchild_service.py','/admin-assets/index.js.map','/static/admin.js','/static/parent.js','/admin-ui/src/App.tsx'):
            with self.subTest(path=path):
                self.assertEqual(self.admin.get(path).status_code,404)

    def test_csrf_origin_and_persistent_session(self):
        missing=self.a.post('/api/children',json={'name':'Denied'})
        self.assertEqual(missing.status_code,403)
        wrong=self.a.post('/api/children',json={'name':'Denied'},headers={'Origin':self.service.config['parent_origin'],'X-CSRF-Token':'bad'})
        self.assertEqual(wrong.status_code,403)
        renewed=TestClient(create_app(CONFIG,'parent'),base_url=self.service.config['parent_origin'])
        renewed.cookies.update(self.a.cookies)
        self.assertEqual(renewed.get('/api/auth/me').status_code,200)
        badlogin=renewed.post('/api/auth/login',json={'loginName':'parenta','password':NEW_PASSWORD},headers={'Origin':self.service.config['admin_origin']})
        self.assertEqual(badlogin.status_code,403)

    def test_port_forwarded_login_keeps_csrf_and_surface_isolation(self):
        config = json.loads(Path(CONFIG).read_text())
        config.update(parent_trusted_origins=['http://forward.example.test:28787'],
                      admin_trusted_origins=['https://admin.example.test:28788'])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text(json.dumps(config))
            parent = TestClient(create_app(path, 'parent'), base_url=config['parent_trusted_origins'][0])
            self.assertEqual(self.login(parent, 'parenta', NEW_PASSWORD).status_code, 200)
            self.assertEqual(parent.get('/api/auth/me').status_code, 200)
            # Denial happens before writes, and successful login still requires CSRF afterward.
            for csrf in ('', 'wrong'):
                response = parent.patch('/api/account/profile', json={'nickname': 'must not save'},
                                        headers={'Origin': str(parent.base_url).rstrip('/'), 'X-CSRF-Token': csrf})
                self.assertEqual(response.status_code, 403)
                self.assertIn('请求校验失败', response.json()['error'])
            for headers in ({'Origin': config['admin_trusted_origins'][0]},
                            {'Origin': 'http://forward.example.test:28788'},
                            {'Origin': 'http://evil.example', 'Host': 'forward.example.test:28787',
                             'X-Forwarded-Host': 'forward.example.test:28787', 'X-Forwarded-Proto': 'http'},
                            {'X-Forwarded-Origin': config['parent_trusted_origins'][0]}):
                response = parent.post('/api/auth/login', json={'loginName':'parenta','password':NEW_PASSWORD}, headers=headers)
                self.assertEqual(response.status_code, 403)
                self.assertIn('请求来源不受信任', response.json()['error'])
            admin = TestClient(create_app(path, 'admin'), base_url=config['admin_trusted_origins'][0])
            self.assertEqual(self.login(admin, 'testadmin', NEW_PASSWORD).status_code, 200)
            self.assertEqual(admin.get('/api/admin/users').status_code, 200)
            self.assertEqual(self.login(admin, 'parenta', NEW_PASSWORD).status_code, 401)

    def test_forced_password_revokes_sessions_and_login_normalization(self):
        name='force'+uuid.uuid4().hex[:8]
        r=self.call(self.admin,'POST','/api/admin/users',{'loginName':name.upper(),'nickname':'Forced','password':PASSWORD})
        self.assertEqual(r.status_code,200,r.text)
        client=TestClient(self.parent_app,base_url=self.service.config['parent_origin'])
        self.assertEqual(self.login(client,name.upper(),PASSWORD).status_code,200)
        old=TestClient(self.parent_app,base_url=self.service.config['parent_origin']);old.cookies.update(client.cookies)
        self.assertEqual(client.get('/api/children').json()['kind'],'password_change_required')
        self.assertEqual(self.call(client,'POST','/api/account/password',{'currentPassword':PASSWORD,'newPassword':NEW_PASSWORD}).status_code,200)
        self.assertEqual(old.get('/api/auth/me').status_code,401)

    def test_six_character_password_create_change_and_reset(self):
        name='policy'+uuid.uuid4().hex[:8]
        path='/api/admin/users'
        for invalid in ('abc12', 'abcdef', '123456'):
            self.assertEqual(self.call(self.admin,'POST',path,{'loginName':name,'nickname':'Policy','password':invalid}).status_code,400)
        created=self.call(self.admin,'POST',path,{'loginName':name,'nickname':'Policy','password':'Abc123'})
        self.assertEqual(created.status_code,200,created.text)
        client=TestClient(self.parent_app,base_url=self.service.config['parent_origin'])
        self.assertEqual(self.login(client,name,'Abc123').status_code,200)
        for invalid in ('abc12', 'abcdef', '123456'):
            self.assertEqual(self.call(client,'POST','/api/account/password',{'currentPassword':'Abc123','newPassword':invalid}).status_code,400)
        self.assertEqual(self.call(client,'POST','/api/account/password',{'currentPassword':'Abc123','newPassword':'Def456'}).status_code,200)

        self.assertEqual(self.login(client,name,'Def456').status_code,200)
        reset_path=path+'/'+created.json()['user']['id']+'/password'
        for invalid in ('abc12', 'abcdef', '123456'):
            self.assertEqual(self.call(self.admin,'POST',reset_path,{'password':invalid}).status_code,400)
        self.assertEqual(client.get('/api/auth/me').status_code,200)
        self.assertEqual(self.call(self.admin,'POST',reset_path,{'password':'Ghi789'}).status_code,200)
        self.assertEqual(client.get('/api/auth/me').status_code,401)
        self.assertEqual(self.login(client,name,'Ghi789').status_code,200)
        self.assertEqual(client.get('/api/children').json()['kind'],'password_change_required')

    def test_forced_password_setup_without_current_password_is_session_scoped(self):
        name='setup'+uuid.uuid4().hex[:8]
        created=self.call(self.admin,'POST','/api/admin/users',{'loginName':name,'nickname':'Setup','password':'Abc123'})
        self.assertEqual(created.status_code,200,created.text)
        client=TestClient(self.parent_app,base_url=self.service.config['parent_origin'])
        other=TestClient(self.parent_app,base_url=self.service.config['parent_origin'])
        self.assertTrue(self.login(client,name,'Abc123').json()['user']['mustChangePassword'])
        self.login(other,name,'Abc123')
        self.assertEqual(client.get('/api/children').status_code,403)
        invalid_csrf=client.post('/api/account/password',json={'newPassword':'Def456'},headers={'Origin':self.service.config['parent_origin'],'X-CSRF-Token':'wrong'})
        self.assertEqual(invalid_csrf.status_code,403)
        self.assertEqual(self.call(client,'POST','/api/account/password',{'newPassword':'abcdef'}).status_code,400)
        response=self.call(client,'POST','/api/account/password',{'newPassword':'Def456'})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(client.get('/api/auth/me').status_code,401)
        self.assertEqual(other.get('/api/auth/me').status_code,401)
        self.assertFalse(self.login(client,name,'Def456').json()['user']['mustChangePassword'])
        self.assertEqual(self.call(client,'POST','/api/account/password',{'newPassword':'Ghi789'}).status_code,400)
        self.assertEqual(self.call(client,'POST','/api/account/password',{'newPassword':'Ghi789','mustChangePassword':True}).status_code,400)
        self.assertEqual(self.call(client,'POST','/api/account/password',{'currentPassword':'wrong','newPassword':'Ghi789'}).status_code,403)
        self.assertEqual(self.call(self.admin,'POST','/api/admin/users/'+created.json()['user']['id']+'/password',{'password':'Reset123'}).status_code,200)
        self.assertTrue(self.login(client,name,'Reset123').json()['user']['mustChangePassword'])
        self.assertEqual(self.call(client,'POST','/api/account/password',{'newPassword':'New123'}).status_code,200)
        self.assertFalse(self.login(client,name,'New123').json()['user']['mustChangePassword'])

    def test_idempotency_and_revision_conflicts(self):
        child=self.child(); body=self.operation(child); path='/api/children/'+child['id']+'/operations'
        first=self.call(self.a,'POST',path,body)
        self.assertEqual(first.status_code,200,first.text)
        repeated=self.call(self.a,'POST',path,body)
        self.assertEqual(repeated.status_code,200,repeated.text)
        self.assertEqual(first.json()['revision'],repeated.json()['revision'])
        changed={**body,'payload':{'amount':2,'reason':'changed','date':'2026-10-15'}}
        self.assertEqual(self.call(self.a,'POST',path,changed).status_code,409)
        stale={**body,'operationId':str(uuid.uuid4())}
        self.assertEqual(self.call(self.a,'POST',path,stale).json()['kind'],'revision_conflict')

    def test_concurrent_same_revision_only_one_write(self):
        child=self.child(); base=self.data(child)
        bodies=[self.operation(child,base),self.operation(child,base)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results=list(executor.map(lambda b:self.call(self.a,'POST','/api/children/'+child['id']+'/operations',b),bodies))
        self.assertEqual(sorted(r.status_code for r in results),[200,409])
        self.assertEqual(self.data(child)['revision'],base['revision']+1)

    def test_concurrent_duplicate_is_exactly_once(self):
        child=self.child(); body=self.operation(child)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results=list(executor.map(lambda _:self.call(self.a,'POST','/api/children/'+child['id']+'/operations',body),range(2)))
        self.assertEqual([r.status_code for r in results],[200,200])
        self.assertEqual(self.data(child)['revision'],1)

    def test_revocation_and_rejoin_invalidates_old_context(self):
        child=self.child();self.join(child)
        old=self.data(child,self.b)
        self.assertEqual(self.call(self.a,'DELETE','/api/children/'+child['id']+'/members/'+self.bu['id']).status_code,200)
        self.assertEqual(self.b.get('/api/children/'+child['id']+'/data').status_code,403)
        self.join(child)
        new=self.data(child,self.b)
        self.assertNotEqual(old['context']['membershipVersion'],new['context']['membershipVersion'])
        body=self.operation(child,old)
        r=self.call(self.b,'POST','/api/children/'+child['id']+'/operations',body)
        self.assertEqual(r.json()['kind'],'membership_changed')

    def test_archive_transfer_and_removed_restore(self):
        child=self.child(); self.join(child)
        current=self.data(child)
        restore=dict(expectedRevision=current['revision'],membershipVersion=self.data(child,self.b)['context']['membershipVersion'],operationId=str(uuid.uuid4()),data=current['data'])
        self.assertEqual(self.call(self.b,'POST','/api/children/'+child['id']+'/data/restore',restore).status_code,404)
        self.archive_fixture(child,True)
        self.assertEqual(self.b.get('/api/children/'+child['id']+'/data').status_code,200)
        self.assertEqual(self.call(self.a,'POST','/api/children/'+child['id']+'/operations',self.operation(child)).json()['kind'],'archived')
        self.assertEqual(self.call(self.b,'PATCH','/api/children/'+child['id'],{'archived':False}).status_code,400)
        self.archive_fixture(child,False)
        self.assertEqual(self.call(self.a,'POST','/api/children/'+child['id']+'/transfer',{'userId':self.bu['id']}).status_code,200)
        self.assertEqual(self.call(self.a,'PATCH','/api/children/'+child['id'],{'name':'No'}).status_code,403)
        self.assertEqual(self.call(self.b,'PATCH','/api/children/'+child['id'],{'name':'New name'}).status_code,200)

    def test_delete_child_revokes_all_access_and_retains_business(self):
        child=self.child(); self.join(child); other=self.child()
        root='/api/children/'+child['id']
        saved=self.call(self.a,'POST',root+'/operations',self.operation(child))
        self.assertEqual(saved.status_code,200)
        previous=self.data(child); operation=self.operation(child,previous)
        replay=self.operation(child,self.data(child))
        self.assertEqual(self.call(self.a,'POST',root+'/operations',replay).status_code,200)
        invite=self.invite(child,target='outsider')
        before=self.data(child); other_before=self.data(other)
        def retained(cur):
            record=self.service.store.read(cur,child['id'])
            cur.execute('SELECT revision,snapshot_json FROM lele.data_snapshots WHERE child_id=%s ORDER BY revision',(child['id'],))
            return record,cur.fetchall()
        retained_before=self.service.transaction(retained)
        for client in (self.b,self.outsider,self.admin):
            self.assertEqual(self.call(client,'DELETE',root).status_code,403)
        self.assertEqual(self.a.delete(root,headers={'Origin':self.service.config['parent_origin'],'X-CSRF-Token':'bad'}).status_code,403)
        self.assertEqual(self.a.delete(root,headers={'Origin':'https://untrusted.example'}).status_code,403)
        for _ in range(2):
            self.assertEqual(self.call(self.a,'DELETE',root).json(),{'ok':True})
        for client in (self.a,self.b):
            self.assertNotIn(child['id'],[c['id'] for c in client.get('/api/children').json()['children']])
            for suffix in ('data','context','members','invitations'):
                self.assertEqual(client.get(root+'/'+suffix).status_code,403,suffix)
        for suffix,method,body in [('operations','POST',operation),('operations','POST',replay),('transfer','POST',{'userId':self.bu['id']}),('invitations','POST',{'loginName':'outsider'}),('members/'+self.bu['id'],'DELETE',{}),('','PATCH',{'name':'Hidden'})]:
            self.assertEqual(self.call(self.a,method,root+('/'+suffix if suffix else ''),body).status_code,403,suffix)
        self.assertNotIn(invite,[i['id'] for i in self.outsider.get('/api/invitations').json()['invitations']])
        for answer in ('accept','reject'):
            self.assertEqual(self.call(self.outsider,'POST','/api/invitations/'+invite+'/'+answer,{}).status_code,403)
        self.assertEqual(self.service.transaction(retained),retained_before)
        self.assertEqual(self.data(other),other_before)
        def inspect(cur):
            cur.execute("SELECT count(*) FROM lele.audit_events WHERE child_id=%s AND action='child.delete'",(child['id'],))
            count=cur.fetchone()[0]
            cur.execute('SELECT deleted_at IS NOT NULL,deleted_by FROM lele.children WHERE id=%s',(child['id'],))
            return count,cur.fetchone()
        self.assertEqual(self.service.transaction(inspect),(1,(True,self.au['id'])))

    def test_archive_api_removed_but_legacy_archived_child_deletable(self):
        child=self.child(); root='/api/children/'+child['id']
        for value in (True,False):
            self.assertEqual(self.call(self.a,'PATCH',root,{'archived':value}).status_code,400)
        self.archive_fixture(child,True)
        self.assertEqual(self.call(self.a,'DELETE',root).status_code,200)
        self.assertEqual(self.a.get(root+'/data').status_code,403)

    def test_delete_rolls_back_if_audit_fails(self):
        child=self.child(); invite=self.invite(child)
        root='/api/children/'+child['id']; before=self.data(child)
        service=self.parent_app.state.service; audit=service.audit
        def failing_audit(cur,actor,action,child=None,detail=None):
            if action=='child.delete':
                raise ApiError(503,'模拟审计失败')
            return audit(cur,actor,action,child,detail)
        with patch.object(service,'audit',side_effect=failing_audit):
            self.assertEqual(self.call(self.a,'DELETE',root).status_code,503)
        self.assertEqual(self.data(child),before)
        self.assertIn(invite,[row['id'] for row in self.b.get('/api/invitations').json()['invitations']])

    def test_concurrent_delete_save_and_invitation(self):
        for mode in ('save','accept'):
            child=self.child(); root='/api/children/'+child['id']
            command=self.operation(child)
            invite=self.invite(child)
            def competing():
                return self.call(self.a,'POST',root+'/operations',command) if mode=='save' else self.call(self.b,'POST','/api/invitations/'+invite+'/accept',{})
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                mutation=pool.submit(competing)
                deletion=pool.submit(self.call,self.a,'DELETE',root)
                self.assertEqual(deletion.result().status_code,200)
                self.assertIn(mutation.result().status_code,(200,403))
            self.assertEqual(self.a.get(root+'/data').status_code,403)
            self.assertEqual(self.b.get(root+'/data').status_code,403)
            self.assertEqual(self.call(self.a,'POST',root+'/operations',command).status_code,403)

    def test_backup_endpoints_removed_and_internal_snapshots_retained(self):
        child=self.child(); self.join(child)
        current=self.data(child)
        root='/api/children/'+child['id']
        for client in (self.a,self.b,self.outsider):
            self.assertEqual(client.get(root+'/data/export').status_code,404)
            self.assertEqual(self.call(client,'POST',root+'/data/restore',{'data':current['data']}).status_code,404)
        self.assertEqual(self.data(child),current)
        command=self.operation(child)
        self.assertEqual(self.call(self.a,'POST',root+'/operations',command).status_code,200)
        def snapshots(cur):
            cur.execute('SELECT snapshot_json FROM lele.data_snapshots WHERE child_id=%s',(child['id'],));return cur.fetchall()
        self.assertEqual(self.service.transaction(snapshots)[0][0],{key:value for key,value in current.items() if key!='context'})

    def test_invitation_target_expiry_reject_revoke(self):
        child=self.child(); invite=self.invite(child)
        sent=self.a.get('/api/children/'+child['id']+'/invitations').json()['invitations']
        def created_at(cur):
            cur.execute('SELECT created_at FROM lele.invitations WHERE id=%s',(invite,))
            return cur.fetchone()[0].isoformat()
        self.assertEqual(next(row for row in sent if row['id']==invite)['createdAt'],self.service.transaction(created_at))
        self.assertEqual(self.call(self.outsider,'POST','/api/invitations/'+invite+'/accept',{}).status_code,404)
        self.assertEqual(self.call(self.b,'POST','/api/invitations/'+invite+'/reject',{}).status_code,200)
        invite=self.invite(child)
        self.assertEqual(self.call(self.a,'DELETE','/api/children/'+child['id']+'/invitations/'+invite).status_code,200)
        sent=self.a.get('/api/children/'+child['id']+'/invitations').json()['invitations']
        self.assertNotIn(invite,[row['id'] for row in sent])
        def revoked_status(cur):
            cur.execute('SELECT status FROM lele.invitations WHERE id=%s',(invite,))
            return cur.fetchone()[0]
        self.assertEqual(self.service.transaction(revoked_status),'revoked')
        self.assertEqual(self.call(self.b,'POST','/api/invitations/'+invite+'/accept',{}).status_code,409)
        invite=self.invite(child)
        self.service.transaction(lambda c:c.execute("UPDATE lele.invitations SET expires_at=now()-interval '1 second' WHERE id=%s",(invite,)),exclusive=True)
        self.assertEqual(self.call(self.b,'POST','/api/invitations/'+invite+'/accept',{}).status_code,409)

    def test_rejected_invitation_delete_and_accepted_visibility(self):
        child=self.child(); root='/api/children/'+child['id']
        accepted=self.invite(child)
        self.assertEqual(self.call(self.b,'POST','/api/invitations/'+accepted+'/accept',{}).status_code,200)
        rejected=self.invite(child,target='outsider')
        self.assertEqual(self.call(self.outsider,'POST','/api/invitations/'+rejected+'/reject',{}).status_code,200)
        sent=self.a.get(root+'/invitations').json()['invitations']
        self.assertNotIn(accepted,[row['id'] for row in sent])
        self.assertEqual(next(row for row in sent if row['id']==rejected)['status'],'rejected')
        path=root+'/invitations/'+rejected
        before=self.data(child); members=self.a.get(root+'/members').json()
        for client in (self.b,self.outsider,self.admin):
            self.assertEqual(self.call(client,'DELETE',path).status_code,403)
        self.assertEqual(self.a.delete(path,headers={'Origin':self.service.config['parent_origin'],'X-CSRF-Token':'bad'}).status_code,403)
        other=self.child()
        self.assertEqual(self.call(self.a,'DELETE','/api/children/'+other['id']+'/invitations/'+rejected).status_code,409)
        self.assertEqual(self.call(self.a,'DELETE',root+'/invitations/'+accepted).status_code,409)
        self.archive_fixture(child,True)
        self.assertEqual(self.call(self.a,'DELETE',path).status_code,409)
        self.archive_fixture(child,False)
        self.assertEqual(self.call(self.a,'DELETE',path).status_code,200)
        self.assertEqual(self.call(self.a,'DELETE',path).status_code,409)
        self.assertNotIn(rejected,[row['id'] for row in self.a.get(root+'/invitations').json()['invitations']])
        self.assertEqual(self.data(child),before)
        self.assertEqual(self.a.get(root+'/members').json(),members)
        def retained_history(cur):
            cur.execute('SELECT status FROM lele.invitations WHERE id=%s',(rejected,))
            status=cur.fetchone()[0]
            cur.execute("SELECT action,detail FROM lele.audit_events WHERE child_id=%s AND detail->>'invitationId'=%s ORDER BY id",(child['id'],rejected))
            return status,cur.fetchall()
        status,events=self.service.transaction(retained_history)
        self.assertEqual(status,'revoked')
        self.assertIn('invitation.reject',[row[0] for row in events])
        self.assertEqual(events[-1],('invitation.delete',{'invitationId':rejected,'previousStatus':'rejected'}))
        self.assertEqual(self.call(self.outsider,'POST','/api/invitations/'+rejected+'/accept',{}).status_code,409)
        self.assertNotEqual(self.invite(child,target='outsider'),rejected)

    def test_admin_disable_and_reset_revoke_sessions(self):
        client,user=self.new_parent('reset'+uuid.uuid4().hex[:8])
        self.assertEqual(self.call(self.admin,'PATCH','/api/admin/users/'+user['id']+'/status',{'status':'disabled'}).status_code,200)
        self.assertEqual(client.get('/api/auth/me').status_code,401)
        self.assertEqual(self.login(client,user['loginName'],NEW_PASSWORD).status_code,401)
        self.call(self.admin,'PATCH','/api/admin/users/'+user['id']+'/status',{'status':'active'})
        self.assertEqual(self.login(client,user['loginName'],NEW_PASSWORD).status_code,200)
        self.call(self.admin,'POST','/api/admin/users/'+user['id']+'/password',{'password':PASSWORD})
        self.assertEqual(client.get('/api/auth/me').status_code,401)
        self.assertTrue(self.login(client,user['loginName'],PASSWORD).json()['user']['mustChangePassword'])

    def test_import_exact_roundtrip_and_schema_idempotence(self):
        child=self.child(); raw=self.raw(child)
        raw['revision']=123;raw['extraStore']={'keep':None};raw['data']['customData']={'unknown':'retained'}
        imported=import_child(CONFIG,self.au['id'],raw)
        read=self.raw(imported)
        self.assertEqual(canonical_bytes(read),canonical_bytes(raw))
        with self.assertRaises(ApiError):import_child(CONFIG,self.au['id'],raw)
        self.assertEqual(initialize(CONFIG),{'initialized':False,'upgraded':False,'version':4})

    def test_backup_retention_and_actor_audit(self):
        child=self.child()
        for _ in range(32):
            result=self.call(self.a,'POST','/api/children/'+child['id']+'/operations',self.operation(child))
            self.assertEqual(result.status_code,200,result.text)
        def inspect(cur):
            cur.execute('SELECT count(*),min(revision),max(revision) FROM lele.data_snapshots WHERE child_id=%s',(child['id'],))
            backups=cur.fetchone()
            cur.execute("SELECT DISTINCT actor_id FROM lele.audit_events WHERE child_id=%s AND action='operation.ledger.manual'",(child['id'],))
            return backups,cur.fetchall()
        backups,actors=self.service.transaction(inspect)
        self.assertEqual(backups,(30,2,31))
        self.assertEqual(actors,[(self.au['id'],)])
        data=self.data(child)['data']
        self.assertEqual(sum(r['amount'] for r in data['ledger']),32)
        self.assertTrue(all(r['actorUserId']==self.au['id'] for r in data['operationLog']))

    def test_malformed_and_arbitrary_full_put_rejected(self):
        child=self.child()
        response=self.a.post('/api/children',content='{"name":NaN}',headers={'Origin':self.service.config['parent_origin'],'Content-Type':'application/json'})
        self.assertEqual(response.status_code,400)
        self.assertEqual(self.call(self.a,'POST','/api/children',[]).status_code,400)
        self.assertEqual(self.call(self.a,'PUT','/api/children/'+child['id']+'/data',{'data':self.data(child)['data']}).status_code,404)
        body=self.operation(child);body['kind']='replace_all';body['payload']={'data':{}}
        self.assertEqual(self.call(self.a,'POST','/api/children/'+child['id']+'/operations',body).status_code,400)
        self.assertEqual(self.data(child)['revision'],0)

    def test_forged_child_context_and_permissions_rejected(self):
        child=self.child();other=self.child()
        body=self.operation(child)
        self.assertEqual(self.call(self.a,'POST','/api/children/'+other['id']+'/operations',body).json()['kind'],'membership_changed')
        body=self.operation(child);body['actorUserId']=self.bu['id']
        self.assertEqual(self.call(self.a,'POST','/api/children/'+child['id']+'/operations',body).status_code,400)
        current=self.data(child)
        data=copy.deepcopy(current['data']);data['memberships']=[{'userId':self.bu['id'],'role':'owner'}]
        restore=dict(expectedRevision=current['revision'],membershipVersion=current['context']['membershipVersion'],operationId=str(uuid.uuid4()),data=data)
        self.assertEqual(self.call(self.a,'POST','/api/children/'+child['id']+'/data/restore',restore).status_code,404)
        self.assertEqual(self.data(child)['revision'],0)

    def test_profile_nickname_only_keeps_login_and_invitation_target_id(self):
        name='rename'+uuid.uuid4().hex[:8]
        client,user=self.new_parent(name)
        child=self.child();invite=self.invite(child,target=name)
        self.assertEqual(self.call(client,'PATCH','/api/account/profile',{'nickname':'Nickname only'}).status_code,200)
        renamed=name+'x'
        for body in ({'loginName':renamed},
                     {'loginName':renamed,'nickname':'Renamed','currentPassword':NEW_PASSWORD},
                     {'loginName':name,'nickname':'Renamed'}):
            response=self.call(client,'PATCH','/api/account/profile',body)
            self.assertEqual(response.status_code,400,response.text)
            self.assertEqual(response.json()['error'],'登录名不支持修改。')
        me=client.get('/api/auth/me').json()['user']
        self.assertEqual((me['loginName'],me['nickname']),(name,'Nickname only'))
        response=self.call(self.admin,'PATCH','/api/account/profile',{'loginName':'renamedadmin','currentPassword':NEW_PASSWORD})
        self.assertEqual(response.status_code,400,response.text)
        self.assertEqual(self.admin.get('/api/auth/me').json()['user']['loginName'],'testadmin')
        self.assertEqual(self.call(client,'POST','/api/invitations/'+invite+'/accept',{}).status_code,200)
        self.assertEqual(client.get('/api/children/'+child['id']+'/data').status_code,200)

    def test_surface_session_expiry_cookie_and_lightweight_health(self):
        def inspect(cur):
            cur.execute('SELECT surface,extract(epoch FROM expires_at-created_at)::integer FROM lele.sessions')
            return cur.fetchall()
        for surface,seconds in self.service.transaction(inspect):
            self.assertEqual(seconds,30*24*3600 if surface=='parent' else 8*3600)
        client=TestClient(self.parent_app,base_url=self.service.config['parent_origin'])
        response=self.login(client,'parenta',NEW_PASSWORD)
        cookie=response.headers['set-cookie']
        self.assertIn('Max-Age=2592000',cookie)
        self.assertIn('HttpOnly',cookie);self.assertIn('SameSite=strict',cookie)
        admin=TestClient(self.admin_app,base_url=self.service.config['admin_origin'])
        response=self.login(admin,'testadmin',NEW_PASSWORD)
        self.assertIn('Max-Age=28800',response.headers['set-cookie'])
        unauth=TestClient(self.parent_app)
        health=unauth.get('/api/health')
        self.assertEqual(health.status_code,200)
        self.assertEqual(health.json()['service'],'lele-task-manager')
        self.assertTrue(health.json()['databaseReady'])
        self.assertNotIn('data',health.json())

    def test_member_self_leave_and_former_owner_leave_preserve_data(self):
        child=self.child();self.join(child)
        current=self.data(child)
        base='/api/children/'+child['id']
        owner_path=base+'/members/'+self.au['id']
        member_path=base+'/members/'+self.bu['id']
        self.assertEqual(self.call(self.a,'DELETE',owner_path).status_code,400)
        self.assertEqual(self.call(self.b,'DELETE',owner_path).status_code,403)
        self.assertEqual(self.call(self.b,'DELETE',member_path).status_code,200)
        self.assertEqual(self.b.get(base+'/data').status_code,403)
        self.assertEqual(self.data(child),current)
        self.join(child)
        self.assertEqual(self.call(self.a,'POST',base+'/transfer',{'userId':self.bu['id']}).status_code,200)
        self.assertEqual(self.call(self.a,'DELETE',owner_path).status_code,200)
        self.assertEqual(self.a.get(base+'/data').status_code,403)
        remaining=self.data(child,self.b)
        self.assertEqual(remaining['data'],current['data'])
        self.assertEqual(remaining['revision'],current['revision'])
        self.assertEqual(self.call(self.b,'DELETE',member_path).status_code,400)

    def test_archived_nonowner_can_leave_but_cannot_remove_others(self):
        child=self.child();self.join(child)
        base='/api/children/'+child['id']
        self.archive_fixture(child,True)
        self.assertEqual(self.call(self.a,'DELETE',base+'/members/'+self.bu['id']).status_code,409)
        self.assertEqual(self.call(self.b,'DELETE',base+'/members/'+self.bu['id']).status_code,200)
        self.assertEqual(self.b.get(base+'/data').status_code,403)
        self.assertEqual(self.data(child)['revision'],0)

    def test_import_whitespace_child_name_preserved_and_operations_succeed(self):
        child=self.child()
        raw=self.raw(child)
        raw['data']['settings']['childName']='  测试孩子  '
        imported=import_child(CONFIG,self.au['id'],raw)
        self.assertEqual(imported['name'],'测试孩子')
        self.assertEqual(self.raw(imported),raw)
        result=self.call(self.a,'POST','/api/children/'+imported['id']+'/operations',self.operation(imported))
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(result.json()['data']['settings']['childName'],'  测试孩子  ')
        self.assertEqual(result.json()['revision'],raw['revision']+1)
        self.assertEqual(sum(r['amount'] for r in result.json()['data']['ledger']),1)

    def test_invite_pending_account_requires_password_change_before_accept(self):
        name='pending'+uuid.uuid4().hex[:8]
        opened=self.call(self.admin,'POST','/api/admin/users',{'loginName':name,'nickname':'Pending','password':PASSWORD})
        self.assertEqual(opened.status_code,200,opened.text)
        child=self.child();invite=self.invite(child,target=name)
        client=TestClient(self.parent_app,base_url=self.service.config['parent_origin'])
        self.assertEqual(self.login(client,name,PASSWORD).status_code,200)
        accept='/api/invitations/'+invite+'/accept'
        self.assertEqual(self.call(client,'POST',accept,{}).json()['kind'],'password_change_required')
        self.assertEqual(self.call(client,'POST','/api/account/password',{'currentPassword':PASSWORD,'newPassword':NEW_PASSWORD}).status_code,200)
        self.assertEqual(self.login(client,name,NEW_PASSWORD).status_code,200)
        self.assertEqual(self.call(client,'POST',accept,{}).status_code,200)
        self.assertEqual(client.get('/api/children/'+child['id']+'/data').status_code,200)

    def test_context_is_lightweight_and_authorized(self):
        child=self.child();path='/api/children/'+child['id']+'/context'
        context=self.a.get(path)
        self.assertEqual(context.status_code,200,context.text)
        self.assertEqual(context.json(),{'child':child,'revision':0})
        self.assertNotIn('data',context.json())
        self.assertEqual(self.outsider.get(path).status_code,403)
        self.join(child)
        member=self.b.get(path).json()
        self.assertEqual(member['child']['role'],'parent')
        self.assertNotEqual(member['child']['membershipVersion'],child['membershipVersion'])
        self.assertEqual(self.call(self.a,'POST','/api/children/'+child['id']+'/operations',self.operation(child)).status_code,200)
        self.assertEqual(self.b.get(path).json()['revision'],1)
        self.assertEqual(self.call(self.b,'DELETE','/api/children/'+child['id']+'/members/'+self.bu['id']).status_code,200)
        self.assertEqual(self.b.get(path).json()['kind'],'membership_revoked')

    def test_z_database_backed_login_rate_limit(self):
        client=TestClient(self.parent_app,base_url=self.service.config['parent_origin'])
        statuses=[self.login(client,'missingname','incorrect-pass-long').status_code for _ in range(12)]
        self.assertIn(429,statuses)
        recreated=TestClient(create_app(CONFIG,'parent'),base_url=self.service.config['parent_origin'])
        self.assertEqual(self.login(recreated,'missingname','incorrect-pass-long').status_code,429)


class ConfigGuardTests(unittest.TestCase):
    def test_implicit_config_forbidden(self):
        with self.assertRaises(ApiError):ChildService('/missing-explicit-config.json')

    def test_environment_guards_and_explicit_production_ssl_waiver(self):
        from lele_growth.child_service import load_config
        base={'environment':'development','database':{'host':'127.0.0.1','port':55432,'dbname':'lele_test_guard','user':'dev','sslmode':'disable','allow_unencrypted':True},'parent_origin':'http://127.0.0.1:18801','admin_origin':'http://127.0.0.1:18802'}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'config.json'
            for host in ('localhost','192.168.1.2','example.com'):
                candidate=copy.deepcopy(base);candidate['database']['host']=host
                path.write_text(json.dumps(candidate))
                with self.assertRaises(ApiError):load_config(path)
            candidate=copy.deepcopy(base);candidate['database']['dbname']='production'
            path.write_text(json.dumps(candidate))
            with self.assertRaises(ApiError):load_config(path)
            candidate=copy.deepcopy(base);candidate['environment']='production';candidate['parent_origin']='https://parent.example.com';candidate['admin_origin']='https://admin.example.com'
            path.write_text(json.dumps(candidate))
            self.assertEqual(load_config(path)['_connect']['sslmode'],'disable')
            candidate['database'].pop('allow_unencrypted');path.write_text(json.dumps(candidate))
            with self.assertRaises(ApiError):load_config(path)

if __name__=='__main__':unittest.main()

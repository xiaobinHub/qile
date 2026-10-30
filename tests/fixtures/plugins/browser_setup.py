"""Recreate only lele_test_plugin_browser and its private UI fixtures."""
import json
import os
from pathlib import Path
import shutil
import sys
import uuid

import psycopg
from psycopg import sql

from lele_growth.child_service import ChildService, initialize, bootstrap, load_config
from lele_growth.plugins.catalog import register_release, update_metadata

root=Path.cwd()
base=load_config(root/'data/development/config.json')
assert base['environment']=='development'
db='lele_test_plugin_browser'
with psycopg.connect(**{**base['_connect'],'dbname':'postgres'},autocommit=True) as conn:
    if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',(db,)).fetchone():
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(db)))
folder=root/'data/testing/plugins-browser';folder.mkdir(parents=True,exist_ok=True,mode=0o700)
config={k:v for k,v in base.items() if not k.startswith('_')}
config.update(database={**base['database'],'dbname':db},parent_origin='http://127.0.0.1:18987',admin_origin='http://127.0.0.1:18988',object_storage={'provider':'test-filesystem','root':str(folder/'objects')})
path=folder/'config.json';path.write_text(json.dumps(config));path.chmod(0o600)
with psycopg.connect(**{**base['_connect'],'dbname':db}) as conn:
    assert conn.execute('SELECT current_database()').fetchone()[0]==db
    conn.execute('DROP SCHEMA IF EXISTS lele CASCADE')
initialize(path)
passwords=json.load(sys.stdin)
bootstrap(path,'pluginadmin','应用管理员',passwords['initial'])
service=ChildService(path)
from lele_growth.maintenance import initialize_plugin_platform
initialize_plugin_platform(service)
def login(name,password,surface):
    return service.request('POST','auth/login',{'loginName':name,'password':password},None,None,config[surface+'_origin'],surface,'127.0.0.1')
def call(session,surface,method,route,body=None):
    return service.request(method,route,body or {},session['_cookie'],session['csrfToken'],config[surface+'_origin'],surface,'127.0.0.1')
admin=login('pluginadmin',passwords['initial'],'admin')
call(admin,'admin','POST','account/password',{'currentPassword':passwords['initial'],'newPassword':passwords['admin']})
admin=login('pluginadmin',passwords['admin'],'admin')
parents={}
for name in ('dad','mom'):
    user=call(admin,'admin','POST','admin/users',{'loginName':'plugin'+name,'nickname':'测试'+name,'password':passwords['initial']})['user']
    call(admin,'admin','PATCH','admin/users/'+user['id']+'/status',{'status':'active'})
    session=login('plugin'+name,passwords['initial'],'parent')
    call(session,'parent','POST','account/password',{'currentPassword':passwords['initial'],'newPassword':passwords[name]})
    parents[name]=login('plugin'+name,passwords[name],'parent')
child=call(parents['dad'],'parent','POST','children',{'name':'插件儿童','gender':'boy','requestId':str(uuid.uuid4())})['child']
other=call(parents['dad'],'parent','POST','children',{'name':'另一个孩子','gender':'girl','requestId':str(uuid.uuid4())})['child']
inv=call(parents['dad'],'parent','POST',f'children/{child["id"]}/invitations',{'loginName':'pluginmom'})['invitation']
call(parents['mom'],'parent','POST',f'invitations/{inv["id"]}/accept')
asset_root=folder/'runtime'
assert asset_root.parent==root/'data/testing/plugins-browser' and not asset_root.is_symlink()
if asset_root.exists(): shutil.rmtree(asset_root)
for plugin_id,name in [('growth-notes','成长随记'),('reminder-demo','提醒执行示例')]:
    build=root/'output/plugin-releases'/plugin_id/'1.0.0/build'
    target=asset_root/plugin_id/'releases/1.0.0'
    if target.exists():shutil.rmtree(target)
    target.parent.mkdir(parents=True,exist_ok=True)
    from lele_growth.plugins.deployment import inspect_package, prepare_release
    # Build/package this checkout explicitly; never prefer an old archive by name.
    sys.path.insert(0,str(root))
    from scripts.package_plugin import package_plugin
    package=package_plugin(root,plugin_id,allow_dirty=True)
    import hashlib
    prepare_release(inspect_package(package),asset_root)
    manifest=json.loads((target/'plugin.json').read_text())
    schema=json.loads((target/manifest['configSchema']).read_text())
    def register(cur):
        release=register_release(cur,manifest,artifact_sha256=hashlib.sha256(package.read_bytes()).hexdigest(),source_commit='browser-fixture',config_schema=schema,activate=True)
        cur.execute('SELECT policy_revision FROM lele.plugin_catalog WHERE id=%s',(plugin_id,))
        update_metadata(cur,plugin_id,{'name':name,'description':'独立插件验收示例','instructions':'此插件用于隔离环境验证。','expectedRevision':cur.fetchone()[0]})
        return release
    service.transaction(register)
state={'childId':child['id'],'otherChildId':other['id']}
(folder/'state.json').write_text(json.dumps(state))
print(json.dumps(state))

"""Explicit release registration and administrator catalog management."""
import re
import uuid

from psycopg.types.json import Jsonb
from lele_growth.child_service import require
from .configuration import EMPTY_SCHEMA, validate_schema
from .manifest import validate_manifest, icon_urls
from .policy import catalog_row, row_dict, rows_dict


def register_release(cur, manifest, *, artifact_sha256, source_commit, config_schema=None, release_id=None, activate=False):
    manifest = validate_manifest(manifest)
    require(isinstance(artifact_sha256,str) and re.fullmatch(r'[a-f0-9]{64}',artifact_sha256) is not None,400,'制品摘要不正确。')
    require(isinstance(source_commit,str) and 0<len(source_commit)<=128,400,'来源提交不正确。')
    if config_schema is None:
        require(not isinstance(manifest.get('configSchema'),str),400,'登记必须提供已解析的配置结构。')
        config_schema = manifest.get('configSchema') or EMPTY_SCHEMA
    config_schema = validate_schema(config_schema)
    manifest = validate_manifest(manifest, config_schema=config_schema)
    plugin_id = manifest['id']
    cur.execute('INSERT INTO lele.plugin_catalog(id,type,name,description,instructions,icon) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(id) DO NOTHING',
                (plugin_id,manifest['type'],manifest.get('name',plugin_id),manifest.get('description',''),manifest.get('instructions',''),next(iter(manifest.get('icons',[])),'')))
    plugin = catalog_row(cur, plugin_id, lock='UPDATE')
    require(plugin['type']==manifest['type'],409,'已有插件不能修改技术类型。','plugin_identity_conflict')
    cur.execute('SELECT * FROM lele.plugin_releases WHERE plugin_id=%s AND version=%s',(plugin_id,manifest['version']))
    release = row_dict(cur)
    if release:
        require(release['artifact_sha256']==artifact_sha256 and release['manifest']==manifest and release['config_schema']==config_schema and release['source_commit']==source_commit,
                409,'相同版本不能覆盖，请使用新版本。','plugin_version_exists')
        require(release_id is None or release['release_id']==release_id,409,'版本登记标识不一致。','plugin_version_exists')
    else:
        release_id = release_id or str(uuid.uuid4())
        require(isinstance(release_id,str) and 0<len(release_id)<=128)
        cur.execute('INSERT INTO lele.plugin_releases(release_id,plugin_id,version,manifest,artifact_sha256,source_commit,config_schema,data_schema_version) VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                    (release_id,plugin_id,manifest['version'],Jsonb(manifest),artifact_sha256,source_commit,Jsonb(config_schema),manifest['dataSchemaVersion']))
        release = row_dict(cur)
    if activate and plugin['active_release_id']!=release['release_id']:
        require(plugin['operation_state']=='ready',409,'应用更新尚未完成。','plugin_updating')
        cur.execute('UPDATE lele.plugin_catalog SET active_release_id=%s,release_epoch=release_epoch+1,policy_revision=policy_revision+1,updated_at=now() WHERE id=%s', (release['release_id'],plugin_id))
    return release


def cancel_work(cur, plugin_id, child_ids=None):
    clause = '' if child_ids is None else ' AND child_id=ANY(%s)'
    args = (plugin_id,) if child_ids is None else (plugin_id,list(child_ids))
    cur.execute("UPDATE lele.plugin_jobs SET status=CASE WHEN status='running' THEN status ELSE 'cancelled' END,cancel_requested=true,updated_at=now() WHERE plugin_id=%s AND status IN ('pending','retry','running')" + clause,args)
    cur.execute("UPDATE lele.plugin_event_deliveries d SET status=CASE WHEN d.status='running' THEN d.status ELSE 'cancelled' END,cancel_requested=true,updated_at=now() FROM lele.plugin_event_outbox o WHERE d.event_id=o.event_id AND d.plugin_id=%s AND d.status IN ('pending','retry','running')" + ('' if child_ids is None else ' AND o.child_id=ANY(%s)'),args)


def revoke_instances(cur, plugin_id, child_ids=None):
    """Caller locks catalog first; sorted child rows then installation rows."""
    args=(plugin_id,) if child_ids is None else (plugin_id,list(child_ids))
    clause='' if child_ids is None else ' AND cp.child_id=ANY(%s)'
    cur.execute('SELECT c.id FROM lele.children c JOIN lele.child_plugins cp ON cp.child_id=c.id WHERE cp.plugin_id=%s AND cp.installed'+clause+' ORDER BY c.id FOR UPDATE OF c',args)
    affected=[row['id'] for row in rows_dict(cur)]
    if affected:
        cur.execute('UPDATE lele.child_plugins SET requires_reenable=true,revision=revision+1,generation=generation+1,updated_at=now() WHERE plugin_id=%s AND child_id=ANY(%s)',(plugin_id,affected))
        cancel_work(cur,plugin_id,affected)
    return affected


def revoke_child(cur, child_id):
    """Called within the existing child archive transaction; takes no catalog lock."""
    cur.execute('SELECT plugin_id FROM lele.child_plugins WHERE child_id=%s AND installed ORDER BY plugin_id FOR UPDATE',(child_id,))
    ids=[row['plugin_id'] for row in rows_dict(cur)]
    for plugin_id in ids:
        cur.execute('UPDATE lele.child_plugins SET requires_reenable=true,revision=revision+1,generation=generation+1,updated_at=now() WHERE child_id=%s AND plugin_id=%s',(child_id,plugin_id))
        cancel_work(cur,plugin_id,[child_id])


def admin_plugin(cur, plugin_id):
    from .installations import public_plugin
    plugin = catalog_row(cur,plugin_id)
    cur.execute('SELECT release_id,version,config_schema,manifest FROM lele.plugin_releases WHERE release_id=%s',(plugin['active_release_id'],))
    plugin.update(row_dict(cur) or {})
    cur.execute('SELECT child_id FROM lele.plugin_scope_children WHERE plugin_id=%s ORDER BY child_id',(plugin_id,))
    plugin['child_ids']=[row['child_id'] for row in rows_dict(cur)]
    cur.execute('SELECT count(*) FILTER(WHERE installed) AS installed_count,count(*) FILTER(WHERE installed AND enabled) AS enabled_count FROM lele.child_plugins WHERE plugin_id=%s',(plugin_id,))
    counts=row_dict(cur)
    result=public_plugin(plugin,admin=True)
    result.update(installedCount=counts['installed_count'],enabledCount=counts['enabled_count'])
    return result


def list_admin(cur, query=''):
    require(isinstance(query,str) and len(query)<=200)
    cur.execute('SELECT id FROM lele.plugin_catalog WHERE strpos(lower(name),lower(%s))>0 ORDER BY sort_order,id',(query,))
    return [admin_plugin(cur,p['id']) for p in rows_dict(cur)]


def update_metadata(cur, plugin_id, body):
    plugin=catalog_row(cur,plugin_id,lock='UPDATE')
    require(set(body)<={'name','description','instructions','sortOrder','icon','expectedRevision'} and 'expectedRevision' in body and len(body)>1)
    check_revision(plugin,body['expectedRevision'])
    values={}
    for key,limit in (('name',80),('description',500),('instructions',4000)):
        if key in body:
            require(isinstance(body[key],str) and len(body[key].strip())<=limit and (key!='name' or bool(body[key].strip())))
            values[key]=body[key].strip()
        else: values[key]=plugin[key]
    order=body.get('sortOrder',plugin['sort_order'])
    require(type(order) is int and -100000<=order<=100000)
    icon=plugin['icon']
    if 'icon' in body:
        cur.execute('SELECT version,manifest FROM lele.plugin_releases WHERE plugin_id=%s AND release_id=%s',(plugin_id,plugin['active_release_id']))
        release=row_dict(cur)
        allowed=icon_urls(plugin_id,release['version'],release['manifest']) if release else {}
        require(isinstance(body['icon'],str) and (body['icon']=='' or body['icon'] in allowed),400,'请选择当前发布包中的图标。','plugin_invalid_icon')
        icon=allowed[body['icon']] if body['icon'] else ''
    cur.execute('UPDATE lele.plugin_catalog SET name=%s,description=%s,instructions=%s,sort_order=%s,icon=%s,policy_revision=policy_revision+1,updated_at=now() WHERE id=%s',(values['name'],values['description'],values['instructions'],order,icon,plugin_id))
    return admin_plugin(cur,plugin_id)


def check_revision(plugin, revision):
    require(type(revision) is int and revision==plugin['policy_revision'],409,'应用资料已改变，请刷新后重试。','plugin_revision_conflict')


def set_publication(cur, plugin_id, published, expected_revision):
    plugin=catalog_row(cur,plugin_id,lock='UPDATE')
    check_revision(plugin,expected_revision)
    if published:
        require(plugin['operation_state']=='ready',409,'应用更新中或暂不可用。','plugin_'+plugin['operation_state'])
        require(plugin['name'].strip() and plugin['description'].strip() and plugin['instructions'].strip(),400,'请完善应用名称、简介和使用说明。')
        cur.execute('SELECT manifest,config_schema FROM lele.plugin_releases WHERE plugin_id=%s AND release_id=%s',(plugin_id,plugin['active_release_id']))
        release=row_dict(cur)
        require(release is not None,409,'没有已验证的活动版本。','plugin_release_unavailable')
        validate_manifest(release['manifest'],config_schema=release['config_schema']); validate_schema(release['config_schema'])
        if plugin['scope_mode']=='children':
            cur.execute('SELECT EXISTS(SELECT 1 FROM lele.plugin_scope_children s JOIN lele.children c ON c.id=s.child_id WHERE s.plugin_id=%s AND c.deleted_at IS NULL)',(plugin_id,))
            require(cur.fetchone()[0],400,'请先选择开放儿童。')
    elif plugin['publication_status']=='published':
        revoke_instances(cur,plugin_id)
    cur.execute('UPDATE lele.plugin_catalog SET publication_status=%s,policy_revision=policy_revision+1,updated_at=now() WHERE id=%s',('published' if published else 'unpublished',plugin_id))
    return admin_plugin(cur,plugin_id)


def set_scope(cur, plugin_id, body):
    require(set(body)=={'scopeMode','childIds','expectedRevision'})
    mode,ids=body['scopeMode'],body['childIds']
    require(mode in ('all','children') and isinstance(ids,list) and all(isinstance(i,str) and 0<len(i)<=128 for i in ids) and len(ids)<=10000 and len(ids)==len(set(ids)))
    require(mode!='all' or not ids)
    plugin=catalog_row(cur,plugin_id,lock='UPDATE'); check_revision(plugin,body['expectedRevision'])
    cur.execute('SELECT child_id FROM lele.plugin_scope_children WHERE plugin_id=%s',(plugin_id,))
    old={row['child_id'] for row in rows_dict(cur)}
    if plugin['operation_state']=='updating':
        expanding = mode=='all' and plugin['scope_mode']!='all' or mode=='children' and plugin['scope_mode']=='children' and not set(ids)<=old
        require(not expanding,409,'更新中不能扩大开放范围。','plugin_updating')
    if mode=='children':
        require(bool(ids) or plugin['publication_status']!='published',400,'已上架应用至少需要一名开放儿童。')
        cur.execute('SELECT id FROM lele.children WHERE id=ANY(%s) AND deleted_at IS NULL ORDER BY id FOR UPDATE',(ids,))
        require(len(cur.fetchall())==len(ids),400,'开放范围包含无效儿童。')
        cur.execute('SELECT child_id FROM lele.child_plugins WHERE plugin_id=%s AND installed AND NOT (child_id=ANY(%s))',(plugin_id,ids))
        removed=[row['child_id'] for row in rows_dict(cur)]
        revoke_instances(cur,plugin_id,removed)
    cur.execute('DELETE FROM lele.plugin_scope_children WHERE plugin_id=%s',(plugin_id,))
    for child_id in sorted(ids):
        cur.execute('INSERT INTO lele.plugin_scope_children(plugin_id,child_id) VALUES(%s,%s)',(plugin_id,child_id))
    cur.execute('UPDATE lele.plugin_catalog SET scope_mode=%s,policy_revision=policy_revision+1,updated_at=now() WHERE id=%s',(mode,plugin_id))
    return admin_plugin(cur,plugin_id)

"""Child-owned installation/configuration lifecycle, durable operation idempotency."""
import hashlib
import json

from psycopg.types.json import Jsonb
from lele_growth.child_service import require, ApiError
from .catalog import cancel_work
from .configuration import EMPTY_SCHEMA, schema_defaults, validate_config
from .manifest import icon_urls
from .policy import load_context, row_dict, rows_dict, eligibility_reason


def public_plugin(context, *, admin=False):
    schema=context.get('config_schema',EMPTY_SCHEMA)
    icons=icon_urls(context.get('plugin_id',context['id']),context.get('version'),context.get('manifest',{}))
    icon=next((url for url,path in icons.items() if path==context['icon']),'')
    result=dict(
        id=context.get('plugin_id',context['id']), name=context['name'],
        description=context['description'], instructions=context['instructions'], icon=icon,
        type=context['type'], publicationStatus=context['publication_status'], scopeMode=context['scope_mode'],
        childIds=context.get('child_ids',[]), version=context.get('version'), releaseId=context.get('release_id'),
        operationState=context['operation_state'], revision=context['policy_revision'] if admin else context.get('revision',0),
        sortOrder=context['sort_order'], installed=context.get('installed',False), enabled=context.get('enabled',False),
        effectiveEnabled=context.get('effective_enabled',False), requiresReenable=context.get('requires_reenable',False),
        configRequired=context.get('reason')=='plugin_config_required' or _config_required(schema,context.get('config',schema_defaults(schema))),
        configRevision=context.get('config_revision',0), reason=context.get('reason'), configSchema=schema)
    if admin: result['icons']=list(icons)
    return result


def _config_required(schema, config):
    try: validate_config(schema,config)
    except ApiError: return True
    return False


def child_plugin(cur, plugin_id, child_id):
    context=load_context(cur,plugin_id,child_id)
    cur.execute('SELECT child_id FROM lele.plugin_scope_children WHERE plugin_id=%s ORDER BY child_id',(plugin_id,))
    context['child_ids']=[r['child_id'] for r in rows_dict(cur)]
    return public_plugin(context)


def list_child(cur, child_id, *, view='available', query=''):
    require(view in ('available','installed','status') and isinstance(query,str) and len(query)<=200)
    cur.execute("SELECT p.id FROM lele.plugin_catalog p LEFT JOIN lele.child_plugins cp ON cp.plugin_id=p.id AND cp.child_id=%s WHERE strpos(lower(p.name),lower(%s))>0 AND " +
                ("cp.installed" if view in ('installed','status') else "p.publication_status='published' AND (p.scope_mode='all' OR EXISTS(SELECT 1 FROM lele.plugin_scope_children s WHERE s.plugin_id=p.id AND s.child_id=%s))") + ' ORDER BY p.sort_order DESC,p.id',
                (child_id,query) if view in ('installed','status') else (child_id,query,child_id))
    return [child_plugin(cur,r['id'],child_id) for r in rows_dict(cur)]


def fingerprint(action, body):
    return hashlib.sha256(json.dumps({'action':action,'body':body},sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def replay_operation(cur, child_id, plugin_id, actor_id, action, body):
    require(isinstance(body.get('operationId'),str) and 1<=len(body['operationId'])<=128,400,'需要有效的操作标识。','plugin_invalid_operation')
    cur.execute('SELECT actor_id,payload_sha256,response FROM lele.plugin_operations WHERE child_id=%s AND plugin_id=%s AND operation_id=%s',(child_id,plugin_id,body['operationId']))
    replay=row_dict(cur)
    if replay:
        require(replay['actor_id']==actor_id and replay['payload_sha256']==fingerprint(action,body),409,'操作标识已用于其他请求。','plugin_operation_conflict')
        return replay['response']
    return None


def save_operation(cur, child_id, plugin_id, actor_id, action, body, response):
    cur.execute('INSERT INTO lele.plugin_operations(child_id,plugin_id,operation_id,actor_id,payload_sha256,response) VALUES(%s,%s,%s,%s,%s,%s)',
                (child_id,plugin_id,body['operationId'],actor_id,fingerprint(action,body),Jsonb(response)))
    return response


def require_manageable(context):
    reason = ('plugin_'+context['publication_status'] if context['publication_status']!='published' else
              'plugin_out_of_scope' if not context['in_scope'] else
              'child_unavailable' if context['archived'] or context['deleted_at'] is not None else
              'plugin_'+context['operation_state'] if context['operation_state']!='ready' else
              'plugin_release_unavailable' if not context['release_id'] else None)
    require(reason is None,503 if reason in ('plugin_updating','plugin_failed') else 409,'应用当前不可管理。',reason)


def mutate_installation(cur, plugin_id, child_id, actor_id, action, body):
    require(action in ('install','enable','disable','uninstall') and set(body)=={'operationId','expectedRevision'})
    replay=replay_operation(cur,child_id,plugin_id,actor_id,action,body)
    if replay is not None: return replay
    context=load_context(cur,plugin_id,child_id)
    require(type(body['expectedRevision']) is int and body['expectedRevision']==context['revision'],409,'应用状态已改变，请刷新重试。','plugin_revision_conflict')
    if action in ('install','enable'): require_manageable(context)
    else: require(context['revision']>0,409,'应用尚未安装。','plugin_not_installed')
    if action=='install':
        require(not context['installed'],409,'应用已经安装。','plugin_already_installed')
        first=context['revision']==0
        config=context['config'] if not first else schema_defaults(context['config_schema'])
        auto_enabled=first and not _config_required(context['config_schema'],config)
        if first:
            cur.execute('INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled,revision,generation,installed_by,updated_by,installed_at) VALUES(%s,%s,true,%s,1,1,%s,%s,now())',(child_id,plugin_id,auto_enabled,actor_id,actor_id))
            cur.execute('INSERT INTO lele.child_plugin_configs(child_id,plugin_id,config,updated_by) VALUES(%s,%s,%s,%s)',(child_id,plugin_id,Jsonb(config),actor_id))
        else:
            cur.execute('UPDATE lele.child_plugins SET installed=true,enabled=false,revision=revision+1,generation=generation+1,updated_by=%s,updated_at=now() WHERE child_id=%s AND plugin_id=%s',(actor_id,child_id,plugin_id))
    elif action=='enable':
        require(context['installed'],409,'请先安装应用。','plugin_not_installed')
        validate_config(context['config_schema'],context['config'])
        cur.execute('UPDATE lele.child_plugins SET enabled=true,requires_reenable=false,revision=revision+1,generation=generation+1,updated_by=%s,updated_at=now() WHERE child_id=%s AND plugin_id=%s',(actor_id,child_id,plugin_id))
    else:
        cur.execute('UPDATE lele.child_plugins SET installed=%s,enabled=false,revision=revision+1,generation=generation+1,updated_by=%s,updated_at=now() WHERE child_id=%s AND plugin_id=%s',(context['installed'] if action=='disable' else False,actor_id,child_id,plugin_id))
        cancel_work(cur,plugin_id,[child_id])
    result={'plugin':child_plugin(cur,plugin_id,child_id)}
    return save_operation(cur,child_id,plugin_id,actor_id,action,body,result)


def get_config(cur, plugin_id, child_id):
    context=load_context(cur,plugin_id,child_id)
    require(context['revision']>0,409,'请先安装应用。','plugin_not_installed')
    return dict(config=context['config'],schema=context['config_schema'],revision=context['config_revision'],plugin=child_plugin(cur,plugin_id,child_id))


def put_config(cur, plugin_id, child_id, actor_id, body):
    require(set(body)=={'config','expectedRevision','operationId'})
    replay=replay_operation(cur,child_id,plugin_id,actor_id,'config',body)
    if replay is not None: return replay
    context=load_context(cur,plugin_id,child_id)
    require_manageable(context)
    require(context['installed'],409,'请先安装应用。','plugin_not_installed')
    require(type(body['expectedRevision']) is int and body['expectedRevision']==context['config_revision'],409,'共享配置已改变，请刷新重试。','plugin_revision_conflict')
    config=validate_config(context['config_schema'],body['config'])
    cur.execute('UPDATE lele.child_plugin_configs SET config=%s,config_revision=config_revision+1,updated_by=%s,updated_at=now() WHERE child_id=%s AND plugin_id=%s',(Jsonb(config),actor_id,child_id,plugin_id))
    cur.execute('UPDATE lele.child_plugins SET revision=revision+1,generation=generation+1,updated_by=%s,updated_at=now() WHERE child_id=%s AND plugin_id=%s',(actor_id,child_id,plugin_id))
    cancel_work(cur,plugin_id,[child_id])
    return save_operation(cur,child_id,plugin_id,actor_id,'config',body,get_config(cur,plugin_id,child_id))

"""Fenced namespace records and effect deduplication, without arbitrary SQL access."""
import json
import re

from psycopg.types.json import Jsonb
from lele_growth.child_service import require
from .policy import active_context, assert_fences, row_dict, rows_dict


def _namespace(value):
    require(isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,511}',value) is not None,400,'记录标识不正确。')
    return value


def _context(cur, context, capability):
    plugin_id=context.get('plugin_id',context.get('pluginId'))
    child_id=context.get('child_id',context.get('childId'))
    current=active_context(cur,plugin_id,child_id)
    assert_fences(current,context)
    require(capability is None or capability in current['capabilities'],403,'应用没有所需能力。','plugin_capability_denied')
    return current


def _public(record):
    if record is None: return None
    return dict(id=record['record_id'],collection=record['collection'],payload=record['payload'],revision=record['revision'],dataSchemaVersion=record['data_schema_version'],createdAt=record['created_at'].isoformat(),updatedAt=record['updated_at'].isoformat())


def list_records(cur, context, collection, *, limit=100, after=None, record_id=None):
    current=_context(cur,context,'plugin.state.read'); _namespace(collection)
    require(type(limit) is int and 1<=limit<=500)
    if record_id is not None:
        return {'record':get_record(cur,current,collection,record_id)}
    if after is not None: _namespace(after)
    cur.execute('SELECT * FROM lele.child_plugin_records WHERE plugin_id=%s AND child_id=%s AND collection=%s AND (%s::text IS NULL OR record_id>%s) ORDER BY record_id LIMIT %s',(current['plugin_id'],current['child_id'],collection,after,after,limit+1))
    records=[_public(row) for row in rows_dict(cur)]
    return {'records':records[:limit],'nextCursor':records[limit-1]['id'] if len(records)>limit else None}


def get_record(cur, context, collection, record_id):
    current=_context(cur,context,'plugin.state.read'); _namespace(collection); _namespace(record_id)
    cur.execute('SELECT * FROM lele.child_plugin_records WHERE plugin_id=%s AND child_id=%s AND collection=%s AND record_id=%s',(current['plugin_id'],current['child_id'],collection,record_id))
    return _public(row_dict(cur))


def put_record(cur, context, collection, record_id, payload, *, expected_revision=None, effect_key=None, operation_id=None, actor_id=None):
    current=_context(cur,context,'plugin.state.write'); _namespace(collection); _namespace(record_id)
    require(isinstance(payload,dict),400,'记录内容必须为对象。')
    try: encoded=json.dumps(payload,ensure_ascii=False,allow_nan=False)
    except (ValueError,TypeError,OverflowError): require(False,400,'记录必须为有效 JSON。')
    require(len(encoded.encode())<=65536,400,'记录内容过大。')
    # A per-installation update lock makes record/effect writes serial with
    # configuration changes and revocation, including first-record inserts.
    cur.execute('SELECT generation FROM lele.child_plugins WHERE plugin_id=%s AND child_id=%s FOR UPDATE',(current['plugin_id'],current['child_id']))
    operation_body=None
    if operation_id is not None:
        from .installations import replay_operation
        operation_body={'operationId':operation_id,'collection':collection,'id':record_id,'payload':payload,'expectedRevision':expected_revision}
        replay=replay_operation(cur,current['child_id'],current['plugin_id'],actor_id,'record',operation_body)
        if replay is not None: return replay
    if effect_key is not None:
        _namespace(effect_key)
        cur.execute('SELECT status,result FROM lele.plugin_effects WHERE plugin_id=%s AND child_id=%s AND effect_key=%s FOR UPDATE',(current['plugin_id'],current['child_id'],effect_key))
        effect=row_dict(cur)
        if effect:
            require(effect['status']=='succeeded',409,'业务结果尚未确认。','plugin_effect_uncertain')
            return effect['result']
    cur.execute('SELECT * FROM lele.child_plugin_records WHERE plugin_id=%s AND child_id=%s AND collection=%s AND record_id=%s FOR UPDATE',(current['plugin_id'],current['child_id'],collection,record_id))
    old=row_dict(cur)
    if expected_revision is not None:
        require(type(expected_revision) is int and expected_revision==(old['revision'] if old else 0),409,'记录已改变。','plugin_revision_conflict')
    cur.execute('INSERT INTO lele.child_plugin_records(child_id,plugin_id,collection,record_id,payload,data_schema_version) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(child_id,plugin_id,collection,record_id) DO UPDATE SET payload=EXCLUDED.payload,revision=lele.child_plugin_records.revision+1,data_schema_version=EXCLUDED.data_schema_version,updated_at=now() RETURNING *',
                (current['child_id'],current['plugin_id'],collection,record_id,Jsonb(payload),current['data_schema_version']))
    result=_public(row_dict(cur))
    if effect_key is not None:
        cur.execute("INSERT INTO lele.plugin_effects(plugin_id,child_id,effect_key,status,result) VALUES(%s,%s,%s,'succeeded',%s)",(current['plugin_id'],current['child_id'],effect_key,Jsonb(result)))
    if operation_body is not None:
        from .installations import save_operation
        return save_operation(cur,current['child_id'],current['plugin_id'],actor_id,'record',operation_body,{'record':result})
    return result


write_record = put_record


def apply_effects(cur, context, effects, *, effect_key):
    current=_context(cur,context,'plugin.state.write' if effects else None)
    _namespace(effect_key)
    require(isinstance(effects,list) and len(effects)<=100,400,'应用效果格式不正确。')
    cur.execute('SELECT status,result FROM lele.plugin_effects WHERE plugin_id=%s AND child_id=%s AND effect_key=%s FOR UPDATE',(current['plugin_id'],current['child_id'],effect_key))
    previous=row_dict(cur)
    if previous:
        require(previous['status']=='succeeded',409,'业务结果尚未确认。','plugin_effect_uncertain')
        return previous['result']
    records=[]
    for effect in effects:
        require(isinstance(effect,dict) and set(effect)=={'collection','id','payload'},400,'应用效果格式不正确。')
        records.append(put_record(cur,current,effect['collection'],effect['id'],effect['payload']))
    result={'records':records}
    cur.execute("INSERT INTO lele.plugin_effects(plugin_id,child_id,effect_key,status,result) VALUES(%s,%s,%s,'succeeded',%s)",(current['plugin_id'],current['child_id'],effect_key,Jsonb(result)))
    return result

"""Durable external writes: bound credentials, account serialization and no replay."""
from datetime import datetime, timezone
import hashlib
import json
import uuid
from psycopg.types.json import Jsonb
from lele_growth.child_service import require
from . import private_store
from .policy import row_dict

TERMINAL = {'succeeded', 'failed', 'cancelled'}
UNRESOLVED = {'prepared', 'dispatching', 'uncertain', 'partially_succeeded', 'needs_repair'}

def public(row, internal=False):
    value = dict(operationId=str(row['operation_id']), kind=row['kind'], state=row['state'],
                 stage=row['stage'], stageVersion=row['stage_version'], bindingRevision=row['binding_revision'],
                 result=row['result'], createdAt=row['created_at'].isoformat(), updatedAt=row['updated_at'].isoformat())
    if internal:
        value.update(canonicalRequest=row['sanitized_request'], baseline=row['baseline'])
    return value

def handle(cur, current, context, action, payload):
    require('plugin.external-operations' in context.get('capabilities', []), 403, '当前请求未获外部操作能力。', 'plugin_capability_denied')
    cur.execute("SELECT 1 FROM lele.memberships m JOIN lele.users u ON u.id=m.user_id WHERE m.child_id=%s AND m.user_id=%s AND u.status='active'", (current['child_id'], context['actorId']))
    require(cur.fetchone(), 403, '无权操作该儿童的课程。', 'RESOURCE_FORBIDDEN')
    saved = private_store.get(cur, current, 'login-session', 'current')
    binding = saved['payload'] if saved else {}
    cur.execute("SELECT * FROM lele.plugin_credentials WHERE id=%s AND child_id=%s AND plugin_id=%s AND state='active'", (binding.get('credentialId'), current['child_id'], current['plugin_id']))
    credential = row_dict(cur)
    require(credential and credential['expires_at'] > datetime.now(timezone.utc), 409, '请重新登录美森账号。', 'RECONNECT_REQUIRED')
    fingerprint = hashlib.sha256((credential['provider'] + ':' + str(binding.get('userid'))).encode()).hexdigest()
    # Same upstream account bound to another child must share the same write fence.
    cur.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (current['plugin_id'] + ':' + fingerprint,))
    if action == 'operation.list':
        cur.execute("SELECT * FROM lele.plugin_external_operations WHERE child_id=%s AND plugin_id=%s AND remote_fingerprint=%s AND state=ANY(%s) ORDER BY created_at LIMIT 50", (current['child_id'], current['plugin_id'], fingerprint, list(UNRESOLVED)))
        return {'ok': True, 'data': {'operations': [public(row_dict_from(cur, r)) for r in cur.fetchall()]}}
    try: operation_id = str(uuid.UUID(payload.get('operationId')))
    except (ValueError, TypeError, AttributeError):
        require(False, 400, '操作标识不正确。', 'VALIDATION_ERROR')
    cur.execute('SELECT * FROM lele.plugin_external_operations WHERE operation_id=%s FOR UPDATE', (operation_id,))
    old = row_dict(cur)
    if old:
        require(old['child_id'] == current['child_id'] and old['plugin_id'] == current['plugin_id'], 403, '操作不属于当前儿童。', 'RESOURCE_FORBIDDEN')
        require(old['remote_fingerprint'] == fingerprint, 409, '账号状态已改变。', 'BINDING_CHANGED')
        if action == 'operation.get': return {'ok': True, 'data': public(old, True)}
    if not old:
        require(action == 'operation.begin', 404, '操作记录不存在。', 'OPERATION_NOT_FOUND')
    canonical = payload.get('canonicalRequest')
    require(isinstance(canonical, dict), 400, '操作参数不正确。', 'VALIDATION_ERROR')
    encoded = json.dumps(canonical, sort_keys=True, separators=(',', ':'), allow_nan=False)
    require(len(encoded.encode()) <= 32768, 400, '操作参数过大。', 'VALIDATION_ERROR')
    request_hash = hashlib.sha256(encoded.encode()).hexdigest()
    if old:
        require(old['request_hash'] == request_hash, 409, '操作标识已用于其他请求。', 'OPERATION_CONFLICT')
        if action == 'operation.begin': return {'ok': True, 'data': {'mayExecute': False, 'operation': public(old, True)}}
        require(type(payload.get('expectedStageVersion')) is int and payload['expectedStageVersion'] == old['stage_version'], 409, '操作状态已改变，请核对结果。', 'REVISION_CONFLICT')
        require(old['state'] not in TERMINAL, 409, '操作已经结束，不能再次发送。', 'OPERATION_CONFLICT')
        if action == 'operation.mark-dispatch':
            require(old['credential_id'] == credential['id'] and old['binding_revision'] == binding['bindingRevision'], 409, '账号状态已改变。', 'BINDING_CHANGED')
            require(old['state'] == 'prepared', 409, '操作已经发送，请核对结果。', 'RESULT_UNCERTAIN')
            cur.execute('SELECT lease_until>now() AS valid FROM lele.plugin_external_leases WHERE plugin_id=%s AND remote_fingerprint=%s AND operation_id=%s', (current['plugin_id'], fingerprint, operation_id))
            lease = row_dict(cur)
            require(lease and lease['valid'], 409, '操作已超时，请核对结果。', 'RESULT_UNCERTAIN')
            state = 'dispatching'
        elif action == 'operation.stage':
            require(old['state'] in ('dispatching', 'needs_repair'), 409, '操作阶段不正确。', 'OPERATION_CONFLICT')
            state = old['state']
        elif action == 'operation.finish':
            state = payload.get('state')
            require(state in TERMINAL | {'uncertain', 'partially_succeeded', 'needs_repair'}, 400, '操作状态不正确。', 'VALIDATION_ERROR')
            require(isinstance(payload.get('result'), dict) and len(json.dumps(payload['result']).encode()) <= 65536, 400, '操作结果不正确。', 'VALIDATION_ERROR')
        else: require(False, 400, '操作动作不正确。', 'VALIDATION_ERROR')
        cur.execute('''UPDATE lele.plugin_external_operations SET state=%s,stage=%s,stage_version=stage_version+1,
result=%s,completed_at=CASE WHEN %s THEN now() ELSE NULL END,updated_at=now() WHERE operation_id=%s RETURNING *''',
                    (state, str(payload.get('stage', old['stage']))[:100], Jsonb(payload.get('result', old['result'])), state in TERMINAL, operation_id))
        updated = row_dict(cur)
        if state in TERMINAL:
            cur.execute('DELETE FROM lele.plugin_external_leases WHERE plugin_id=%s AND remote_fingerprint=%s AND operation_id=%s', (current['plugin_id'], fingerprint, operation_id))
        return {'ok': True, 'data': {'operation': public(updated, True)}}
    require(action == 'operation.begin', 404, '操作记录不存在。', 'OPERATION_NOT_FOUND')
    require(type(payload.get('bindingRevision')) is int and payload['bindingRevision'] == binding['bindingRevision'], 409, '账号状态已改变。', 'BINDING_CHANGED')
    kind = payload.get('kind')
    require(kind in ('book', 'preview', 'cancel', 'change-draft', 'favorite'), 400, '操作类型不正确。', 'VALIDATION_ERROR')
    cur.execute("SELECT 1 FROM lele.plugin_external_operations WHERE plugin_id=%s AND remote_fingerprint=%s AND state=ANY(%s) LIMIT 1", (current['plugin_id'], fingerprint, list(UNRESOLVED)))
    require(cur.fetchone() is None, 409, '该美森账号有尚未确认的操作，请先核对结果。', 'OPERATION_IN_PROGRESS')
    baseline = payload.get('baseline', {})
    require(isinstance(baseline, dict) and len(json.dumps(baseline).encode()) <= 32768, 400, '操作核对数据过大。', 'VALIDATION_ERROR')
    cur.execute('''INSERT INTO lele.plugin_external_operations(operation_id,child_id,plugin_id,actor_id,binding_revision,
credential_id,credential_revision,remote_fingerprint,kind,request_hash,hash_key_id,resource_keys,state,stage,sanitized_request,baseline)
VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'sha256',%s,'prepared','validate',%s,%s) RETURNING *''',
                (operation_id, current['child_id'], current['plugin_id'], context['actorId'], binding['bindingRevision'], credential['id'], credential['revision'], fingerprint, kind, request_hash, Jsonb(payload.get('resourceKeys', [])), Jsonb(canonical), Jsonb(baseline)))
    result = row_dict(cur)
    cur.execute("INSERT INTO lele.plugin_external_leases(plugin_id,remote_fingerprint,operation_id,lease_until) VALUES(%s,%s,%s,now()+interval '60 seconds') ON CONFLICT(plugin_id,remote_fingerprint) DO UPDATE SET operation_id=EXCLUDED.operation_id,lease_until=EXCLUDED.lease_until,updated_at=now()", (current['plugin_id'], fingerprint, operation_id))
    return {'ok': True, 'data': {'mayExecute': True, 'operation': public(result, True)}}

def row_dict_from(cur, row): return {column.name: value for column, value in zip(cur.description, row)}

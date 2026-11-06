"""Encrypted, child-scoped external login sessions and durable login attempt receipts."""
import hashlib
import hmac
import json
import uuid
from datetime import datetime, timedelta, timezone
from lele_growth.child_service import require
from . import private_store, credential_vault
from .policy import row_dict

COLLECTION = 'login-session'


def current(cur, scope, vault, owner):
    record = private_store.get(cur, scope, COLLECTION, 'current')
    saved = record['payload'] if record else {}
    result = dict(status='unbound', bindingRevision=saved.get('bindingRevision', 0),
                  maskedAccount=saved.get('maskedAccount'), contract=None,
                  canManageConnection=owner, lastCheckedAt=saved.get('connectedAt'))
    credential_id = saved.get('credentialId')
    if not credential_id:
        return result
    cur.execute("SELECT expires_at,state,revision FROM lele.plugin_credentials WHERE id=%s AND child_id=%s AND plugin_id=%s",
                (credential_id, scope['child_id'], scope['plugin_id']))
    credential = row_dict(cur)
    if not credential or credential['state'] != 'active' or not credential['expires_at'] or credential['expires_at'] <= datetime.now(timezone.utc):
        result['status'] = 'reconnect_required'
        return result
    require(vault is not None, 503, '美森登录服务尚未配置，请联系管理员。', 'plugin_vault_unavailable')
    result.update(status='connected', userid=saved['userid'], credentialId=credential_id,
                  credentialRevision=credential['revision'],
                  token=credential_vault.token(cur, scope, credential_id, vault))
    return result


def handle(cur, scope, context, action, payload, vault):
    # A signed plugin job has no user actor, but may read the saved Mison session.
    job_reader = action in ('session.get', 'session.invalidate') and bool(context.get('jobId')) and context.get('actorId') is None
    if job_reader:
        owner = False
    else:
        cur.execute('''SELECT 1 FROM lele.memberships m JOIN lele.users u ON u.id=m.user_id
WHERE m.child_id=%s AND m.user_id=%s AND u.status='active' ''', (scope['child_id'], context['actorId']))
        require(cur.fetchone() is not None, 403, '当前用户无权访问该儿童的美森账号。', 'OWNER_REQUIRED')
        cur.execute('SELECT owner_id FROM lele.children WHERE id=%s', (scope['child_id'],))
        owner = cur.fetchone()[0] == context['actorId']
    if action == 'session.get':
        return {'ok': True, 'data': current(cur, scope, vault, owner)}
    if action == 'session.invalidate':
        binding = private_store.get(cur, scope, COLLECTION, 'current')
        saved = binding['payload'] if binding else {}
        require(saved.get('credentialId') == payload.get('credentialId') and saved.get('bindingRevision') == payload.get('bindingRevision'),
                409, '账号状态已改变。', 'BINDING_CHANGED')
        cur.execute("UPDATE lele.plugin_credentials SET state='revoked',updated_at=now() WHERE id=%s AND child_id=%s AND plugin_id=%s",
                    (saved['credentialId'], scope['child_id'], scope['plugin_id']))
        return {'ok': True, 'data': current(cur, scope, vault, owner)}
    require(owner, 403, '仅儿童负责人可登录或管理美森账号。', 'OWNER_REQUIRED')
    require(vault is not None, 503, '美森登录服务尚未配置，请联系管理员。', 'plugin_vault_unavailable')
    operation_id = payload.get('operationId')
    try:
        operation_id = str(uuid.UUID(operation_id))
    except (ValueError, TypeError, AttributeError):
        require(False, 400, '登录操作标识不正确。', 'VALIDATION_ERROR')
    binding = private_store.get(cur, scope, COLLECTION, 'current')
    revision = binding['payload'].get('bindingRevision', 0) if binding else 0
    if action == 'session.disconnect':
        require(type(payload.get('bindingRevision')) is int and payload['bindingRevision'] == revision,
                409, '账号状态已改变，请刷新页面。', 'BINDING_CHANGED')
        cur.execute("UPDATE lele.plugin_credentials SET state='revoked',updated_at=now() WHERE child_id=%s AND plugin_id=%s AND state='active'",
                    (scope['child_id'], scope['plugin_id']))
        private_store.put(cur, scope, COLLECTION, 'current', {'bindingRevision': revision + 1}, expected_revision=binding['revision'] if binding else 0)
        return {'ok': True, 'data': current(cur, scope, vault, owner)}
    attempt = private_store.get(cur, scope, 'login-attempt', operation_id)
    now = datetime.now(timezone.utc)
    if action == 'session.begin':
        username, password = payload.get('username'), payload.get('password')
        require(isinstance(username, str) and 1 <= len(username) <= 128 and isinstance(password, str) and 1 <= len(password) <= 256,
                400, '请输入有效账号和密码。', 'VALIDATION_ERROR')
        key_id = attempt['payload']['keyId'] if attempt else vault.active_key_id()
        require(key_id in vault.keys, 503, '登录校验密钥不可用。', 'plugin_vault_unavailable')
        digest = hmac.new(vault.keys[key_id], json.dumps([username, password, payload.get('bindingRevision')], ensure_ascii=False).encode(), hashlib.sha256).hexdigest()
        if attempt:
            saved = attempt['payload']
            require(saved['actorId'] == context['actorId'], 403, '登录请求不属于当前用户。', 'OWNER_REQUIRED')
            require(hmac.compare_digest(saved['hash'], digest), 409, '该操作标识已用于其他登录请求。', 'OPERATION_CONFLICT')
            if saved['state'] == 'succeeded':
                require(saved['resultRevision'] == revision, 409, '账号状态已改变。', 'BINDING_CHANGED')
                return {'ok': True, 'data': {'mayExecute': False, 'session': current(cur, scope, vault, owner)}}
            require(False, 409, saved.get('message', '上次登录结果待确认，请勿重复提交。'), saved.get('code', 'RESULT_UNCERTAIN'))
        require(type(payload.get('bindingRevision')) is int and payload['bindingRevision'] == revision, 409, '账号状态已改变，请重新打开登录页。', 'BINDING_CHANGED')
        lease = private_store.get(cur, scope, COLLECTION, 'login-lease')
        require(lease is None, 409, '登录请求正在处理，请稍后再试。', 'OPERATION_IN_PROGRESS')
        private_store.put(cur, scope, COLLECTION, 'login-lease', {'operationId': operation_id}, expires_at=now + timedelta(seconds=60))
        private_store.put(cur, scope, 'login-attempt', operation_id,
                          {'state': 'dispatching', 'hash': digest, 'keyId': key_id, 'bindingRevision': revision, 'actorId': context['actorId']},
                          expected_revision=0, expires_at=now + timedelta(days=7))
        return {'ok': True, 'data': {'mayExecute': True}}
    require(attempt is not None and attempt['payload']['actorId'] == context['actorId'], 404, '登录请求不存在。', 'OPERATION_CONFLICT')
    saved = attempt['payload']
    if saved['state'] == 'succeeded':
        require(saved['resultRevision'] == revision, 409, '账号状态已改变。', 'BINDING_CHANGED')
        return {'ok': True, 'data': current(cur, scope, vault, owner)}
    require(saved['state'] == 'dispatching' and saved['bindingRevision'] == revision, 409, '登录状态已改变。', 'BINDING_CHANGED')
    if action == 'session.finish':
        lease = private_store.get(cur, scope, COLLECTION, 'login-lease')
        require(lease is not None and lease['payload']['operationId'] == operation_id,
                409, '登录请求已过期，请核对登录状态。', 'RESULT_UNCERTAIN')
        token, userid = payload.get('token'), payload.get('userid')
        require(isinstance(token, str) and 1 <= len(token) <= 32768 and isinstance(userid, str) and userid.isdecimal(),
                400, '美森登录返回格式不正确。', 'UPSTREAM_SCHEMA_CHANGED')
        try:
            expires = datetime.fromisoformat(payload['expiresAt'])
            require(expires.tzinfo is not None, 400, '美森会话有效期不正确。', 'UPSTREAM_SCHEMA_CHANGED')
        except (KeyError, TypeError, ValueError):
            require(False, 400, '美森会话有效期不正确。', 'UPSTREAM_SCHEMA_CHANGED')
        require(now < expires <= now + timedelta(days=32), 400, '美森会话有效期不正确。', 'UPSTREAM_SCHEMA_CHANGED')
        credential_id = uuid.uuid4().hex
        key, nonce, ciphertext = vault.encrypt(provider='mison', plugin_id=scope['plugin_id'], child_id=scope['child_id'], credential_id=credential_id, token=token)
        cur.execute("UPDATE lele.plugin_credentials SET state='revoked',updated_at=now() WHERE child_id=%s AND plugin_id=%s AND state='active'", (scope['child_id'], scope['plugin_id']))
        cur.execute('''INSERT INTO lele.plugin_credentials(id,child_id,plugin_id,provider,key_id,nonce,ciphertext,expires_at,masked_account,state)
VALUES(%s,%s,%s,'mison',%s,%s,%s,%s,%s,'active')''',
                    (credential_id, scope['child_id'], scope['plugin_id'], key, nonce, ciphertext, expires, payload['maskedAccount']))
        private_store.put(cur, scope, COLLECTION, 'current', {'credentialId': credential_id, 'userid': userid,
                          'maskedAccount': payload['maskedAccount'], 'connectedAt': now.isoformat(), 'bindingRevision': revision + 1}, expected_revision=binding['revision'] if binding else 0)
        saved.update(state='succeeded', resultRevision=revision + 1)
    else:
        require(action == 'session.fail', 400, '登录动作不正确。')
        saved.update(state='uncertain' if payload.get('uncertain') else 'failed',
                     code=payload.get('code', 'UPSTREAM_REJECTED'), message=payload.get('message', '登录未完成。')[:200])
    private_store.put(cur, scope, 'login-attempt', operation_id, saved, expected_revision=attempt['revision'], expires_at=now + timedelta(days=7))
    lease = private_store.get(cur, scope, COLLECTION, 'login-lease')
    if lease and lease['payload']['operationId'] == operation_id:
        private_store.delete(cur, scope, COLLECTION, 'login-lease', expected_revision=lease['revision'])
    return {'ok': True, 'data': current(cur, scope, vault, owner)}

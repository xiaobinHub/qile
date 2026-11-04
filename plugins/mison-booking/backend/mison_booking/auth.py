"""Password login against the documented Mison endpoint. No automatic login/retry."""
import base64
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from lele_plugin_sdk.bridge import BridgeClient, BridgeError

class AuthError(Exception):
    def __init__(self, code, message, operation_id=None):
        super().__init__(message)
        self.code, self.operation_id = code, operation_id

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def bridge(context, action, payload):
    try:
        return BridgeClient().call(context, action, payload)
    except BridgeError as error:
        raise AuthError({'plugin_revision_conflict': 'REVISION_CONFLICT'}.get(error.code, error.code), str(error)) from None
    except (OSError, ValueError, RuntimeError):
        raise AuthError('UPSTREAM_UNAVAILABLE', '登录服务暂时不可用，请稍后重试。') from None

def session(context):
    return bridge(context, 'session.get', {})

def public_connection(value):
    return {key: value.get(key) for key in ('status', 'bindingRevision', 'maskedAccount', 'contract', 'canManageConnection', 'lastCheckedAt')}

def upstream_login(username, password):
    request = urllib.request.Request('https://api.mison.cn/v2/member/login',
                data=json.dumps({'username': username, 'password': password}).encode(),
                headers={'Content-Type': 'application/json', 'Accept': 'application/json'}, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise AuthError('UPSTREAM_SCHEMA_CHANGED', '美森登录响应格式不正确。')
            value = json.loads(raw)
    except urllib.error.HTTPError as error:
        if error.code in (400, 401, 403):
            raise AuthError('UPSTREAM_REJECTED', '美森登录校验失败，请检查账号和密码。') from None
        raise AuthError('RESULT_UNCERTAIN', '美森登录响应异常，请稍后核对账号连接状态。') from None
    except (OSError, ValueError):
        raise AuthError('RESULT_UNCERTAIN', '美森登录未返回完整结果，请稍后核对连接状态。') from None
    if not isinstance(value, dict):
        raise AuthError('UPSTREAM_SCHEMA_CHANGED', '美森登录响应格式不正确。')
    if value.get('status') != 0:
        message = str(value.get('msg') or '登录失败，请检查账号和密码。')
        message = re.sub(r'<[^>]*>', '', message).replace(password, '***').replace(username, '***')[:160]
        raise AuthError('UPSTREAM_REJECTED', message)
    data = value.get('data')
    if not isinstance(data, dict) or data.get('status') != 200 or not isinstance(data.get('token'), str) or not str(data.get('userid', '')).isdecimal():
        raise AuthError('UPSTREAM_SCHEMA_CHANGED', '美森未返回有效会话，请稍后重试。')
    token = data['token']
    try:
        segment = token.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(segment + '=' * (-len(segment) % 4)))
        expires = datetime.fromtimestamp(int(claims['exp']), timezone.utc)
        now = datetime.now(timezone.utc)
        if not now < expires <= now + timedelta(days=32):
            raise ValueError()
    except (ValueError, KeyError, IndexError, TypeError, OverflowError):
        raise AuthError('UPSTREAM_SCHEMA_CHANGED', '美森会话有效期不正确，请稍后重新登录。') from None
    return {'token': token, 'userid': str(data['userid']), 'expiresAt': expires.isoformat(),
            'maskedAccount': username[:3] + '****' + username[-4:] if len(username) >= 7 else username[:1] + '***'}

def login(context, body):
    if set(body) != {'operationId', 'bindingRevision', 'username', 'password'}:
        raise AuthError('VALIDATION_ERROR', '登录参数不正确。')
    username, password = body.get('username'), body.get('password')
    if not isinstance(username, str) or not username.strip() or len(username) > 128 or not isinstance(password, str) or not 1 <= len(password) <= 256:
        raise AuthError('VALIDATION_ERROR', '请输入美森账号和密码。')
    payload = {**body, 'username': username.strip()}
    begin = bridge(context, 'session.begin', payload)
    if not begin['mayExecute']:
        return public_connection(begin['session'])
    try:
        result = upstream_login(payload['username'], password)
    except AuthError as error:
        try:
            bridge(context, 'session.fail', {'operationId': body['operationId'], 'code': error.code,
                                           'message': str(error), 'uncertain': error.code != 'UPSTREAM_REJECTED'})
        except AuthError:
            pass
        raise AuthError(error.code, str(error), body['operationId'] if error.code != 'UPSTREAM_REJECTED' else None) from None
    try:
        return public_connection(bridge(context, 'session.finish', {**result, 'operationId': body['operationId']}))
    except AuthError:
        raise AuthError('RESULT_UNCERTAIN', '美森已校验成功，保存连接状态未确认。请刷新页面核对，不要重复登录。', body['operationId']) from None

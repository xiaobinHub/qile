"""Authenticated plugin routing and signed invocation contexts.

No worker RPC runs inside a database transaction. Every accepted result returns
through fresh authentication, eligibility and fencing checks in one transaction.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from urllib.parse import urlsplit, parse_qs

from lele_growth.child_service import ApiError, require, digest
from .policy import active_context, assert_fences, catalog_row
from .supervisor import RuntimeClient

CLAIMS = ('pluginId', 'childId', 'releaseId', 'generation', 'configRevision', 'releaseEpoch', 'policyRevision')


class ContextSigner:
    """Self-contained HMAC authority; independent of browser cookies and DB secrets."""
    def __init__(self, secret=None, *, clock=time.time):
        self.secret = secret or secrets.token_bytes(32)
        require(isinstance(self.secret, bytes) and len(self.secret) >= 32, 503)
        self.clock = clock

    def issue(self, context, *, actor=None, job_id=None, capabilities=None, ttl=60):
        require(1 <= ttl <= 3600, 400)
        allowed = list(context.get('capabilities', []))
        capabilities = allowed if capabilities is None else list(capabilities)
        require(set(capabilities) <= set(allowed), 403, '应用能力越界。', 'plugin_capability_denied')
        claims = {key: context[key] for key in CLAIMS}
        claims.update(actorId=actor, jobId=job_id, capabilities=capabilities, version=context['version'],
                      configSha256=hashlib.sha256(json.dumps(context.get('config', {}), sort_keys=True, allow_nan=False).encode()).hexdigest(),
                      expiresAt=int(self.clock()) + ttl, nonce=secrets.token_hex(16))
        encoded = base64.urlsafe_b64encode(json.dumps(claims, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).rstrip(b'=')
        signature = hmac.new(self.secret, encoded, hashlib.sha256).hexdigest()
        return {**claims, 'config': json.loads(json.dumps(context.get('config', {}))),
                'scopeToken': encoded.decode() + '.' + signature}

    def verify(self, context, *, capability=None, plugin_id=None, child_id=None):
        try:
            token = context['scopeToken']
            require(isinstance(token, str) and len(token) <= 16384, 403)
            encoded, signature = token.split('.')
            require(hmac.compare_digest(hmac.new(self.secret, encoded.encode(), hashlib.sha256).hexdigest(), signature), 403)
            claims = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
            require(type(claims['expiresAt']) is int and self.clock() < claims['expiresAt'], 403)
            require(all(context.get(key) == value for key, value in claims.items()), 403)
            require(hashlib.sha256(json.dumps(context['config'], sort_keys=True, allow_nan=False).encode()).hexdigest() == claims['configSha256'], 403)
            require(plugin_id is None or plugin_id == claims['pluginId'], 403)
            require(child_id is None or child_id == claims['childId'], 403)
            require(capability is None or capability in claims['capabilities'], 403,
                    '应用未获此能力授权。', 'plugin_capability_denied')
            return claims
        except (KeyError, ValueError, TypeError, UnicodeError):
            raise ApiError(403, '应用上下文校验失败。', 'plugin_context_invalid') from None
        except ApiError as error:
            if error.kind:
                raise
            raise ApiError(403, '应用上下文已失效。', 'plugin_context_invalid') from None


class PluginGateway:
    def __init__(self, service, *, runtime=None, signer=None):
        self.service = service
        self.runtime = runtime or RuntimeClient()
        self.signer = signer or ContextSigner()

    def _authenticate(self, cur, plugin_id, child_id, token, csrf, origin, surface, write):
        require(surface == 'parent', 403, '管理员不能访问孩子业务数据。')
        user = self.service.authenticate(cur, token, surface)
        require(not user[5] and user[4] == 'active', 403, '请先修改初始密码。', 'password_change_required')
        if write:
            require(self.service.origin_trusted(origin, surface), 403, '请求来源不受信任。')
            require(isinstance(csrf, str) and hmac.compare_digest(digest(csrf), user[7]), 403, '请求校验失败，请刷新页面。')
        # Catalog must be locked before child rows (the core policy lock order).
        catalog_row(cur, plugin_id)
        self.service.access(cur, user, child_id, write=write)
        context = active_context(cur, plugin_id, child_id)
        return context, user

    def issue_job_context(self, current, job_id, *, ttl=360):
        return self.signer.issue(current, job_id=job_id, ttl=ttl)

    def final_context(self, cur, supplied, *, capability=None):
        claims = self.signer.verify(supplied, capability=capability)
        catalog_row(cur, claims['pluginId'])
        self.service.lock_child(cur, claims['childId'])
        current = active_context(cur, claims['pluginId'], claims['childId'])
        assert_fences(current, claims)
        return current

    def apply_effects(self, cur, supplied, result, *, effect_key):
        from . import state_store
        current = self.final_context(cur, supplied)
        effects = result.get('effects', [])
        require(isinstance(effects, list) and len(effects) <= 100, 502, '应用效果格式不正确。', 'plugin_invalid_effects')
        if effects:
            self.signer.verify(supplied, capability='plugin.state.write')
        # One durable batch key prevents a changed/reordered retry from adding
        # effects to an already successful business occurrence.
        key = hashlib.sha256(effect_key.encode()).hexdigest()
        return state_store.apply_effects(cur, current, effects, effect_key=key)

    def route(self, method, path, body, token, csrf, origin, surface, release_id):
        url = urlsplit(path)
        match = re.fullmatch(r'(?:api/)?children/([^/]+)/plugins/([^/]+)/runtime(?:/(.*))?', url.path.lstrip('/'))
        if not match:
            return NotImplemented
        require(isinstance(body, dict), 400)
        child_id, plugin_id, endpoint = match.groups()
        endpoint = endpoint or ''
        require(method in ('GET', 'POST', 'PUT', 'DELETE'), 405)
        write = method != 'GET'
        def initial(cur):
            current, user = self._authenticate(cur, plugin_id, child_id, token, csrf, origin, surface, write)
            require(isinstance(release_id, str) and release_id == current['releaseId'], 409,
                    '应用版本已改变，请重新进入。', 'plugin_version_changed')
            declared = (current['manifest'].get('backend') or {}).get('requestTimeoutSeconds', 10)
            context = self.signer.issue(current, actor=user[0], ttl=min(120, declared + 30))
            record_route = re.fullmatch(r'records/([A-Za-z0-9_-]{1,64})(?:/([^/]{1,128}))?', endpoint)
            if record_route:
                from . import state_store
                collection, record_id = record_route.groups()
                if method == 'GET':
                    self.signer.verify(context, capability='plugin.state.read')
                    query = {**body, **{key: values[0] for key, values in parse_qs(url.query, keep_blank_values=True).items()}}
                    require(set(query) <= {'limit', 'after', 'cursor'}, 400, '分页参数不正确。')
                    limit = query.get('limit', '100')
                    require(type(limit) is int or isinstance(limit, str) and limit.isdecimal(), 400)
                    require(1 <= int(limit) <= 200, 400)
                    after = query.get('after', query.get('cursor'))
                    require(after is None or isinstance(after, str) and 1 <= len(after) <= 512, 400)
                    require('after' not in query or 'cursor' not in query or query['after'] == query['cursor'], 400)
                    if record_id is not None:
                        return ('done', {'record': state_store.get_record(cur, current, collection, record_id)})
                    return ('done', state_store.list_records(cur, current, collection, limit=int(limit), after=after))
                require(method == 'PUT' and record_id is not None and set(body) <= {'payload', 'operationId', 'expectedRevision'} and {'payload', 'operationId'} <= set(body), 400)
                self.signer.verify(context, capability='plugin.state.write')
                operation_id = body['operationId']
                require(isinstance(operation_id, str) and 8 <= len(operation_id) <= 128, 400, '写入需要 operationId。')
                return ('done', state_store.put_record(cur, current, collection, record_id, body['payload'],
                              expected_revision=body.get('expectedRevision'), operation_id=operation_id, actor_id=user[0]))
            require(bool(current['manifest'].get('backend')), 404, '应用接口不存在。')
            return ('call', (context, declared))
        kind, value = self.service.transaction(initial)
        if kind == 'done':
            return value
        value, declared = value
        result = self.runtime.call(value, 'handle_request', {'path': endpoint, 'method': method, 'body': body}, timeout=declared)
        def finish(cur):
            current, _ = self._authenticate(cur, plugin_id, child_id, token, csrf, origin, surface, write)
            assert_fences(current, self.signer.verify(value))
            require(write or not result.get('effects'), 502, '读取请求不能产生业务效果。', 'plugin_invalid_effects')
            if result.get('effects'):
                operation_id = body.get('operationId')
                require(isinstance(operation_id, str) and 8 <= len(operation_id) <= 128, 400, '写入需要 operationId。')
                self.apply_effects(cur, value, result, effect_key='request:' + str(value['actorId']) + ':' + operation_id)
            return {key: item for key, item in result.items() if key != 'effects'}
        return self.service.transaction(finish)

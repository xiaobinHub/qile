"""Unix bridge for private plugin records, credentials and operations."""
from __future__ import annotations

from datetime import datetime, timezone

from lele_growth.child_service import require
from . import private_store
from .policy import active_context, assert_fences, row_dict


class PluginBridge:
    def __init__(self, service, vault):
        self.service = service
        self.vault = vault

    @staticmethod
    def _vault_available(vault):
        require(vault is not None, 503, '插件凭据能力尚未配置。', 'plugin_vault_unavailable')
        return vault

    def handle(self, context, action, payload):
        require(isinstance(payload, dict), 400, '插件Bridge请求不正确。', 'plugin_invalid_bridge_request')
        plugin_id = context.get('pluginId')
        child_id = context.get('childId')
        actor_id = context.get('actorId')
        require(isinstance(plugin_id, str) and isinstance(child_id, str) and isinstance(actor_id, str),
                403, '插件上下文不正确。', 'plugin_context_invalid')

        def work(cur):
            current = active_context(cur, plugin_id, child_id)
            assert_fences(current, context)
            require(action in ('actor.info', 'private.get', 'private.put', 'private.delete',
                               'credential.get', 'session.get', 'session.begin', 'session.finish', 'session.fail', 'session.disconnect', 'session.invalidate', 'operation.begin', 'operation.mark-dispatch',
                               'operation.stage', 'operation.finish', 'operation.get', 'operation.list', 'resource.issue'),
                    400, '插件Bridge动作不存在。', 'plugin_bridge_action_unavailable')
            if action == 'actor.info':
                cur.execute('SELECT owner_id FROM lele.children WHERE id=%s', (child_id,))
                return {'ok': True, 'data': {'role': 'owner' if row_dict(cur)['owner_id'] == actor_id else 'member'}}
            if action == 'resource.issue':
                from .resources import issue
                return {'ok': True, 'data': issue(cur, current, context, payload)}
            if action.startswith('session.'):
                self._capability(current, 'plugin.credentials')
                self._capability(current, 'plugin.private-state')
                from . import login_sessions
                return login_sessions.handle(cur, current, context, action, payload, self.vault)
            if action == 'private.get':
                self._capability(current, 'plugin.private-state')
                include_expired = payload.get('includeExpired', False)
                require(type(include_expired) is bool, 400, 'includeExpired必须为布尔值。', 'VALIDATION_ERROR')
                return {'ok': True, 'data': {'record': private_store.get(cur, current, payload.get('collection'),
                                                                       payload.get('recordId'), include_expired=include_expired)}}
            if action == 'private.put':
                self._capability(current, 'plugin.private-state')
                expires_at = None
                if payload.get('expiresAt') is not None:
                    try: expires_at = datetime.fromisoformat(payload['expiresAt'])
                    except (TypeError, ValueError): require(False, 400, '私有记录有效期不正确。', 'VALIDATION_ERROR')
                    require(expires_at.tzinfo is not None and expires_at > datetime.now(timezone.utc), 400, '私有记录已过期。', 'DRAFT_EXPIRED')
                return {'ok': True, 'data': {'record': private_store.put(cur, current, payload.get('collection'), payload.get('recordId'),
                                                                                payload.get('payload'), expected_revision=payload.get('expectedRevision'), expires_at=expires_at)}}
            if action == 'private.delete':
                self._capability(current, 'plugin.private-state')
                return {'ok': True, 'data': private_store.delete(cur, current, payload.get('collection'), payload.get('recordId'),
                                                                 expected_revision=payload.get('expectedRevision', 0))}
            if action == 'credential.get':
                self._capability(current, 'plugin.credentials')
                from . import credential_vault
                return {'ok': True, 'data': {'token': credential_vault.token(cur, current, payload.get('credentialId'), self._vault_available(self.vault))}}
            return self._operation(cur, current, context, action, payload)
        return self.service.transaction(work)

    @staticmethod
    def _capability(current, capability):
        require(capability in current['capabilities'], 403, '插件未获此能力。', 'plugin_capability_denied')

    def _operation(self, cur, current, context, action, payload):
        self._capability(current, 'plugin.external-operations')
        from . import external_operations
        return external_operations.handle(cur, current, context, action, payload)

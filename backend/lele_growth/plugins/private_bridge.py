"""Unix bridge for private plugin records, credentials and operations."""
from __future__ import annotations

from datetime import datetime, timezone
import uuid

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
        job = actor_id is None and isinstance(context.get('jobId'), str)
        require(isinstance(plugin_id, str) and isinstance(child_id, str) and (isinstance(actor_id, str) or job),
                403, '插件上下文不正确。', 'plugin_context_invalid')

        def work(cur):
            current = active_context(cur, plugin_id, child_id)
            assert_fences(current, context)
            if job:
                self._job_access(cur, current, context, action)
            require(action in ('actor.info', 'private.get', 'private.put', 'private.delete',
                               'credential.get', 'session.get', 'session.begin', 'session.finish', 'session.fail', 'session.disconnect', 'session.invalidate', 'operation.begin', 'operation.mark-dispatch',
                               'operation.stage', 'operation.finish', 'operation.get', 'operation.list', 'resource.issue',
                               'courseSync.get', 'courseSync.check', 'courseSync.preview', 'courseSync.save', 'courseSync.run', 'courseSync.purge'),
                    400, '插件Bridge动作不存在。', 'plugin_bridge_action_unavailable')
            if action == 'actor.info':
                cur.execute('SELECT owner_id FROM lele.children WHERE id=%s', (child_id,))
                return {'ok': True, 'data': {'role': 'owner' if row_dict(cur)['owner_id'] == actor_id else 'member'}}
            if action == 'resource.issue':
                from .resources import issue
                return {'ok': True, 'data': issue(cur, current, context, payload)}
            if action.startswith('courseSync.'):
                require(plugin_id == 'mison-booking', 403, '此插件不能同步课程。', 'plugin_capability_denied')
                self._capability(current, 'plugin.private-state')
                self._capability(current, 'plugin.credentials')
                if not job:
                    cur.execute("SELECT 1 FROM lele.memberships m JOIN lele.users u ON u.id=m.user_id WHERE m.child_id=%s AND m.user_id=%s AND u.status='active'", (child_id, actor_id))
                    require(cur.fetchone() is not None, 403, '当前用户无权同步该儿童的课程。', 'OWNER_REQUIRED')
                from lele_growth.course_sync_host import handle as sync_courses
                return sync_courses(self.service, cur, current, context, action, payload)
            if action.startswith('session.'):
                self._capability(current, 'plugin.credentials')
                self._capability(current, 'plugin.private-state')
                from . import login_sessions
                before = private_store.get(cur, current, 'login-session', 'current') if action in ('session.disconnect', 'session.finish') and plugin_id == 'mison-booking' else None
                result = login_sessions.handle(cur, current, context, action, payload, self.vault)
                if plugin_id == 'mison-booking' and action == 'session.disconnect':
                    from lele_growth.course_sync_host import purge_saved
                    purge_saved(self.service, cur, child_id, actor_id)
                elif plugin_id == 'mison-booking' and action == 'session.finish':
                    after = private_store.get(cur, current, 'login-session', 'current')
                    old_account = (before or {}).get('payload', {}).get('userid') if before else None
                    new_account = (after or {}).get('payload', {}).get('userid') if after else None
                    if old_account and old_account != new_account:
                        from lele_growth.course_sync_host import purge_saved
                        purge_saved(self.service, cur, child_id, actor_id, old_account)
                return result
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
    def _job_access(cur, current, context, action):
        # Runtime signature and active invocation admission are checked before
        # this bridge. Recheck the live DB lease/attempt in the write transaction.
        require(current['plugin_id'] == 'mison-booking' and action in (
            'session.get', 'session.invalidate', 'courseSync.get', 'courseSync.run')
            and {'plugin.jobs.schedule', 'plugin.credentials', 'plugin.private-state'} <= set(context.get('capabilities', [])),
            403, '后台任务不能执行此动作。', 'plugin_capability_denied')
        try:
            job_id = str(uuid.UUID(context['jobId']))
        except (ValueError, TypeError, AttributeError):
            require(False, 403, '后台任务身份不正确。', 'plugin_job_revoked')
        attempt = context.get('jobAttempt')
        require(type(attempt) is int and attempt > 0, 403, '后台任务身份不正确。', 'plugin_job_revoked')
        cur.execute("""SELECT 1 FROM lele.plugin_jobs WHERE id=%s AND plugin_id=%s AND child_id=%s
AND task_id='sync-courses' AND status='running' AND NOT cancel_requested AND lease_until>now()
AND attempt=%s AND generation=%s AND config_revision=%s AND release_epoch=%s AND release_id=%s FOR SHARE""",
            (job_id, current['plugin_id'], current['child_id'], attempt, current['generation'],
             current['configRevision'], current['releaseEpoch'], current['releaseId']))
        require(cur.fetchone() is not None, 409, '后台任务租约或运行资格已失效。', 'plugin_job_revoked')

    @staticmethod
    def _capability(current, capability):
        require(capability in current['capabilities'], 403, '插件未获此能力。', 'plugin_capability_denied')

    def _operation(self, cur, current, context, action, payload):
        self._capability(current, 'plugin.external-operations')
        from . import external_operations
        result = external_operations.handle(cur, current, context, action, payload)
        operation = result.get('data', {}).get('operation', {})
        if (current['plugin_id'] == 'mison-booking' and action == 'operation.finish'
                and operation.get('kind') == 'cancel' and operation.get('state') == 'succeeded'):
            details = operation.get('canonicalRequest', {}).get('details', {})
            if isinstance(details.get('courseSync'), dict):
                from lele_growth.course_sync_host import confirmed_cancel
                confirmed_cancel(self.service, cur, current, context, details['courseSync'])
        return result

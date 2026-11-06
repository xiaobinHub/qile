"""Mison sync through the real bridge and an owned disposable PostgreSQL DB."""
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import copy
import json
from pathlib import Path
import secrets
import sys
import tempfile
from unittest.mock import patch
import uuid

from lele_growth.child_service import ApiError
from lele_growth.plugins.catalog import register_release
from lele_growth.plugins.credential_vault import CredentialVault
from lele_growth.plugins.gateway import ContextSigner, PluginGateway
from lele_growth.plugins.policy import active_context
from lele_growth.plugins.private_bridge import PluginBridge
from tests.backend.test_plugin_lifecycle import PluginDatabaseCase
from tests.backend.test_mison_course_sync import FakeClient

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'plugins/mison-booking/backend'), str(ROOT / 'packages/plugin-sdk-python/src')]
from lele_plugin_sdk.bridge import BridgeError
from mison_booking import auth, course_sync, handle_job, read_store
from mison_booking.upstream import Client


class MisonSyncIntegrationTests(PluginDatabaseCase):
    def setUp(self):
        super().setUp()
        self.plugin_id = 'mison-booking'
        manifest = json.loads((ROOT / 'plugins/mison-booking/plugin.json').read_text())
        self.service.transaction(lambda cur: register_release(cur, manifest, artifact_sha256='b' * 64,
            source_commit='sync-integration', config_schema={'type': 'object', 'properties': {}}, activate=True), exclusive=True)
        self.publish()
        self.install()
        self.signer = ContextSigner()
        self.gateway = PluginGateway(self.service, signer=self.signer)
        self.scope = self.service.transaction(lambda cur: active_context(cur, self.plugin_id, self.a['id']))
        self.context = self.signer.issue(self.scope, actor='owner')
        folder = tempfile.TemporaryDirectory(prefix='mison-sync-integration-')
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        key = self.folder / 'vault.key'
        key.write_text('test-v1:' + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())
        key.chmod(0o600)
        self.bridge = PluginBridge(self.service, CredentialVault(key))
        self.login()
        read_store.memo.values.clear()
        read_store.memo.size = 0
        self.upstream = FakeClient()
        self.upstream.pages['cancelled'] = []
        self.upstream.pages['upcoming'] = [{'cid': 11, 'teachername': 'Fixture', 'datestart': '2026-11-12 19:00',
                                            'dateend': '19:25', 'course_name': 'Upcoming'}]
        self.upstream.pages['completed'] = [{'cid': 12, 'teachername': 'Fixture', 'datestart': '2026-11-02 19:00',
                                            'dateend': '19:25', 'course_name': 'Completed'}]

    def invoke(self, action, payload=None, context=None):
        return self.bridge.handle(context or self.context, action, payload or {})['data']

    def login(self, userid='987654'):
        revision = self.invoke('session.get')['bindingRevision']
        operation = str(uuid.uuid4())
        self.invoke('session.begin', {'operationId': operation, 'bindingRevision': revision,
                                     'username': 'fixture-user', 'password': 'fixture'})
        return self.invoke('session.finish', {'operationId': operation, 'token': 'fixture', 'userid': userid,
            'maskedAccount': 'fixture***', 'expiresAt': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()})

    def request(self, **overrides):
        settings = self.invoke('courseSync.get')
        return {'operationId': str(uuid.uuid4()), 'expectedRevision': settings['revision'],
                'bindingRevision': self.invoke('session.get')['bindingRevision'], 'enabled': True,
                'points': 10, 'startDate': '2026-11-01', **overrides}

    def record(self):
        return self.service.transaction(lambda cur: self.service.store.read(cur, self.a['id']))

    @contextmanager
    def adapters(self, bridge_call=None):
        def bridge(context, action, payload):
            try:
                return (bridge_call(context, action, payload) if bridge_call else
                        self.bridge.handle(context, action, payload))['data']
            except ApiError as error:
                raise BridgeError(error.kind, error.error) from None
        def upstream(client, endpoint, body, writing):
            self.assertFalse(writing, 'Sync must never write to Mison')
            return self.upstream.call(endpoint, body)
        with patch.object(auth.BridgeClient, 'call', side_effect=bridge), patch.object(Client, '_request', upstream):
            yield

    def save(self, body=None):
        with self.adapters():
            return course_sync.save(self.context, body or self.request())

    def test_run_uses_saved_settings_and_completes_new_lessons_once(self):
        self.save()
        self.upstream.pages['completed'].append({'cid': 13, 'teachername': 'Fixture', 'datestart': '2026-11-03 20:00',
                                                 'dateend': '20:25', 'course_name': 'New completed'})
        with self.adapters():
            first = course_sync.run_now(self.context, {'operationId': str(uuid.uuid4())})
            second = course_sync.run_now(self.context, {'operationId': str(uuid.uuid4())})
        self.assertEqual(first['state'], 'synced')
        self.assertEqual(first['points'], 10)
        self.assertEqual(second['points'], 0)
        self.assertEqual(sum(row['amount'] for row in self.record()['data']['ledger']), 20)

    def test_collection_cannot_commit_after_disconnect_relogin_or_account_change(self):
        for change in ('disconnect', 'same-account', 'different-account', 'expired', 'credential-revision'):
            with self.subTest(change=change):
                self.login()
                body = self.request()
                before = self.record()
                def collect_then_change(client):
                    lessons, contract = original(client)
                    if change == 'expired':
                        self.service.transaction(lambda cur: cur.execute(
                            "UPDATE lele.plugin_credentials SET expires_at=now()-interval '1 second' WHERE child_id=%s AND plugin_id=%s",
                            (self.a['id'], self.plugin_id)))
                    elif change == 'credential-revision':
                        self.service.transaction(lambda cur: cur.execute(
                            "UPDATE lele.plugin_credentials SET revision=revision+1 WHERE child_id=%s AND plugin_id=%s",
                            (self.a['id'], self.plugin_id)))
                    elif change == 'disconnect':
                        self.invoke('session.disconnect', {'operationId': str(uuid.uuid4()),
                                                          'bindingRevision': client.session['bindingRevision']})
                    else:
                        self.login('123456' if change == 'different-account' else '987654')
                    return lessons, contract
                original = course_sync.collect_lessons
                with self.adapters(), patch.object(course_sync, 'collect_lessons', side_effect=collect_then_change):
                    with self.assertRaises(auth.AuthError) as caught:
                        course_sync.save(self.context, body)
                self.assertIn(caught.exception.code, ('BINDING_CHANGED', 'RECONNECT_REQUIRED'))
                self.assertEqual(self.record(), before)
                self.assertFalse(self.invoke('courseSync.get')['enabled'])

    def test_original_retry_does_not_override_a_newer_setting_or_repeat_upstream_reads(self):
        original = self.request()
        result = self.save(original)
        newer = self.request(startDate='2026-11-03')
        self.assertEqual(self.save(newer)['clawback'], 10)
        before = self.record()
        with self.adapters(), patch.object(course_sync, 'collect_lessons', side_effect=AssertionError('Replay collected upstream')):
            replay = course_sync.save(self.context, original)
        self.assertEqual(replay, result)
        self.assertEqual(self.record(), before)
        self.assertEqual(self.invoke('courseSync.get')['startDate'], '2026-11-03')
        with self.adapters(), self.assertRaises(auth.AuthError) as caught:
            course_sync.save(self.context, {**original, 'points': 20})
        self.assertEqual(caught.exception.code, 'OPERATION_CONFLICT')

    def test_stale_new_save_rejected_and_disable_allowed_after_credential_expiry(self):
        first, stale = self.request(), self.request(points=20)
        self.save(first)
        before = self.record()
        with self.adapters(), self.assertRaises(auth.AuthError) as caught:
            course_sync.save(self.context, stale)
        self.assertEqual(caught.exception.code, 'REVISION_CONFLICT')
        self.assertEqual(self.record(), before)
        self.service.transaction(lambda cur: cur.execute(
            "UPDATE lele.plugin_credentials SET expires_at=now()-interval '1 second' WHERE child_id=%s AND plugin_id=%s",
            (self.a['id'], self.plugin_id)))
        disabled = self.save(self.request(enabled=False))
        self.assertEqual(disabled['state'], 'disabled')
        self.assertEqual(disabled['removed'], 1)
        self.assertEqual(sum(row['amount'] for row in self.record()['data']['ledger']), 10)

    def test_settings_changed_during_run_cannot_apply_an_old_snapshot(self):
        self.save()
        original = course_sync.collect_lessons
        def collect_then_disable(client):
            lessons, contract = original(client)
            self.save(self.request(enabled=False))
            return lessons, contract
        with self.adapters(), patch.object(course_sync, 'collect_lessons', side_effect=collect_then_disable):
            result = course_sync.run_now(self.context, {'operationId': str(uuid.uuid4())})
        self.assertIn(result['state'], ('disabled', 'paused'))
        self.assertFalse(self.invoke('courseSync.get')['enabled'])
        self.assertEqual(len(self.record()['data']['series']), 1)

    def test_duplicate_commits_are_atomic_and_failed_receipt_rolls_back_business_data(self):
        body = self.request()
        with self.adapters():
            payload = {**course_sync._sync_payload(self.context, body, enabled=True), 'request': body}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.invoke('courseSync.save', copy.deepcopy(payload)), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(len(self.record()['data']['ledger']), 1)
        before = self.record()
        settings = self.invoke('courseSync.get')
        from lele_growth.plugins import private_store
        original_put = private_store.put
        def fail_receipt(cur, scope, collection, record_id, *args, **kwargs):
            if collection == 'course-sync-receipts':
                raise ApiError(503, 'Injected receipt failure', 'review_failure')
            return original_put(cur, scope, collection, record_id, *args, **kwargs)
        with patch.object(private_store, 'put', side_effect=fail_receipt), self.assertRaises(ApiError):
            self.invoke('courseSync.save', {'request': self.request(enabled=False)})
        self.assertEqual(self.record(), before)
        self.assertEqual(self.invoke('courseSync.get'), settings)

    def test_scheduler_to_admitted_bridge_completes_sync_without_user_actor(self):
        self.save()
        self.upstream.pages['completed'].append({'cid': 14, 'teachername': 'Fixture', 'datestart': '2026-11-04 20:00',
                                                 'dateend': '20:25', 'course_name': 'Scheduled'})
        from deploy.plugin_runtime import PluginRuntimeService
        from lele_growth.plugins.dev_mode import DevRegistry
        runtime = PluginRuntimeService(self.service, self.folder / 'runtime')
        runtime.bridge = self.bridge
        runtime.development = DevRegistry(self.service.config, root=self.folder / 'dev-registry')
        self.addCleanup(runtime.close)
        def execute(context, action, payload, **kwargs):
            self.assertIsNone(context.get('actorId'))
            self.assertEqual(action, 'handle_job')
            return handle_job(context, payload['task'], payload.get('payload', {}))
        job_id = runtime.scheduler.enqueue(self.plugin_id, self.a['id'], 'sync-courses', 'integration-sync', datetime.now(timezone.utc))
        with self.adapters(runtime.handle_bridge), patch.object(runtime.supervisor, '_call', side_effect=execute):
            self.assertTrue(runtime.scheduler.run_one(self.plugin_id))
        row = self.service.transaction(lambda cur: cur.execute('SELECT status,result FROM lele.plugin_jobs WHERE id=%s', (job_id,)).fetchone())
        self.assertEqual(row[0], 'succeeded', row)
        self.assertEqual(row[1]['points'], 10)

    def test_background_identity_cannot_manage_accounts_settings_or_private_records(self):
        job_id = self.service.transaction(lambda cur: cur.execute(
            "INSERT INTO lele.plugin_jobs(id,plugin_id,child_id,task_id,occurrence_key,due_at,payload,generation,config_revision,release_epoch,release_id,status,lease_until,attempt) VALUES(%s,%s,%s,'sync-courses','identity-check',now(),'{}',%s,%s,%s,%s,'running',now()+interval '60 seconds',1) RETURNING id",
            (str(uuid.uuid4()), self.plugin_id, self.a['id'], self.scope['generation'], self.scope['configRevision'], self.scope['releaseEpoch'], self.scope['releaseId'])).fetchone()[0])
        job = self.gateway.issue_job_context(self.scope, job_id, attempt=1)
        self.assertTrue(self.invoke('session.get', context=job)['status'] == 'connected')
        wrong_attempt = self.gateway.issue_job_context(self.scope, job_id, attempt=2)
        with self.assertRaises(ApiError):
            self.invoke('courseSync.get', context=wrong_attempt)
        limited = self.signer.issue(self.scope, job_id=job_id, job_attempt=1, capabilities=['plugin.jobs.schedule'])
        with self.assertRaises(ApiError):
            self.invoke('session.get', context=limited)
        for action in ('session.begin', 'session.finish', 'session.disconnect', 'courseSync.save', 'private.put', 'credential.get'):
            with self.subTest(action=action), self.assertRaises(ApiError):
                self.invoke(action, context=job)
        session = self.invoke('session.get', context=job)
        invalidated = self.invoke('session.invalidate', {'credentialId': session['credentialId'],
            'bindingRevision': session['bindingRevision']}, context=job)
        self.assertEqual(invalidated['status'], 'reconnect_required')
        self.service.transaction(lambda cur: cur.execute("UPDATE lele.plugin_jobs SET cancel_requested=true WHERE id=%s", (job_id,)))
        with self.assertRaises(ApiError):
            self.invoke('session.get', context=job)
        self.service.transaction(lambda cur: cur.execute("UPDATE lele.plugin_jobs SET cancel_requested=false,lease_until=now()-interval '1 second' WHERE id=%s", (job_id,)))
        with self.assertRaises(ApiError):
            self.invoke('courseSync.get', context=job)

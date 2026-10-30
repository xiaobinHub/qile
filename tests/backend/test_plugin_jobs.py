"""Postgres task/outbox contracts, including actual isolated worker execution."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import copy
from pathlib import Path
import tempfile
import unittest
import uuid

from psycopg.types.json import Jsonb
from lele_growth.child_service import ApiError
from lele_growth.plugins.catalog import register_release, update_metadata, set_publication, set_scope
from lele_growth.plugins.configuration import validate_config
from lele_growth.plugins.deployment import inspect_package, prepare_release
from lele_growth.plugins.events import EventDispatcher, emit_task_completed
from lele_growth.plugins.gateway import PluginGateway
from lele_growth.plugins.policy import active_context
from lele_growth.plugins.scheduler import PluginScheduler, occurrence, RETRY_DELAYS
from lele_growth.plugins.supervisor import PluginSupervisor
from tests.backend.test_plugin_runtime import DatabaseFixture, make_package, manifest

UTC = timezone.utc


class ScheduleTests(unittest.TestCase):
    def test_daily_default_shanghai_and_stable_interval_keys(self):
        now = datetime(2026, 10, 30, 2, 30, tzinfo=UTC)
        key, due = occurrence({'time': '09:00'}, {}, now)
        self.assertEqual(due, datetime(2026, 10, 30, 1, tzinfo=UTC))
        self.assertTrue(key.endswith('+08:00'))
        key1, due1 = occurrence({'intervalSeconds': 60}, {}, now)
        key2, due2 = occurrence({'intervalSeconds': 60}, {}, now + timedelta(seconds=10))
        self.assertEqual((key1, due1), (key2, due2))
        with self.assertRaises(ApiError): occurrence({'time': '25:00'}, {}, now)

    def test_config_time_optional_seconds_preserve_due_and_day_boundary(self):
        task = {'schedule': {'configTime': 'time'}}
        schema = {'type': 'object', 'properties': {'time': {'type': 'string', 'format': 'time'}}}
        cases = [
            ('20:00:00', datetime(2026, 10, 31, 12, 0, 0, tzinfo=UTC), datetime(2026, 10, 31, 12, 0, 0, tzinfo=UTC)),
            ('20:00:30', datetime(2026, 10, 31, 12, 0, 29, tzinfo=UTC), datetime(2026, 10, 30, 12, 0, 30, tzinfo=UTC)),
            ('20:00:30', datetime(2026, 10, 31, 12, 0, 30, tzinfo=UTC), datetime(2026, 10, 31, 12, 0, 30, tzinfo=UTC)),
            ('20:00:30', datetime(2026, 10, 31, 12, 0, 31, tzinfo=UTC), datetime(2026, 10, 31, 12, 0, 30, tzinfo=UTC)),
        ]
        for value, now, expected in cases:
            with self.subTest(value=value, now=now):
                config = validate_config(schema, {'time': value})
                key, due = occurrence(task, config, now)
                self.assertEqual(due, expected)
                self.assertEqual(datetime.fromisoformat(key).astimezone(UTC), expected)
        for value in ('20:00:60', '20:00:99', '20:00:1', '20:00:-1', '20:00:30.5'):
            with self.subTest(value=value):
                with self.assertRaises(ApiError): validate_config(schema, {'time': value})
                with self.assertRaises(ApiError): occurrence(task, {'time': value}, cases[0][1])


class JobTests(DatabaseFixture):
    def setUp(self):
        super().setUp()
        self.now = datetime.now(UTC)
        self.scheduler = PluginScheduler(self.service, self.gateway, owner='worker-a', clock=lambda: self.now)

    def enqueue(self, key=None, *, due=None, payload=None):
        return self.scheduler.enqueue(self.plugin_id, self.child_id, 'remind', key or uuid.uuid4().hex, due or self.now, payload)

    def claim(self):
        return self.scheduler.claim(self.plugin_id)

    def status(self, job_id):
        return self.sql('SELECT status,attempt FROM lele.plugin_jobs WHERE id=%s', (job_id,))[0]

    def result(self, key):
        return {'effects': [{'collection': 'executions', 'id': key, 'payload': {'message': 'ok'}}]}

    def test_concurrent_claim_has_single_owner_and_atomic_effect(self):
        job_id = self.enqueue('same-business-occurrence')
        other = PluginScheduler(self.service, self.gateway, owner='worker-b', clock=lambda: self.now)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.scheduler.claim, self.plugin_id), pool.submit(other.claim, self.plugin_id)]
            jobs = [f.result(timeout=5) for f in futures]
        claimed = [(scheduler, job) for scheduler, job in zip((self.scheduler, other), jobs) if job]
        self.assertEqual(len(claimed), 1)
        scheduler, job = claimed[0]
        scheduler.complete(job, self.result('same-business-occurrence'))
        self.assertEqual(self.status(job_id), ('succeeded', 1))
        self.assertEqual(self.enqueue('same-business-occurrence'), job_id)
        self.assertEqual(self.sql('SELECT count(*) FROM lele.child_plugin_records WHERE plugin_id=%s', (self.plugin_id,)), [(1,)])
        with self.assertRaises(ApiError): scheduler.complete(job, self.result('same-business-occurrence'))

    def test_expired_lease_old_attempt_cannot_commit_and_retry_is_deduplicated(self):
        job_id = self.enqueue('lease-test')
        old = self.claim()
        self.now += timedelta(seconds=50)
        self.assertGreaterEqual(self.scheduler.reap(), 1)
        self.assertEqual(self.status(job_id), ('retry', 1))
        self.now += timedelta(seconds=10)
        new = self.claim()
        with self.assertRaises(ApiError): self.scheduler.complete(old, self.result('lease-test'))
        self.scheduler.complete(new, self.result('lease-test'))
        self.assertEqual(self.status(job_id), ('succeeded', 2))
        self.assertEqual(self.sql('SELECT revision FROM lele.child_plugin_records WHERE plugin_id=%s', (self.plugin_id,)), [(1,)])

    def test_three_retries_then_failure_and_uncertain_never_retried(self):
        job_id = self.enqueue('retry')
        for attempt in range(1, 5):
            job = self.claim(); self.assertIsNotNone(job)
            self.assertEqual(job['attempt'], attempt)
            self.scheduler.fail(job)
            self.assertEqual(self.status(job_id)[0], 'retry' if attempt < 4 else 'failed')
            self.now += timedelta(seconds=RETRY_DELAYS[min(attempt - 1, 2)])
        self.assertIsNone(self.claim())
        uncertain_id = self.enqueue('external', payload={'externalNonIdempotent': True})
        uncertain = self.claim()
        self.scheduler.fail(uncertain, uncertain=True)
        self.now += timedelta(days=1)
        self.assertIsNone(self.claim())
        self.assertEqual(self.status(uncertain_id)[0], 'uncertain')

    def test_disable_and_deleted_child_block_creation_claim_and_final_write(self):
        running_id = self.enqueue('running')
        running = self.claim()
        pending_id = self.enqueue('pending')
        self.sql('UPDATE lele.child_plugins SET enabled=false,generation=generation+1 WHERE plugin_id=%s', (self.plugin_id,))
        with self.assertRaises(ApiError): self.enqueue('after-disable')
        with self.assertRaises(ApiError): self.scheduler.complete(running, self.result('running'))
        self.assertIsNone(self.claim())
        self.assertEqual(self.status(pending_id)[0], 'cancelled')
        self.sql('UPDATE lele.child_plugins SET enabled=true,generation=generation+1 WHERE plugin_id=%s', (self.plugin_id,))
        self.sql('UPDATE lele.children SET deleted_at=now(),deleted_by=%s WHERE id=%s', (self.user_id, self.child_id))
        with self.assertRaises(ApiError): self.enqueue('after-delete')
        self.assertEqual(self.sql('SELECT count(*) FROM lele.child_plugin_records WHERE plugin_id=%s', (self.plugin_id,)), [(0,)])

    def test_misfire_skip_and_latest_coalescing(self):
        skipped = self.enqueue('old-reminder', due=self.now - timedelta(minutes=6))
        self.assertIsNone(self.claim()); self.assertEqual(self.status(skipped)[0], 'skipped')
        data = copy.deepcopy(self.data); data['tasks'][0]['misfirePolicy'] = 'latest'
        self.sql('UPDATE lele.plugin_releases SET manifest=%s WHERE release_id=%s', (Jsonb(data), self.release_id))
        old = self.enqueue('old-report', due=self.now - timedelta(days=1))
        latest = self.enqueue('latest-report')
        job = self.claim()
        self.assertEqual(job['id'], latest); self.assertEqual(self.status(old)[0], 'skipped')

    def test_epoch_switch_rejects_old_result_but_occurrence_key_is_version_independent(self):
        job_id = self.enqueue('across-update')
        old = self.claim()
        data = copy.deepcopy(self.data); data['version'] = '1.0.1'
        self.service.transaction(lambda cur: register_release(cur, data, artifact_sha256='b' * 64, source_commit='test', config_schema=self.schema, activate=True))
        with self.assertRaises(ApiError): self.scheduler.complete(old, self.result('across-update'))
        self.assertEqual(self.enqueue('across-update'), job_id)

    def test_metadata_revision_keeps_running_job_valid_and_admin_conflicts_strict(self):
        job_id = self.enqueue('metadata-edit')
        job = self.claim()
        previous_revision = job['context']['policyRevision']
        self.service.transaction(lambda cur: update_metadata(cur, self.plugin_id,
                                 {'name': '管理员新名称', 'expectedRevision': previous_revision}))
        current = self.context()
        self.assertEqual(current['policyRevision'], previous_revision + 1)
        self.assertEqual(self.gateway.signer.verify(job['context'])['policyRevision'], previous_revision)
        with self.assertRaises(ApiError) as error:
            self.service.transaction(lambda cur: update_metadata(cur, self.plugin_id,
                                     {'name': '过期修改', 'expectedRevision': previous_revision}))
        self.assertEqual(error.exception.kind, 'plugin_revision_conflict')
        self.scheduler.complete(job, self.result('metadata-edit'))
        self.assertEqual(self.status(job_id), ('succeeded', 1))

    def test_unpublication_still_revokes_claimed_job(self):
        self.enqueue('unpublish')
        job = self.claim()
        self.service.transaction(lambda cur: set_publication(cur, self.plugin_id, False, job['context']['policyRevision']))
        with self.assertRaises(ApiError) as error:
            self.scheduler.complete(job, self.result('unpublish'))
        self.assertEqual(error.exception.kind, 'plugin_unpublished')
        self.assertEqual(self.sql('SELECT count(*) FROM lele.child_plugin_records WHERE plugin_id=%s', (self.plugin_id,)), [(0,)])

    def test_scope_revocation_still_rejects_claimed_job(self):
        self.enqueue('scope-revoked')
        job = self.claim()
        other_child = str(uuid.uuid4())
        def change_scope(cur):
            cur.execute("INSERT INTO lele.children(id,name,owner_id) VALUES(%s,'另童',%s)", (other_child, self.user_id))
            cur.execute('INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES(%s,%s,%s)', (other_child, self.user_id, str(uuid.uuid4())))
            return set_scope(cur, self.plugin_id, {'scopeMode': 'children', 'childIds': [other_child],
                                                  'expectedRevision': job['context']['policyRevision']})
        self.service.transaction(change_scope)
        with self.assertRaises(ApiError) as error:
            self.scheduler.complete(job, self.result('scope-revoked'))
        self.assertEqual(error.exception.kind, 'plugin_out_of_scope')
        self.assertEqual(self.sql('SELECT count(*) FROM lele.child_plugin_records WHERE plugin_id=%s', (self.plugin_id,)), [(0,)])

    def test_invalid_second_effect_rolls_back_first_and_dedup_record(self):
        self.enqueue('atomic')
        job = self.claim()
        result = self.result('first')
        result['effects'].append({'collection': 'bad/path', 'id': 'invalid', 'payload': {}})
        with self.assertRaises(ApiError): self.scheduler.complete(job, result)
        self.assertEqual(self.sql('SELECT count(*) FROM lele.child_plugin_records WHERE plugin_id=%s', (self.plugin_id,)), [(0,)])
        self.assertEqual(self.sql('SELECT count(*) FROM lele.plugin_effects WHERE plugin_id=%s', (self.plugin_id,)), [(0,)])

    def test_real_worker_job_writes_reference_execution(self):
        with tempfile.TemporaryDirectory(prefix='real-plugin-job-') as directory:
            root = Path(directory) / 'runtime'
            package = make_package(directory, self.data, schema=self.schema)
            prepare_release(inspect_package(package), root)
            supervisor = PluginSupervisor(root)
            try:
                self.gateway.runtime = supervisor
                job_id = self.enqueue('real-occurrence')
                self.assertTrue(self.scheduler.run_one(self.plugin_id))
                self.assertEqual(self.status(job_id), ('succeeded', 1))
                record = self.sql('SELECT record_id,payload,revision FROM lele.child_plugin_records WHERE plugin_id=%s', (self.plugin_id,))[0]
                self.assertEqual(record, ('real-occurrence', {'message': 'ok'}, 1))
            finally:
                supervisor.close()

    def test_heartbeat_and_stale_owner_are_fenced(self):
        job_id = self.enqueue('heartbeat')
        self.claim()
        self.now += timedelta(seconds=20)
        self.assertTrue(self.scheduler.heartbeat(job_id))
        other = PluginScheduler(self.service, self.gateway, owner='other', clock=lambda: self.now)
        self.assertFalse(other.heartbeat(job_id))
        self.sql('UPDATE lele.plugin_jobs SET cancel_requested=true WHERE id=%s', (job_id,))
        self.assertFalse(self.scheduler.heartbeat(job_id))

    def test_transactional_outbox_duplicate_and_independent_deliveries(self):
        data = copy.deepcopy(self.data); data['events'] = ['task.completed']
        self.sql('UPDATE lele.plugin_releases SET manifest=%s WHERE release_id=%s', (Jsonb(data), self.release_id))
        operation_id = uuid.uuid4().hex
        def emit(cur):
            return emit_task_completed(cur, self.child_id, 4, {'occurrenceKey': 'task@2026-10-30', 'privateSnapshot': {'ignored': True}}, operation_id)
        def aborted(cur):
            emit(cur)
            raise RuntimeError('rollback original core operation')
        with self.assertRaises(RuntimeError): self.service.transaction(aborted)
        self.assertEqual(self.sql('SELECT count(*) FROM lele.plugin_event_outbox WHERE child_id=%s', (self.child_id,)), [(0,)])
        event_id = self.service.transaction(emit)
        self.assertEqual(self.service.transaction(emit), event_id)
        second = 'event-' + uuid.uuid4().hex[:12]
        second_data = copy.deepcopy(data); second_data['id'] = second
        def install_second(cur):
            register_release(cur, second_data, artifact_sha256='c' * 64, source_commit='test', config_schema=self.schema, activate=True)
            cur.execute("UPDATE lele.plugin_catalog SET publication_status='published' WHERE id=%s", (second,))
            cur.execute('INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled) VALUES(%s,%s,true,true)', (self.child_id, second))
            cur.execute('INSERT INTO lele.child_plugin_configs(child_id,plugin_id,config) VALUES(%s,%s,%s)', (self.child_id, second, Jsonb({'message': 'ok'})))
        self.service.transaction(install_second)
        dispatcher = EventDispatcher(self.service, self.scheduler)
        dispatcher.dispatch(limit=1000)
        dispatcher.dispatch(limit=1000)
        deliveries = self.sql('SELECT plugin_id,status FROM lele.plugin_event_deliveries WHERE event_id=%s AND plugin_id=ANY(%s) ORDER BY plugin_id', (event_id, [self.plugin_id, second]))
        self.assertEqual(set(deliveries), {(self.plugin_id, 'pending'), (second, 'pending')})
        self.now = datetime.now(UTC)
        first_job = self.claim(); self.assertIsNotNone(first_job)
        self.scheduler.fail(first_job, uncertain=True)
        second_job = self.scheduler.claim(second)
        self.scheduler.complete(second_job, self.result(event_id))
        self.assertEqual(set(self.sql('SELECT plugin_id,status FROM lele.plugin_event_deliveries WHERE event_id=%s AND plugin_id=ANY(%s)', (event_id, [self.plugin_id, second]))), {(self.plugin_id, 'uncertain'), (second, 'succeeded')})
        payload = self.sql('SELECT payload FROM lele.plugin_event_outbox WHERE event_id=%s', (event_id,))[0][0]
        self.assertNotIn('privateSnapshot', payload)

    def test_malformed_schedule_isolated_from_another_plugins_jobs(self):
        from unittest.mock import patch
        from lele_growth.plugins import scheduler as module
        second = 'schedule-' + uuid.uuid4().hex[:12]
        data = copy.deepcopy(self.data); data['id'] = second
        def install(cur):
            register_release(cur, data, artifact_sha256='d' * 64, source_commit='test', config_schema=self.schema, activate=True)
            cur.execute("UPDATE lele.plugin_catalog SET publication_status='published' WHERE id=%s", (second,))
            cur.execute('INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled) VALUES(%s,%s,true,true)', (self.child_id, second))
            cur.execute('INSERT INTO lele.child_plugin_configs(child_id,plugin_id,config) VALUES(%s,%s,%s)', (self.child_id, second, Jsonb({'message': 'healthy'})))
            cur.execute('UPDATE lele.child_plugin_configs SET config=%s WHERE plugin_id=%s AND child_id=%s', (Jsonb({'message': 'malformed'}), self.plugin_id, self.child_id))
        self.service.transaction(install)
        original = module.occurrence
        def fail_one(task, config, now):
            if config.get('message') == 'malformed': raise TypeError('malformed schedule configuration')
            return original(task, config, now)
        with patch.object(module, 'occurrence', side_effect=fail_one):
            self.scheduler.schedule_due()
        self.assertEqual(self.sql('SELECT count(*) FROM lele.plugin_jobs WHERE plugin_id=%s', (self.plugin_id,)), [(0,)])
        self.assertEqual(self.sql('SELECT count(*) FROM lele.plugin_jobs WHERE plugin_id=%s', (second,)), [(1,)])
        job = self.scheduler.claim(second)
        self.assertIsNotNone(job)
        self.scheduler.complete(job, self.result(job['occurrence_key']))
        self.assertEqual(self.sql('SELECT status FROM lele.plugin_jobs WHERE plugin_id=%s', (second,)), [('succeeded',)])

    def test_declared_timeout_reaches_worker_instead_of_supervisor_default(self):
        data = copy.deepcopy(self.data); data['tasks'][0]['timeoutSeconds'] = 2
        self.sql('UPDATE lele.plugin_releases SET manifest=%s WHERE release_id=%s', (Jsonb(data), self.release_id))
        worker = '''import time
from datetime import datetime

def health(): return {'ok':True}
def handle_job(context,task,payload):
    time.sleep(1.1)
    return {'effects':[{'collection':'executions','id':payload['occurrenceKey'],'payload':{'timeoutHonored':True}}]}
'''
        with tempfile.TemporaryDirectory(prefix='plugin-timeout-') as directory:
            root = Path(directory) / 'runtime'
            prepare_release(inspect_package(make_package(directory, data, worker=worker, schema=self.schema)), root)
            supervisor = PluginSupervisor(root, call_timeout=0.1)
            try:
                self.gateway.runtime = supervisor
                job_id = self.enqueue('declared-timeout')
                self.assertTrue(self.scheduler.run_one(self.plugin_id))
                self.assertEqual(self.status(job_id), ('succeeded', 1))
                self.assertEqual(self.sql('SELECT payload FROM lele.child_plugin_records WHERE plugin_id=%s', (self.plugin_id,)), [({'timeoutHonored': True},)])
            finally:
                supervisor.close()

"""Event subscription boundaries and bounded scans in disposable local databases."""
import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import threading
import uuid
from unittest.mock import patch

from psycopg.types.json import Jsonb

from lele_growth.child_service import ApiError
from lele_growth.plugins.catalog import register_release, set_publication
from lele_growth.plugins.events import EventDispatcher, emit_task_completed
from lele_growth.plugins.installations import mutate_installation
from lele_growth.plugins.policy import catalog_row
from lele_growth.plugins.scheduler import PluginScheduler
from tests.backend.test_plugin_runtime import DatabaseFixture


class EventDeliveryRegressionTests(DatabaseFixture):
    def setUp(self):
        super().setUp()
        self.now = datetime.now(timezone.utc) + timedelta(seconds=1)
        self.scheduler = PluginScheduler(self.service, self.gateway, clock=lambda: self.now)
        self.dispatcher = EventDispatcher(self.service, self.scheduler)
        self.subscribe()

    def subscribe(self, enabled=True):
        manifest = copy.deepcopy(self.data)
        manifest.update(tasks=[], events=['task.completed'] if enabled else [])
        self.sql('UPDATE lele.plugin_releases SET manifest=%s WHERE release_id=%s',
                 (Jsonb(manifest), self.release_id))

    def emit(self, label='task', operation_id=None):
        def work(cur):
            self.service.lock_child(cur, self.child_id)
            return emit_task_completed(cur, self.child_id, 1, {'occurrenceKey': label},
                                       operation_id or uuid.uuid4().hex)
        return self.service.transaction(work)

    def publication(self, enabled):
        # The minimal worker fixture has no marketing metadata.
        self.sql("UPDATE lele.plugin_catalog SET name='review',description='review',instructions='review' WHERE id=%s", (self.plugin_id,))
        revision = self.sql('SELECT policy_revision FROM lele.plugin_catalog WHERE id=%s', (self.plugin_id,))[0][0]
        return self.service.transaction(lambda cur: set_publication(cur, self.plugin_id, enabled, revision))

    def manage(self, action):
        revision = self.sql('SELECT revision FROM lele.child_plugins WHERE plugin_id=%s AND child_id=%s',
                            (self.plugin_id, self.child_id))[0][0]
        return self.service.transaction(lambda cur: mutate_installation(
            cur, self.plugin_id, self.child_id, self.user_id, action,
            {'expectedRevision': revision, 'operationId': uuid.uuid4().hex}))

    def claim(self):
        return self.scheduler.claim(self.plugin_id)

    def jobs(self):
        return self.sql('SELECT occurrence_key,status FROM lele.plugin_jobs WHERE plugin_id=%s ORDER BY occurrence_key', (self.plugin_id,))

    def effect(self, event_id):
        return {'effects': [{'collection': 'events', 'id': event_id, 'payload': {'received': True}}]}

    def test_distinct_events_are_not_coalesced_or_expired_and_duplicate_emit_is_once(self):
        operation_id = uuid.uuid4().hex
        first = self.emit('first', operation_id)
        self.assertEqual(self.emit('first', operation_id), first)
        self.sql("UPDATE lele.plugin_event_outbox SET created_at=now()-interval '10 minutes' WHERE event_id=%s", (first,))
        events = {first, *(self.emit(str(index)) for index in range(4))}
        self.dispatcher.dispatch(limit=1000)
        self.dispatcher.dispatch(limit=1000)
        consumed = set()
        while (job := self.claim()) is not None:
            consumed.add(job['occurrence_key'])
            self.scheduler.complete(job, self.effect(job['occurrence_key']))
        self.assertEqual(consumed, events)
        self.assertEqual(len(self.jobs()), 5)
        self.assertEqual(self.sql('SELECT count(*) FROM lele.child_plugin_records WHERE plugin_id=%s', (self.plugin_id,)), [(5,)])
        self.assertEqual(self.sql("SELECT count(*) FROM lele.plugin_event_deliveries WHERE plugin_id=%s AND status='succeeded'", (self.plugin_id,)), [(5,)])

    def test_an_event_retry_does_not_discard_earlier_or_later_events(self):
        first, second = self.emit('first'), self.emit('second')
        self.dispatcher.dispatch()
        job = self.claim()
        self.assertIsNotNone(job)
        self.scheduler.fail(job)
        other = self.claim()
        self.assertIsNotNone(other)
        self.assertNotEqual(other['id'], job['id'])
        self.scheduler.complete(other, self.effect(other['occurrence_key']))
        self.now += timedelta(seconds=10)
        retry = self.claim()
        self.assertEqual(retry['id'], job['id'])
        self.scheduler.complete(retry, self.effect(retry['occurrence_key']))
        self.assertEqual(dict(self.jobs()), {first: 'succeeded', second: 'succeeded'})

    def test_unpublished_events_do_not_replay_after_republication(self):
        self.publication(False)
        self.emit('while-unpublished')
        self.dispatcher.dispatch()
        self.publication(True)
        self.manage('enable')
        self.dispatcher.dispatch()
        self.assertEqual(self.jobs(), [])
        current = self.emit('after-enable')
        self.dispatcher.dispatch()
        self.assertEqual(self.claim()['occurrence_key'], current)

    def test_disabled_events_and_pre_revocation_backlog_do_not_replay(self):
        self.emit('before-disable-but-not-dispatched')
        self.manage('disable')
        self.emit('while-disabled')
        self.manage('enable')
        self.dispatcher.dispatch()
        self.assertEqual(self.jobs(), [])
        self.assertEqual(self.sql('SELECT status FROM lele.plugin_event_deliveries WHERE plugin_id=%s', (self.plugin_id,)), [('cancelled',)])

    def test_first_install_and_new_subscription_do_not_receive_earlier_events(self):
        self.manage('uninstall')
        self.emit('before-reinstall')
        self.manage('install')
        self.manage('enable')
        self.subscribe(False)
        self.emit('before-subscription')
        self.subscribe(True)
        self.dispatcher.dispatch()
        self.assertEqual(self.jobs(), [])

    def test_update_pause_and_runtime_restart_preserve_event_time_recipients(self):
        self.sql("UPDATE lele.plugin_catalog SET operation_state='updating',release_epoch=release_epoch+1 WHERE id=%s", (self.plugin_id,))
        event_id = self.emit('during-update')
        self.dispatcher.dispatch()
        self.assertEqual(self.jobs(), [])
        self.sql("UPDATE lele.plugin_catalog SET operation_state='ready',release_epoch=release_epoch+1 WHERE id=%s", (self.plugin_id,))
        restarted = PluginScheduler(self.service, self.gateway, clock=lambda: self.now)
        EventDispatcher(self.service, restarted).dispatch()
        job = restarted.claim(self.plugin_id)
        self.assertIsNotNone(job)
        self.assertEqual(job['occurrence_key'], event_id)
        restarted.complete(job, self.effect(event_id))

    def test_dispatch_then_revoke_cannot_submit_effects_and_statuses_agree(self):
        event_id = self.emit()
        self.dispatcher.dispatch()
        job = self.claim()
        self.manage('disable')
        with self.assertRaises(ApiError):
            self.scheduler.complete(job, self.effect(event_id))
        self.scheduler.fail(job, code='plugin_disabled')
        self.assertEqual(self.jobs(), [(event_id, 'cancelled')])
        self.assertEqual(self.sql('SELECT status FROM lele.plugin_event_deliveries WHERE event_id=%s AND plugin_id=%s', (event_id, self.plugin_id)), [('cancelled',)])

    def test_core_completion_and_unpublication_have_no_catalog_child_lock_inversion(self):
        child_locked, catalog_locked = threading.Event(), threading.Event()

        def completion():
            def work(cur):
                self.service.lock_child(cur, self.child_id)
                cur.execute('SELECT id FROM lele.children WHERE id=%s FOR UPDATE', (self.child_id,))
                child_locked.set()
                self.assertTrue(catalog_locked.wait(3))
                return emit_task_completed(cur, self.child_id, 1, {'occurrenceKey': 'concurrent'}, uuid.uuid4().hex)
            return self.service.transaction(work)

        def unpublish():
            self.assertTrue(child_locked.wait(3))
            def work(cur):
                plugin = catalog_row(cur, self.plugin_id, lock='UPDATE')
                catalog_locked.set()
                return set_publication(cur, self.plugin_id, False, plugin['policy_revision'])
            return self.service.transaction(work)

        with ThreadPoolExecutor(max_workers=2) as pool:
            completed = pool.submit(completion)
            revoked = pool.submit(unpublish)
            completed.result(timeout=6)
            revoked.result(timeout=6)
        self.dispatcher.dispatch()
        self.assertEqual(self.jobs(), [])


class ScheduleScanRegressionTests(DatabaseFixture):
    def seed_children(self, count):
        prefix = 'scan-' + uuid.uuid4().hex[:12] + '-'
        def seed(cur):
            cur.execute('UPDATE lele.child_plugins SET enabled=false WHERE plugin_id<>%s', (self.plugin_id,))
            cur.execute("INSERT INTO lele.children(id,name,owner_id) SELECT %s||lpad(i::text,5,'0'),'scan',%s FROM generate_series(1,%s) AS i", (prefix, self.user_id, count))
            cur.execute("INSERT INTO lele.memberships(child_id,user_id,membership_version) SELECT id,owner_id,'scan-member:'||id FROM lele.children WHERE starts_with(id,%s)", (prefix,))
            cur.execute("INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled) SELECT id,%s,true,true FROM lele.children WHERE starts_with(id,%s)", (self.plugin_id, prefix))
        self.service.transaction(seed)
        return prefix

    def test_scan_is_bounded_advances_wraps_and_includes_new_instances(self):
        prefix = self.seed_children(4)
        now = datetime.now(timezone.utc)
        scheduler = PluginScheduler(self.service, self.gateway, clock=lambda: now,
                                    schedule_batch_size=2, schedule_budget_seconds=60)
        scheduler.schedule_due()
        self.assertEqual(self.sql('SELECT count(*) FROM lele.plugin_jobs WHERE plugin_id=%s', (self.plugin_id,)), [(2,)])
        self.sql('UPDATE lele.child_plugins SET enabled=false WHERE child_id=%s', (prefix + '00003',))
        for _ in range(4):
            scheduler.schedule_due()
        self.assertEqual(self.sql('SELECT count(*) FROM lele.plugin_jobs WHERE plugin_id=%s', (self.plugin_id,)), [(4,)])
        self.sql('UPDATE lele.child_plugins SET enabled=true WHERE child_id=%s', (prefix + '00003',))
        for _ in range(4):
            scheduler.schedule_due()
        self.assertEqual(self.sql('SELECT count(*) FROM lele.plugin_jobs WHERE plugin_id=%s', (self.plugin_id,)), [(5,)])

    def test_more_than_one_thousand_instances_all_receive_one_occurrence(self):
        self.seed_children(1000)
        now = datetime.now(timezone.utc)
        scheduler = PluginScheduler(self.service, self.gateway, clock=lambda: now,
                                    schedule_batch_size=200, schedule_budget_seconds=60)
        for _ in range(12):
            scheduler.schedule_due()
        self.assertEqual(self.sql('SELECT count(*),count(DISTINCT child_id) FROM lele.plugin_jobs WHERE plugin_id=%s', (self.plugin_id,)), [(1001, 1001)])

    def test_time_budget_advances_after_a_failed_instance(self):
        self.seed_children(2)
        scheduler = PluginScheduler(self.service, self.gateway, schedule_batch_size=2,
                                    schedule_budget_seconds=0.1)
        with patch('lele_growth.plugins.scheduler.occurrence', side_effect=ValueError('bad schedule')), \
                patch('lele_growth.plugins.scheduler.time.monotonic', side_effect=[0, 1, 1, 2]):
            scheduler.schedule_due()
        for _ in range(4):
            scheduler.schedule_due()
        self.assertEqual(self.sql('SELECT count(*) FROM lele.plugin_jobs WHERE plugin_id=%s', (self.plugin_id,)), [(3,)])

    def test_reconcile_finds_a_later_plugin_after_ten_thousand_instances(self):
        from deploy.plugin_runtime import PluginRuntimeService
        self.seed_children(10001)
        other_id = 'zz-scan-' + uuid.uuid4().hex[:12]
        manifest = copy.deepcopy(self.data)
        manifest['id'] = other_id
        def install(cur):
            register_release(cur, manifest, artifact_sha256='b'*64, source_commit='test',
                             config_schema=self.schema, activate=True)
            cur.execute("UPDATE lele.plugin_catalog SET publication_status='published' WHERE id=%s", (other_id,))
            cur.execute('INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled) VALUES(%s,%s,true,true)', (self.child_id, other_id))
        self.service.transaction(install)
        with tempfile.TemporaryDirectory(prefix='plugin-scan-runtime-') as directory:
            runtime = PluginRuntimeService(self.service, Path(directory) / 'runtime')
            try:
                self.assertEqual(runtime.reconcile(), {(self.plugin_id, '1.0.0'), (other_id, '1.0.0')})
            finally:
                runtime.close()

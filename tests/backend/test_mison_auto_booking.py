"""Automatic booking against isolated PostgreSQL and synthetic upstream data."""
from copy import deepcopy
from datetime import datetime, timedelta
import json
import unittest
import uuid
from urllib.parse import quote
from unittest.mock import patch

from psycopg.types.json import Jsonb
from tests.backend import test_mison_booking as booking_fixture
from lele_growth.child_service import ApiError
from lele_growth.plugins import auto_booking as host
from lele_growth.plugins.catalog import register_release
from lele_growth.plugins import external_operations, private_store
from lele_growth.plugins.scheduler import PluginScheduler
from mison_booking import auto_booking, handle_job, handle_request, read_api
from mison_booking import auth, bark, operations
from mison_booking.upstream import Client


class AutoBookingRulesTests(unittest.TestCase):
    def test_notification_settings_default_off_and_validate_recipients_and_scenes(self):
        config = host.defaults()
        config.pop('notifications')
        self.assertEqual(host.validate_config(config)['notifications'], {'enabled': False, 'barkKeys': [], 'events': ['booked']})
        for changes in ({'enabled': True}, {'enabled': True, 'barkKeys': ['fixture_key_123'], 'events': []},
                        {'barkKeys': ['fixture_key_123'] * 2}, {'barkKeys': ['https://api.day.app/key']},
                        {'barkKeys': [None]}, {'events': ['failed']}, {'enabled': 1},
                        {'barkKeys': [f'fixture_key_{i}' for i in range(11)]}):
            with self.subTest(changes=changes), self.assertRaises(ApiError):
                host.validate_config({**host.defaults(), 'notifications': {**host.defaults()['notifications'], **changes}})

    def test_check_interval_legacy_default_and_invalid_ranges(self):
        legacy = host.defaults()
        legacy.pop('checkInterval')
        self.assertEqual(host.validate_config(legacy)['checkInterval'], {'minMinutes': 4, 'maxMinutes': 6})
        self.assertNotIn('checkInterval', legacy)
        for interval in (None, {}, [2, 5], {'minMinutes': 0, 'maxMinutes': 5},
                         {'minMinutes': 2, 'maxMinutes': 31}, {'minMinutes': 6, 'maxMinutes': 5},
                         {'minMinutes': True, 'maxMinutes': 5}, {'minMinutes': 2.5, 'maxMinutes': 5},
                         {'minMinutes': 2, 'maxMinutes': 5, 'extra': 1}):
            with self.subTest(interval=interval), self.assertRaises(ApiError):
                host.validate_config({**host.defaults(), 'checkInterval': interval})
        for minute in (1, 30):
            config = {**host.defaults(), 'checkInterval': {'minMinutes': minute, 'maxMinutes': minute}}
            self.assertEqual(host.validate_config(config), config)
            self.assertEqual(host.check_interval_seconds(config), minute * 60)

    def test_check_interval_draws_fresh_seconds_with_inclusive_endpoints(self):
        config = {**host.defaults(), 'checkInterval': {'minMinutes': 2, 'maxMinutes': 5}}
        with patch.object(host.secrets, 'randbelow', side_effect=[0, 180, 79]) as random:
            self.assertEqual([host.check_interval_seconds(config) for _ in range(3)], [120, 300, 199])
        self.assertEqual([call.args for call in random.call_args_list], [(181,)] * 3)

    def test_sleep_crosses_midnight_and_resumes_at_exclusive_end(self):
        config = host.defaults()
        for moment, expected in [('2026-11-12T23:00', '2026-11-13T08:00'), ('2026-11-13T07:59', '2026-11-13T08:00')]:
            actual = host.quiet_until(config, datetime.fromisoformat(moment).replace(tzinfo=host.TZ))
            self.assertEqual(actual.isoformat(timespec='minutes')[:16], expected)
        self.assertIsNone(host.quiet_until(config, datetime(2026, 11, 13, 8, tzinfo=host.TZ)))
        config['sleep'] = {'enabled': True, 'start': '12:00', 'end': '13:00'}
        self.assertIsNone(host.quiet_until(config, datetime(2026, 11, 13, 8, tzinfo=host.TZ)))
        self.assertEqual(host.quiet_until(config, datetime(2026, 11, 13, 12, tzinfo=host.TZ)).hour, 13)

    def test_configuration_rejects_duplicates_and_invalid_sleep_and_weekdays(self):
        config = host.defaults()
        self.assertEqual(host.validate_config(config), config)
        for change in ({'dates': ['2026-11-16', '2026-11-16']}, {'minNoticeHours': True},
                       {'sleep': {'enabled': True, 'start': '08:00', 'end': '08:00'}},
                       {'weekdaySlots': {'1': ['19:00']}}, {'dates': ['2026-02-30']}):
            with self.subTest(change=change), self.assertRaises(ApiError):
                host.validate_config({**config, **change})

    def test_cancellation_identity_never_uses_teacher_name_and_time_alone(self):
        self.assertFalse(auto_booking.matches_identity({'teacherName': 'Jenyy', 'date': '2026-11-16'}, {'teacherName': 'Jenyy', 'date': '2026-11-16'}))
        self.assertTrue(auto_booking.matches_identity({'cid': '123'}, {'cid': '123'}))
        self.assertTrue(auto_booking.matches_identity({'bookingId': '456'}, {'bookingId': '456'}))
        self.assertFalse(auto_booking.matches_identity({'cid': '123', 'bookingId': '456'}, {'cid': '124', 'bookingId': '456'}))
        self.assertFalse(auto_booking.matches_identity({'cid': '123', 'bookingId': '456', 'bid': '11'}, {'bookingId': '456', 'bid': '12'}))

    def test_consecutive_groups_use_slot_priorities_independently_of_time_order(self):
        cases = (
            (['20:00', '19:30'], 2, ['19:30', '20:00']),
            (['20:00', '18:00', '18:30', '19:30'], 2, ['19:30', '20:00']),
            (['19:30', '20:00', '19:00'], 2, ['19:30', '20:00']),
            (['20:00', '19:00', '19:30'], 3, ['19:00', '19:30', '20:00']),
            (['20:00', '19:00'], 2, None),
        )
        for slots, count, expected in cases:
            with self.subTest(slots=slots, count=count):
                self.assertEqual(auto_booking.consecutive(slots, count), expected)


class AutoBookingApiTests(booking_fixture.BookingApiTests):
    notification_config = {'enabled': True, 'barkKeys': ['fixture_bark_key_A', 'fixture_bark_key_B'], 'events': ['booked']}

    def setUp(self):
        super().setUp()
        self.plugin_id = 'mison-booking'
        self.data.update(id=self.plugin_id, version='1.1.' + str(uuid.uuid4().int))
        self.data['platformApi']['minMinor'] = 3
        self.data['capabilities'].append('plugin.jobs.schedule')
        self.data['tasks'] = [
            {'id': 'auto-booking', 'intervalSeconds': 300, 'timeoutSeconds': 60, 'misfirePolicy': 'latest'},
            {'id': 'sync-courses', 'intervalSeconds': 31536000, 'timeoutSeconds': 60, 'misfirePolicy': 'skip'},
        ]

        def fixture(cur):
            release = register_release(cur, self.data, artifact_sha256=uuid.uuid4().hex * 2, source_commit='auto-fixture', config_schema=self.schema, activate=True)
            cur.execute("UPDATE lele.plugin_catalog SET publication_status='published' WHERE id=%s", (self.plugin_id,))
            cur.execute('INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled) VALUES(%s,%s,true,true)', (self.child_id, self.plugin_id))
            cur.execute('INSERT INTO lele.child_plugin_configs(child_id,plugin_id,config,config_revision) VALUES(%s,%s,%s,1)', (self.child_id, self.plugin_id, Jsonb({'message': 'ok'})))
            return release['release_id']

        self.release_id = self.service.transaction(fixture)
        self.ctx = {**self.context(), 'actorId': self.user_id}
        self.addCleanup(self.clean_auto_fixture)
        self.scheduler = PluginScheduler(self.service, self.gateway)
        self.moment = read_api.now().replace(hour=10, minute=0, second=0, microsecond=0)
        self.addCleanup(patch.stopall)
        patch.object(host, 'now', return_value=self.moment).start()
        patch.object(read_api, 'now', return_value=self.moment).start()
        self.fake.favorite_rows = [self.fake.teacher(101), self.fake.teacher(102)]
        original_record = self.fake.record
        generated = [9000]

        def record(cid, start='2099-01-02 19:00'):
            if cid >= 9000:
                generated[0] += 1
                cid = generated[0]
            return {**original_record(cid, start), 'dateend': (datetime.fromisoformat(start) + timedelta(minutes=25)).strftime('%H:%M')}

        self.fake.record = record

    def clean_auto_fixture(self):
        self.sql('DELETE FROM lele.plugin_external_leases WHERE operation_id IN (SELECT operation_id FROM lele.plugin_external_operations WHERE child_id=%s AND plugin_id=%s)', (self.child_id, self.plugin_id))
        self.sql('DELETE FROM lele.plugin_external_operations WHERE child_id=%s AND plugin_id=%s', (self.child_id, self.plugin_id))
        self.sql('DELETE FROM lele.plugin_private_records WHERE child_id=%s AND plugin_id=%s', (self.child_id, self.plugin_id))

    def configured(self, **changes):
        config = self.run_api('auto-booking/config')
        fields = {**host.defaults(), 'teachers': [{'id': '101', 'name': 'Teacher 101', 'avatarUrl': None}], 'dates': [self.day], **changes}
        fields.setdefault('dailyLessons', 1)
        fields.setdefault('rebookCancelled', True)
        if 'weekdaySlots' not in changes:
            fields['weekdaySlots'][str(datetime.fromisoformat(self.day).isoweekday())] = ['19:30', '19:00'] if changes.get('dailyLessons', 1) == 1 else ['19:30', '20:00']
        return self.run_api('auto-booking/config', 'PUT', {**fields, 'operationId': str(uuid.uuid4()), 'bindingRevision': 1, 'expectedRevision': config['revision']})

    def start_auto(self):
        config = self.run_api('auto-booking/config')
        return self.run_api('auto-booking/start', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1, 'expectedRevision': config['revision']})

    def state(self):
        return self.service.transaction(lambda cur: host.load(cur, self.context_scope())[2])

    def context_scope(self):
        return {'plugin_id': self.plugin_id, 'child_id': self.child_id}

    def peer_context(self):
        peer = str(uuid.uuid4())

        def fixture(cur):
            cur.execute("INSERT INTO lele.children(id,name,owner_id) VALUES(%s,'auto-peer',%s)", (peer, self.user_id))
            cur.execute('INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES(%s,%s,%s)',
                        (peer, self.user_id, str(uuid.uuid4())))
            cur.execute('INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled) VALUES(%s,%s,true,true)',
                        (peer, self.plugin_id))
            cur.execute('INSERT INTO lele.child_plugin_configs(child_id,plugin_id,config,config_revision) VALUES(%s,%s,%s,1)',
                        (peer, self.plugin_id, Jsonb({'message': 'ok'})))

        self.service.transaction(fixture)
        from lele_growth.plugins.policy import active_context
        context = self.service.transaction(lambda cur: active_context(cur, self.plugin_id, peer))
        context['actorId'] = self.user_id
        self.addCleanup(lambda: self.sql('DELETE FROM lele.plugin_private_records WHERE child_id=%s AND plugin_id=%s',
                                         (peer, self.plugin_id)))
        self.assertTrue(handle_request(context, 'connection/login', 'POST',
                                       {**self.body, 'operationId': str(uuid.uuid4())})['ok'])
        return context

    def step(self):
        state = self.state()
        self.scheduler.enqueue(self.plugin_id, self.child_id, 'auto-booking', state['epoch'] + ':' + str(state['step']), datetime.now(host.TZ) - timedelta(seconds=1))
        job = self.scheduler.claim(self.plugin_id)
        self.assertIsNotNone(job)
        result = handle_job(job['context'], 'auto-booking', {})
        self.scheduler.complete(job, result)
        return result

    def round(self):
        checks = self.state()['checks']
        for _ in range(30):
            self.step()
            if self.state()['checks'] > checks:
                return self.state()
        self.fail('round did not complete within bounded steps')

    def test_auto_prefers_teacher_then_slot_and_repeated_round_does_not_duplicate(self):
        with self.connected():
            self.configured()
            self.start_auto()
            state = self.round()
            self.assertEqual(len(self.sent), 1)
            self.assertEqual(self.sent[0][1]['dtime'], '19:30')
            self.assertEqual(state['totalBooked'], 1)
            self.assertIn('Teacher 101', state['message'])
            self.assertIn('19:30', state['message'])
            self.assertEqual(state['checks'], 1)
            self.assertIn(self.day, state['fulfilledDates'])
            wait = (datetime.fromisoformat(state['nextCheckAt']) - self.moment).total_seconds()
            self.assertTrue(240 <= wait <= 360)
            self.round()
            self.assertEqual(len(self.sent), 1)
            self.assertEqual(self.state()['totalBooked'], 1)

    def test_saved_check_interval_is_used_after_each_round_and_interruption(self):
        with self.connected():
            interval = {'minMinutes': 2, 'maxMinutes': 5}
            self.assertEqual(self.configured(checkInterval=interval)['checkInterval'], interval)
            self.assertEqual(self.run_api('auto-booking/config')['checkInterval'], interval)
            self.start_auto()
            with patch.object(host.secrets, 'randbelow', side_effect=[0, 180]):
                for expected in (120, 300):
                    state = self.round()
                    self.assertEqual((datetime.fromisoformat(state['nextCheckAt']) - self.moment).total_seconds(), expected)
            self.scheduler.enqueue(self.plugin_id, self.child_id, 'auto-booking',
                                   state['epoch'] + ':' + str(state['step']), self.moment)
            self.sql("UPDATE lele.plugin_jobs SET status='failed' WHERE child_id=%s AND plugin_id=%s AND occurrence_key=%s",
                     (self.child_id, self.plugin_id, state['epoch'] + ':' + str(state['step'])))
            moment = self.moment + timedelta(minutes=6)
            with patch.object(host.secrets, 'randbelow', return_value=80):
                self.service.transaction(lambda cur: host.due(cur, self.context(), moment))
            self.assertEqual((datetime.fromisoformat(self.state()['nextCheckAt']) - moment).total_seconds(), 200)

    def test_legacy_save_request_keeps_original_check_interval_default(self):
        with self.connected():
            fields = host.defaults()
            fields.pop('checkInterval')
            result = self.run_api('auto-booking/config', 'PUT', {
                **fields, 'operationId': str(uuid.uuid4()), 'bindingRevision': 1, 'expectedRevision': 0})
            self.assertEqual(result['checkInterval'], {'minMinutes': 4, 'maxMinutes': 6})

    def test_existing_manual_lesson_blocks_automatic_even_at_other_time(self):
        with self.connected():
            self.live.append(self.fake.record(8801, self.day + ' 20:00'))
            self.configured()
            self.start_auto()
            self.round()
            self.assertEqual(self.sent, [])
            self.assertIn(self.day, self.state()['fulfilledDates'])

    def test_notification_keys_encrypted_at_rest_and_hidden_from_members(self):
        with self.connected():
            result = self.configured(notifications=deepcopy(self.notification_config))
            self.assertEqual(result['notifications'], self.notification_config)
            raw = json.dumps(self.state())
            for key in self.notification_config['barkKeys']:
                self.assertNotIn(key, raw)
            self.assertIn('ciphertext', raw)
            self.assertEqual(self.run_api('auto-booking/config')['notifications'], self.notification_config)
            previous_context = self.ctx
            self.ctx = {**self.ctx, 'actorId': str(uuid.uuid4())}
            try:
                public = self.run_api('auto-booking/config')
            finally:
                self.ctx = previous_context
            self.assertFalse(public['canManage'])
            self.assertEqual(public['notifications']['barkKeys'], ['已配置', '已配置'])

    def test_notifications_only_send_once_after_confirmed_booking_and_preserve_legacy_save(self):
        with self.connected(), patch.object(bark, 'push', return_value='succeeded') as push:
            self.configured(notifications=deepcopy(self.notification_config))
            config = self.run_api('auto-booking/config')
            legacy = {key: value for key, value in config.items() if key not in ('revision', 'canManage', 'notifications')}
            result = self.run_api('auto-booking/config', 'PUT', {
                **legacy, 'operationId': str(uuid.uuid4()), 'expectedRevision': config['revision']})
            self.assertEqual(result['notifications'], self.notification_config)
            self.start_auto()
            state = self.round()
            self.assertEqual(push.call_count, 1)
            notice = push.call_args.args[0]
            self.assertEqual(notice['keys'], self.notification_config['barkKeys'])
            self.assertIn(self.day, notice['body'])
            self.assertIn('19:30', notice['body'])
            self.assertIn('Teacher 101', notice['body'])
            self.assertEqual(next(iter(state['notificationQueue'].values()))['state'], 'succeeded')
            self.round()
            self.assertEqual(push.call_count, 1)
            self.assertEqual(len(self.sent), 1)
            self.assertEqual(self.state()['totalBooked'], 1)

    def test_notification_transport_failure_never_replays_booking_or_leaks_keys(self):
        with self.connected(), patch.object(bark, 'push', side_effect=TimeoutError('fixture_bark_key_A')) as push:
            self.configured(notifications=deepcopy(self.notification_config))
            self.start_auto()
            state = self.round()
            self.assertEqual(state['totalBooked'], 1)
            self.assertEqual(next(iter(state['notificationQueue'].values()))['state'], 'uncertain')
            self.round()
            self.assertEqual(push.call_count, 1)
            self.assertEqual(len(self.sent), 1)
            logs = self.run_api('auto-booking/logs')['items']
            self.assertTrue(any(item['kind'] == 'notification' and '未确认' in item['message'] for item in logs))
            self.assertNotIn('fixture_bark_key_A', json.dumps(logs))

    def test_disabled_notifications_do_not_send_after_success(self):
        with self.connected(), patch.object(bark, 'push') as push:
            self.configured(notifications={**deepcopy(self.notification_config), 'enabled': False})
            self.start_auto()
            self.round()
            self.assertEqual(self.state()['totalBooked'], 1)
            push.assert_not_called()

    def test_reconciled_success_after_stop_sends_notification_once(self):
        with self.connected(), patch.object(bark, 'push', return_value='succeeded') as push:
            self.configured(notifications=deepcopy(self.notification_config))
            self.start_auto()
            self.drop = 'onevoneAppointment'
            with patch.object(operations, 'reconcile_book', side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE', '回执尚未同步。')):
                self.round()
            push.assert_not_called()
            self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
            self.drop = None
            self.round()
            self.assertEqual(push.call_count, 1)
            self.assertFalse(self.state()['enabled'])
            self.assertIsNone(self.state()['nextCheckAt'])
            self.assertEqual(len(self.sent), 1)

    def test_notification_queued_before_worker_restart_delivers_after_stop(self):
        with self.connected(), patch.object(bark, 'push', return_value='succeeded') as push:
            self.configured(notifications=deepcopy(self.notification_config))
            self.start_auto()
            with patch.object(auto_booking, 'flush_notifications'):
                self.round()
            self.assertTrue(host.notifications.pending(self.state()))
            self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
            self.service.transaction(lambda cur: host.due(cur, self.context(), self.moment + timedelta(seconds=1)))
            self.step()
            self.assertEqual(push.call_count, 1)
            self.assertIsNone(self.state()['nextCheckAt'])
            self.assertFalse(self.state()['enabled'])

    def test_claimed_notification_is_not_resent_after_acknowledgement_loss(self):
        with self.connected(), patch.object(bark, 'push', return_value='succeeded') as push:
            self.configured(notifications=deepcopy(self.notification_config))
            self.start_auto()
            original = auto_booking.host

            def host_call(context, action, payload=None):
                if action == 'notification-finish':
                    raise auth.AuthError('UPSTREAM_UNAVAILABLE', '回执丢失。')
                return original(context, action, payload)

            with patch.object(auto_booking, 'host', side_effect=host_call):
                self.round()
            self.round()
            self.assertEqual(push.call_count, 1)
            self.assertEqual(next(iter(self.state()['notificationQueue'].values()))['state'], 'uncertain')

    def test_stopped_notification_batches_get_new_scheduler_occurrences_until_drained(self):
        with self.connected(), patch.object(bark, 'push', return_value='succeeded') as push, patch.object(
                self.gateway.runtime, 'call', side_effect=lambda context, method, args, **kwargs:
                handle_job(context, args['task'], args['payload'])):
            self.configured(notifications=deepcopy(self.notification_config))
            self.start_auto()
            with patch.object(auto_booking, 'flush_notifications'):
                self.round()

            def add_pending(cur):
                key, record, state, _ = host.load(cur, self.context_scope())
                original = next(iter(state['notificationQueue'].values()))
                for _ in range(3):
                    state['notificationQueue'][str(uuid.uuid4())] = deepcopy(original)
                host.save(cur, self.context_scope(), key, record, state)

            self.service.transaction(add_pending)
            self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
            self.scheduler.schedule_due()
            self.assertTrue(self.scheduler.run_one(self.plugin_id))
            self.assertEqual(push.call_count, 3)
            self.assertTrue(host.notifications.pending(self.state()))
            self.scheduler.schedule_due()
            self.assertTrue(self.scheduler.run_one(self.plugin_id))
            self.assertEqual(push.call_count, 4)
            self.assertFalse(host.notifications.pending(self.state()))
            self.assertIsNone(self.state()['nextCheckAt'])

    def test_transient_notification_claim_failure_after_stop_recovers_on_new_occurrence(self):
        with self.connected(), patch.object(bark, 'push', return_value='succeeded') as push, patch.object(
                self.gateway.runtime, 'call', side_effect=lambda context, method, args, **kwargs:
                handle_job(context, args['task'], args['payload'])):
            self.configured(notifications=deepcopy(self.notification_config))
            self.start_auto()
            with patch.object(auto_booking, 'flush_notifications'):
                self.round()
            self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
            original = auto_booking.host

            def fail_claim(context, action, payload=None):
                if action == 'notification-claim':
                    raise auth.AuthError('UPSTREAM_UNAVAILABLE', '短暂不可用。')
                return original(context, action, payload)

            self.scheduler.schedule_due()
            with patch.object(auto_booking, 'host', side_effect=fail_claim):
                self.assertTrue(self.scheduler.run_one(self.plugin_id))
            push.assert_not_called()
            self.scheduler.schedule_due()
            self.assertTrue(self.scheduler.run_one(self.plugin_id))
            self.assertEqual(push.call_count, 1)
            self.assertIsNone(self.state()['nextCheckAt'])

    def test_transient_empty_course_list_does_not_release_manual_reservation(self):
        with self.connected():
            self.live.append(self.fake.record(8801, self.day + ' 20:00'))
            self.configured()
            self.start_auto()
            self.round()
            self.live.clear()
            self.round()
            self.assertEqual(self.sent, [])

    def test_dashboard_counts_one_manual_lesson_on_a_two_lesson_target(self):
        with self.connected():
            draft = self.create_draft(['20:00'])
            self.assertEqual(self.run_api('bookings', 'POST', self.submit_body(draft))['state'], 'succeeded')
            other_day = (datetime.fromisoformat(self.day) + timedelta(days=1)).date().isoformat()
            self.live.append(self.fake.record(8801, other_day + ' 20:00'))
            self.configured(dailyLessons=2)
            self.start_auto()
            self.round()
            status = self.run_api('auto-booking/status')
            self.assertEqual(status['completedLessons'], 1)
            self.assertEqual(status['totalBooked'], 0)
            self.assertEqual(len(self.sent), 1)

    def test_two_lessons_require_one_contiguous_pair_and_disabled_rebook_keeps_day_closed(self):
        with self.connected():
            weekdays = host.defaults()['weekdaySlots']
            weekdays[str(datetime.fromisoformat(self.day).isoweekday())] = ['20:00', '19:30']
            self.configured(dailyLessons=2, rebookCancelled=False, weekdaySlots=weekdays)
            self.start_auto()
            state = self.round()
            self.assertEqual(len(self.sent), 1)
            self.assertEqual(self.sent[0][1]['dtime'], '19:30')
            self.assertEqual(self.sent[0][1]['lesson_period'], 2)
            self.assertEqual(state['totalBooked'], 2)
            self.round()
            status = self.run_api('auto-booking/status')
            self.assertEqual(status['completedLessons'], 2)
            self.assertEqual(status['totalBooked'], 2)
            original = self.live.pop()
            self.cancelled.append({'cid': original['cid'], 'dateTime': original['datestart'], 'teachername': original['teachername'], 'courseware_id': original['courseware_id']})
            self.round()
            self.assertEqual(len(self.sent), 1)
            status = self.run_api('auto-booking/status')
            self.assertEqual(status['completedLessons'], 1)
            self.assertEqual(status['totalBooked'], 2)
            self.cancelled.append({'cid': self.live.pop()['cid']})
            self.round()
            status = self.run_api('auto-booking/status')
            self.assertEqual(status['completedLessons'], 0)
            self.assertEqual(status['totalBooked'], 2)
            self.assertEqual(len(self.sent), 1)

    def test_dashboard_recovers_legacy_batch_total_from_receipt_during_list_lag(self):
        with self.connected():
            self.configured(dailyLessons=2)
            self.start_auto()
            self.round()
            self.sql("""UPDATE lele.plugin_private_records
SET payload=(payload - 'completedLessonCounts') || %s
WHERE child_id=%s AND plugin_id=%s AND collection='auto-booking'""",
                     (Jsonb({'totalBooked': 1, 'lastCheckAt': host.stamp(self.moment + timedelta(seconds=5))}),
                      self.child_id, self.plugin_id))
            self.live.clear()
            status = self.run_api('auto-booking/status')
            self.assertEqual(status['completedLessons'], 2)
            self.assertEqual(status['totalBooked'], 2)
            self.round()
            status = self.run_api('auto-booking/status')
            self.assertEqual(status['completedLessons'], 2)
            self.assertEqual(status['totalBooked'], 2)
            self.assertEqual(len(self.sent), 1)

    def test_confirmed_cancellation_reopens_date_and_counts_rebooking(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.round()
            original = self.live.pop()
            self.cancelled.append({'cid': original['cid'], 'dateTime': original['datestart'], 'teachername': original['teachername'], 'courseware_id': original['courseware_id']})
            self.round()
            self.assertEqual(len(self.sent), 2, self.state())
            self.assertEqual(self.state()['totalBooked'], 2)

    def check_grouped_cancellation(self, *, rebook, list_lag=False):
        from lele_growth.business_operations import default_data
        from lele_growth.child_service import STORE_FORMAT, STORE_VERSION, now_iso

        def initialize_child_store(cur):
            record = dict(format=STORE_FORMAT, version=STORE_VERSION, revision=0,
                          updatedAt=now_iso(), data=default_data('测试'))
            self.service.store.replace(cur, self.child_id, record['data'])
            self.service.store.metadata(cur, self.child_id, record, insert=True)

        self.service.transaction(initialize_child_store)
        self.grouped_bookings = True
        with self.connected():
            self.configured(dailyLessons=2, rebookCancelled=rebook)
            self.start_auto()
            if list_lag:
                with patch.object(operations, 'reconcile_book', side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE', '等待列表')):
                    initial = self.round()
                self.assertNotIn('evidence', initial['ledger'][self.day])
            else:
                initial = self.round()
                self.assertEqual(initial['ledger'][self.day]['evidence']['coursewareIds'], ['501', '502'])
                self.round()
            self.assertEqual(self.run_api('auto-booking/status')['completedLessons'], 2)
            self.assertEqual(len(self.live), 1)
            booking = self.run_api('bookings')['items'][0]
            self.run_api('bookings/'+booking['key']+'/cancel', 'POST', {
                'operationId':str(uuid.uuid4()), 'bindingRevision':1,
                'snapshotVersion':booking['snapshotVersion'], 'adjustLessons':False})
            self.assertEqual(self.live, [])
            self.round()
            appointments = [body for endpoint, body in self.sent if endpoint == 'onevoneAppointment']
            self.assertEqual([body['lesson_period'] for body in appointments], [2, 2] if rebook else [2])
            self.assertEqual(len(self.live), int(rebook))
            self.assertEqual(self.run_api('auto-booking/status')['completedLessons'], 2 if rebook else 0)

    def test_grouped_cancellation_with_rebooking(self):
        self.check_grouped_cancellation(rebook=True)

    def test_grouped_cancellation_without_rebooking(self):
        self.check_grouped_cancellation(rebook=False)

    def test_grouped_cancellation_with_rebooking_before_booking_identity_is_observed(self):
        self.check_grouped_cancellation(rebook=True, list_lag=True)

    def test_stop_between_selection_and_dispatch_prevents_new_booking(self):
        with self.connected():
            self.configured()
            self.start_auto()
            for _ in range(10):
                self.step()
                if self.state()['run']['cursor'].get('candidate'):
                    break
            self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
            self.assertFalse(self.state()['enabled'])
            self.assertIsNone(self.state()['nextCheckAt'])
            self.assertEqual(self.sent, [])

    def test_only_owner_can_enable_and_stale_config_is_rejected(self):
        with self.connected():
            self.configured()
            response = handle_request(self.ctx, 'auto-booking/start', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1, 'expectedRevision': 0})
            self.assertFalse(response['ok'])
            self.assertEqual(response['error']['code'], 'REVISION_CONFLICT')
            with patch.object(host, 'owner', return_value=False):
                response = handle_request(self.ctx, 'auto-booking/start', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1, 'expectedRevision': 1})
                self.assertFalse(response['ok'])
                self.assertEqual(response['error']['code'], 'OWNER_REQUIRED')

    def test_saved_snapshot_is_read_only_and_keeps_unopened_days(self):
        with self.connected():
            self.configured()
            self.start_auto()
            read = Client.call

            def call(client, endpoint, body):
                if endpoint == 'onevoneGetDaysAvailable':
                    return {'data': [1, 0]}
                return read(client, endpoint, body)

            with patch.object(Client, 'call', call):
                self.round()
            response = self.run_api('auto-booking/snapshot?teacherId=101')
            self.assertEqual([day['state'] for day in response['teacher']['days']], ['ready', 'unopened'])
            self.assertFalse(response['teacher']['bookingUnavailable'])
            self.assertEqual(self.sent, [])

    def test_large_schedules_can_match_the_last_teacher(self):
        with self.connected():
            teachers = range(101, 105)
            self.fake.favorite_rows = [self.fake.teacher(teacher) for teacher in teachers]
            self.configured(teachers=[{'id': str(teacher), 'name': f'Teacher {teacher}', 'avatarUrl': None}
                                      for teacher in teachers])
            self.start_auto()
            read = Client.call

            def call(client, endpoint, body):
                if endpoint == 'onevoneGetDaysAvailable':
                    return {'data': [1] * 14}
                result = read(client, endpoint, body)
                if endpoint == 'onevoneGetTeacherInfo':
                    result['data'].update(tid=body['tid'], name=f"Teacher {body['tid']}", all_date=[
                        {'dtime': f'{minute // 60:02d}:{minute % 60:02d}',
                         'is_dated': 0 if body['tid'] == 104 else 99}
                        for minute in range(5 * 60, 23 * 60, 30)
                    ])
                return result

            with patch.object(Client, 'call', call):
                for _ in range(10):
                    self.step()
                    cursor = self.state()['run']['cursor']
                    if cursor.get('candidate'):
                        break
                self.assertEqual(cursor['candidate']['teacher']['id'], '104')
                self.assertNotIn('schedules', cursor)
                self.round()

            self.assertEqual([(body['tid'], body['dtime']) for name, body in self.sent
                              if name == 'onevoneAppointment'], [(104, '19:30')])
            schedule = self.run_api('auto-booking/snapshot?teacherId=104')['teacher']
            self.assertEqual(len(schedule['days']), 14)
            self.assertEqual(len(schedule['days'][3]['slots']), 36)

    def test_sixty_day_snapshot_resumes_from_persisted_day_index(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.step()
            self.step()
            read = Client.call
            scanned = []
            bridge_call = auth.BridgeClient.call

            def drop_snapshot_reply(context, action, payload=None):
                result = bridge_call(context, action, payload)
                if action == 'autoBooking.snapshot-stage':
                    raise TimeoutError('snapshot bridge response was lost')
                return result

            def call(client, endpoint, body):
                if endpoint == 'onevoneGetDaysAvailable':
                    return {'data': [1] * 60}
                result = read(client, endpoint, body)
                if endpoint == 'onevoneGetTeacherInfo':
                    scanned.append(body['ddate'])
                    result['data']['all_date'] = [
                        {'dtime': f'{minute // 60:02d}:{minute % 60:02d}', 'is_dated': 0}
                        for minute in range(0, 24 * 60, 30)
                    ]
                    if len(scanned) == 30:
                        client.deadline = auto_booking.time.monotonic() + 5
                return result

            with patch.object(Client, 'call', call):
                with patch.object(auth.BridgeClient, 'call', side_effect=drop_snapshot_reply):
                    with self.assertRaisesRegex(RuntimeError, '进度暂未确认'):
                        self.step()
                checkpoint = self.state()
                self.assertIsNone(checkpoint['snapshot'])
                capture = checkpoint['run']['cursor']['capture']
                self.assertEqual(capture['dayIndex'], 30)
                self.assertNotIn('days', capture)

                self.sql("""UPDATE lele.plugin_jobs SET status='failed',lease_owner=NULL,lease_until=NULL
                            WHERE child_id=%s AND plugin_id=%s AND status='running'""",
                         (self.child_id, self.plugin_id))
                self.scheduler = PluginScheduler(self.service, self.gateway)
                with patch.object(auth.BridgeClient, 'call', side_effect=drop_snapshot_reply):
                    with self.assertRaisesRegex(RuntimeError, '进度暂未确认'):
                        self.step()
                self.assertEqual(len(scanned), 60)
                state = self.state()
                published = state['snapshot']['id']
                self.assertEqual(state['run']['cursor']['phase'], 'matching')
                self.sql("""UPDATE lele.plugin_jobs SET status='failed',lease_owner=NULL,lease_until=NULL
                            WHERE child_id=%s AND plugin_id=%s AND status='running'""",
                         (self.child_id, self.plugin_id))
                self.step()
                self.assertEqual(self.state()['snapshot']['id'], published)
                self.assertEqual(len(scanned), 60)
                self.assertEqual(len(set(scanned)), 60)
                self.round()

            snapshot = self.run_api('auto-booking/snapshot?teacherId=101')['teacher']
            self.assertEqual(len(snapshot['days']), 60)
            self.assertEqual(len(snapshot['days'][-1]['slots']), 48)
            self.assertEqual(len(self.sent), 1)

    def test_legacy_snapshot_is_readable_until_new_round_publishes(self):
        with self.connected():
            self.configured()
            self.start_auto()
            scope = self.context_scope()
            previous_id = uuid.uuid4().hex
            day = {'date': self.day, 'state': 'unopened', 'slots': []}

            def persist_legacy(cur):
                key, record, state, _ = host.load(cur, scope)
                state['snapshot'] = {'id': previous_id, 'checkedAt': host.stamp(),
                                     'configRevision': state['configRevision'], 'teachers': [
                                         {'id': '101', 'baseDate': self.day, 'dayCount': 1},
                                     ]}
                state['run'] = {'id': str(uuid.uuid4()), 'configRevision': state['configRevision'],
                                'cursor': {'phase': 'matching', 'schedules': {}}, 'startedAt': host.stamp()}
                private_store.put(cur, scope, host.SNAPSHOTS, host.snapshot_record_id(key, previous_id, '101'),
                                  {'schedule': {'baseDate': self.day, 'days': [day], 'bookingUnavailable': False}})
                host.save(cur, scope, key, record, state)

            self.service.transaction(persist_legacy)
            self.assertEqual(self.run_api('auto-booking/snapshot?teacherId=101')['teacher']['days'], [day])
            self.step()
            self.assertEqual(self.state()['run']['cursor']['phase'], 'inventory')
            self.assertEqual(self.run_api('auto-booking/status')['snapshot']['id'], previous_id)
            self.round()
            self.assertNotEqual(self.run_api('auto-booking/status')['snapshot']['id'], previous_id)
            self.assertEqual(self.sql("""SELECT count(*) FROM lele.plugin_private_records
                WHERE child_id=%s AND plugin_id=%s AND collection=%s AND record_id LIKE %s""",
                (self.child_id, self.plugin_id, host.SNAPSHOTS, '%:' + previous_id + ':%')), [(0,)])

    def test_unavailable_teacher_does_not_hide_other_teachers_or_change_their_date_windows(self):
        with self.connected():
            self.configured(teachers=[
                {'id': '101', 'name': 'Teacher 101', 'avatarUrl': None},
                {'id': '102', 'name': 'Teacher 102', 'avatarUrl': None},
            ])
            self.start_auto()
            read = Client.call

            def call(client, endpoint, body):
                if endpoint == 'onevoneGetDaysAvailable':
                    return {'data': [0, 0, 0] if body['tid'] == 101 else [1, 0]}
                if endpoint == 'onevoneGetTeacherInfo':
                    if body['tid'] == 101:
                        raise auth.AuthError('UPSTREAM_REJECTED', '该老师由于个人原因暂时无法预约')
                    return {'data': {**read(client, endpoint, body)['data'], 'tid': 102}}
                return read(client, endpoint, body)

            with patch.object(Client, 'call', call):
                state = self.round()
                self.assertIsNotNone(state['snapshot'], state['message'])
            with patch.object(Client, 'call', side_effect=AssertionError('stored snapshots need no upstream recheck')):
                unavailable = self.run_api('auto-booking/snapshot?teacherId=101')['teacher']
                other = self.run_api('auto-booking/snapshot?teacherId=102')['teacher']
            self.assertTrue(unavailable['bookingUnavailable'])
            self.assertEqual([day['state'] for day in unavailable['days']], ['unopened'] * 3)
            self.assertFalse(other['bookingUnavailable'])
            self.assertEqual([day['state'] for day in other['days']], ['ready', 'unopened'])
            self.assertEqual(self.sent, [])

    def test_sleep_start_is_deferred_and_stop_is_idempotent(self):
        with self.connected():
            self.configured(sleep={'enabled': True, 'start': '09:00', 'end': '11:00'})
            result = self.start_auto()
            self.assertEqual(result['state'], 'sleeping')
            self.assertIn('11:00:00', result['nextCheckAt'])
            body = {'operationId': str(uuid.uuid4()), 'bindingRevision': 1}
            self.run_api('auto-booking/stop', 'POST', body)
            self.run_api('auto-booking/stop', 'POST', body)
            self.assertFalse(self.state()['enabled'])

    def test_higher_teacher_beats_better_slot_of_lower_teacher(self):
        with self.connected():
            read = Client.call

            def call(client, endpoint, body):
                result = read(client, endpoint, body)
                if endpoint == 'onevoneGetTeacherInfo':
                    result['data'].update(tid=body['tid'], name='Teacher ' + str(body['tid']))
                    if body['tid'] == 101:
                        result['data']['all_date'][1]['is_dated'] = 999
                return result

            with patch.object(Client, 'call', call):
                self.configured(teachers=[{'id': '101', 'name': 'Teacher 101', 'avatarUrl': None}, {'id': '102', 'name': 'Teacher 102', 'avatarUrl': None}])
                self.start_auto()
                self.round()
            self.assertEqual(self.sent[0][1]['tid'], 101)
            self.assertEqual(self.sent[0][1]['dtime'], '19:00')

    def test_unavailable_draft_slot_tries_same_teacher_before_lower_priority_teacher(self):
        with self.connected():
            read = Client.call
            teacher_ids = ['101', '102']
            self.configured(teachers=[{'id': tid, 'name': 'Teacher ' + tid, 'avatarUrl': None} for tid in teacher_ids])
            self.start_auto()
            reads = 0

            def call(client, endpoint, body):
                nonlocal reads
                result = read(client, endpoint, body)
                if endpoint == 'onevoneGetTeacherInfo':
                    tid = body['tid']
                    result['data'].update(tid=tid, name=f'Teacher {tid}')
                    if tid == 101 and body['ddate'] == self.day:
                        reads += 1
                        if reads > 1:
                            result['data']['all_date'][1]['is_dated'] = 999
                return result

            with patch.object(Client, 'call', call):
                state = self.round()
            self.assertEqual(state['checks'], 1)
            self.assertEqual([(body['tid'], body['dtime']) for _, body in self.sent], [(101, '19:00')])

    def test_rejected_two_lesson_group_keeps_overlapping_backup_eligible(self):
        with self.connected():
            weekdays = host.defaults()['weekdaySlots']
            weekdays[str(datetime.fromisoformat(self.day).isoweekday())] = ['19:00', '19:30', '20:00']
            self.configured(dailyLessons=2, weekdaySlots=weekdays)
            self.start_auto()
            mutate = Client.mutate

            def reject_first(client, endpoint, body):
                if body['dtime'] == '19:00':
                    self.sent.append((endpoint, body))
                    raise auth.AuthError('UPSTREAM_REJECTED', '时段不可约')
                return mutate(client, endpoint, body)

            with patch.object(Client, 'mutate', reject_first):
                state = self.round()
            self.assertEqual(state['checks'], 1)
            self.assertEqual([(body['dtime'], body['lesson_period']) for _, body in self.sent], [('19:00', 2), ('19:30', 2)])

    def test_confirmed_unavailable_slot_excludes_all_overlapping_groups(self):
        with self.connected():
            weekdays = host.defaults()['weekdaySlots']
            weekdays[str(datetime.fromisoformat(self.day).isoweekday())] = ['19:00', '19:30', '20:00']
            self.configured(dailyLessons=2, weekdaySlots=weekdays)
            self.start_auto()
            slots = auto_booking.drafts.slots
            inspected = []

            def late_conflict(client, teacher_id, day, starts):
                inspected.append(starts)
                if len(inspected) == 3:
                    raise auto_booking.drafts.UnavailableSlots(['19:30'])
                return slots(client, teacher_id, day, starts)

            with patch.object(auto_booking.drafts, 'slots', late_conflict):
                self.round()
            self.assertEqual(self.sent, [])
            self.assertEqual(inspected, [['19:00', '19:30']] * 3)

    def test_failed_high_priority_teacher_query_never_falls_through(self):
        with self.connected():
            self.configured(teachers=[{'id': '101', 'name': 'Teacher 101', 'avatarUrl': None}, {'id': '102', 'name': 'Teacher 102', 'avatarUrl': None}])
            self.start_auto()
            read = Client.call

            def call(client, endpoint, body):
                if endpoint == 'onevoneGetTeacherInfo' and body['tid'] == 101:
                    raise auth.AuthError('UPSTREAM_UNAVAILABLE', '老师档期读取失败。')
                return read(client, endpoint, body)

            with patch.object(Client, 'call', call):
                state = self.round()
            self.assertEqual(self.sent, [])
            self.assertIn('读取失败', state['message'])

    def test_uncertain_booking_after_stop_reconciles_without_resending(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.drop = 'onevoneAppointment'
            with patch.object(operations, 'reconcile_book', side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE', '回执尚未同步。')):
                state = self.round()
            self.assertIsNotNone(state['pending'])
            self.assertEqual(self.run_api('auto-booking/status')['state'], 'stopped')
            self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
            state = self.round()
            self.assertIsNone(state['pending'])
            self.assertFalse(state['enabled'])
            self.assertEqual(state['totalBooked'], 1)
            self.assertEqual(len(self.sent), 1)

    def test_acknowledgement_of_partial_booking_releases_only_the_other_dates(self):
        with self.connected():
            later = (datetime.fromisoformat(self.day) + timedelta(days=7)).date().isoformat()
            self.configured(dailyLessons=2, dates=[self.day, later])
            self.start_auto()
            self.drop = 'onevoneAppointment'
            with patch.object(operations, 'reconcile_book', side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE', '回执尚未同步。')):
                pending = self.round()['pending']
            self.drop = None
            self.live.pop()
            operation_id = pending['operationId']
            path = 'operations/' + operation_id
            self.step()
            partial = self.run_api(path)
            self.assertEqual(partial['state'], 'partially_succeeded')
            self.assertEqual([lesson['startTime'] for lesson in partial['result']['bookingEvidence']], ['19:30'])
            status = self.run_api('auto-booking/status')
            self.assertEqual(status['completedLessons'], 1)
            self.assertEqual(status['totalBooked'], 1)
            self.sql('UPDATE lele.plugin_external_operations SET updated_at=%s WHERE operation_id=%s',
                     (self.moment - timedelta(seconds=61), operation_id))
            for _ in range(2):
                self.step()
            self.assertEqual(self.run_api(path)['stageVersion'], partial['stageVersion'])

            confirmation = {'bindingRevision': 1, 'confirmedInApp': True}
            receipt = self.run_api(path + '/acknowledge', 'POST', confirmation)
            self.assertEqual(receipt['state'], 'cancelled')
            self.assertEqual(receipt['result']['bookingEvidence'], partial['result']['bookingEvidence'])
            self.assertEqual(self.run_api(path + '/acknowledge', 'POST', confirmation), receipt)
            self.assertEqual(self.run_api('auto-booking/status')['totalBooked'], 1)
            state = self.state()
            self.assertTrue(state['enabled'])
            self.assertIsNone(state['pending'])
            self.assertIsNone(state['run'])
            self.assertEqual(state['closedDates'], [self.day])

            self.live.clear()  # A temporarily incomplete upstream list cannot reopen the closed date.
            self.scheduler = PluginScheduler(self.service, self.gateway)
            self.round()
            self.assertEqual([body['ddate'] for name, body in self.sent if name == 'onevoneAppointment'],
                             [self.day, later])

    def test_stopped_task_can_recover_a_cancelled_receipt_from_an_older_release(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.drop = 'onevoneAppointment'
            with patch.object(operations, 'reconcile_book', side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE', '回执尚未同步。')):
                pending = self.round()['pending']
            self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
            receipt = self.bridge.handle(self.ctx, 'operation.get', {'operationId': pending['operationId']})['data']
            self.service.transaction(lambda cur: external_operations.handle(
                cur, self.context_scope(), self.ctx, 'operation.finish',
                {'operationId': receipt['operationId'], 'canonicalRequest': receipt['canonicalRequest'],
                 'expectedStageVersion': receipt['stageVersion'], 'state': 'cancelled', 'result': {}},
            ))
            self.assertIsNotNone(self.state()['pending'])
            self.step()
            state = self.state()
            self.assertIsNone(state['pending'])
            self.assertIsNone(state['nextCheckAt'])
            self.assertEqual(state['phase'], 'stopped')
            self.assertEqual(state['closedDates'], [self.day])
            self.assertEqual(len(self.sent), 1)

    def test_repeated_acknowledgement_recovers_legacy_pending_without_a_scheduled_job(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.drop = 'onevoneAppointment'
            with patch.object(operations, 'reconcile_book', side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE', '回执尚未同步。')):
                pending = self.round()['pending']
            self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
            receipt = self.bridge.handle(self.ctx, 'operation.get', {'operationId': pending['operationId']})['data']
            scope = self.context_scope()

            def persist_legacy_closure(cur):
                external_operations.handle(
                    cur, scope, self.ctx, 'operation.finish',
                    {'operationId': receipt['operationId'], 'canonicalRequest': receipt['canonicalRequest'],
                     'expectedStageVersion': receipt['stageVersion'], 'state': 'cancelled', 'result': {}},
                )
                key, record, state, _ = host.load(cur, scope)
                state['nextCheckAt'] = None
                host.save(cur, scope, key, record, state)

            self.service.transaction(persist_legacy_closure)
            self.assertIsNotNone(self.state()['pending'])
            self.run_api(f"operations/{pending['operationId']}/acknowledge", 'POST',
                         {'bindingRevision': 1, 'confirmedInApp': True})
            self.assertIsNone(self.state()['pending'])
            self.assertIsNone(self.state()['nextCheckAt'])
            self.assertEqual(self.state()['closedDates'], [self.day])

    def test_manual_booking_between_selection_and_dispatch_blocks_second_lesson(self):
        with self.connected():
            self.configured()
            self.start_auto()
            for _ in range(10):
                self.step()
                if self.state()['run']['cursor'].get('candidate'):
                    break
            draft = self.create_draft(['19:00'])
            self.run_api('bookings', 'POST', self.submit_body(draft))
            with patch.object(operations, 'book', wraps=operations.book) as auto_book:
                self.round()
            self.assertEqual(auto_book.call_count, 1)
            self.assertEqual(len(self.sent), 1)

    def test_stale_job_cannot_resume_after_config_change(self):
        with self.connected():
            self.configured()
            self.start_auto()
            state = self.state()
            self.scheduler.enqueue(self.plugin_id, self.child_id, 'auto-booking', state['epoch'] + ':' + str(state['step']), datetime.now(host.TZ) - timedelta(seconds=1))
            job = self.scheduler.claim(self.plugin_id)
            self.configured()
            with self.assertRaises(auth.AuthError) as failure:
                handle_job(job['context'], 'auto-booking', {})
            self.assertEqual(failure.exception.code, 'AUTO_BOOKING_CHANGED')
            self.assertEqual(self.sent, [])

    def test_duplicate_job_lease_and_forbidden_background_action_are_rejected(self):
        with self.connected():
            self.configured()
            self.start_auto()
            state = self.state()
            self.scheduler.enqueue(self.plugin_id, self.child_id, 'auto-booking', state['epoch'] + ':' + str(state['step']), datetime.now(host.TZ) - timedelta(seconds=1))
            job = self.scheduler.claim(self.plugin_id)
            with self.assertRaises(ApiError):
                self.bridge.handle(job['context'], 'session.disconnect', {})
            with self.assertRaises(ApiError):
                self.bridge.handle(job['context'], 'private.put', {'collection': 'booking-draft', 'recordId': 'manual', 'payload': {}})
            with self.assertRaises(ApiError):
                self.bridge.handle({**job['context'], 'jobAttempt': job['attempt'] + 1}, 'autoBooking.begin', {})

    def test_logs_paginate_and_counters_survive_stop_start(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.round()
            for _ in range(34):
                self.configured()
            page = self.run_api('auto-booking/logs')
            self.assertEqual(len(page['items']), 30)
            self.assertIsNotNone(page['nextCursor'])
            following = self.run_api('auto-booking/logs?cursor=' + quote(page['nextCursor'], safe=''))
            self.assertTrue(following['items'])
            self.assertFalse({row['id'] for row in page['items']} & {row['id'] for row in following['items']})
            self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
            self.start_auto()
            self.assertEqual(self.state()['totalBooked'], 1)
            self.assertEqual(self.state()['checks'], 1)

    def test_log_retention_purges_expired_and_keeps_active_logs(self):
        with self.connected():
            current = self.context_scope()
            expired_id = 'cleanup-expired-' + uuid.uuid4().hex
            active_id = 'cleanup-active-' + uuid.uuid4().hex
            self.service.transaction(lambda cur: private_store.put(
                cur, current, 'auto-booking-log', expired_id, {'id': expired_id},
                expires_at=host.now() - timedelta(seconds=1)))
            self.service.transaction(lambda cur: private_store.put(
                cur, current, 'auto-booking-log', active_id, {'id': active_id},
                expires_at=host.now() + timedelta(days=host.LOG_RETENTION_DAYS)))
            deleted = self.service.transaction(lambda cur: host.cleanup_logs(cur, current))
            self.assertEqual(deleted, 1)
            self.assertIsNone(self.service.transaction(lambda cur: private_store.get(
                cur, current, 'auto-booking-log', expired_id, include_expired=True)))
            self.assertIsNotNone(self.service.transaction(lambda cur: private_store.get(
                cur, current, 'auto-booking-log', active_id, include_expired=True)))

    def test_daily_sync_task_cleans_expired_logs(self):
        with self.connected(), patch('mison_booking.course_sync.handle_job', return_value={'state': 'waiting'}) as sync_job:
            current = self.context_scope()
            expired_id = 'daily-cleanup-' + uuid.uuid4().hex
            self.service.transaction(lambda cur: private_store.put(
                cur, current, 'auto-booking-log', expired_id, {'id': expired_id},
                expires_at=host.now() - timedelta(seconds=1)))
            self.scheduler.enqueue(self.plugin_id, self.child_id, 'sync-courses', 'cleanup-test',
                                  datetime.now(host.TZ) - timedelta(seconds=1))
            job = self.scheduler.claim(self.plugin_id)
            self.assertIsNotNone(job)
            result = handle_job(job['context'], 'sync-courses', {})
            self.scheduler.complete(job, result)
            sync_job.assert_called_once()
            self.assertIsNone(self.service.transaction(lambda cur: private_store.get(
                cur, current, 'auto-booking-log', expired_id, include_expired=True)))

    def test_cleanup_logs_is_job_only(self):
        with self.connected():
            with self.assertRaises(ApiError):
                self.service.transaction(lambda cur: host.handle(
                    cur, self.context_scope(), self.ctx, 'autoBooking.cleanup-logs', {}))

    def test_unselected_dates_keep_manual_occupancy_evidence(self):
        with self.connected():
            self.live.append(self.fake.record(8801, self.day + ' 20:00'))
            self.configured()
            self.start_auto()
            self.round()
            other_day = (datetime.fromisoformat(self.day) + timedelta(days=7)).date().isoformat()
            self.live.append(self.fake.record(8802, other_day + ' 20:00'))
            self.configured(dates=[other_day])
            self.round()
            self.configured()
            self.live.clear()
            self.start_auto()
            self.round()
            self.assertEqual(self.sent, [])

    def test_malformed_existing_course_date_never_allows_new_booking(self):
        with self.connected():
            self.live.append({**self.fake.record(8801), 'datestart': None})
            self.configured()
            self.start_auto()
            state = self.round()
            self.assertEqual(self.sent, [])
            self.assertIn('日期', state['message'])

    def test_more_than_five_completed_pages_do_not_prevent_future_booking(self):
        with self.connected():
            read = Client.call

            def call(client, endpoint, body):
                if endpoint == 'getBackList':
                    record = self.fake.record(body['page_no'], '2020-01-01 19:00')
                    return {'data': {'list': [record], 'allPage': 6, 'lastPage': body['page_no'] == 6}}
                return read(client, endpoint, body)

            self.configured()
            self.start_auto()
            with patch.object(Client, 'call', call):
                self.round()
            self.assertEqual(len(self.sent), 1)

    def test_plugin_generation_change_stops_old_strategy_before_writes(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.sql('UPDATE lele.child_plugins SET generation=generation+1 WHERE child_id=%s AND plugin_id=%s', (self.child_id, self.plugin_id))
            self.service.transaction(lambda cur: host.due(cur, self.context(), self.moment + timedelta(seconds=1)))
            self.assertFalse(self.state()['enabled'])
            self.assertEqual(self.sent, [])

    def test_pending_receipt_survives_generation_change_as_read_only(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.drop = 'onevoneAppointment'
            with patch.object(operations, 'reconcile_book', side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE', '回执尚未同步。')):
                self.round()
            self.sql('UPDATE lele.child_plugins SET generation=generation+1 WHERE child_id=%s AND plugin_id=%s', (self.child_id, self.plugin_id))
            self.ctx = {**self.context(), 'actorId': self.user_id}
            self.service.transaction(lambda cur: host.due(cur, self.context(), self.moment + timedelta(seconds=1)))
            self.assertFalse(self.state()['enabled'])
            self.round()
            self.assertIsNone(self.state()['pending'])
            self.assertEqual(len(self.sent), 1)

    def test_restart_after_success_receipt_and_before_checkpoint_never_resends(self):
        with self.connected():
            self.configured()
            self.start_auto()
            for _ in range(10):
                self.step()
                if self.state()['run']['cursor'].get('candidate'):
                    break
            with patch.object(auto_booking, 'checkpoint', side_effect=RuntimeError('worker stopped')):
                with self.assertRaises(RuntimeError):
                    self.step()
            self.assertEqual(self.state()['totalBooked'], 1)
            self.sql("UPDATE lele.plugin_jobs SET status='failed',lease_until=NULL,lease_owner=NULL WHERE child_id=%s AND plugin_id=%s AND status='running'", (self.child_id, self.plugin_id))
            self.service.transaction(lambda cur: host.due(cur, self.context(), self.moment + timedelta(seconds=2)))
            self.live.clear()
            self.round()
            self.assertEqual(len(self.sent), 1)
            self.assertEqual(self.state()['totalBooked'], 1)

    def test_restart_recovers_failed_receipt_and_tries_backup_once(self):
        with self.connected():
            self.configured()
            self.start_auto()
            for _ in range(10):
                self.step()
                if self.state()['run']['cursor'].get('candidate'):
                    break
            self.assertEqual(self.state()['run']['cursor']['candidate']['time'], '19:30')
            mutate = Client.mutate
            save_progress = auto_booking.save_progress

            def reject_first(client, endpoint, body):
                if body['dtime'] == '19:30':
                    self.sent.append((endpoint, body))
                    raise auth.AuthError('UPSTREAM_REJECTED', '时段不可约')
                return mutate(client, endpoint, body)

            def interrupt_before_outcome(context, action, payload):
                if action == 'outcome':
                    raise RuntimeError('worker stopped after recording upstream rejection')
                return save_progress(context, action, payload)

            with patch.object(Client, 'mutate', reject_first):
                with patch.object(auto_booking, 'save_progress', interrupt_before_outcome):
                    with self.assertRaisesRegex(RuntimeError, 'worker stopped'):
                        self.step()
                self.assertIsNotNone(self.state()['pending'])
                self.sql("""UPDATE lele.plugin_jobs SET status='retry',lease_until=NULL,lease_owner=NULL,due_at=now()-interval '1 second'
WHERE child_id=%s AND plugin_id=%s AND status='running'""", (self.child_id, self.plugin_id))
                self.round()
            self.assertEqual([body['dtime'] for _, body in self.sent], ['19:30', '19:00'])

    def test_two_children_cannot_enable_the_same_account(self):
        with self.connected():
            self.configured()
            self.start_auto()
            context = self.peer_context()
            with patch.object(self, 'ctx', context):
                self.configured()
                response = handle_request(context, 'auto-booking/start', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1, 'expectedRevision': 1})
                self.assertEqual(response['error']['code'], 'AUTO_BOOKING_ACCOUNT_BUSY')

    def test_closed_appointment_date_is_protected_for_another_child_on_the_same_account(self):
        self.check_closed_date_across_children(legacy=False)

    def test_legacy_cancelled_receipt_protects_other_children_before_reconciliation(self):
        self.check_closed_date_across_children(legacy=True)

    def check_closed_date_across_children(self, *, legacy):
        with self.connected():
            self.configured()
            self.start_auto()
            self.drop = 'onevoneAppointment'
            with patch.object(operations, 'reconcile_book', side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE', '回执尚未同步。')):
                pending = self.round()['pending']
            self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
            if legacy:
                receipt = self.bridge.handle(self.ctx, 'operation.get', {'operationId': pending['operationId']})['data']
                self.service.transaction(lambda cur: external_operations.handle(
                    cur, self.context_scope(), self.ctx, 'operation.finish',
                    {'operationId': receipt['operationId'], 'canonicalRequest': receipt['canonicalRequest'],
                     'expectedStageVersion': receipt['stageVersion'], 'state': 'cancelled', 'result': {}},
                ))
                self.assertIsNotNone(self.state()['pending'])
            else:
                self.sql('UPDATE lele.plugin_external_operations SET updated_at=%s WHERE operation_id=%s',
                         (self.moment - timedelta(seconds=61), pending['operationId']))
                self.run_api(f"operations/{pending['operationId']}/acknowledge", 'POST',
                             {'bindingRevision': 1, 'confirmedInApp': True})
            self.live.clear()
            self.drop = None
            context = self.peer_context()
            with patch.object(self, 'ctx', context), patch.object(self, 'child_id', context['childId']):
                self.configured()
                self.start_auto()
                self.round()
                self.assertEqual(self.state()['totalBooked'], 0)
                self.assertEqual(len(self.sent), 1)

    def test_owner_transfer_reconciles_pending_without_restoring_write_authority(self):
        with self.connected(), patch.object(bark, 'push', return_value='succeeded') as push:
            self.configured(notifications=deepcopy(self.notification_config))
            self.start_auto()
            self.drop = 'onevoneAppointment'
            with patch.object(operations, 'reconcile_book', side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE', '回执尚未同步。')):
                self.round()
            successor = str(uuid.uuid4())

            def transfer(cur):
                cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status,must_change_password) VALUES(%s,%s,'successor','unused','parent','active',false)", (successor, 'auto-' + successor))
                cur.execute('INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES(%s,%s,%s)', (self.child_id, successor, str(uuid.uuid4())))
                cur.execute('UPDATE lele.children SET owner_id=%s WHERE id=%s', (successor, self.child_id))

            self.service.transaction(transfer)
            self.service.transaction(lambda cur: host.due(cur, self.context(), self.moment + timedelta(seconds=1)))
            self.round()
            self.assertFalse(self.state()['enabled'])
            self.assertEqual(self.state()['ownerId'], successor)
            self.assertIsNone(self.state()['pending'])
            self.assertEqual(len(self.sent), 1)
            push.assert_not_called()
            self.ctx = {**self.ctx, 'actorId': successor}
            self.assertEqual(self.run_api('auto-booking/config')['notifications'], host.notifications.defaults())

    def test_contradictory_pagination_never_allows_automatic_booking(self):
        with self.connected():
            self.configured()
            self.start_auto()
            read = Client.call

            def call(client, endpoint, body):
                if endpoint == 'getLiveList':
                    return {'data': {'list': [], 'allPage': 2, 'lastPage': True}}
                return read(client, endpoint, body)

            with patch.object(Client, 'call', call):
                state = self.round()
            self.assertEqual(self.sent, [])
            self.assertIn('分页', state['message'])

    def test_conflicting_cancellation_cid_never_releases_confirmed_receipt(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.round()
            original = self.live.pop()
            self.cancelled.append({'cid': original['cid'] - 1, 'dateTime': original['datestart'], 'teachername': original['teachername'], 'courseware_id': original['courseware_id']})
            self.round()
            self.assertEqual(len(self.sent), 1)

    def test_cancellation_without_cid_uses_captured_booking_identity(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.round()
            original = self.live.pop()
            self.cancelled.append({'courseid': original['courseid'], 'dateTime': original['datestart'],
                                   'teachername': original['teachername'], 'courseware_id': original['courseware_id']})
            self.round()
            self.assertEqual(len(self.sent), 2)

    def test_unknown_receipt_reconciles_completed_lesson_after_downtime(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.drop = 'onevoneAppointment'
            with patch.object(operations, 'reconcile_book', side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE', '回执尚未同步。')):
                self.round()
            completed = self.live.pop()
            read = Client.call

            def call(client, endpoint, body):
                if endpoint == 'getBackList':
                    return {'data': {'list': [completed], 'allPage': 1, 'lastPage': True}}
                return read(client, endpoint, body)

            later = self.moment + timedelta(days=5)
            with patch.object(read_api, 'now', return_value=later), patch.object(host, 'now', return_value=later), patch.object(Client, 'call', call):
                self.round()
            self.assertIsNone(self.state()['pending'])
            self.assertEqual(self.state()['totalBooked'], 1)
            self.assertEqual(len(self.sent), 1)

    def test_rate_limit_respects_retry_delay_without_submitting(self):
        with self.connected():
            self.configured()
            self.start_auto()
            read = Client.call

            def call(client, endpoint, body):
                if endpoint == 'onevoneGetDaysAvailable':
                    raise auth.AuthError('UPSTREAM_RATE_LIMITED', '稍后检查。', retry_after=900)
                return read(client, endpoint, body)

            with patch.object(Client, 'call', call):
                state = self.round()
            self.assertEqual((datetime.fromisoformat(state['nextCheckAt']) - self.moment).total_seconds(), 900)
            self.assertEqual(self.sent, [])

    def test_partial_course_list_never_discards_other_manual_holds(self):
        with self.connected():
            first = self.fake.record(8801, self.day + ' 20:00')
            second = self.fake.record(8802, self.day + ' 19:00')
            self.live.extend([first, second])
            self.configured()
            self.start_auto()
            self.round()
            self.live.remove(first)
            self.round()
            self.live.clear()
            self.cancelled.append({'cid': second['cid'], 'dateTime': second['datestart'],
                                   'teachername': second['teachername'], 'courseware_id': second['courseware_id']})
            self.round()
            self.assertEqual(self.sent, [])
            self.assertIn(self.day, self.state()['fulfilledDates'])

    def test_quota_rejection_stops_before_trying_another_candidate(self):
        with self.connected():
            self.configured()
            self.start_auto()

            def reject(client, endpoint, body):
                self.sent.append((endpoint, body))
                raise auth.AuthError('UPSTREAM_REJECTED', '课时不足，请先续费。')

            with patch.object(Client, 'mutate', reject):
                state = self.round()
            self.assertFalse(state['enabled'])
            self.assertIn('课时不足', state['message'])
            self.assertEqual(len(self.sent), 1)


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite([loader.loadTestsFromTestCase(AutoBookingRulesTests)])
    suite.addTests(AutoBookingApiTests(name) for name in AutoBookingApiTests.__dict__ if name.startswith('test_'))
    return suite


if __name__ == '__main__':
    unittest.main()

"""Automatic booking against isolated PostgreSQL and synthetic upstream data."""
from copy import deepcopy
from datetime import datetime, timedelta
import unittest
import uuid
from urllib.parse import quote
from unittest.mock import patch

from psycopg.types.json import Jsonb
from tests.backend import test_mison_booking as booking_fixture
from lele_growth.child_service import ApiError
from lele_growth.plugins import auto_booking as host
from lele_growth.plugins.catalog import register_release
from lele_growth.plugins.scheduler import PluginScheduler
from mison_booking import auto_booking, handle_job, handle_request, read_api
from mison_booking import auth, operations
from mison_booking.upstream import Client


class AutoBookingRulesTests(unittest.TestCase):
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


class AutoBookingApiTests(booking_fixture.BookingApiTests):
    def setUp(self):
        super().setUp()
        self.plugin_id = 'mison-booking'
        self.data.update(id=self.plugin_id, version='1.1.' + str(uuid.uuid4().int))
        self.data['platformApi']['minMinor'] = 3
        self.data['capabilities'].append('plugin.jobs.schedule')
        self.data['tasks'] = [{'id': 'auto-booking', 'intervalSeconds': 300, 'timeoutSeconds': 60, 'misfirePolicy': 'latest'}]

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
        fields['weekdaySlots'][str(datetime.fromisoformat(self.day).isoweekday())] = ['19:30', '19:00'] if changes.get('dailyLessons', 1) == 1 else ['19:30', '20:00']
        return self.run_api('auto-booking/config', 'PUT', {**fields, 'operationId': str(uuid.uuid4()), 'bindingRevision': 1, 'expectedRevision': config['revision']})

    def start_auto(self):
        config = self.run_api('auto-booking/config')
        return self.run_api('auto-booking/start', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1, 'expectedRevision': config['revision']})

    def state(self):
        return self.service.transaction(lambda cur: host.load(cur, self.context_scope())[2])

    def context_scope(self):
        return {'plugin_id': self.plugin_id, 'child_id': self.child_id}

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
            self.assertEqual(state['checks'], 1)
            self.assertIn(self.day, state['fulfilledDates'])
            wait = (datetime.fromisoformat(state['nextCheckAt']) - self.moment).total_seconds()
            self.assertTrue(240 <= wait <= 360)
            self.round()
            self.assertEqual(len(self.sent), 1)
            self.assertEqual(self.state()['totalBooked'], 1)

    def test_existing_manual_lesson_blocks_automatic_even_at_other_time(self):
        with self.connected():
            self.live.append(self.fake.record(8801, self.day + ' 20:00'))
            self.configured()
            self.start_auto()
            self.round()
            self.assertEqual(self.sent, [])
            self.assertIn(self.day, self.state()['fulfilledDates'])

    def test_transient_empty_course_list_does_not_release_manual_reservation(self):
        with self.connected():
            self.live.append(self.fake.record(8801, self.day + ' 20:00'))
            self.configured()
            self.start_auto()
            self.round()
            self.live.clear()
            self.round()
            self.assertEqual(self.sent, [])

    def test_two_lessons_require_one_contiguous_pair_and_disabled_rebook_keeps_day_closed(self):
        with self.connected():
            self.configured(dailyLessons=2, rebookCancelled=False)
            self.start_auto()
            state = self.round()
            self.assertEqual(len(self.sent), 1)
            self.assertEqual(self.sent[0][1]['dtime'], '19:30')
            self.assertEqual(self.sent[0][1]['lesson_period'], 2)
            self.assertEqual(state['totalBooked'], 1)
            original = self.live.pop()
            self.cancelled.append({'cid': original['cid'], 'dateTime': original['datestart'], 'teachername': original['teachername'], 'courseware_id': original['courseware_id']})
            self.round()
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

    def test_schedule_pages_are_read_only_and_do_not_hide_unopened_days(self):
        with self.connected():
            self.configured()
            end = (self.moment.date() + timedelta(days=22)).isoformat()
            response = self.run_api('auto-booking/schedules?teacherId=101&from=' + self.day + '&to=' + end)
            self.assertEqual(len(response['days']), 2)
            self.assertIsNotNone(response['nextCursor'])
            final = self.run_api('auto-booking/schedules?teacherId=101&from=' + end + '&to=' + end)
            self.assertEqual(final['days'][0]['state'], 'unopened')
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
            self.round()
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

    def test_two_children_cannot_enable_the_same_account(self):
        with self.connected():
            self.configured()
            self.start_auto()
            peer = str(uuid.uuid4())

            def fixture(cur):
                cur.execute("INSERT INTO lele.children(id,name,owner_id) VALUES(%s,'auto-peer',%s)", (peer, self.user_id))
                cur.execute('INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES(%s,%s,%s)', (peer, self.user_id, str(uuid.uuid4())))
                cur.execute('INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled) VALUES(%s,%s,true,true)', (peer, self.plugin_id))
                cur.execute('INSERT INTO lele.child_plugin_configs(child_id,plugin_id,config,config_revision) VALUES(%s,%s,%s,1)', (peer, self.plugin_id, Jsonb({'message': 'ok'})))

            self.service.transaction(fixture)
            from lele_growth.plugins.policy import active_context
            context = self.service.transaction(lambda cur: active_context(cur, self.plugin_id, peer))
            context['actorId'] = self.user_id
            self.addCleanup(lambda: self.sql('DELETE FROM lele.plugin_private_records WHERE child_id=%s AND plugin_id=%s', (peer, self.plugin_id)))
            self.assertTrue(handle_request(context, 'connection/login', 'POST', {**self.body, 'operationId': str(uuid.uuid4())})['ok'])
            original_context = self.ctx
            try:
                self.ctx = context
                self.configured()
                response = handle_request(context, 'auto-booking/start', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1, 'expectedRevision': 1})
                self.assertEqual(response['error']['code'], 'AUTO_BOOKING_ACCOUNT_BUSY')
            finally:
                self.ctx = original_context

    def test_owner_transfer_reconciles_pending_without_restoring_write_authority(self):
        with self.connected():
            self.configured()
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

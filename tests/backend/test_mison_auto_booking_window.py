"""Automatic check-window boundaries using guarded DB fixtures and fake Mison calls."""
from datetime import datetime, timedelta
import unittest
import uuid
from unittest.mock import patch

from tests.backend.test_mison_auto_booking import AutoBookingApiTests
from lele_growth.plugins import auto_booking as host
from mison_booking import auto_booking, auth, bark, operations, read_api
from mison_booking.upstream import Client


class CheckWindowRulesTests(unittest.TestCase):
    def test_complement_windows_and_all_day_keep_existing_config_contract(self):
        for sleep, active_hours in (
                ({'enabled': True, 'start': '23:00', 'end': '08:00'}, range(8, 23)),
                ({'enabled': True, 'start': '08:00', 'end': '23:00'}, (*range(8), 23)),
                ({'enabled': True, 'start': '15:00', 'end': '13:00'}, (13, 14)),
                ({'enabled': False, 'start': '23:00', 'end': '08:00'}, range(24))):
            config = host.validate_config({**host.defaults(), 'sleep': sleep})
            for hour in range(24):
                with self.subTest(sleep=sleep, hour=hour):
                    moment = datetime(2026, 11, 19, hour, tzinfo=host.TZ)
                    self.assertEqual(host.quiet_until(config, moment) is None, hour in active_hours)


class CheckWindowApiTests(AutoBookingApiTests):
    def setUp(self):
        super().setUp()
        # The scheduler scans every installed child. Retire these fixtures so
        # later suites do not spend their bounded scan on our completed cases.
        self.addCleanup(lambda: self.sql('UPDATE lele.child_plugins SET enabled=false WHERE child_id=%s AND plugin_id=%s',
                                        (self.child_id, self.plugin_id)))

    def clock(self, moments):
        patch.object(host, 'now', side_effect=lambda: moments[0]).start()
        patch.object(read_api, 'now', side_effect=lambda: moments[0]).start()

    def closing(self):
        return self.moment.replace(hour=23)

    def opening(self):
        return (self.moment + timedelta(days=1)).replace(hour=8)

    def assert_deferred(self):
        state = self.state()
        self.assertIsNone(state['run'])
        self.assertEqual(datetime.fromisoformat(state['nextCheckAt']), self.opening())
        return state

    def test_queued_occurrence_skips_at_closing_and_new_occurrence_resumes_at_opening(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.step()
            previous = self.state()['step']
            moments = [self.closing()]
            self.clock(moments)
            with patch.object(Client, 'call', side_effect=AssertionError('Mison outside window')):
                self.assertEqual(self.step(), {'state': 'skipped'})
            self.assertGreater(self.assert_deferred()['step'], previous)
            self.assertIsNone(self.service.transaction(lambda cur: host.due(cur, self.context(), moments[0])))
            moments[0] = self.opening()
            self.assertIsNotNone(self.service.transaction(lambda cur: host.due(cur, self.context(), moments[0])))
            self.assertEqual(self.step()['state'], 'continuing')

    def test_pending_defers_with_running_or_stopped_task_and_reconciles_once_when_open(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.drop = 'onevoneAppointment'
            with patch.object(operations, 'reconcile_book', side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE', '回执尚未同步。')):
                pending = self.round()['pending']
            self.assertIsNotNone(pending)
            moments = [self.closing()]
            self.clock(moments)
            for stopped in (False, True):
                if stopped:
                    self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
                with patch.object(Client, 'call', side_effect=AssertionError('Mison outside window')):
                    self.assertIsNone(self.service.transaction(lambda cur: host.due(cur, self.context(), moments[0])))
                    self.assertEqual(self.step(), {'state': 'skipped'})
                self.assertEqual(self.assert_deferred()['pending'], pending)
            moments[0] = self.opening()
            self.round()
            self.assertIsNone(self.state()['pending'])
            self.assertFalse(self.state()['enabled'])
            self.assertEqual(self.state()['totalBooked'], 1)
            self.assertEqual(len(self.sent), 1)

    def test_inventory_rechecks_admission_between_calls_and_manual_reads_stay_available(self):
        with self.connected():
            self.configured()
            self.start_auto()
            moments = [self.moment]
            self.clock(moments)
            read = Client.call
            calls = []

            def call(client, endpoint, body):
                calls.append(endpoint)
                result = read(client, endpoint, body)
                moments[0] = self.closing()
                return result

            with patch.object(Client, 'call', call):
                self.assertEqual(self.step(), {'state': 'changed'})
            self.assertEqual(calls, ['getLiveList'])
            self.assert_deferred()
            self.assertEqual(self.sent, [])
            self.assertIn('data', Client(self.ctx).call('getLiveList', {}))

    def test_contract_bootstrap_rechecks_admission_before_second_call(self):
        with self.connected():
            self.configured()
            self.start_auto()
            read_api.memo.values.clear()
            read_api.memo.size = 0
            moments = [self.moment]
            self.clock(moments)
            read = Client.call
            calls = []

            def call(client, endpoint, body):
                calls.append(endpoint)
                result = read(client, endpoint, body)
                moments[0] = self.closing()
                return result

            with patch.object(Client, 'call', call):
                self.assertEqual(self.step(), {'state': 'changed'})
            self.assertEqual(calls, ['myOneToOneList'])
            self.assert_deferred()

    def test_stop_between_inventory_calls_revokes_automatic_reads(self):
        with self.connected():
            self.configured()
            self.start_auto()
            read = Client.call
            calls = []

            def call(client, endpoint, body):
                calls.append(endpoint)
                result = read(client, endpoint, body)
                self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
                return result

            with patch.object(Client, 'call', call):
                self.assertEqual(self.step(), {'state': 'changed'})
            self.assertEqual(calls, ['getLiveList'])
            self.assertFalse(self.state()['enabled'])
            self.assertEqual(self.sent, [])

    def test_snapshot_guard_at_closing_defers_occurrence_without_waiting_for_scheduler(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.step()
            self.step()
            self.assertEqual(self.state()['run']['cursor']['phase'], 'snapshot')
            moments = [self.moment]
            self.clock(moments)
            read = Client.call
            calls = []

            def call(client, endpoint, body):
                calls.append(endpoint)
                result = read(client, endpoint, body)
                moments[0] = self.closing()
                return result

            with patch.object(Client, 'call', call):
                self.assertEqual(self.step(), {'state': 'changed'})
            self.assertEqual(calls, ['onevoneGetDaysAvailable'])
            self.assert_deferred()
            moments[0] = self.opening()
            self.assertIsNotNone(self.service.transaction(lambda cur: host.due(cur, self.context(), moments[0])))
            self.assertEqual(self.step()['state'], 'continuing')

    def test_pending_reconciliation_rechecks_each_page_and_keeps_receipt_on_closing(self):
        with self.connected():
            self.configured()
            self.start_auto()
            self.drop = 'onevoneAppointment'
            with patch.object(operations, 'reconcile_book', side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE', '回执尚未同步。')):
                pending = self.round()['pending']
            moments = [self.moment]
            self.clock(moments)
            read = Client.call
            calls = []

            def call(client, endpoint, body):
                calls.append(endpoint)
                if endpoint == 'getLiveList':
                    moments[0] = self.closing()
                    return {'data': {'list': [], 'allPage': 2, 'lastPage': False}}
                return read(client, endpoint, body)

            with patch.object(Client, 'call', call):
                self.assertEqual(self.step(), {'state': 'changed'})
            self.assertEqual(calls, ['getLiveList'])
            self.assertEqual(self.assert_deferred()['pending'], pending)
            moments[0] = self.opening()
            self.round()
            self.assertIsNone(self.state()['pending'])
            self.assertEqual(len(self.sent), 1)

    def test_all_day_and_overnight_windows_admit_at_midnight(self):
        with self.connected():
            moments = [self.moment.replace(hour=23, minute=59, second=59)]
            self.clock(moments)
            for sleep in ({'enabled': False, 'start': '23:00', 'end': '08:00'},
                          {'enabled': True, 'start': '08:00', 'end': '23:00'}):
                self.configured(sleep=sleep)
                self.start_auto()
                self.assertIsNotNone(self.service.transaction(lambda cur: host.due(cur, self.context(), moments[0])))
                self.assertEqual(self.step()['state'], 'continuing')
                moments[0] = self.moment + timedelta(days=1)
                moments[0] = moments[0].replace(hour=0)
                self.assertEqual(self.step()['state'], 'continuing')
                self.run_api('auto-booking/stop', 'POST', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})

    def test_closing_before_dispatch_retains_pending_until_safe_reconciliation(self):
        with self.connected():
            self.configured()
            self.start_auto()
            for _ in range(10):
                self.step()
                if self.state()['run']['cursor'].get('candidate'):
                    break
            moments = [self.moment]
            self.clock(moments)
            book = operations.book

            def closing_book(client, body):
                moments[0] = self.closing()
                return book(client, body)

            with patch.object(operations, 'book', closing_book):
                self.assertEqual(self.step(), {'state': 'changed'})
            self.assertIsNotNone(self.assert_deferred()['pending'])
            self.assertEqual(self.sent, [])
            moments[0] = self.opening()
            self.round()
            self.assertIsNone(self.state()['pending'])
            self.assertEqual(len(self.sent), 1)

    def test_lost_receipt_at_closing_is_retained_and_never_rebooks(self):
        with self.connected():
            self.configured()
            self.start_auto()
            for _ in range(10):
                self.step()
                if self.state()['run']['cursor'].get('candidate'):
                    break
            moments = [self.moment]
            self.clock(moments)
            mutate = Client.mutate
            self.drop = 'onevoneAppointment'

            def closing_mutate(client, endpoint, body):
                try:
                    return mutate(client, endpoint, body)
                finally:
                    moments[0] = self.closing()

            with patch.object(Client, 'mutate', closing_mutate):
                self.assertEqual(self.step(), {'state': 'changed'})
            pending = self.assert_deferred()['pending']
            self.assertIsNotNone(pending)
            self.assertEqual(len(self.sent), 1)
            receipt, = self.sql('SELECT state,result FROM lele.plugin_external_operations WHERE operation_id=%s',
                                (pending['operationId'],))
            self.assertEqual(receipt[0], 'uncertain')
            self.assertNotIn('notDispatched', receipt[1])
            with patch.object(Client, 'call', side_effect=AssertionError('Mison outside window')):
                self.assertEqual(self.step(), {'state': 'skipped'})
            self.assertEqual(self.state()['pending'], pending)
            moments[0] = self.opening()
            self.round()
            self.assertIsNone(self.state()['pending'])
            self.assertEqual(self.state()['totalBooked'], 1)
            self.assertEqual(len(self.sent), 1)

    def test_closing_after_mark_dispatch_records_unsent_and_reopening_books_once(self):
        with self.connected():
            self.configured()
            self.start_auto()
            for _ in range(10):
                self.step()
                if self.state()['run']['cursor'].get('candidate'):
                    break
            self.assertIsNotNone(self.state()['run']['cursor'].get('candidate'))
            moments = [self.moment]
            self.clock(moments)
            advance = operations.advance
            dispatched = []

            def closing_after_mark(client, operation, action, **changes):
                result = advance(client, operation, action, **changes)
                if action == 'mark-dispatch':
                    self.assertEqual(result['state'], 'dispatching')
                    dispatched.append(result['operationId'])
                    moments[0] = self.closing()
                    # A cache expiry must not introduce another read between
                    # mark-dispatch and the guarded transport boundary.
                    read_api.memo.values.clear()
                    read_api.memo.size = 0
                return result

            with patch.object(operations, 'advance', closing_after_mark):
                self.assertEqual(self.step(), {'state': 'changed'})
            self.assertEqual(len(dispatched), 1)
            self.assertEqual(self.sent, [])
            receipt, = self.sql('SELECT state,result FROM lele.plugin_external_operations WHERE operation_id=%s',
                                (dispatched[0],))
            self.assertEqual(receipt[0], 'failed')
            self.assertTrue(receipt[1]['notDispatched'])
            self.assertEqual(receipt[1]['errorCode'], 'AUTO_BOOKING_SLEEPING')
            self.assertIsNone(self.assert_deferred()['pending'])
            self.assertEqual(self.state()['totalBooked'], 0)
            with patch.object(Client, 'call', side_effect=AssertionError('Mison outside window')):
                self.assertEqual(self.step(), {'state': 'skipped'})
            moments[0] = self.opening()
            for _ in range(2):
                self.round()
                self.assertIsNone(self.state()['pending'])
                self.assertEqual(len(self.sent), 1)
                self.assertEqual(self.state()['totalBooked'], 1)

    def test_transport_timeout_after_admission_stays_uncertain_without_resending(self):
        transport = Client.mutate
        with self.connected():
            self.configured()
            self.start_auto()
            for _ in range(10):
                self.step()
                if self.state()['run']['cursor'].get('candidate'):
                    break
            self.assertIsNotNone(self.state()['run']['cursor'].get('candidate'))
            with patch.object(Client, 'mutate', transport), patch(
                    'mison_booking.upstream.urllib.request.build_opener') as build_opener:
                build_opener.return_value.open.side_effect = TimeoutError('synthetic transport timeout')
                self.step()
                build_opener.return_value.open.assert_called_once()
                pending = self.state()['pending']
                self.assertIsNotNone(pending)
                receipt, = self.sql('SELECT state,result FROM lele.plugin_external_operations WHERE operation_id=%s',
                                    (pending['operationId'],))
                self.assertEqual(receipt[0], 'uncertain')
                self.assertEqual(receipt[1]['errorCode'], 'RESULT_UNCERTAIN')
                self.assertNotIn('notDispatched', receipt[1])
                self.clock([self.opening()])
                for _ in range(2):
                    self.round()
                    self.assertEqual(self.state()['pending'], pending)
                    self.assertEqual(self.state()['totalBooked'], 0)
                    build_opener.return_value.open.assert_called_once()

    def test_bark_queue_drains_outside_window_without_mison_polling(self):
        with self.connected(), patch.object(bark, 'push', return_value='succeeded') as push:
            self.configured(notifications=self.notification_config)
            self.start_auto()
            with patch.object(auto_booking, 'flush_notifications'):
                self.round()
            self.clock([self.closing()])
            due = self.service.transaction(lambda cur: host.due(cur, self.context(), self.closing()))
            self.assertIsNotNone(due)
            self.assertEqual(due[1], self.closing())
            with patch.object(Client, 'call', side_effect=AssertionError('Mison outside window')):
                self.assertEqual(self.step(), {'state': 'skipped'})
            push.assert_called_once()
            self.assertFalse(host.notifications.pending(self.assert_deferred()))


def load_tests(loader, tests, pattern):
    suite = loader.loadTestsFromTestCase(CheckWindowRulesTests)
    suite.addTests(CheckWindowApiTests(name) for name in CheckWindowApiTests.__dict__ if name.startswith('test_'))
    return suite

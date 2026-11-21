"""Bark aliases with synthetic keys, temporary encryption, and no network or DB."""
import base64
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import MagicMock, patch

from lele_growth.child_service import ApiError
from lele_growth.plugins import auto_booking as host
from lele_growth.plugins import auto_booking_notifications as notifications
from lele_growth.plugins.credential_vault import CredentialVault

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'plugins/mison-booking/backend'), str(ROOT / 'packages/plugin-sdk-python/src')]
from mison_booking import bark


KEY_A, KEY_B, KEY_C = 'fixture_bark_key_A', 'fixture_bark_key_B', 'fixture_bark_key_C'
ABSENT = object()


def settings(keys, names=ABSENT, *, enabled=True, events=None):
    value = {'enabled': enabled, 'barkKeys': list(keys), 'events': ['booked'] if events is None else events}
    if names is not ABSENT:
        value['barkKeyNames'] = names
    return value


class BarkNameValidationTests(unittest.TestCase):
    def validate(self, value):
        return host.validate_config({**host.defaults(), 'notifications': value})['notifications']

    def test_legacy_default_and_request_keep_exact_three_field_shape(self):
        expected = {'enabled': False, 'barkKeys': [], 'events': ['booked']}
        self.assertEqual(notifications.defaults(), expected)
        config = host.defaults()
        config.pop('notifications')
        self.assertEqual(host.validate_config(config)['notifications'], expected)
        self.assertEqual(self.validate(settings([KEY_A])), settings([KEY_A]))

    def test_names_are_trimmed_and_explicit_blanks_stay_empty(self):
        incoming = settings([KEY_A, KEY_B, KEY_C], ['  手机  ', ' \t\n', ' 平板 '])
        before = deepcopy(incoming)
        result = self.validate(incoming)
        self.assertEqual(result['barkKeyNames'], ['手机', '', '平板'])
        self.assertEqual(result['barkKeys'], before['barkKeys'])
        self.assertEqual(incoming, before)
        keys = [f'fixture_key_{index}' for index in range(10)]
        self.assertEqual(self.validate(settings(keys, [''] * 10))['barkKeyNames'][-1], '')

    def test_forty_character_names_and_empty_named_recipients_are_valid(self):
        self.assertEqual(self.validate(settings([KEY_A], ['  ' + '名' * 40 + '  ']))['barkKeyNames'], ['名' * 40])
        self.assertEqual(self.validate(settings([], [], enabled=False)), settings([], [], enabled=False))

    def test_invalid_name_shape_count_type_or_length_is_rejected(self):
        for names in (None, 'phone', {'name': 'phone'}, ('phone',), [], ['one', 'two'],
                      [None], [False], [1], [[]], [{}], ['名' * 41], ['  ' + 'x' * 41 + '  ']):
            with self.subTest(names=names), self.assertRaises(ApiError) as failure:
                self.validate(settings([KEY_A], names))
            self.assertEqual((failure.exception.status, failure.exception.kind), (400, 'VALIDATION_ERROR'))
        with self.assertRaises(ApiError):
            self.validate(settings([], ['orphan'], enabled=False))

    def test_optional_names_do_not_relax_other_notification_validation(self):
        valid = settings([KEY_A], ['phone'])
        invalid = [None, [], {}, {**valid, 'extra': True}]
        invalid.extend({key: value for key, value in valid.items() if key != missing}
                       for missing in ('enabled', 'barkKeys', 'events'))
        invalid.extend({**valid, **changes} for changes in (
            {'enabled': 1}, {'barkKeys': ['short']}, {'barkKeys': [' ' + KEY_A]},
            {'barkKeys': ['https://api.day.app/key']}, {'barkKeys': [None]},
            {'barkKeys': [KEY_A, KEY_A], 'barkKeyNames': ['one', 'two']},
            {'events': ['failed']}, {'events': []},
            {'barkKeys': [f'fixture_key_{index}' for index in range(11)], 'barkKeyNames': [''] * 11}))
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ApiError) as failure:
                self.validate(value)
            self.assertEqual((failure.exception.status, failure.exception.kind), (400, 'VALIDATION_ERROR'))


class BarkNameStorageTests(unittest.TestCase):
    def setUp(self):
        # A network attempt is a test failure even if transport code catches it.
        network_patch = patch('socket.socket.connect', side_effect=AssertionError('Unexpected network access'))
        self.network = network_patch.start()
        self.addCleanup(network_patch.stop)
        folder = tempfile.TemporaryDirectory(prefix='mison-bark-names-')
        self.addCleanup(folder.cleanup)
        key_path = Path(folder.name) / 'vault.key'
        key_path.write_text('fixture-v1:' + base64.urlsafe_b64encode(b'n' * 32).decode())
        key_path.chmod(0o600)
        self.vault = CredentialVault(key_path)
        self.current = {'plugin_id': 'mison-booking', 'child_id': 'fixture-child'}
        self.account_key = 'fixture-account-fingerprint'
        self.actor = 'fixture-owner'
        self.state = {'config': host.defaults(), 'ownerId': self.actor, 'notificationQueue': {}}

    def tearDown(self):
        self.network.assert_not_called()

    def save(self, keys, names=ABSENT, *, actor=None, enabled=True, events=None):
        self.state['config'] = host.validate_config({
            **host.defaults(), 'notifications': settings(keys, names, enabled=enabled, events=events)})
        notifications.store(self.state, self.current, self.account_key, self.vault, actor or self.actor)
        return self.public()

    def public(self, *, can_manage=True, owner_valid=True, vault=ABSENT):
        return notifications.public(self.state, can_manage, self.current, self.account_key,
                                    self.vault if vault is ABSENT else vault, owner_valid)

    def enqueue(self, operation_id='fixture-booking'):
        notifications.enqueue(self.state, {
            'operationId': operation_id, 'date': '2099-11-20', 'time': '19:30',
            'teacher': {'name': '测试'}, 'times': ['19:30', '20:00']})

    def test_names_are_nonsecret_fingerprint_metadata_and_keys_stay_encrypted(self):
        self.save([KEY_A, KEY_B], ['手机', '平板'])
        stored = self.state['notificationCredentials']
        fingerprints = [hashlib.sha256(key.encode()).hexdigest() for key in (KEY_A, KEY_B)]
        self.assertEqual(stored['fingerprints'], fingerprints)
        self.assertEqual(stored['names'], dict(zip(fingerprints, ['手机', '平板'])))
        self.assertEqual(self.state['config']['notifications'], settings([], enabled=True))
        raw = json.dumps(self.state)
        for key in (KEY_A, KEY_B):
            self.assertNotIn(key, raw)
        encrypted = {key: stored[key] for key in ('key_id', 'nonce', 'ciphertext')}
        self.assertEqual(self.vault.decrypt(**notifications.scope(self.current, self.account_key), **encrypted),
                         json.dumps([KEY_A, KEY_B]))

    def test_owner_gets_names_and_readonly_keeps_masked_count_and_scenes(self):
        self.save([KEY_A, KEY_B], ['手机', '平板'], enabled=False, events=[])
        before = deepcopy(self.state)
        owner = self.public()
        self.assertEqual(owner, settings([KEY_A, KEY_B], ['手机', '平板'], enabled=False, events=[]))
        self.assertEqual(self.public(can_manage=False, vault=None),
                         settings(['已配置', '已配置'], enabled=False, events=[]))
        owner['barkKeyNames'][0] = 'local edit'
        self.assertEqual(self.state, before)

    def test_invalid_owner_always_gets_legacy_defaults_without_decryption(self):
        self.save([KEY_A, KEY_B], ['手机', '平板'])
        for can_manage in (False, True):
            with self.subTest(can_manage=can_manage):
                self.assertEqual(self.public(can_manage=can_manage, owner_valid=False, vault=None),
                                 notifications.defaults())

    def test_legacy_save_without_prior_aliases_keeps_three_field_response(self):
        for keys in ([KEY_A, KEY_B], [KEY_B, KEY_C]):
            with self.subTest(keys=keys):
                self.assertEqual(self.save(keys), settings(keys))
                self.assertNotIn('names', self.state['notificationCredentials'])
                self.assertNotIn('barkKeyNames', self.state['config']['notifications'])

    def test_explicit_rename_preserves_recipient_fingerprints_and_pending_queue(self):
        self.save([KEY_A, KEY_B], ['手机', '平板'])
        self.enqueue()
        queue = deepcopy(self.state['notificationQueue'])
        fingerprints = self.state['notificationCredentials']['fingerprints'][:]
        self.assertEqual(self.save([KEY_A, KEY_B], [' 工作手机 ', ' '])['barkKeyNames'], ['工作手机', ''])
        self.assertEqual(self.state['notificationCredentials']['fingerprints'], fingerprints)
        self.assertEqual(self.state['notificationQueue'], queue)

    def test_explicit_replace_remove_and_reorder_pair_names_with_incoming_keys(self):
        self.save([KEY_A, KEY_B], ['手机', '平板'])
        result = self.save([KEY_B, KEY_C], ['新平板', '新手机'])
        self.assertEqual(result, settings([KEY_B, KEY_C], ['新平板', '新手机']))
        self.assertNotIn(notifications.fingerprint(KEY_A), self.state['notificationCredentials']['names'])
        result = self.save([KEY_C, KEY_B], ['新手机', '新平板'])
        self.assertEqual(result, settings([KEY_C, KEY_B], ['新手机', '新平板']))
        self.assertEqual(self.save([KEY_B], ['仅平板']), settings([KEY_B], ['仅平板']))
        self.assertEqual(self.state['notificationCredentials']['names'], {notifications.fingerprint(KEY_B): '仅平板'})

    def test_legacy_save_preserves_names_by_fingerprint_through_reorder_add_and_remove(self):
        self.save([KEY_A, KEY_B], ['手机', '平板'])
        with patch.object(self.vault, 'decrypt', side_effect=AssertionError('Retention must use fingerprints')):
            self.state['config']['notifications'] = settings([KEY_B, KEY_C, KEY_A])
            notifications.store(self.state, self.current, self.account_key, self.vault, self.actor)
        self.assertEqual(self.public(), settings([KEY_B, KEY_C, KEY_A], ['平板', '', '手机']))
        self.assertEqual(self.save([KEY_A, KEY_C]), settings([KEY_A, KEY_C], ['手机', '']))
        self.assertNotIn(notifications.fingerprint(KEY_B), self.state['notificationCredentials']['names'])
        self.assertEqual(self.save([KEY_B, KEY_A]), settings([KEY_B, KEY_A], ['', '手机']))

    def test_legacy_full_replacement_uses_defaults_without_resurrecting_deleted_names(self):
        self.save([KEY_A], ['手机'])
        self.assertEqual(self.save([KEY_C]), settings([KEY_C], ['']))
        self.assertEqual(self.save([KEY_A]), settings([KEY_A], ['']))

    def test_names_never_transfer_to_another_actor_on_legacy_save(self):
        self.save([KEY_A, KEY_B], ['手机', '平板'])
        self.state['ownerId'] = 'successor'
        self.assertEqual(self.save([KEY_B, KEY_A], actor='successor'), settings([KEY_B, KEY_A]))
        self.assertEqual(self.state['notificationOwnerId'], 'successor')
        self.assertNotIn('names', self.state['notificationCredentials'])
        self.assertEqual(self.save([KEY_A], ['继任者手机'], actor='successor'), settings([KEY_A], ['继任者手机']))

    def test_empty_recipients_clear_metadata_for_explicit_and_legacy_requests(self):
        for index, names in enumerate(([], ABSENT)):
            with self.subTest(names=names):
                self.save([KEY_A], ['手机'])
                operation_id = f'fixture-booking-{index}'
                self.enqueue(operation_id)
                self.assertEqual(self.save([], names, enabled=False), notifications.defaults())
                self.assertIsNone(self.state['notificationCredentials'])
                self.assertIsNone(self.state['notificationOwnerId'])
                self.assertEqual(self.state['notificationQueue'][operation_id]['state'], 'skipped')
                self.assertEqual(self.save([KEY_A]), settings([KEY_A]))

    def test_host_save_and_read_use_metadata_without_changing_host_contract(self):
        self.state.update(configRevision=0, bindingRevision=1, receipts={}, enabled=False, pending=None,
                          step=0, run=None)
        context = {'actorId': self.actor}
        saved = []

        def persist(cur, current, key, record, state):
            saved.append(deepcopy(state))

        with patch.object(host, 'load', side_effect=lambda *args: (
                self.account_key, None, self.state, {'bindingRevision': 1})), \
             patch.object(host, 'owner', return_value=True), patch.object(host, 'assert_binding'), \
             patch.object(host, 'save', side_effect=persist), patch.object(host, 'event'), \
             patch.object(host, 'public_status', return_value={}):
            for value in (settings([KEY_A, KEY_B], [' 手机 ', '平板']), settings([KEY_B, KEY_A])):
                payload = {'config': {**host.defaults(), 'notifications': value},
                           'operationId': str(uuid.uuid4()), 'expectedRevision': self.state['configRevision']}
                result = host.handle(None, self.current, context, 'autoBooking.save', payload, vault=self.vault)
                self.assertTrue(result['ok'])
            self.assertEqual(result['data']['notifications'], settings([KEY_B, KEY_A], ['平板', '手机']))
            self.assertEqual(result['data']['revision'], 2)
            read = host.handle(None, self.current, context, 'autoBooking.get', {}, vault=self.vault)
            self.assertEqual(read['data']['config'], result['data'])
            self.assertEqual(len(saved), 2)
            for state in saved:
                self.assertNotIn('barkKeyNames', state['config']['notifications'])
                for key in (KEY_A, KEY_B):
                    self.assertNotIn(key, json.dumps(state))

    def test_alias_edits_leave_delivery_targets_payload_and_single_attempt_unchanged(self):
        self.save([KEY_A, KEY_B], ['手机', '平板'])
        self.enqueue()
        self.save([KEY_B, KEY_C, KEY_A], ['新平板', '新增设备', '新手机'])
        notice = notifications.claim(self.state, self.current, self.account_key, self.vault, lambda *args: None)
        self.assertEqual(notice['keys'], [KEY_B, KEY_A])
        self.assertEqual(set(notice), {'operationId', 'claimId', 'keys', 'title', 'body'})
        response = MagicMock(status=200)
        response.read.return_value = b'{"code":200}'
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value = response
        with patch.object(bark.urllib.request, 'build_opener', return_value=opener):
            outcome = bark.push(notice)
        self.assertEqual(outcome, 'succeeded')
        payload = json.loads(opener.open.call_args.args[0].data)
        self.assertEqual(payload, {
            'device_keys': [KEY_B, KEY_A], 'title': '美森约课成功',
            'body': '成功预约 测试 11/20 19:30', 'group': '美森自动约课', 'ttl': 600})
        notifications.finish(self.state, {**notice, 'state': outcome}, lambda *args: None)
        self.assertIsNone(notifications.claim(self.state, self.current, self.account_key, self.vault, lambda *args: None))
        opener.open.assert_called_once()

    def test_removed_key_is_not_replaced_by_new_key_in_already_queued_delivery(self):
        self.save([KEY_A, KEY_B], ['手机', '平板'])
        self.enqueue()
        self.save([KEY_B, KEY_C])
        notice = notifications.claim(self.state, self.current, self.account_key, self.vault, lambda *args: None)
        self.assertEqual(notice['keys'], [KEY_B])

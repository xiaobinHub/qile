"""Mison login: injected upstream only, encrypted storage in a guarded lele_test* DB."""
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import secrets
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'plugins/mison-booking/backend'), str(ROOT / 'packages/plugin-sdk-python/src')]
from mison_booking import auth, handle_request
from lele_growth.child_service import ApiError
from lele_growth.plugins.credential_vault import CredentialVault
from lele_growth.plugins.private_bridge import PluginBridge
from lele_plugin_sdk.bridge import BridgeError
from tests.backend.test_plugin_runtime import DatabaseFixture
from psycopg.types.json import Jsonb


def token():
    claims = {'exp': int((datetime.now(timezone.utc) + timedelta(days=29)).timestamp()), 'password': 'synthetic-claim-secret'}
    return 'fixture.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.fixture'


class UpstreamLoginTests(unittest.TestCase):
    def response(self, value):
        opener = Mock()
        opener.open.return_value.__enter__ = Mock(return_value=io.BytesIO(json.dumps(value).encode()))
        opener.open.return_value.__exit__ = Mock(return_value=False)
        return patch.object(auth.urllib.request, 'build_opener', return_value=opener), opener

    def test_documented_https_json_contract_and_both_success_levels(self):
        change, opener = self.response({'status': 0, 'data': {'status': 200, 'token': token(), 'userid': 42}})
        with change:
            result = auth.upstream_login('13800000000', 'fixture-password')
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://api.mison.cn/v2/member/login')
        self.assertEqual(json.loads(request.data), {'username': '13800000000', 'password': 'fixture-password'})
        self.assertEqual(result['userid'], '42')
        self.assertEqual(result['maskedAccount'], '138****0000')
        self.assertNotIn('password', result)
        opener.open.assert_called_once()

    def test_bad_password_preserves_reason_without_secrets(self):
        change, _ = self.response({'status': 11111, 'msg': '<b>用户名或密码错误</b> fixture-password 13800000000'})
        with change, self.assertRaises(auth.AuthError) as failure:
            auth.upstream_login('13800000000', 'fixture-password')
        self.assertEqual(failure.exception.code, 'UPSTREAM_REJECTED')
        self.assertIn('用户名或密码错误', str(failure.exception))
        self.assertNotIn('fixture-password', str(failure.exception))
        self.assertNotIn('13800000000', str(failure.exception))

    def test_missing_nested_success_or_expiry_cannot_log_in(self):
        for data in ({'status': 403, 'token': token(), 'userid': 42},
                     {'status': 200, 'token': 'bad-jwt', 'userid': 42}):
            change, _ = self.response({'status': 0, 'data': data})
            with self.subTest(data=data['status']), change, self.assertRaises(auth.AuthError):
                auth.upstream_login('test-user', 'test-password')

    def test_transport_timeout_and_redirect_are_never_retried(self):
        for failure in (TimeoutError(), urllib.error.HTTPError('https://api.mison.cn', 302, 'redirect', {}, None)):
            opener = Mock()
            opener.open.side_effect = failure
            with patch.object(auth.urllib.request, 'build_opener', return_value=opener), self.assertRaises(auth.AuthError) as caught:
                auth.upstream_login('test-user', 'test-password')
            self.assertEqual(caught.exception.code, 'RESULT_UNCERTAIN')
            opener.open.assert_called_once()
        self.assertIsNone(auth.NoRedirect().redirect_request(None, None, None, None, None, None))


class LoginSessionTests(DatabaseFixture):
    def setUp(self):
        super().setUp()
        self.data['capabilities'] += ['plugin.private-state', 'plugin.credentials']
        self.data['platformApi']['minMinor'] = 1
        self.data['backend']['requestTimeoutSeconds'] = 45
        self.sql('UPDATE lele.plugin_releases SET manifest=%s WHERE release_id=%s', (Jsonb(self.data), self.release_id))
        folder = tempfile.TemporaryDirectory(prefix='mison-vault-tests-')
        self.addCleanup(folder.cleanup)
        key = Path(folder.name) / 'vault.key'
        key.write_text('test-v1:' + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())
        key.chmod(0o600)
        self.vault = CredentialVault(key)
        self.bridge = PluginBridge(self.service, self.vault)
        self.ctx = {**self.context(), 'actorId': self.user_id}
        self.body = {'operationId': str(uuid.uuid4()), 'bindingRevision': 0, 'username': '13800000000', 'password': 'synthetic-password'}

    @contextmanager
    def connected_bridge(self):
        def invoke(context, action, payload):
            try:
                return self.bridge.handle(context, action, payload)['data']
            except ApiError as error:
                raise BridgeError(error.kind, error.error) from None
        with patch.object(auth.BridgeClient, 'call', side_effect=invoke), \
             patch('mison_booking.read_api.bootstrap_details', return_value=(None, None)):
            yield

    def login(self, body=None):
        return handle_request(self.ctx, 'connection/login', 'POST', body or self.body)

    def bootstrap(self):
        return handle_request(self.ctx, 'bootstrap', 'GET', {})

    def test_success_refresh_replay_encryption_and_disconnect(self):
        secret = token()
        value = {'token': secret, 'userid': '42', 'expiresAt': (datetime.now(timezone.utc) + timedelta(days=29)).isoformat(), 'maskedAccount': '138****0000'}
        with self.connected_bridge(), patch.object(auth, 'upstream_login', return_value=value) as upstream:
            first = self.login()
            self.assertTrue(first['ok'], first)
            self.assertEqual(first['data']['status'], 'connected')
            self.assertEqual(self.login()['data'], first['data'])
            upstream.assert_called_once()
            fresh = self.bootstrap()
            self.assertEqual(fresh['data']['connection'], first['data'])
            self.assertNotIn(secret, json.dumps(fresh))
            self.assertNotIn('synthetic-claim-secret', json.dumps(fresh))
            stored = self.sql('SELECT ciphertext FROM lele.plugin_credentials WHERE child_id=%s AND plugin_id=%s', (self.child_id, self.plugin_id))
            self.assertNotEqual(stored[0][0], secret)
            private = self.sql('SELECT payload FROM lele.plugin_private_records WHERE child_id=%s AND plugin_id=%s', (self.child_id, self.plugin_id))
            self.assertNotIn(secret, json.dumps(private))
            self.assertNotIn(self.body['password'], json.dumps(private))
            worker = self.bridge.handle(self.ctx, 'session.get', {})['data']
            self.assertEqual(worker['token'], secret)
            logged_out = handle_request(self.ctx, 'connection', 'DELETE', {'operationId': str(uuid.uuid4()), 'bindingRevision': 1})
            self.assertEqual(logged_out['data']['status'], 'unbound')
            self.assertEqual(self.bootstrap()['data']['connection']['status'], 'unbound')
            self.assertFalse(self.login()['ok'])  # old receipt cannot restore a revoked binding
            upstream.assert_called_once()

    def test_wrong_password_keeps_unbound_then_manual_retry_can_succeed(self):
        with self.connected_bridge(), patch.object(auth, 'upstream_login', side_effect=auth.AuthError('UPSTREAM_REJECTED', '用户名或密码错误')) as upstream:
            rejected = self.login()
            self.assertFalse(rejected['ok'])
            self.assertEqual(rejected['error']['message'], '用户名或密码错误')
            self.assertNotIn('operationId', rejected['error'])
            self.assertEqual(self.bootstrap()['data']['connection']['status'], 'unbound')
            self.assertFalse(self.login()['ok'])
            upstream.assert_called_once()
            self.assertEqual(self.sql('SELECT count(*) FROM lele.plugin_credentials WHERE child_id=%s', (self.child_id,)), [(0,)])
            retry = {**self.body, 'operationId': str(uuid.uuid4())}
            self.login(retry)
            self.assertEqual(upstream.call_count, 2)

    def test_timeout_receipt_blocks_duplicate_outbound_request(self):
        with self.connected_bridge(), patch.object(auth, 'upstream_login', side_effect=auth.AuthError('RESULT_UNCERTAIN', '结果待确认')) as upstream:
            result = self.login()
            self.assertEqual(result['error']['operationId'], self.body['operationId'])
            self.assertFalse(self.login()['ok'])
            upstream.assert_called_once()
            mismatch = self.login({**self.body, 'password': 'different-password'})
            self.assertEqual(mismatch['error']['code'], 'OPERATION_CONFLICT')

    def test_member_cannot_login_and_removed_member_cannot_read_token(self):
        other = str(uuid.uuid4())
        self.sql("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES(%s,%s,'member','unused','parent','active')", (other, other))
        self.sql('INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES(%s,%s,%s)', (self.child_id, other, str(uuid.uuid4())))
        member = {**self.ctx, 'actorId': other}
        self.assertFalse(self.bridge.handle(member, 'session.get', {})['data']['canManageConnection'])
        with self.assertRaises(ApiError): self.bridge.handle(member, 'session.begin', self.body)
        self.sql('DELETE FROM lele.memberships WHERE child_id=%s AND user_id=%s', (self.child_id, other))
        with self.assertRaises(ApiError): self.bridge.handle(member, 'session.get', {})

    def test_stale_context_and_missing_vault_cannot_write(self):
        with self.assertRaises(ApiError): PluginBridge(self.service, None).handle(self.ctx, 'session.begin', self.body)
        self.sql('UPDATE lele.child_plugins SET generation=generation+1 WHERE child_id=%s AND plugin_id=%s', (self.child_id, self.plugin_id))
        with self.assertRaises(ApiError): self.bridge.handle(self.ctx, 'session.begin', self.body)

    def test_gateway_uses_manifest_timeout_before_signing_context(self):
        runtime = Mock()
        runtime.call.return_value = {'ok': True, 'data': {'status': 'unbound'}}
        self.gateway.runtime = runtime
        result = self.route('GET', 'bootstrap')
        self.assertTrue(result['ok'])
        self.assertEqual(runtime.call.call_args.kwargs['timeout'], 45)
        supplied = runtime.call.call_args.args[0]
        self.assertGreater(supplied['expiresAt'], int(datetime.now(timezone.utc).timestamp()) + 60)

    def test_remote_expiry_cannot_revoke_a_different_or_replaced_credential(self):
        value = {'token': token(), 'userid': '42', 'expiresAt': (datetime.now(timezone.utc) + timedelta(days=29)).isoformat(), 'maskedAccount': '138****0000'}
        with self.connected_bridge(), patch.object(auth, 'upstream_login', return_value=value):
            self.assertTrue(self.login()['ok'])
            current = self.bridge.handle(self.ctx, 'session.get', {})['data']
            with self.assertRaises(ApiError):
                self.bridge.handle(self.ctx, 'session.invalidate', {'credentialId': 'another-credential', 'bindingRevision': 1})
            self.assertEqual(self.bootstrap()['data']['connection']['status'], 'connected')
            expired = self.bridge.handle(self.ctx, 'session.invalidate', {'credentialId': current['credentialId'], 'bindingRevision': 1})['data']
            self.assertEqual(expired['status'], 'reconnect_required')
            self.assertNotIn('token', expired)
            self.assertEqual(self.bootstrap()['data']['connection']['status'], 'reconnect_required')


if __name__ == '__main__':
    unittest.main()

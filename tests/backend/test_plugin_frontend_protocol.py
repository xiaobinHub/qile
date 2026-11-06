"""Frontend compatibility is checked before module delivery or worker calls."""
from unittest.mock import patch
from fastapi.testclient import TestClient

from lele_growth.accounts_app import create_app
from lele_growth.child_service import ApiError
from lele_growth.plugins.catalog import register_release
from lele_growth.plugins.gateway import PluginGateway
from lele_growth.plugins.manifest import validate_manifest
from tests.backend.test_plugin_lifecycle import PluginDatabaseCase
from tests.backend.test_plugin_manifest import manifest


class FrontendProtocolTests(PluginDatabaseCase):
    def setUp(self):
        super().setUp()
        self.data = manifest(self.plugin_id)
        self.data['version'] = '1.0.1'
        self.data['frontendApi']['minMinor'] = 1
        self.data['backend'] = {'entryModule': 'frontend_protocol_fixture'}
        self.service.transaction(lambda cur: register_release(cur, self.data, artifact_sha256='b' * 64,
            source_commit='frontend-protocol', config_schema={'type': 'object', 'properties': {}}, activate=True), exclusive=True)
        self.publish()
        self.install()
        self.release_id = self.service.transaction(lambda cur: cur.execute(
            'SELECT active_release_id FROM lele.plugin_catalog WHERE id=%s', (self.plugin_id,)).fetchone()[0])
        self.token, self.csrf, _ = self.sessions['owner']

    def client(self):
        app = create_app(self.path)
        client = TestClient(app)
        client.cookies.set('lele_parent', self.token)
        return client

    def test_manifest_accepts_frontend_1_1_and_rejects_unknown_major_or_required_minor(self):
        self.assertEqual(validate_manifest(self.data), self.data)
        for protocol in ({'major': 1, 'minMinor': 2}, {'major': 2, 'minMinor': 0}):
            with self.subTest(protocol=protocol), self.assertRaises(ApiError):
                validate_manifest({**self.data, 'frontendApi': protocol})

    def test_entry_rejects_old_missing_and_malformed_clients_before_serving_a_module(self):
        path = '/api/' + self.ppath('entry')
        with self.client() as client:
            for advertised in (None, '1.0', '2.0', 'bad', '1.-1'):
                headers = {} if advertised is None else {'X-Plugin-Frontend-Api': advertised}
                response = client.get(path, headers=headers)
                self.assertEqual(response.status_code, 409, response.text)
                self.assertEqual(response.json()['kind'], 'plugin_frontend_incompatible')
            response = client.get(path, headers={'X-Plugin-Frontend-Api': '1.1'})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()['frontendApi'], {'major': 1, 'minMinor': 1})

    def test_runtime_rejects_old_clients_before_dispatch(self):
        runtime_path = 'children/' + self.a['id'] + '/plugins/' + self.plugin_id + '/runtime/read'
        with patch('lele_growth.plugins.gateway.RuntimeClient.call', return_value={'ok': True}) as worker:
            with self.client() as client:
                headers = {'X-Plugin-Release': self.release_id}
                response = client.get('/api/' + runtime_path, headers=headers)
                self.assertEqual(response.status_code, 409, response.text)
                worker.assert_not_called()
                response = client.get('/api/' + runtime_path, headers={**headers, 'X-Plugin-Frontend-Api': '1.1'})
                self.assertEqual(response.status_code, 200, response.text)
                worker.assert_called_once()

    def test_legacy_plugin_still_accepts_an_old_host_without_the_header(self):
        self.data['frontendApi']['minMinor'] = 0
        self.data['version'] = '1.0.2'
        self.service.transaction(lambda cur: register_release(cur, self.data, artifact_sha256='c' * 64,
            source_commit='frontend-protocol-legacy', config_schema={'type': 'object', 'properties': {}}, activate=True), exclusive=True)
        with self.client() as client:
            response = client.get('/api/' + self.ppath('entry'))
        self.assertEqual(response.status_code, 200, response.text)

    def test_signed_job_attempt_cannot_be_forged(self):
        from tests.backend.test_plugin_runtime import scope
        from lele_growth.plugins.gateway import ContextSigner
        signer = ContextSigner()
        context = signer.issue(scope(), job_id='test-job', job_attempt=1)
        self.assertEqual(signer.verify(context)['jobAttempt'], 1)
        with self.assertRaises(ApiError):
            signer.verify({**context, 'jobAttempt': 2})

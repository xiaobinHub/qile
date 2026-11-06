"""Local runtime lifecycle regression tests; all processes and DB access are mocked."""
import contextlib
import fcntl
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('dev_runtime_tests', ROOT / 'scripts/dev.py')
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)


class DevelopmentRuntimeTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='dev-runtime-test-')
        self.addCleanup(folder.cleanup)
        self.runtime = Path(folder.name)
        self.config = self.runtime / 'config.json'
        for name, value in [('RUNTIME', self.runtime), ('CONFIG', self.config)]:
            change = patch.object(dev, name, value)
            change.start()
            self.addCleanup(change.stop)
        self.source = {'environment': 'development', 'database': {'host': '127.0.0.1'},
                       'parent_origin': 'http://127.0.0.1:18787', 'admin_origin': 'http://127.0.0.1:18788'}
        self.load = patch('lele_growth.child_service.load_config', return_value=self.source)
        self.load.start()
        self.addCleanup(self.load.stop)

    def test_stale_socket_is_not_a_ready_service(self):
        sockets = self.runtime / 'plugin-sockets'
        sockets.mkdir()
        (sockets / 'control.sock').touch()
        (sockets / 'control.token').write_text('test-only-credential')
        with patch('lele_growth.plugins.supervisor.unix_request', side_effect=OSError('stale')):
            self.assertFalse(dev.plugin_runtime_ready())
        with patch('lele_growth.plugins.supervisor.unix_request', return_value={'ok': True, 'protocol': 'invalid'}):
            self.assertFalse(dev.plugin_runtime_ready())
        from lele_growth.plugins.manifest import FRONTEND_API_MINOR, PLATFORM_API_MINOR
        with patch('lele_growth.plugins.supervisor.unix_request', return_value={'ok': True, 'protocol': '1.0'}):
            self.assertFalse(dev.plugin_runtime_ready())
        with patch('lele_growth.plugins.supervisor.unix_request', return_value={'ok': True, 'protocol': '1.0', 'frontendMinor': FRONTEND_API_MINOR}):
            self.assertFalse(dev.plugin_runtime_ready())
        with patch('lele_growth.plugins.supervisor.unix_request', return_value={'ok': True, 'protocol': '1.0', 'frontendMinor': FRONTEND_API_MINOR, 'platformMinor': PLATFORM_API_MINOR}):
            self.assertTrue(dev.plugin_runtime_ready())

    def test_start_creates_persistent_runtime_and_waits_for_authenticated_readiness(self):
        process = Mock(pid=12345)
        process.poll.return_value = None
        with patch.object(dev, 'plugin_runtime_ready', side_effect=[False, False, True]), \
             patch.object(dev.subprocess, 'Popen', return_value=process) as launch, \
             patch.object(dev.time, 'sleep'):
            dev.ensure_plugin_runtime()
        process.terminate.assert_not_called()
        self.assertEqual((self.runtime / 'plugin-runtime.pid').read_text(), '12345')
        options = launch.call_args.kwargs
        self.assertTrue(options['start_new_session'])
        self.assertEqual(options['env']['LELE_PLUGIN_ROOT'], str(self.runtime / 'plugin-runtime'))
        self.assertEqual(options['env']['LELE_PLUGIN_SOCKET_ROOT'], str(self.runtime / 'plugin-sockets'))
        self.assertEqual(options['env']['LELE_DEV_RELOAD'], '1')
        vault_key = Path(options['env']['LELE_PLUGIN_VAULT_KEY'])
        self.assertTrue(vault_key.is_file())
        self.assertEqual(vault_key.stat().st_mode & 0o777, 0o600)
        self.assertEqual(launch.call_args.args[0][-1], str(self.config))

    def test_healthy_service_is_reused_without_spawning_another_process(self):
        with patch.object(dev, 'plugin_runtime_ready', return_value=True), patch.object(dev.subprocess, 'Popen') as launch:
            dev.ensure_plugin_runtime()
            dev.ensure_plugin_runtime()
        launch.assert_not_called()

    def test_unready_but_owned_service_cannot_have_its_socket_replaced(self):
        sockets = self.runtime / 'plugin-sockets'
        sockets.mkdir()
        with (sockets / 'service.lock').open('a+') as owner:
            fcntl.flock(owner, fcntl.LOCK_EX)
            with patch.object(dev, 'plugin_runtime_ready', return_value=False), patch.object(dev.subprocess, 'Popen') as launch:
                with self.assertRaisesRegex(RuntimeError, '仍在运行但未就绪'):
                    dev.ensure_plugin_runtime()
                launch.assert_not_called()

    def test_start_also_starts_runtime_when_both_web_surfaces_are_already_healthy(self):
        with patch.object(dev, 'prepare_database', return_value=self.source), \
             patch('lele_growth.child_service.initialize'), \
             patch.object(dev, 'ensure_plugin_runtime') as ensure, \
             patch.object(dev, 'health', return_value=True), \
             patch.object(dev, '_lan_ip', return_value=None), \
             patch.object(dev.subprocess, 'Popen') as launch, contextlib.redirect_stdout(io.StringIO()):
            dev.start()
        ensure.assert_called_once()
        launch.assert_not_called()

    def test_web_processes_reload_backend_code(self):
        process = Mock(pid=42)
        process.poll.return_value = None
        with patch.object(dev, 'prepare_database', return_value=self.source), \
             patch('lele_growth.child_service.initialize'), \
             patch.object(dev, 'ensure_plugin_runtime'), \
             patch.object(dev, 'health', side_effect=[False, True, False, True]), \
             patch.object(dev, '_lan_ip', return_value=None), \
             patch.object(dev.subprocess, 'Popen', return_value=process) as launch, \
             patch.object(dev.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
            dev.start()
        self.assertEqual(launch.call_count, 2)
        reload_dir = str(dev.ROOT / 'backend' / 'lele_growth')
        for call in launch.call_args_list:
            command = call.args[0]
            self.assertIn('--reload', command)
            self.assertIn(reload_dir, command)

    def test_stale_runtime_protocol_is_restarted(self):
        from lele_growth.plugins.manifest import FRONTEND_API_MINOR
        process = Mock(pid=77)
        process.poll.return_value = None
        stale = {'ok': True, 'protocol': '1.0', 'frontendMinor': FRONTEND_API_MINOR - 1}
        with patch.object(dev, 'plugin_runtime_status', return_value=stale), \
             patch.object(dev, 'stop_plugin_runtime') as stop, \
             patch.object(dev, 'plugin_runtime_ready', side_effect=[False, True]), \
             patch.object(dev.subprocess, 'Popen', return_value=process) as launch, \
             patch.object(dev.time, 'sleep'):
            dev.ensure_plugin_runtime()
        stop.assert_called_once()
        launch.assert_called_once()
        self.assertEqual(launch.call_args.kwargs['env']['LELE_DEV_RELOAD'], '1')

    def test_current_frontend_with_old_platform_is_restarted(self):
        from lele_growth.plugins.manifest import FRONTEND_API_MINOR, PLATFORM_API_MINOR
        process = Mock(pid=78)
        process.poll.return_value = None
        stale = {'ok': True, 'protocol': '1.0', 'frontendMinor': FRONTEND_API_MINOR,
                 'platformMinor': PLATFORM_API_MINOR - 1}
        with patch.object(dev, 'plugin_runtime_status', return_value=stale), \
             patch.object(dev, 'stop_plugin_runtime') as stop, \
             patch.object(dev, 'plugin_runtime_ready', side_effect=[False, True]), \
             patch.object(dev.subprocess, 'Popen', return_value=process), patch.object(dev.time, 'sleep'):
            dev.ensure_plugin_runtime()
        stop.assert_called_once()

    def test_deployment_reuses_runtime_and_does_not_terminate_it(self):
        package = self.runtime / 'plugin.tar.gz'
        package.touch()
        manager = Mock()
        manager.execute.side_effect = [{'target': {'targetId': 'local-test'}}, {'status': 'succeeded'}]
        with patch.object(dev.subprocess, 'run', return_value=SimpleNamespace(stdout='True\n')), \
             patch.object(dev, 'prepare_database'), patch('lele_growth.child_service.initialize'), \
             patch('lele_growth.child_service.ChildService'), \
             patch('lele_growth.maintenance.initialize_plugin_platform'), \
             patch('lele_growth.plugins.deployment.PluginDeployment', return_value=manager) as deployment, \
             patch.object(dev, 'ensure_plugin_runtime') as ensure, \
             patch.object(dev.subprocess, 'Popen') as launch, contextlib.redirect_stdout(io.StringIO()):
            dev.plugins_deploy(package)
        ensure.assert_called_once()
        launch.assert_not_called()
        self.assertEqual(deployment.call_args.kwargs['runtime'].sockets, self.runtime / 'plugin-sockets')
        self.assertTrue(manager.execute.call_args.kwargs['apply'])

    def test_reused_pid_does_not_signal_an_unrelated_process(self):
        pid = self.runtime / 'plugin-runtime.pid'
        pid.write_text('12345')
        with patch.object(dev.subprocess, 'check_output', return_value='unrelated application'), patch.object(dev.os, 'kill') as kill:
            dev.stop_plugin_runtime()
        kill.assert_not_called()
        self.assertFalse(pid.exists())

    def test_remote_configuration_is_rejected_before_launch(self):
        self.source['database']['host'] = 'remote.invalid'
        with patch.object(dev.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(RuntimeError, '本机 development'):
                dev.ensure_plugin_runtime()
        launch.assert_not_called()

    def test_readiness_endpoint_still_requires_private_control_authentication(self):
        from fastapi.testclient import TestClient
        from deploy import plugin_runtime
        runtime = Mock(root=self.runtime / 'plugins')
        sockets = self.runtime / 'plugin-sockets'
        with patch.dict(dev.os.environ, {'LELE_PLUGIN_SOCKET_ROOT': str(sockets)}), \
             patch.object(plugin_runtime, 'ChildService'), \
             patch.object(plugin_runtime, 'PluginRuntimeService', return_value=runtime):
            app = plugin_runtime.create_app(self.config)
            credential = (sockets / 'control.token').read_text().strip()
            with TestClient(app) as client:
                self.assertEqual(client.post('/ready', json={}).status_code, 403)
                self.assertEqual(client.post('/ready', json={}, headers={'Authorization': 'Bearer incorrect'}).status_code, 403)
                response = client.post('/ready', json={}, headers={'Authorization': 'Bearer ' + credential})
                self.assertEqual(response.status_code, 200)
                from lele_growth.plugins.manifest import FRONTEND_API_MINOR, PLATFORM_API_MINOR
                self.assertEqual(response.json(), {'ok': True, 'protocol': '1.0', 'frontendMinor': FRONTEND_API_MINOR,
                                                  'platformMinor': PLATFORM_API_MINOR})

    def test_bridge_identity_cannot_control_runtime_and_requires_signed_context(self):
        from fastapi.testclient import TestClient
        from deploy import plugin_runtime
        from lele_growth.child_service import ApiError
        runtime = Mock(root=self.runtime / 'plugins')
        runtime.bridge.handle.return_value = {'ok': True, 'data': {'status': 'unbound'}}
        runtime.handle_bridge.side_effect = runtime.bridge.handle
        sockets = self.runtime / 'plugin-sockets'
        with patch.dict(dev.os.environ, {'LELE_PLUGIN_SOCKET_ROOT': str(sockets)}), \
             patch.object(plugin_runtime, 'ChildService'), \
             patch.object(plugin_runtime, 'PluginRuntimeService', return_value=runtime):
            app = plugin_runtime.create_app(self.config)
            control = {'Authorization': 'Bearer ' + (sockets / 'control.token').read_text().strip()}
            bridge = {'Authorization': 'Bearer ' + (sockets / 'bridge.token').read_text().strip()}
            body = {'context': {'scopeToken': 'test-signed'}, 'action': 'session.get', 'payload': {}}
            with TestClient(app) as client:
                runtime.transport_signer = Mock()
                self.assertEqual(client.post('/bridge', json=body, headers=control).status_code, 403)
                for path in ('/ready', '/call', '/stop', '/health'):
                    self.assertEqual(client.post(path, json={}, headers=bridge).status_code, 403)
                result = client.post('/bridge', json=body, headers=bridge)
                self.assertEqual(result.status_code, 200)
                runtime.transport_signer.verify.assert_called_with(body['context'])
                runtime.bridge.handle.assert_called_once()
                runtime.transport_signer.verify.side_effect = ApiError(403, 'invalid signature')
                self.assertEqual(client.post('/bridge', json=body, headers=bridge).status_code, 403)
                runtime.bridge.handle.assert_called_once()


if __name__ == '__main__':
    unittest.main()

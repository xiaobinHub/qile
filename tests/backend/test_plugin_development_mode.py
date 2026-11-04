"""Isolated development overlay regressions. No database or external service."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, redirect_stderr
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import io
import os
from pathlib import Path
import shutil
import socket
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi.responses import JSONResponse
from lele_growth.child_service import ApiError
from lele_growth.plugins.dev_mode import DevRegistry, authorize_resource, mount_proxy, proxy_target, invocation
from lele_growth.plugins.supervisor import PluginSupervisor, Worker
from tests.backend.test_plugin_runtime import scope
from lele_growth.plugins.gateway import ContextSigner

ROOT = Path(__file__).resolve().parents[2]
CONFIG = {'environment': 'development', 'database': {'host': '127.0.0.1'}, '_object_storage': None}
SCHEMA = {'type': 'object', 'properties': {}}
MANIFEST = {'manifestVersion': 1, 'id': 'runtime-demo', 'version': '1.0.0', 'type': 'page',
            'platformApi': {'major': 1, 'minMinor': 0}, 'frontendApi': {'major': 1, 'minMinor': 0},
            'frontend': {'entry': 'frontend/entry.js', 'styles': []},
            'backend': {'entryModule': 'runtime_demo'}, 'configSchema': 'schemas/config.json',
            'dataSchemaVersion': 1, 'capabilities': [], 'tasks': [], 'events': [], 'icons': []}
SOURCE = '''import os, sys, time, importlib.util

def health(): return {"ok": True}
def handle_request(context, path, method, body):
    if path == "slow": time.sleep(.3)
    return {"pid": os.getpid(), "value": "first", "host": importlib.util.find_spec("lele_growth") is not None,
            "secret": any(k in os.environ for k in ("DATABASE_URL", "LELE_ACCOUNTS_CONFIG", "PGPASSWORD")),
            "isolated": sys.flags.isolated}
'''


class ViteFixture(BaseHTTPRequestHandler):
    requests = []
    def do_GET(self):
        self.requests.append((self.path, dict(self.headers)))
        self.send_response(200)
        health = self.path.endswith('/__dev_health')
        self.send_header('Content-Type', 'application/json' if health else 'text/javascript')
        self.send_header('Set-Cookie', 'upstream=must-not-escape')
        self.end_headers()
        self.wfile.write(b'{"ok":true}' if health else b'export const value = 1;')
    def log_message(self, *args):
        pass


class Fixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='pdev-')
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name).resolve()
        self.registry = DevRegistry(CONFIG, repo=self.repo)
        self.source = self.repo / 'plugins/runtime-demo'
        (self.source / 'backend').mkdir(parents=True)
        (self.source / 'schemas').mkdir()
        (self.source / 'schemas/config.json').write_text(json.dumps(SCHEMA))
        (self.source / 'plugin.json').write_text(json.dumps(MANIFEST))
        (self.source / 'backend/runtime_demo.py').write_text(SOURCE)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), ViteFixture)
        self.server.daemon_threads = True
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.data = {'pluginId': 'runtime-demo', 'sessionId': 'session_123', 'port': self.server.server_port,
                     'pid': os.getpid(), 'backend': False, 'sourceRoot': str(self.source),
                     'revision': 1, 'state': 'ready', 'version': '1.0.0', 'releaseId': 'release-a'}
        change = patch.dict(os.environ, {'LELE_PLUGIN_SOCKET_ROOT': str(self.repo / 'sockets')})
        change.start()
        self.addCleanup(change.stop)

    def save(self, **changes):
        self.data.update(changes)
        self.registry.write(self.data)

    def runtime(self, real=False):
        from deploy.plugin_runtime import PluginRuntimeService
        service = Mock(config=CONFIG)
        with patch.object(PluginRuntimeService, '_vault', return_value=None):
            runtime = PluginRuntimeService(service, self.repo / 'installed')
        self.addCleanup(runtime.close)
        runtime.development = self.registry
        runtime.supervisor.development_registry = self.registry
        if not real:
            runtime.supervisor = Mock()
        return runtime

    def sdk(self):
        shutil.copytree(ROOT / 'packages/plugin-sdk-python/src', self.repo / 'packages/plugin-sdk-python/src',
                        ignore=shutil.ignore_patterns('__pycache__'))


class RegistryTests(Fixture):
    def test_local_only_gate_and_production_stale_headers(self):
        for config in ({**CONFIG, 'environment': 'production'}, {**CONFIG, 'database': {'host': 'remote.invalid'}}):
            registry = DevRegistry(config, repo=self.repo)
            self.assertIsNone(registry.descriptor('runtime-demo'))
            with self.assertRaises(ApiError): registry.guard()
            with self.assertRaises(ApiError):
                with registry.admission('runtime-demo', 'session_123', '1'): pass
            self.assertFalse(registry.root.exists())

    def test_fences_missing_stale_and_after_stop(self):
        self.save()
        for session, revision in ((None, None), ('old_session', '1'), ('session_123', None), ('session_123', '0')):
            with self.subTest(session=session, revision=revision), self.assertRaises(ApiError):
                with self.registry.admission('runtime-demo', session, revision): pass
        with self.registry.admission('runtime-demo', 'session_123', '1'):
            self.assertEqual(invocation.get()['revision'], 1)
        self.assertIsNone(invocation.get())
        self.registry.path('runtime-demo').unlink()
        with self.assertRaises(ApiError): self.registry.fence('runtime-demo', 'session_123', '1')
        with self.registry.admission('runtime-demo'): pass

    def test_dead_or_corrupt_session_never_falls_back(self):
        self.save()
        with patch('lele_growth.plugins.dev_mode.http.client.HTTPConnection.connect', side_effect=OSError):
            with self.assertRaises(ApiError): self.registry.descriptor('runtime-demo')
            with self.assertRaises(ApiError): self.registry.fence('runtime-demo', 'session_123', '1')
        self.registry.path('runtime-demo').write_text('{invalid')
        with self.assertRaises(ApiError): self.registry.descriptor('runtime-demo')

    def test_draining_descriptor_does_not_probe_health_or_admit_new_requests(self):
        self.save(state='draining')
        with patch.object(self.registry, 'live', side_effect=AssertionError('health probe during drain')):
            self.assertEqual(self.registry.descriptor('runtime-demo')['state'], 'draining')
        with self.assertRaises(ApiError):
            with self.registry.admission('runtime-demo', 'session_123', '1'): pass

    def test_admission_wait_is_bounded_without_terminating_work(self):
        self.save()
        with self.registry.lock('runtime-demo'):
            start = time.monotonic()
            with self.assertRaises(ApiError):
                with self.registry.lock('runtime-demo', exclusive=True, wait=True, timeout=.05): pass
            self.assertLess(time.monotonic() - start, .5)
        self.assertEqual(self.registry.read('runtime-demo')['state'], 'ready')

    def test_old_terminal_cannot_reload_or_stop_replacement_session(self):
        runtime = self.runtime()
        self.save()
        for operation in ('dev-stop', 'dev-reload'):
            with self.assertRaises(ApiError) as error:
                runtime.control_development(operation, {'pluginId': 'runtime-demo', 'sessionId': 'old_session'})
            self.assertEqual(error.exception.kind, 'plugin_dev_session_changed')
            self.assertEqual(self.registry.read('runtime-demo')['state'], 'ready')
            self.assertEqual(self.registry.read('runtime-demo')['revision'], 1)
        runtime.control_development('dev-stop', {'pluginId': 'runtime-demo'})
        self.assertIsNone(self.registry.read('runtime-demo'))

    def test_manifest_compatibility_all_but_frontend_paths(self):
        installed = copy.deepcopy(MANIFEST)
        installed['frontend'] = {'entry': 'frontend/compiled.js', 'styles': ['frontend/compiled.css']}
        self.registry.compatible('runtime-demo', installed, SCHEMA)
        for key, value in [('version', '2.0.0'), ('capabilities', ['plugin.state.write']), ('tasks', [{'id': 'new'}])]:
            changed = {**installed, key: value}
            with self.subTest(key=key), self.assertRaises(ApiError):
                self.registry.compatible('runtime-demo', changed, SCHEMA)
        with self.assertRaises(ApiError): self.registry.compatible('runtime-demo', installed, {'type': 'object'})

    def test_generic_plugin_without_config_schema_uses_installed_empty_schema(self):
        from lele_growth.plugins.configuration import EMPTY_SCHEMA
        data = copy.deepcopy(MANIFEST)
        data.pop('configSchema')
        (self.source / 'plugin.json').write_text(json.dumps(data))
        self.registry.compatible('runtime-demo', data, EMPTY_SCHEMA)

    def test_frontend_reload_drains_host_admission_without_touching_installed_worker(self):
        runtime = self.runtime()
        self.save()
        with patch('deploy.plugin_runtime.installed_release', return_value=(MANIFEST, SCHEMA, 'release-a')):
            with ThreadPoolExecutor(max_workers=1) as pool:
                with self.registry.admission('runtime-demo', 'session_123', '1'):
                    pending = pool.submit(runtime.control_development, 'dev-reload', {'pluginId': 'runtime-demo'})
                    deadline = time.monotonic() + 2
                    while self.registry.read('runtime-demo')['state'] == 'ready' and time.monotonic() < deadline:
                        time.sleep(.01)
                    self.assertFalse(pending.done())
                    self.assertEqual(self.registry.read('runtime-demo')['state'], 'draining')
                    with self.assertRaises(ApiError):
                        with self.registry.admission('runtime-demo', 'session_123', '1'): pass
                self.assertEqual(pending.result(2)['development']['revision'], 2)
            runtime.control_development('dev-stop', {'pluginId': 'runtime-demo'})
        runtime.supervisor.drain_development.assert_not_called()
        runtime.supervisor.start.assert_not_called()
        self.assertIsNone(self.registry.read('runtime-demo'))

    def test_frontend_registration_does_not_stop_or_restart_worker(self):
        runtime = self.runtime()
        body = {key: self.data[key] for key in ('pluginId', 'sessionId', 'port', 'pid', 'backend')}
        with patch('deploy.plugin_runtime.installed_release', return_value=(MANIFEST, SCHEMA, 'release-a')):
            result = runtime.control_development('dev-register', body)
        self.assertEqual(result['development']['revision'], 1)
        runtime.supervisor.drain_development.assert_not_called()
        runtime.supervisor.start.assert_not_called()

    def test_failed_reload_stays_registered_and_rejects_requests(self):
        runtime = self.runtime()
        self.save()
        with patch('deploy.plugin_runtime.installed_release', return_value=({**MANIFEST, 'version': '2.0.0'}, SCHEMA, 'release-a')):
            with self.assertRaises(ApiError): runtime.control_development('dev-reload', {'pluginId': 'runtime-demo'})
        self.assertEqual(self.registry.read('runtime-demo')['state'], 'failed')
        self.assertEqual(self.registry.read('runtime-demo')['revision'], 2)
        with self.assertRaises(ApiError): self.registry.descriptor('runtime-demo')


class SourceWorkerTests(Fixture):
    def test_real_source_worker_isolated_and_reload_uses_new_source(self):
        self.sdk()
        runtime = self.runtime(real=True)
        body = {key: self.data[key] for key in ('pluginId', 'sessionId', 'port', 'pid', 'backend')}
        body['backend'] = True
        with patch('deploy.plugin_runtime.installed_release', return_value=(MANIFEST, SCHEMA, 'release-a')), \
             patch.dict(os.environ, {'DATABASE_URL': 'fixture', 'PGPASSWORD': 'fixture'}):
            data = runtime.control_development('dev-register', body)['development']
            result = runtime.supervisor.call(ContextSigner().issue(scope()), 'handle_request', {'path': 'inspect', 'method': 'GET', 'body': {}}, development=data)
            self.assertEqual((result['host'], result['secret'], result['isolated']), (False, False, 1))
            self.assertEqual(result['value'], 'first')
            original_pid = result['pid']
            (self.source / 'backend/runtime_demo.py').write_text(SOURCE.replace('first', 'second'))
            data = runtime.control_development('dev-reload', {'pluginId': 'runtime-demo'})['development']
            result = runtime.supervisor.call(ContextSigner().issue(scope()), 'handle_request', {'path': 'inspect', 'method': 'GET', 'body': {}}, development=data)
            self.assertEqual(result['value'], 'second')
            self.assertNotEqual(original_pid, result['pid'])
            # A crashed process must not be silently restarted or replaced by installed code.
            worker = next(iter(runtime.supervisor.workers.values()))
            worker.process.kill(); worker.process.wait()
            with self.assertRaises(ApiError): runtime.supervisor.call(ContextSigner().issue(scope()), 'handle_request', {}, development=data)
            with self.assertRaises(ApiError): runtime.supervisor.call(ContextSigner().issue(scope()), 'handle_request', {})
            runtime.control_development('dev-stop', {'pluginId': 'runtime-demo'})
        self.assertFalse(runtime.supervisor.workers)
        self.assertFalse((self.repo / 'installed').exists())

    def test_failed_source_boot_never_restores_installed_worker(self):
        self.sdk()
        runtime = self.runtime(real=True)
        (self.source / 'backend/runtime_demo.py').write_text('raise RuntimeError("fixture boot failure")')
        body = {key: self.data[key] for key in ('pluginId', 'sessionId', 'port', 'pid', 'backend')}
        body['backend'] = True
        with patch('deploy.plugin_runtime.installed_release', return_value=(MANIFEST, SCHEMA, 'release-a')):
            with self.assertRaises(ApiError): runtime.control_development('dev-register', body)
        self.assertEqual(self.registry.read('runtime-demo')['state'], 'failed')
        log = Path(self.registry.read('runtime-demo')['executable']).parent.parent / 'worker.log'
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertIn('fixture boot failure', log.read_text())
        with self.assertRaises(ApiError): runtime.supervisor.start('runtime-demo', '1.0.0')

    def test_development_log_capture_is_bounded(self):
        from lele_growth.plugins.supervisor import MAX_DEV_LOG
        log = self.repo / 'worker.log'
        fd = os.open(log, os.O_CREAT | os.O_WRONLY, 0o600)
        PluginSupervisor._capture_log(io.BufferedReader(io.BytesIO(b'x' * (MAX_DEV_LOG * 3) + b'end')),
                                      os.fdopen(fd, 'ab', buffering=0))
        self.assertLessEqual(log.stat().st_size, MAX_DEV_LOG)
        self.assertTrue(log.read_bytes().endswith(b'end'))

    def test_reload_waits_for_real_inflight_request_to_finish(self):
        self.sdk()
        runtime = self.runtime(real=True)
        body = {key: self.data[key] for key in ('pluginId', 'sessionId', 'port', 'pid', 'backend')}
        body['backend'] = True
        with patch('deploy.plugin_runtime.installed_release', return_value=(MANIFEST, SCHEMA, 'release-a')):
            data = runtime.control_development('dev-register', body)['development']
            worker = next(iter(runtime.supervisor.workers.values()))
            with ThreadPoolExecutor(max_workers=2) as pool:
                request = pool.submit(runtime.supervisor.call, ContextSigner().issue(scope()), 'handle_request',
                                      {'path': 'slow'}, development=data)
                deadline = time.monotonic() + 2
                while not worker.inflight and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertEqual(worker.inflight, 1)
                reload = pool.submit(runtime.control_development, 'dev-reload', {'pluginId': 'runtime-demo'})
                self.assertEqual(request.result(3)['pid'], worker.process.pid)
                self.assertEqual(reload.result(3)['development']['revision'], 2)
            self.assertIsNotNone(worker.process.poll())

    def test_drain_timeout_never_terminates_active_worker(self):
        supervisor = PluginSupervisor(self.repo / 'installed')
        self.addCleanup(supervisor.close)
        process = Mock()
        process.poll.return_value = None
        worker = Worker('runtime-demo', 'dev:session_123:1', process, self.repo / 'worker.sock', inflight=1)
        supervisor.workers[('runtime-demo', worker.version)] = worker
        with patch.object(supervisor, '_terminate') as terminate:
            with self.assertRaises(ApiError): supervisor.drain_development('runtime-demo', timeout=0)
            terminate.assert_not_called()
            self.assertTrue(worker.stopping)
            self.assertEqual(worker.inflight, 1)
            worker.inflight = 0
            supervisor.drain_development('runtime-demo', timeout=0)
            terminate.assert_called_once_with(worker)
        self.assertFalse(supervisor.workers)


class RuntimeControlTests(Fixture):
    def test_timed_out_worker_bridge_commit_blocks_reload_and_late_bridge_is_rejected(self):
        runtime = self.runtime(real=True)
        runtime.transport_signer = ContextSigner(b't' * 32)
        runtime.service.transaction.return_value = 10
        self.save()
        context = runtime.transport_signer.issue(scope(), actor='fixture-user')
        started, commit, rpc_timeout = threading.Event(), threading.Event(), threading.Event()
        captured = {}
        def rpc(sealed, *args, **kwargs):
            captured['context'] = sealed
            started.set()
            self.assertTrue(rpc_timeout.wait(3))
            raise ApiError(503, 'fixture timeout', 'plugin_runtime_unavailable')
        def transaction(*args):
            captured['bridge_started'] = True
            self.assertTrue(commit.wait(3))
            captured['committed'] = True
            return {'ok': True, 'data': {'receipt': 'complete'}}
        with patch.object(runtime.supervisor, '_call', side_effect=rpc), \
             patch.object(runtime.bridge, 'handle', side_effect=transaction), \
             patch('deploy.plugin_runtime.installed_release', return_value=(MANIFEST, SCHEMA, 'release-a')):
            with ThreadPoolExecutor(max_workers=3) as pool:
                request = pool.submit(runtime.call, context, 'handle_request', {},
                                      development={'sessionId': 'session_123', 'revision': 1})
                self.assertTrue(started.wait(2))
                sealed = captured['context']
                self.assertEqual(runtime.transport_signer.verify(sealed)['development']['revision'], 1)
                with self.assertRaises(ApiError):
                    runtime.handle_bridge({**sealed, 'development': {'sessionId': 'forged', 'revision': 2}}, 'operation.finish', {})
                bridge = pool.submit(runtime.handle_bridge, sealed, 'operation.finish', {})
                deadline = time.monotonic() + 2
                while not captured.get('bridge_started') and time.monotonic() < deadline: time.sleep(.005)
                self.assertTrue(captured.get('bridge_started'))
                rpc_timeout.set()
                reload = pool.submit(runtime.control_development, 'dev-reload', {'pluginId': 'runtime-demo'})
                deadline = time.monotonic() + 2
                while self.registry.read('runtime-demo')['state'] != 'draining' and time.monotonic() < deadline: time.sleep(.005)
                self.assertFalse(reload.done())
                self.assertFalse(request.done())
                commit.set()
                self.assertEqual(bridge.result(2)['data']['receipt'], 'complete')
                with self.assertRaises(ApiError): request.result(2)
                self.assertEqual(reload.result(2)['development']['revision'], 2)
                self.assertTrue(captured['committed'])
                with self.assertRaises(ApiError): runtime.handle_bridge(sealed, 'operation.finish', {})

    def test_admitted_request_can_finish_bridge_phases_during_drain(self):
        runtime = self.runtime(real=True)
        runtime.transport_signer = ContextSigner(b't' * 32)
        runtime.service.transaction.return_value = 10
        self.save()
        context = runtime.transport_signer.issue(scope(), actor='fixture-user')
        started, finish = threading.Event(), threading.Event()
        captured = {}
        def rpc(sealed, *args, **kwargs):
            captured['context'] = sealed
            started.set()
            self.assertTrue(finish.wait(3))
            return {'ok': True}
        with patch.object(runtime.supervisor, '_call', side_effect=rpc), \
             patch.object(runtime.bridge, 'handle', return_value={'ok': True}) as handle, \
             patch('deploy.plugin_runtime.installed_release', return_value=(MANIFEST, SCHEMA, 'release-a')):
            with ThreadPoolExecutor(max_workers=2) as pool:
                request = pool.submit(runtime.call, context, 'handle_request', {},
                                      development={'sessionId': 'session_123', 'revision': 1})
                self.assertTrue(started.wait(2))
                reload = pool.submit(runtime.control_development, 'dev-reload', {'pluginId': 'runtime-demo'})
                deadline = time.monotonic() + 2
                while self.registry.read('runtime-demo')['state'] != 'draining' and time.monotonic() < deadline: time.sleep(.005)
                for action in ('operation.mark-dispatch', 'operation.stage', 'operation.finish'):
                    self.assertTrue(runtime.handle_bridge(captured['context'], action, {})['ok'])
                self.assertEqual(handle.call_count, 3)
                finish.set()
                self.assertTrue(request.result(2)['ok'])
                self.assertEqual(reload.result(2)['development']['revision'], 2)

    def test_frontend_only_scheduler_uses_installed_worker_without_browser_fences(self):
        runtime = self.runtime(real=True)
        self.assertIs(runtime.scheduler.gateway.runtime, runtime.supervisor)
        context = runtime.gateway.issue_job_context(scope(), 'fixture-job')
        process = Mock()
        process.poll.return_value = None
        worker = Worker('runtime-demo', '1.0.0', process, self.repo / 'installed-worker.sock')
        # An unavailable/reloading Vite session must not break installed jobs.
        for state in ('ready', 'draining', 'failed'):
            for task in ('remind', 'event:fixture-event'):
                with self.subTest(state=state, task=task):
                    self.save(state=state)
                    job = {'id': 'fixture-job', 'context': context, 'task_id': task,
                           'payload': {}, 'occurrence_key': 'fixture-occurrence', 'timeoutSeconds': 10}
                    with patch.object(runtime.scheduler, 'claim', return_value=job), \
                         patch.object(runtime.scheduler, 'complete') as complete, \
                         patch.object(runtime.scheduler, 'fail') as fail, \
                         patch.dict(runtime.supervisor.workers, {('runtime-demo', '1.0.0'): worker}), \
                         patch('lele_growth.plugins.supervisor.unix_request', return_value={'effects': []}), \
                         patch.object(runtime.supervisor, 'call', wraps=runtime.supervisor.call) as call, \
                         patch.object(runtime.development, 'admission', side_effect=AssertionError('browser fence used')):
                        self.assertTrue(runtime.scheduler.run_one('runtime-demo'))
                        call.assert_called_once_with(context, 'handle_job',
                            {'task': task, 'payload': {'occurrenceKey': 'fixture-occurrence'}}, timeout=10)
                        complete.assert_called_once_with(job, {'effects': []})
                        fail.assert_not_called()

    def test_frontend_only_scheduler_heartbeat_cancellation_uses_internal_worker(self):
        runtime = self.runtime(real=True)
        runtime.scheduler.lease_seconds = .3
        self.save()
        context = runtime.gateway.issue_job_context(scope(), 'fixture-job')
        job = {'id': 'fixture-job', 'context': context, 'task_id': 'remind',
               'payload': {}, 'occurrence_key': 'fixture-occurrence', 'timeoutSeconds': 10}
        cancelled = threading.Event()
        def execute(context, action, payload, **kwargs):
            if action == 'cancel_job':
                cancelled.set()
                return {'cancelled': True}
            self.assertTrue(cancelled.wait(2), 'heartbeat did not reach the installed worker')
            return {'effects': []}
        with patch.object(runtime.scheduler, 'claim', return_value=job), \
             patch.object(runtime.scheduler, 'heartbeat', return_value=False), \
             patch.object(runtime.scheduler, 'complete'), \
             patch.object(runtime.scheduler, 'fail') as fail, \
             patch.object(runtime.supervisor, 'call', side_effect=execute) as call, \
             patch.object(runtime.development, 'admission', side_effect=AssertionError('browser fence used')):
            self.assertTrue(runtime.scheduler.run_one('runtime-demo'))
            call.assert_any_call(context, 'cancel_job', {'jobId': 'fixture-job'})
            fail.assert_not_called()

    def test_private_runtime_rechecks_fences_and_never_uses_source_for_frontend_only(self):
        runtime = self.runtime()
        runtime.transport_signer = Mock()
        runtime.service.transaction.return_value = 10
        self.save()
        context = ContextSigner().issue(scope())
        with self.assertRaises(ApiError): runtime.call(context, 'handle_request', {})
        with self.assertRaises(ApiError):
            runtime.call(context, 'handle_request', {}, development={'sessionId': 'session_123', 'revision': 0})
        runtime.supervisor.call.assert_not_called()
        runtime.call(context, 'handle_request', {}, development={'sessionId': 'session_123', 'revision': 1})
        self.assertIsNone(runtime.supervisor.call.call_args.kwargs['development'])
        self.registry.path('runtime-demo').unlink()
        with self.assertRaises(ApiError):
            runtime.call(context, 'handle_request', {}, development={'sessionId': 'session_123', 'revision': 1})

    def test_control_endpoints_require_control_identity_and_local_configuration(self):
        from deploy import plugin_runtime
        runtime = self.runtime()
        runtime.development = DevRegistry({**CONFIG, 'environment': 'production'}, repo=self.repo)
        with patch.object(plugin_runtime, 'PluginRuntimeService', return_value=runtime), \
             patch.object(plugin_runtime, 'ChildService', return_value=runtime.service):
            app = plugin_runtime.create_app('unused-config')
        sockets = self.repo / 'sockets'
        control = {'Authorization': 'Bearer ' + (sockets / 'control.token').read_text()}
        bridge = {'Authorization': 'Bearer ' + (sockets / 'bridge.token').read_text()}
        client = TestClient(app)
        self.addCleanup(client.close)
        for operation in ('register', 'reload', 'stop', 'status'):
            path = '/dev-' + operation
            for headers in ({}, bridge):
                self.assertEqual(client.post(path, json={'pluginId': 'runtime-demo'}, headers=headers).status_code, 403)
            response = client.post(path, json={'pluginId': 'runtime-demo'}, headers=control)
            self.assertEqual(response.status_code, 404)
            self.assertEqual(response.json()['kind'], 'plugin_dev_disabled')
        self.assertFalse(self.registry.root.exists())


class CliTests(unittest.TestCase):
    def test_dev_control_errors_are_useful_but_never_echo_upstream_details(self):
        from lele_growth.plugins.supervisor import unix_request
        for endpoint, expected in (('/dev-register', 'plugin_dev_session_exists'), ('/call', 'plugin_worker_failed')):
            response = Mock(status=409)
            response.read.return_value = json.dumps({'kind': 'plugin_dev_session_exists', 'error': 'private-upstream-details'}).encode()
            connection = Mock()
            connection.getresponse.return_value = response
            with patch('lele_growth.plugins.supervisor.UnixConnection', return_value=connection):
                with self.assertRaises(ApiError) as error: unix_request('/unused', endpoint, {})
            self.assertEqual(error.exception.kind, expected)
            self.assertNotIn('private-upstream-details', error.exception.error)
            if endpoint.startswith('/dev-'): self.assertIn('已有开发会话', error.exception.error)

    def test_reload_stop_forward_optional_session_owner(self):
        from scripts import plugin_dev
        from contextlib import redirect_stdout
        for command in ('reload', 'stop'):
            with patch('lele_growth.child_service.load_config', return_value=CONFIG), \
                 patch('lele_growth.plugins.supervisor.RuntimeClient._request', return_value={'development': None}) as request, \
                 redirect_stdout(io.StringIO()):
                self.assertEqual(plugin_dev.main([command, 'runtime-demo', '--session', 'session_123']), 0)
            self.assertEqual(request.call_args.args[1]['sessionId'], 'session_123')

    def test_fallback_names_existing_start_command_without_exception_details(self):
        from scripts import plugin_dev
        output = io.StringIO()
        with patch('lele_growth.child_service.load_config', side_effect=RuntimeError('private-fixture-details')), redirect_stderr(output):
            self.assertEqual(plugin_dev.main(['status', 'runtime-demo']), 1)
        result = json.loads(output.getvalue())
        self.assertIn('.venv/bin/python scripts/dev.py start', result['error'])
        self.assertNotIn('private-fixture-details', output.getvalue())
        self.assertNotIn('npm run dev:start', output.getvalue())


class HostTests(Fixture):
    def app(self):
        from lele_growth import accounts_app
        service = Mock(config=CONFIG)
        service.request.return_value = {'entry': '/installed.js', 'styles': ['installed.css'], 'releaseId': 'release-a', 'version': '1.0.0'}
        with patch.object(accounts_app, 'ChildService', return_value=service), \
             patch('lele_growth.plugins.dev_mode.DevRegistry', return_value=self.registry):
            app = accounts_app.create_app('unused-config')
        return app, service

    def test_entry_augments_authorized_response_and_keeps_installed_identity(self):
        app, service = self.app()
        self.save()
        with TestClient(app) as client:
            response = client.get('/api/children/child-a/plugins/runtime-demo/entry')
            self.assertEqual(response.status_code, 200)
            entry = response.json()
            self.assertEqual(entry['releaseId'], 'release-a')
            self.assertEqual(entry['version'], '1.0.0')
            self.assertEqual(entry['entry'], '/__plugin-dev/runtime-demo/session_123/@plugin-entry')
            self.assertEqual(entry['styles'], [])
            self.assertEqual(entry['development']['revision'], 1)
            service.request.side_effect = ApiError(403, 'denied')
            self.assertEqual(client.get('/api/children/child-a/plugins/runtime-demo/entry').status_code, 403)

    def test_generic_runtime_writes_fenced_before_gateway_and_after_stop(self):
        app, _ = self.app()
        self.save()
        path = '/api/children/child-a/plugins/runtime-demo/runtime/records/notes/a'
        with patch('lele_growth.plugins.gateway.PluginGateway.route', return_value={'ok': True}) as route, TestClient(app) as client:
            self.assertEqual(client.put(path, json={}).status_code, 409)
            route.assert_not_called()
            headers = {'X-Plugin-Dev-Session': 'session_123', 'X-Plugin-Dev-Revision': '1'}
            self.assertEqual(client.put(path, json={}, headers=headers).status_code, 200)
            route.assert_called_once()
            self.registry.path('runtime-demo').unlink()
            self.assertEqual(client.put(path, json={}, headers=headers).status_code, 409)
            self.assertEqual(client.put(path, json={}).status_code, 200)

    def test_http_proxy_keeps_query_and_strips_credentials_and_upstream_cookies(self):
        app, _ = self.app()
        self.save()
        ViteFixture.requests.clear()
        with patch('lele_growth.plugins.dev_mode.authorize_resource') as authorize, TestClient(app) as client:
            response = client.get('/__plugin-dev/runtime-demo/session_123/src/main.tsx?t=123&import',
                                  headers={'Authorization': 'Bearer must-not-forward', 'Cookie': 'lele_parent=main-session'})
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('set-cookie', response.headers)
            self.assertIn('text/javascript', response.headers['content-type'])
            path, headers = next(item for item in ViteFixture.requests if 'main.tsx' in item[0])
            self.assertTrue(path.endswith('?t=123&import'))
            self.assertNotIn('Authorization', headers)
            self.assertNotIn('Cookie', headers)
            self.assertEqual(authorize.call_args.args[1], 'main-session')
            authorize.side_effect = ApiError(403, 'denied')
            count = len(ViteFixture.requests)
            self.assertEqual(client.get('/__plugin-dev/runtime-demo/session_123/@vite/client').status_code, 403)
            self.assertEqual(len(ViteFixture.requests), count)

    def test_proxy_production_gate_and_session_scope(self):
        self.save()
        with self.assertRaises(ApiError): proxy_target(self.registry, 'runtime-demo', 'old_session', '@vite/client', '')
        for path in ('../config.json', 'x\\y', 'x\r\nHost:evil'):
            with self.assertRaises(ApiError): proxy_target(self.registry, 'runtime-demo', 'session_123', path, '')
        production = DevRegistry({**CONFIG, 'environment': 'production'}, repo=self.repo)
        with self.assertRaises(ApiError): proxy_target(production, 'runtime-demo', 'session_123', '@vite/client', '')

    def test_proxy_authorization_uses_normal_child_access(self):
        service = Mock()
        user = ('user-a', None, None, 'parent', 'active', False, None, 'csrf-hash')
        service.authenticate.return_value = user
        cursor = Mock()
        cursor.fetchall.return_value = [('child-a',)]
        service.transaction.side_effect = lambda fn: fn(cursor)
        with patch('lele_growth.plugins.gateway.PluginGateway._authenticate', return_value=({'pluginId': 'runtime-demo'}, user)) as auth:
            authorize_resource(service, 'session-cookie', 'parent', 'runtime-demo')
            auth.assert_called_once_with(cursor, 'runtime-demo', 'child-a', 'session-cookie', None, None, 'parent', False)
            auth.side_effect = ApiError(403, 'child revoked')
            with self.assertRaises(ApiError): authorize_resource(service, 'session-cookie', 'parent', 'runtime-demo')
        with self.assertRaises(ApiError): authorize_resource(service, 'session-cookie', 'admin', 'runtime-demo')

    def test_websocket_proxy_authenticates_forwards_and_closes_on_revocation(self):
        from websockets.sync.server import serve
        from starlette.websockets import WebSocketDisconnect
        def echo(connection):
            connection.send('connected')
            try:
                for message in connection:
                    connection.send(message)
            except Exception:
                pass
        with serve(echo, '127.0.0.1', 0, subprotocols=['vite-hmr']) as upstream:
            thread = threading.Thread(target=upstream.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(upstream.shutdown)
            self.save(port=upstream.socket.getsockname()[1])
            app, service = self.app()
            service.origin_trusted.return_value = True
            # live() uses a TCP probe; avoid noisy incomplete WS handshakes here.
            with patch.object(self.registry, 'live', side_effect=lambda data: data), \
                 patch('lele_growth.plugins.dev_mode.authorize_resource') as authorize, TestClient(app) as client:
                path = '/__plugin-dev/runtime-demo/session_123/?token=vite-token'
                with client.websocket_connect(path, subprotocols=['vite-hmr'], headers={'Origin': 'http://127.0.0.1:18787'}) as ws:
                    self.assertEqual(ws.receive_text(), 'connected')
                    ws.send_text('ping-test')
                    self.assertEqual(ws.receive_text(), 'ping-test')
                    authorize.side_effect = ApiError(403, 'revoked')
                    ws.send_text('must-not-arrive')
                    with self.assertRaises(WebSocketDisconnect): ws.receive_text()
                with self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect(path, subprotocols=['vite-hmr']): pass
                authorize.side_effect = None
                service.origin_trusted.return_value = False
                with self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect(path, subprotocols=['vite-hmr']): pass


if __name__ == '__main__':
    unittest.main()

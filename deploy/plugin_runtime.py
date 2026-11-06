"""Independent private runtime service. Never mounted on parent/admin or TCP.

Run: python deploy/plugin_runtime.py --config <explicit-config>
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager, nullcontext
from contextvars import ContextVar
import fcntl
import hmac
import logging
import hashlib
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from lele_growth.child_service import ApiError, ChildService, require
from lele_growth.plugins.events import EventDispatcher
from lele_growth.plugins.gateway import PluginGateway, ContextSigner
from lele_growth.plugins.policy import active_context, assert_fences, rows_dict
from lele_growth.plugins.private_bridge import PluginBridge
from lele_growth.plugins.scheduler import PluginScheduler
from lele_growth.plugins.supervisor import PluginSupervisor, plugin_root, private_directory, socket_root
from lele_growth.plugins.dev_mode import DevRegistry, WorkerAdmissions, installed_release

NOT_ADMITTED = object()


class PluginRuntimeService:
    def __init__(self, service, root=None):
        self.service = service
        self.root = Path(root or plugin_root()).resolve()
        self.supervisor = PluginSupervisor(self.root)
        self.development = DevRegistry(service.config)
        self.worker_admissions = WorkerAdmissions()
        self.admitted_generation = ContextVar('runtime_generation', default=NOT_ADMITTED)
        self.supervisor.development_registry = self.development
        self.supervisor.invocation_guard = self.worker_admission
        # Trusted in-process jobs/cancellations use installed workers directly.
        # Do not point this gateway at self or RuntimeClient: browser development
        # fences apply to /call, not to the independent installed job lifecycle.
        # Backend-source mode is separately paused by _loop and supervisor.start.
        self.gateway = PluginGateway(service, runtime=self.supervisor)
        self.scheduler = PluginScheduler(service, self.gateway)
        self.events = EventDispatcher(service, self.scheduler)
        self.stopped = threading.Event()
        self.thread = None
        self.pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix='plugin-jobs')
        self.pending = {}
        self.transport_signer = None
        self.bridge = PluginBridge(service, self._vault())
        self.stage_errors = {}
        self.enabled = set()

    def call(self, context, action, payload, *, timeout=None, development=None):
        require(action in ('handle_request', 'handle_job', 'cancel_job') and isinstance(context, dict) and isinstance(payload, dict), 400)
        (self.transport_signer or self.gateway.signer).verify(context)
        def check(cur):
            current = active_context(cur, context.get('pluginId'), context.get('childId'))
            assert_fences(current, context)
            require(current['version'] == context.get('version') and time.time() < context.get('expiresAt', 0), 403)
            require(isinstance(context.get('scopeToken'), str) and set(context.get('capabilities', [])) <= set(current['capabilities']), 403)
            task = next((task for task in current['manifest'].get('tasks', []) if task['id'] == payload.get('task')), None)
            declared = current['manifest'].get('backend', {}).get('requestTimeoutSeconds', 10)
            maximum = task.get('timeoutSeconds', 10) if task and action == 'handle_job' else declared
            selected = min(10, maximum) if timeout is None else timeout
            require(type(selected) in (int, float) and 0 < selected <= maximum <= 300, 400, '任务超时预算不正确。')
            return selected
        require(development is None or isinstance(development, dict), 400)
        fence = development or {}
        with self.development.admission(context['pluginId'], fence.get('sessionId'), fence.get('revision')) as session:
            require(session is None or session.get('releaseId') == context.get('releaseId'), 409,
                    '安装版本已改变，请停止开发会话。', 'plugin_dev_incompatible')
            selected = self.service.transaction(check)
            token = self.admitted_generation.set(session)
            try:
                return self.supervisor.call(context, action, payload, timeout=selected,
                                            development=session if session and session['backend'] else None)
            finally:
                self.admitted_generation.reset(token)

    @contextmanager
    def worker_admission(self, context, development):
        admitted = self.admitted_generation.get()
        if admitted is not NOT_ADMITTED:
            admission = nullcontext(admitted)  # Outer /call holds its reader lock.
        elif development is not None:
            admission = self.development.admission(context['pluginId'], development['sessionId'], development['revision'])
        else:
            admission = self.development.internal_admission(context['pluginId'])
        with admission as session:
            with self.worker_admissions.worker(context, session, self.transport_signer or self.gateway.signer) as sealed:
                yield sealed

    def handle_bridge(self, context, action, payload):
        (self.transport_signer or self.gateway.signer).verify(context)
        with self.worker_admissions.bridge(context):
            return self.bridge.handle(context, action, payload)

    def control_development(self, operation, body):
        registry = self.development
        registry.guard()
        plugin_id = body.get('pluginId')
        registry.path(plugin_id)
        with registry.lock(plugin_id, exclusive=True, control=True):
            previous = registry.read(plugin_id)
            if operation in ('dev-stop', 'dev-reload') and body.get('sessionId') is not None:
                require(previous is not None and body['sessionId'] == previous['sessionId'], 409,
                        '此终端的开发会话已失效。', 'plugin_dev_session_changed')
            if operation == 'dev-status':
                return {'ok': True, 'development': previous}
            if operation == 'dev-stop' and previous is None:
                return {'ok': True, 'development': None}
            if operation == 'dev-register':
                import re
                from lele_growth.plugins.dev_mode import SESSION
                require(isinstance(body.get('sessionId'), str) and re.fullmatch(SESSION, body['sessionId'])
                        and type(body.get('port')) is int and 1 <= body['port'] <= 65535
                        and type(body.get('pid')) is int and body['pid'] > 0
                        and type(body.get('backend')) is bool, 400)
                require(previous is None, 409, '已有开发会话，请先停止。', 'plugin_dev_session_exists')
                data = {key: body[key] for key in ('pluginId', 'sessionId', 'port', 'pid', 'backend')}
                data.update(sourceRoot=str(registry.repo / 'plugins' / plugin_id), revision=1)
            else:
                require(previous is not None, 409, '开发会话不存在。', 'plugin_dev_session_changed')
                data = dict(previous)
            # Verify compatibility before registration; on reload a mismatch is
            # recorded as a failed session instead of restoring installed code.
            if operation == 'dev-register':
                manifest, schema, release_id = installed_release(self.service, plugin_id)
                registry.compatible(plugin_id, manifest, schema)
                require(not data['backend'] or bool(manifest.get('backend')), 409, '插件没有后端。')
                data.update(version=manifest['version'], releaseId=release_id)
                registry.live({**data, 'state': 'ready'})
            data['state'] = 'draining'
            registry.write(data)
            try:
                # Mark first, then wait: new admissions reject immediately.
                with registry.lock(plugin_id, exclusive=True, wait=True):
                    if data['backend']:
                        self.supervisor.drain_development(plugin_id)
                    if operation == 'dev-stop':
                        registry.path(plugin_id).unlink()
                        return {'ok': True, 'development': None}
                    if operation == 'dev-reload':
                        data['revision'] += 1
                    manifest, schema, release_id = installed_release(self.service, plugin_id)
                    registry.compatible(plugin_id, manifest, schema)
                    require(release_id == data['releaseId'], 409, '安装版本已改变，请先停止开发会话。', 'plugin_dev_incompatible')
                    if data['backend']:
                        data['executable'] = str(registry.prepare_environment(data))
                        self.supervisor.start(plugin_id, data['version'], development=data)
                    registry.live({**data, 'state': 'ready'})
                    data['state'] = 'ready'
                    data.pop('errorKind', None)
                    registry.write(data)
                    return {'ok': True, 'development': data}
            except Exception as error:
                data.update(state='failed', errorKind=error.kind if isinstance(error, ApiError) else 'plugin_dev_start_failed')
                registry.write(data)
                if isinstance(error, ApiError):
                    raise
                raise ApiError(503, '插件开发启动失败，请检查源码后重载。', 'plugin_dev_start_failed') from None

    def _vault(self):
        from pathlib import Path
        key_path = Path(os.environ.get('LELE_PLUGIN_VAULT_KEY', '/etc/lele-growth/plugin-vault.txt'))
        if not key_path.is_file():
            return None
        from lele_growth.plugins.credential_vault import CredentialVault
        return CredentialVault(key_path)

    def reconcile(self):
        # Never acquire another plugin's catalog lock while retaining a child's
        # row lock from the previous plugin. Lifecycle operations lock catalog
        # first and may be waiting for that same child.
        pairs = self.service.transaction(lambda cur: rows_dict(cur.execute(
            """SELECT cp.plugin_id,cp.child_id FROM lele.child_plugins cp
            JOIN lele.plugin_catalog p ON p.id=cp.plugin_id
            WHERE cp.installed AND cp.enabled AND NOT cp.requires_reenable
              AND p.publication_status='published' AND p.operation_state='ready'
            ORDER BY cp.plugin_id,cp.child_id""")))
        enabled = set()
        confirmed = set()
        for pair in pairs:
            if pair['plugin_id'] in confirmed:
                continue
            try:
                current = self.service.transaction(lambda cur: active_context(cur, pair['plugin_id'], pair['child_id']))
                confirmed.add(pair['plugin_id'])
                if current['manifest'].get('backend'):
                    enabled.add((pair['plugin_id'], current['version']))
            except ApiError:
                continue
        prepared = self.service.transaction(lambda cur: rows_dict(cur.execute(
            "SELECT d.plugin_id,r.version FROM lele.plugin_deployments d JOIN lele.plugin_releases r ON r.release_id=d.new_release_id WHERE d.status='running' AND d.lease_until>now()")))
        enabled.update((row['plugin_id'], row['version']) for row in prepared)
        for key in list(self.supervisor.workers):
            try:
                development = self.development.read(key[0])
            except ApiError:
                continue  # A corrupt overlay cannot authorize forced shutdown.
            if development and development['backend']:
                # Lifecycle controls alone own source drains. Never let periodic
                # reconciliation terminate a worker during an in-flight save.
                continue
            if key not in enabled:
                self.supervisor.stop(key[0], key[1], timeout=0)
        self.enabled = enabled
        return enabled

    def _stage(self, name, action):
        try:
            return action()
        except Exception:
            now = time.monotonic()
            if now - self.stage_errors.get(name, -60) >= 60:
                logging.getLogger(__name__).warning('Plugin runtime stage failed: %s', name)
                self.stage_errors[name] = now
            return None

    def _loop(self):
        while not self.stopped.is_set():
            self._stage('lease-recovery', self.scheduler.reap)
            self._stage('scheduling', self.scheduler.schedule_due)
            self._stage('events', self.events.dispatch)
            self._stage('reconcile', self.reconcile)
            for plugin_id in {key[0] for key in self.enabled}:
                try:
                    development = self.development.read(plugin_id)
                except ApiError:
                    continue  # Fail closed for this plugin, not all schedulers.
                if development and development['backend']:
                    continue
                future = self.pending.get(plugin_id)
                if future is None or future.done():
                    self.pending[plugin_id] = self.pool.submit(self.scheduler.run_one, plugin_id)
            self.stopped.wait(1)

    def start(self):
        self.thread = threading.Thread(target=self._loop, name='plugin-scheduler', daemon=True)
        self.thread.start()

    def close(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=2)
        self.supervisor.close()
        self.pool.shutdown(wait=True, cancel_futures=True)


def create_app(config_path, root=None):
    runtime = PluginRuntimeService(ChildService(config_path), root)
    directory = private_directory(socket_root(runtime.root))
    credential_path = directory / 'control.token'
    if credential_path.exists():
        require(not credential_path.is_symlink() and credential_path.stat().st_uid == os.getuid() and credential_path.stat().st_mode & 0o077 == 0, 503, '运行凭证权限不正确。')
        credential = credential_path.read_text().strip()
    else:
        credential = secrets.token_urlsafe(48)
        with credential_path.open('x') as file:
            file.write(credential)
        credential_path.chmod(0o600)
    runtime.transport_signer = ContextSigner(hashlib.sha256(credential.encode()).digest())
    bridge_token = secrets.token_urlsafe(32)
    bridge_token_path = directory / 'bridge.token'
    if bridge_token_path.exists():
        bridge_token = bridge_token_path.read_text().strip()
        require(not bridge_token_path.is_symlink() and bridge_token_path.stat().st_mode & 0o077 == 0, 503, '插件Bridge凭证权限不正确。')
    else:
        with bridge_token_path.open('x') as file:
            file.write(bridge_token)
        bridge_token_path.chmod(0o600)

    @asynccontextmanager
    async def lifespan(app):
        # One scheduler/worker owner for a root. A second service may not steal
        # the control socket or create another subprocess for the same plugin.
        lock = (directory / 'service.lock').open('a+')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            runtime.start()
            yield
        finally:
            runtime.close()
            lock.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.runtime = runtime

    @app.exception_handler(ApiError)
    async def api_error(request, error):
        return JSONResponse({'error': error.error, 'kind': error.kind}, status_code=error.status)

    @app.post('/{operation}')
    async def operate(operation: str, request: Request):
        expected = bridge_token if operation == 'bridge' else credential
        require(hmac.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + expected), 403, '运行服务身份校验失败。')
        require(operation in ('call', 'bridge', 'health', 'stop', 'ready', 'dev-register', 'dev-reload', 'dev-stop', 'dev-status'), 404)
        chunks = bytearray()
        async for chunk in request.stream():
            chunks.extend(chunk)
            require(len(chunks) <= 1024 * 1024, 413)
        import json
        try:
            body = json.loads(chunks or b'{}')
        except ValueError:
            raise ApiError(400, '请求格式不正确。') from None
        require(isinstance(body, dict), 400)
        if operation == 'ready':
            from lele_growth.plugins.manifest import FRONTEND_API_MINOR
            return {'ok': True, 'protocol': '1.0', 'frontendMinor': FRONTEND_API_MINOR}
        if operation.startswith('dev-'):
            return await run_in_threadpool(runtime.control_development, operation, body)
        if operation == 'bridge':
            require(isinstance(body.get('context'), dict) and isinstance(body.get('action'), str) and isinstance(body.get('payload'), dict), 400)
            runtime.transport_signer.verify(body['context'])
            return await run_in_threadpool(runtime.handle_bridge, body['context'], body['action'], body['payload'])
        if operation == 'call':
            return await run_in_threadpool(runtime.call, body.get('context'), body.get('action'), body.get('payload'), timeout=body.get('timeoutSeconds'), development=body.get('development'))
        require(isinstance(body.get('pluginId'), str) and (isinstance(body.get('version'), str) or operation == 'stop' and body.get('version') is None), 400)
        if operation == 'health':
            return await run_in_threadpool(runtime.supervisor.health, body['pluginId'], body['version'])
        timeout = body.get('timeout', 30)
        require(type(timeout) in (int, float) and 0 <= timeout <= 30, 400)
        return await run_in_threadpool(runtime.supervisor.stop, body['pluginId'], body.get('version'), timeout=timeout)
    return app


def create_from_env():
    config_path = os.environ.get('LELE_ACCOUNTS_CONFIG')
    require(config_path, 503, '必须显式指定 LELE_ACCOUNTS_CONFIG。')
    return create_app(config_path)


def _code_stamp(root):
    stamp = []
    for path in root.rglob('*.py'):
        if '__pycache__' in path.parts:
            continue
        try:
            stamp.append((str(path.relative_to(root)), path.stat().st_mtime_ns))
        except OSError:
            continue
    return tuple(sorted(stamp))


def _reload_development_runtime(config, directory):
    """Restart the runtime child when backend code changes. Development only."""
    command = [sys.executable, str(Path(__file__).resolve()), '--config', str(config)]
    env = os.environ.copy()
    env['LELE_DEV_RELOAD_CHILD'] = '1'
    watch = ROOT / 'backend' / 'lele_growth'
    sock = directory / 'control.sock'
    state = {'process': None, 'stop': False}

    def stop(signum, _frame):
        state['stop'] = True
        process = state['process']
        if process is not None and process.poll() is None:
            process.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not state['stop']:
        seen = _code_stamp(watch)
        if sock.exists() or sock.is_symlink():
            sock.unlink()
        process = subprocess.Popen(command, env=env)
        state['process'] = process
        changed = False
        while process.poll() is None and not state['stop']:
            time.sleep(0.5)
            if _code_stamp(watch) != seen:
                changed = True
                process.terminate()
                break
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        if state['stop'] or not changed:
            return process.returncode or 0
    process = state['process']
    return process.returncode or 0 if process is not None else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args(argv)
    directory = private_directory(socket_root())
    if os.environ.get('LELE_DEV_RELOAD') == '1' and os.environ.get('LELE_DEV_RELOAD_CHILD') != '1':
        raise SystemExit(_reload_development_runtime(args.config, directory))
    import uvicorn
    # umask also protects uvicorn's Unix socket from other local users.
    os.umask(0o077)
    uvicorn.run(create_app(args.config), uds=str(directory / 'control.sock'), access_log=False, log_level='warning')


if __name__ == '__main__':
    main()

"""Independent private runtime service. Never mounted on parent/admin or TCP.

Run: python deploy/plugin_runtime.py --config <explicit-config>
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import fcntl
import hmac
import logging
import hashlib
import os
from pathlib import Path
import secrets
import signal
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
from lele_growth.plugins.scheduler import PluginScheduler
from lele_growth.plugins.supervisor import PluginSupervisor, plugin_root, private_directory, socket_root


class PluginRuntimeService:
    def __init__(self, service, root=None):
        self.service = service
        self.root = Path(root or plugin_root()).resolve()
        self.supervisor = PluginSupervisor(self.root)
        self.gateway = PluginGateway(service, runtime=self.supervisor)
        self.scheduler = PluginScheduler(service, self.gateway)
        self.events = EventDispatcher(service, self.scheduler)
        self.stopped = threading.Event()
        self.thread = None
        self.pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix='plugin-jobs')
        self.pending = {}
        self.transport_signer = None
        self.stage_errors = {}
        self.enabled = set()

    def call(self, context, action, payload, *, timeout=None):
        require(action in ('handle_request', 'handle_job', 'cancel_job') and isinstance(context, dict) and isinstance(payload, dict), 400)
        (self.transport_signer or self.gateway.signer).verify(context)
        def check(cur):
            current = active_context(cur, context.get('pluginId'), context.get('childId'))
            assert_fences(current, context)
            require(current['version'] == context.get('version') and time.time() < context.get('expiresAt', 0), 403)
            require(isinstance(context.get('scopeToken'), str) and set(context.get('capabilities', [])) <= set(current['capabilities']), 403)
            task = next((task for task in current['manifest'].get('tasks', []) if task['id'] == payload.get('task')), None)
            maximum = task.get('timeoutSeconds', 10) if task and action == 'handle_job' else 10
            selected = min(10, maximum) if timeout is None else timeout
            require(type(selected) in (int, float) and 0 < selected <= maximum <= 300, 400, '任务超时预算不正确。')
            return selected
        selected = self.service.transaction(check)
        return self.supervisor.call(context, action, payload, timeout=selected)

    def reconcile(self):
        # Never acquire another plugin's catalog lock while retaining a child's
        # row lock from the previous plugin. Lifecycle operations lock catalog
        # first and may be waiting for that same child.
        pairs = self.service.transaction(lambda cur: rows_dict(cur.execute(
            "SELECT plugin_id,child_id FROM lele.child_plugins WHERE installed AND enabled ORDER BY plugin_id,child_id LIMIT 10000")))
        enabled = set()
        for pair in pairs:
            try:
                current = self.service.transaction(lambda cur: active_context(cur, pair['plugin_id'], pair['child_id']))
                if current['manifest'].get('backend'):
                    enabled.add((pair['plugin_id'], current['version']))
            except ApiError:
                continue
        prepared = self.service.transaction(lambda cur: rows_dict(cur.execute(
            "SELECT d.plugin_id,r.version FROM lele.plugin_deployments d JOIN lele.plugin_releases r ON r.release_id=d.new_release_id WHERE d.status='running' AND d.lease_until>now()")))
        enabled.update((row['plugin_id'], row['version']) for row in prepared)
        for key in list(self.supervisor.workers):
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
        require(hmac.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + credential), 403, '运行服务身份校验失败。')
        require(operation in ('call', 'health', 'stop'), 404)
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
        if operation == 'call':
            return await run_in_threadpool(runtime.call, body.get('context'), body.get('action'), body.get('payload'), timeout=body.get('timeoutSeconds'))
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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args(argv)
    import uvicorn
    directory = private_directory(socket_root())
    # umask also protects uvicorn's Unix socket from other local users.
    os.umask(0o077)
    uvicorn.run(create_app(args.config), uds=str(directory / 'control.sock'), access_log=False, log_level='warning')


if __name__ == '__main__':
    main()

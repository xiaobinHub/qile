"""Bounded Unix HTTP subprocess supervisor; importing this never imports plugins."""
from __future__ import annotations

import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field

from lele_growth.child_service import ApiError, require
from lele_growth.paths import PROJECT_ROOT

MAX_BODY = 1024 * 1024


def plugin_root():
    return Path(os.environ.get('LELE_PLUGIN_ROOT', PROJECT_ROOT / 'data' / 'plugin-runtime')).resolve()


def socket_root(root=None):
    root = Path(root or plugin_root()).resolve()
    digest = hashlib.sha256(str(root).encode()).hexdigest()[:12]
    return Path(os.environ.get('LELE_PLUGIN_SOCKET_ROOT', Path(tempfile.gettempdir()) / f'lele-plugin-{os.getuid()}-{digest}'))


def private_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(not path.is_symlink() and path.stat().st_uid == os.getuid() and path.stat().st_mode & 0o077 == 0,
            503, '应用运行目录权限不正确。', 'plugin_runtime_unavailable')
    return path


def release_path(plugin_id, version, root=None):
    require(isinstance(plugin_id, str) and re.fullmatch(r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*', plugin_id), 400)
    require(isinstance(version, str) and re.fullmatch(r'\d+\.\d+\.\d+', version), 400)
    base = Path(root or plugin_root()).resolve()
    path = base / plugin_id / 'releases' / version
    require(path.resolve() == path and not path.is_symlink(), 400, '应用版本路径不正确。')
    return path


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__('localhost', timeout=timeout)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def unix_request(path, endpoint, body, *, timeout=10, credential=None):
    connection = UnixConnection(path, timeout)
    try:
        data = json.dumps(body, allow_nan=False).encode()
        require(len(data) <= MAX_BODY, 413, '应用请求过大。')
        headers = {'Content-Type': 'application/json'}
        if credential:
            headers['Authorization'] = 'Bearer ' + credential
        connection.request('POST', endpoint, data, headers)
        response = connection.getresponse()
        data = response.read(MAX_BODY + 1)
        require(len(data) <= MAX_BODY, 502, '应用响应过大。', 'plugin_invalid_response')
        result = json.loads(data)
        require(response.status == 200, 503 if response.status == 503 else 502,
                '应用进程暂时无法处理请求。', 'plugin_worker_failed')
        require(isinstance(result, dict), 502, '应用响应格式不正确。', 'plugin_invalid_response')
        return result
    except (OSError, http.client.HTTPException, ValueError):
        raise ApiError(503, '应用运行服务暂时不可用。', 'plugin_runtime_unavailable') from None
    finally:
        connection.close()


@dataclass
class Worker:
    plugin_id: str
    version: str
    process: subprocess.Popen
    socket: Path
    inflight: int = 0
    stopping: bool = False
    capacity: threading.BoundedSemaphore = field(default_factory=lambda: threading.BoundedSemaphore(4))


class PluginSupervisor:
    def __init__(self, root=None, *, start_timeout=8, call_timeout=10, drain_timeout=30):
        self.root = Path(root or plugin_root()).resolve()
        self.sockets = private_directory(socket_root(self.root))
        self.start_timeout, self.call_timeout, self.drain_timeout = start_timeout, call_timeout, drain_timeout
        self.workers = {}
        self.failures = {}
        self.lock = threading.RLock()
        self.plugin_locks = {}

    def _plugin_lock(self, plugin_id):
        with self.lock:
            return self.plugin_locks.setdefault(plugin_id, threading.RLock())

    def start(self, plugin_id, version, *, candidate=False):
        with self._plugin_lock(plugin_id):
            key = (plugin_id, version)
            with self.lock:
                worker = self.workers.get(key)
                if worker and worker.process.poll() is None and not worker.stopping:
                    return worker
                failures, retry_at = self.failures.get(key, (0, 0))
            require(time.monotonic() >= retry_at, 503, '应用正在等待重启。', 'plugin_restart_backoff')
            release = release_path(plugin_id, version, self.root)
            manifest = json.loads((release / 'plugin.json').read_text())
            backend = manifest.get('backend')
            require(backend and backend.get('entryModule'), 409, '此应用没有后台进程。')
            executable = release / '.venv' / 'bin' / 'python'
            require(executable.is_file(), 503, '应用独立运行环境尚未准备。', 'plugin_venv_missing')
            sock = self.sockets / ('w-' + secrets.token_hex(8) + '.sock')
            environment = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
            environment.update(PYTHONUNBUFFERED='1', PYTHONDONTWRITEBYTECODE='1')
            command = [str(executable), '-I', '-m', 'lele_plugin_sdk.worker', '--module', backend['entryModule'], '--socket', str(sock)]
            process = subprocess.Popen(command, cwd=release, env=environment, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
            worker = Worker(plugin_id, version, process, sock)
            try:
                deadline = time.monotonic() + self.start_timeout
                while time.monotonic() < deadline and process.poll() is None:
                    try:
                        if sock.exists():
                            health = unix_request(sock, '/health', {}, timeout=0.5)
                            require(health.get('ok') is True and health.get('protocol') == '1.0', 503, '应用健康检查失败。')
                            with self.lock:
                                self.workers[key] = worker
                                self.failures.pop(key, None)
                            return worker
                    except ApiError:
                        pass
                    time.sleep(0.025)
                raise ApiError(503, '应用进程启动或健康检查失败。', 'plugin_start_failed')
            except BaseException:
                self._terminate(worker)
                with self.lock:
                    self.failures[key] = (failures + 1, time.monotonic() + min(60, 2 ** min(failures, 6)))
                raise

    @staticmethod
    def _terminate(worker):
        if worker.process.poll() is None:
            try:
                os.killpg(worker.process.pid, signal.SIGTERM)
                worker.process.wait(timeout=2)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(worker.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                worker.process.wait(timeout=2)
        worker.socket.unlink(missing_ok=True)

    def call(self, context, action, payload, *, timeout=None):
        require(action in ('handle_request', 'handle_job', 'cancel_job'), 400)
        timeout = self.call_timeout if timeout is None else timeout
        require(type(timeout) in (int, float) and 0 < timeout <= 300, 400)
        worker = self.start(context['pluginId'], context['version'])
        require(worker.capacity.acquire(blocking=False), 503, '应用正在处理较多请求。', 'plugin_busy')
        try:
            with self.lock:
                require(not worker.stopping, 503, '应用更新中。', 'plugin_updating')
                worker.inflight += 1
            try:
                try:
                    return unix_request(worker.socket, '/' + action, {**payload, 'context': context}, timeout=timeout)
                except ApiError as error:
                    if error.kind == 'plugin_runtime_unavailable':
                        # A timed-out computation cannot accumulate behind later
                        # requests. Fence its results and terminate its group.
                        worker.stopping = True
                        self._terminate(worker)
                        with self.lock:
                            count, _ = self.failures.get((worker.plugin_id, worker.version), (0, 0))
                            self.failures[(worker.plugin_id, worker.version)] = (count + 1, time.monotonic() + min(60, 2 ** min(count, 6)))
                    raise
            finally:
                with self.lock:
                    worker.inflight -= 1
        finally:
            worker.capacity.release()

    def health(self, plugin_id, version):
        worker = self.start(plugin_id, version, candidate=True)
        health = unix_request(worker.socket, '/health', {}, timeout=1)
        require(health.get('ok') is True and health.get('protocol') == '1.0',
                503, '应用健康检查失败。', 'plugin_health_failed')
        return health

    def stop(self, plugin_id, version=None, *, timeout=None):
        # No global lock is held during network calls, waits or process termination.
        with self._plugin_lock(plugin_id):
            with self.lock:
                workers = [(key, value) for key, value in self.workers.items() if key[0] == plugin_id and (version is None or key[1] == version)]
                for _, worker in workers:
                    worker.stopping = True
            deadline = time.monotonic() + (self.drain_timeout if timeout is None else timeout)
            for key, worker in workers:
                while worker.inflight and time.monotonic() < deadline:
                    time.sleep(0.025)
                if worker.process.poll() is None and not worker.inflight:
                    try:
                        unix_request(worker.socket, '/shutdown', {}, timeout=0.5)
                        worker.process.wait(timeout=1)
                    except (ApiError, subprocess.TimeoutExpired):
                        pass
                self._terminate(worker)
                with self.lock:
                    self.workers.pop(key, None)
        return {'ok': True, 'stopped': len(workers)}

    def close(self):
        for plugin_id in {key[0] for key in list(self.workers)}:
            self.stop(plugin_id, timeout=0)


class RuntimeClient:
    """Parent/admin talk only to the local runtime service, never spawn workers."""
    def __init__(self, root=None):
        self.root = Path(root or plugin_root()).resolve()
        self.sockets = socket_root(self.root)

    def _request(self, endpoint, body, timeout=15):
        try:
            credential = (self.sockets / 'control.token').read_text().strip()
        except OSError:
            raise ApiError(503, '应用运行服务尚未启动。', 'plugin_runtime_unavailable') from None
        return unix_request(self.sockets / 'control.sock', endpoint, body, timeout=timeout, credential=credential)

    def call(self, context, action, payload, *, timeout=None):
        from .gateway import ContextSigner
        try:
            credential = (self.sockets / 'control.token').read_text().strip()
        except OSError:
            raise ApiError(503, '应用运行服务尚未启动。', 'plugin_runtime_unavailable') from None
        # The worker never receives this authority key. The private runtime
        # verifies the signed scope as well as the transport identity.
        signer = ContextSigner(hashlib.sha256(credential.encode()).digest())
        remaining = min(360, int(context.get('expiresAt', 0) - time.time()))
        require(remaining >= 1, 403, '应用上下文已过期。', 'plugin_context_invalid')
        sealed = signer.issue(context, actor=context.get('actorId'), job_id=context.get('jobId'),
                              capabilities=context.get('capabilities'), ttl=remaining)
        return self._request('/call', dict(context=sealed, action=action, payload=payload, timeoutSeconds=timeout), timeout=max(15, (timeout or 10) + 10))

    def health(self, plugin_id, version):
        return self._request('/health', dict(pluginId=plugin_id, version=version))

    def stop(self, plugin_id, version=None, *, timeout=30):
        return self._request('/stop', dict(pluginId=plugin_id, version=version, timeout=timeout), timeout=timeout + 5)

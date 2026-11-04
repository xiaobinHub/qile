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
from contextlib import nullcontext

from lele_growth.child_service import ApiError, require
from lele_growth.paths import PROJECT_ROOT

MAX_BODY = 1024 * 1024
MAX_DEV_LOG = 1024 * 1024
DEV_CONTROL_ERRORS = {
    'plugin_dev_incompatible': '源码清单、配置结构或安装版本不兼容，请检查后显式部署或停止开发会话。',
    'plugin_dev_session_exists': '此插件已有开发会话，请先停止已有会话。',
    'plugin_dev_session_changed': '此终端的开发会话已失效，未修改当前会话。',
    'plugin_dev_draining': '仍有业务请求或 Bridge 事务执行中；未强制终止，请稍后重试。',
    'plugin_dev_disabled': '开发模式仅允许本机 development 配置。',
    'plugin_dev_not_installed': '请先显式安装插件版本。',
    'plugin_dev_unavailable': '开发服务不可用，请检查 Vite 终端和本机私有 worker.log。',
    'plugin_dev_environment_failed': '开发独立环境准备失败，请检查本机开发目录权限。',
    'plugin_start_failed': '开发后端启动失败，请查看本机私有 worker.log 后重载。',
    'plugin_dev_start_failed': '开发后端启动失败，请查看本机私有 worker.log 后重载。',
}


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
        if response.status != 200 and endpoint.startswith('/dev-'):
            kind = result.get('kind', '') if isinstance(result, dict) else ''
            kind = kind if isinstance(kind, str) else ''
            raise ApiError(response.status if response.status in (400, 403, 404, 409, 503) else 503,
                           DEV_CONTROL_ERRORS.get(kind, '插件开发控制失败，请检查会话状态和本机私有 worker.log。'),
                           kind if isinstance(kind, str) and re.fullmatch(r'plugin_[a-z_]+', kind) else 'plugin_dev_failed')
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
    log_thread: threading.Thread | None = None
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
        self.development_registry = None
        self.invocation_guard = None

    def _plugin_lock(self, plugin_id):
        with self.lock:
            return self.plugin_locks.setdefault(plugin_id, threading.RLock())

    def start(self, plugin_id, version, *, candidate=False, development=None):
        with self._plugin_lock(plugin_id):
            if development is None and self.development_registry is not None:
                session = self.development_registry.read(plugin_id)
                require(session is None or not session['backend'], 503,
                        '此应用已进入开发模式。', 'plugin_dev_unavailable')
            key = (plugin_id, version) if development is None else (plugin_id, 'dev:' + development['sessionId'] + ':' + str(development['revision']))
            with self.lock:
                worker = self.workers.get(key)
                if worker and worker.process.poll() is None and not worker.stopping:
                    return worker
                failures, retry_at = self.failures.get(key, (0, 0))
            require(time.monotonic() >= retry_at, 503, '应用正在等待重启。', 'plugin_restart_backoff')
            release = release_path(plugin_id, version, self.root) if development is None else Path(development['sourceRoot'])
            manifest = json.loads((release / 'plugin.json').read_text())
            backend = manifest.get('backend')
            require(backend and backend.get('entryModule'), 409, '此应用没有后台进程。')
            executable = release / '.venv' / 'bin' / 'python' if development is None else Path(development['executable'])
            require(executable.is_file(), 503, '应用独立运行环境尚未准备。', 'plugin_venv_missing')
            sock = self.sockets / ('w-' + secrets.token_hex(8) + '.sock')
            environment = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
            environment.update(PYTHONUNBUFFERED='1', PYTHONDONTWRITEBYTECODE='1')
            if backend.get('requestTimeoutSeconds'):
                environment['LELE_PLUGIN_BRIDGE_SOCKET'] = str(self.sockets / 'control.sock')
                credential = (self.sockets / 'bridge.token').read_text().strip() if (self.sockets / 'bridge.token').is_file() else ''
                if credential:
                    environment['LELE_PLUGIN_BRIDGE_TOKEN'] = credential
            command = [str(executable), '-I', '-B', '-m', 'lele_plugin_sdk.worker', '--module', backend['entryModule'], '--socket', str(sock)]
            if development is not None:
                # Ignore any stale source __pycache__ left by external editors.
                command[3:3] = ['-X', 'pycache_prefix=' + str(executable.parent.parent / ('bytecode-' + str(development['revision'])))]
            log = None
            if development is not None:
                command.insert(1, '-u')
                log_path = executable.parent.parent / 'worker.log'
                fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
                try:
                    require(os.fstat(fd).st_uid == os.getuid() and os.fstat(fd).st_mode & 0o077 == 0, 503,
                            '开发日志权限不正确。', 'plugin_dev_environment_failed')
                    log = os.fdopen(fd, 'ab', buffering=0)
                except BaseException:
                    os.close(fd)
                    raise
            try:
                process = subprocess.Popen(command, cwd=release, env=environment, stdin=subprocess.DEVNULL,
                                           stdout=subprocess.PIPE if log else subprocess.DEVNULL,
                                           stderr=subprocess.STDOUT if log else subprocess.DEVNULL,
                                           start_new_session=True, close_fds=True)
            except BaseException:
                if log:
                    log.close()
                raise
            worker = Worker(plugin_id, key[1], process, sock)
            if log:
                worker.log_thread = threading.Thread(target=self._capture_log, args=(process.stdout, log), daemon=True,
                                                     name='plugin-dev-log')
                worker.log_thread.start()
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
    def _capture_log(stream, log):
        """Drain both streams without accumulating memory or unbounded files."""
        try:
            with log, stream:
                while chunk := stream.read1(8192):
                    if os.fstat(log.fileno()).st_size + len(chunk) > MAX_DEV_LOG:
                        log.truncate(0)
                        log.seek(0)
                    log.write(chunk)
                    log.flush()
        except OSError:
            pass  # Never print log content or filesystem exception details.

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
        if worker.log_thread:
            worker.log_thread.join(timeout=2)

    def call(self, context, action, payload, *, timeout=None, development=None):
        guard = self.invocation_guard(context, development) if self.invocation_guard else nullcontext(context)
        with guard as sealed:
            return self._call(sealed, action, payload, timeout=timeout, development=development)

    def _call(self, context, action, payload, *, timeout=None, development=None):
        require(action in ('handle_request', 'handle_job', 'cancel_job'), 400)
        timeout = self.call_timeout if timeout is None else timeout
        require(type(timeout) in (int, float) and 0 < timeout <= 300, 400)
        if development is None:
            worker = self.start(context['pluginId'], context['version'])
        else:
            # A crashed source worker fails closed until an explicit reload.
            key = (context['pluginId'], 'dev:' + development['sessionId'] + ':' + str(development['revision']))
            with self.lock:
                worker = self.workers.get(key)
                require(worker is not None and worker.process.poll() is None and not worker.stopping,
                        503, '插件开发进程不可用，请显式重载。', 'plugin_dev_unavailable')
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

    def drain_development(self, plugin_id, *, source_only=False, timeout=30):
        """Pause admission; never kill an in-flight operation due to a save."""
        with self._plugin_lock(plugin_id):
            with self.lock:
                workers = [(key, worker) for key, worker in self.workers.items()
                           if key[0] == plugin_id and (not source_only or key[1].startswith('dev:'))]
                for _, worker in workers:
                    worker.stopping = True
            deadline = time.monotonic() + timeout
            for key, worker in workers:
                while worker.inflight and time.monotonic() < deadline:
                    time.sleep(0.025)
                require(not worker.inflight, 503, '开发进程仍有请求执行中，请稍后重载或停止。', 'plugin_dev_draining')
                self._terminate(worker)
                with self.lock:
                    self.workers.pop(key, None)
                    self.failures.pop(key, None)
        return {'ok': True, 'stopped': len(workers)}


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
        from .dev_mode import invocation
        return self._request('/call', dict(context=sealed, action=action, payload=payload, timeoutSeconds=timeout,
                                          development=invocation.get()), timeout=max(15, (timeout or 10) + 10))

    def health(self, plugin_id, version):
        return self._request('/health', dict(pluginId=plugin_id, version=version))

    def stop(self, plugin_id, version=None, *, timeout=30):
        return self._request('/stop', dict(pluginId=plugin_id, version=version, timeout=timeout), timeout=timeout + 5)

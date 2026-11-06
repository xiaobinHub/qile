"""Local plugin sessions. Installed policy/data remain the only authority.

The registry is an overlay, never an installation. A dead/failed session stays
registered until explicit stop. flock admissions also cover generic host writes.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager, suppress
from contextvars import ContextVar
import base64
import copy
import fcntl
import http.client
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import time

from lele_growth.child_service import ApiError, require
from lele_growth.paths import PROJECT_ROOT

invocation = ContextVar('plugin_development_invocation', default=None)
ID = r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*'
SESSION = r'[A-Za-z0-9_-]{8,128}'


def local_development(config):
    return (config.get('environment') == 'development'
            and config.get('database', {}).get('host') in ('localhost', '127.0.0.1', '::1'))


def unavailable(kind='plugin_dev_unavailable'):
    return ApiError(503, '插件开发服务不可用，请检查开发终端或显式停止开发会话。', kind)


class DevRegistry:
    def __init__(self, config, *, repo=None, root=None):
        self.enabled = local_development(config)
        self.repo = Path(repo or PROJECT_ROOT).resolve()
        self.root = Path(root or self.repo / 'data/development/plugin-dev')

    def guard(self):
        require(self.enabled, 404, '开发模式仅允许本机 development 配置。', 'plugin_dev_disabled')

    def path(self, plugin_id):
        require(isinstance(plugin_id, str) and len(plugin_id) <= 64 and re.fullmatch(ID, plugin_id), 400)
        return self.root / (plugin_id + '.json')

    def directory(self):
        from .supervisor import private_directory
        self.guard()
        return private_directory(self.root)

    def read(self, plugin_id):
        if not self.enabled:
            return None
        path = self.path(plugin_id)
        try:
            if self.root.exists():
                require(not self.root.is_symlink() and self.root.stat().st_uid == os.getuid()
                        and self.root.stat().st_mode & 0o077 == 0, 503)
            require(not path.is_symlink(), 503)
            if not path.exists():
                return None
            require(path.stat().st_uid == os.getuid() and path.stat().st_mode & 0o077 == 0, 503)
            data = json.loads(path.read_text())
            require(data['pluginId'] == plugin_id and re.fullmatch(SESSION, data['sessionId'])
                    and type(data['port']) is int and 1 <= data['port'] <= 65535
                    and type(data['revision']) is int and data['revision'] >= 1
                    and type(data['backend']) is bool and type(data['pid']) is int and data['pid'] > 0
                    and data['sourceRoot'] == str(self.repo / 'plugins' / plugin_id), 503)
            return data
        except (OSError, ValueError, KeyError, TypeError, ApiError):
            raise unavailable('plugin_dev_registry_invalid') from None

    def write(self, data):
        self.directory()
        path = self.path(data['pluginId'])
        temporary = self.root / ('.' + secrets.token_hex(12))
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as target:
                json.dump(data, target, allow_nan=False)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    @contextmanager
    def lock(self, plugin_id, *, exclusive=False, wait=False, control=False, timeout=350):
        self.directory()
        suffix = '.control.lock' if control else '.admission.lock'
        path = self.path(plugin_id).with_suffix(suffix)
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            deadline = time.monotonic() + timeout
            while True:
                try:
                    fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if not wait or time.monotonic() >= deadline:
                        raise unavailable('plugin_dev_draining') from None
                    time.sleep(min(.025, max(0, deadline - time.monotonic())))
            yield
        finally:
            os.close(fd)

    def live(self, data):
        require(data.get('state') == 'ready', 503, '插件开发服务正在重载或启动失败。', 'plugin_dev_unavailable')
        connection = http.client.HTTPConnection('127.0.0.1', data['port'], timeout=0.75)
        try:
            os.kill(data['pid'], 0)
            connection.request('GET', f"/__plugin-dev/{data['pluginId']}/{data['sessionId']}/__dev_health")
            response = connection.getresponse()
            body = response.read(1025)
            require(response.status == 200 and len(body) <= 1024, 503)
            health = json.loads(body)
            require(isinstance(health, dict) and health.get('ok') is True, 503)
        except (OSError, http.client.HTTPException, ValueError, ApiError):
            raise unavailable() from None
        finally:
            connection.close()
        return data

    def fence(self, plugin_id, session, revision, *, check_live=True):
        data = self.read(plugin_id)
        if data is None:
            require(session is None and revision is None, 409, '开发会话已停止，请重新进入应用。', 'plugin_dev_session_changed')
        else:
            require(session == data['sessionId'] and str(revision) == str(data['revision']), 409,
                    '开发会话已改变，请重新进入应用。', 'plugin_dev_session_changed')
            if check_live:
                self.live(data)
        return data

    @contextmanager
    def admission(self, plugin_id, session=None, revision=None, *, release_id=None):
        if not self.enabled:
            self.fence(plugin_id, session, revision)
            yield None
            return
        # Even installed calls acquire admission: registration must drain them.
        with self.lock(plugin_id):
            data = self.fence(plugin_id, session, revision)
            require(data is None or release_id is None or data.get('releaseId') == release_id,
                    409, '安装版本已改变，请停止开发会话。', 'plugin_dev_incompatible')
            token = invocation.set(None if data is None else {
                'pluginId': plugin_id, 'sessionId': data['sessionId'], 'revision': data['revision']})
            try:
                yield data
            finally:
                invocation.reset(token)

    def descriptor(self, plugin_id, release_id=None):
        data = self.read(plugin_id)
        if data is None:
            return None
        require(release_id is None or data.get('releaseId') == release_id, 409,
                '安装版本已改变，请停止开发会话。', 'plugin_dev_incompatible')
        if data.get('state') != 'draining':
            self.live(data)
        return {key: data[key] for key in ('sessionId', 'revision', 'backend', 'state')} | {
            'base': f"/__plugin-dev/{plugin_id}/{data['sessionId']}/"}

    @contextmanager
    def internal_admission(self, plugin_id):
        """Installed background jobs are independent of frontend liveness."""
        if not self.enabled:
            yield None
            return
        with self.lock(plugin_id):
            data = self.read(plugin_id)
            require(data is None or not data['backend'], 503,
                    '源码后台模式暂停已安装后台任务。', 'plugin_dev_draining')
            yield data

    def compatible(self, plugin_id, installed, config_schema=None):
        from .manifest import validate_manifest
        source = self.repo / 'plugins' / plugin_id
        require(source.resolve() == source and source.is_dir(), 400, '开发源码路径不正确。')
        try:
            manifest = json.loads((source / 'plugin.json').read_text())
            validate_manifest(manifest)
            left, right = copy.deepcopy(manifest), copy.deepcopy(installed)
            for value in (left, right):
                if isinstance(value.get('frontend'), dict):
                    value['frontend'].pop('entry', None)
                    value['frontend'].pop('styles', None)
            require(left == right, 409, '源码清单与已安装版本不兼容，请先显式部署。', 'plugin_dev_incompatible')
            if config_schema is not None:
                from .configuration import EMPTY_SCHEMA
                reference = manifest.get('configSchema')
                schema = json.loads((source / reference).read_text()) if isinstance(reference, str) else reference or EMPTY_SCHEMA
                require(schema == config_schema, 409, '源码配置结构与已安装版本不兼容。', 'plugin_dev_incompatible')
            return manifest
        except (OSError, ValueError):
            raise ApiError(409, '开发源码或配置清单无法读取。', 'plugin_dev_incompatible') from None

    def prepare_environment(self, data):
        """Only SDK + source backend on sys.path; no host packages/credentials."""
        source = Path(data['sourceRoot']) / 'backend'
        require(source.resolve() == source and source.is_dir(), 400, '插件后端源码不存在。')
        sdk = self.repo / 'packages/plugin-sdk-python/src'
        require((sdk / 'lele_plugin_sdk/worker.py').is_file(), 503, '插件 SDK 不存在。')
        environment = self.directory() / 'environments' / data['pluginId'] / data['sessionId']
        environment.mkdir(parents=True, exist_ok=True, mode=0o700)
        executable = environment / 'bin/python'
        try:
            if not executable.is_file():
                subprocess.run([sys.executable, '-I', '-m', 'venv', '--without-pip', str(environment)],
                               check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            result = subprocess.run([str(executable), '-I', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'],
                                    check=True, timeout=10, capture_output=True, text=True)
            site = Path(result.stdout.strip())
            require(site.is_relative_to(environment) and site.is_dir(), 503)
            # Plain absolute paths, never executable .pth statements. SDK first.
            paths = [str(sdk.resolve()), str(source.resolve())]
            require(all('\n' not in path and '\r' not in path for path in paths), 400)
            (site / 'lele-plugin-dev.pth').write_text('\n'.join(paths) + '\n')
            return executable
        except (OSError, subprocess.SubprocessError):
            raise unavailable('plugin_dev_environment_failed') from None


class WorkerAdmissions:
    """Bridge transactions retain the invocation's generation drain admission.

    An RPC timeout closes new bridge admission but waits for existing bridge
    transactions to commit/rollback before releasing the registry reader lock.
    No policy/action is bypassed here; PluginBridge still owns receipt semantics.
    """
    def __init__(self):
        self.condition = threading.Condition()
        self.active = {}

    @contextmanager
    def worker(self, context, session, signer):
        ttl = max(1, min(360, int(context.get('expiresAt', 0) - time.time())))
        sealed = signer.issue(context, actor=context.get('actorId'), job_id=context.get('jobId'),
                              job_attempt=context.get('jobAttempt'), capabilities=context.get('capabilities'), ttl=ttl)
        # Extend the normal signed claims without changing the shared gateway
        # contract. ContextSigner.verify authenticates every added claim too.
        claims = signer.verify(sealed)
        claims['development'] = None if session is None else {
            key: session[key] for key in ('sessionId', 'revision', 'backend')}
        encoded = base64.urlsafe_b64encode(json.dumps(claims, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).rstrip(b'=')
        signature = hmac.new(signer.secret, encoded, hashlib.sha256).hexdigest()
        sealed = {**sealed, 'development': claims['development'], 'scopeToken': encoded.decode() + '.' + signature}
        token = sealed['scopeToken']
        record = {'accepting': True, 'bridges': 0}
        with self.condition:
            self.active[token] = record
        try:
            yield sealed
        finally:
            with self.condition:
                record['accepting'] = False
                while record['bridges']:
                    self.condition.wait()
                self.active.pop(token, None)

    @contextmanager
    def bridge(self, context):
        with self.condition:
            record = self.active.get(context['scopeToken'])
            require(record is not None and record['accepting'], 409,
                    '插件请求已结束或开发代次已失效。', 'plugin_dev_context_revoked')
            record['bridges'] += 1
        try:
            yield
        finally:
            with self.condition:
                record['bridges'] -= 1
                self.condition.notify_all()


def installed_release(service, plugin_id):
    def query(cur):
        cur.execute('SELECT r.manifest,r.config_schema,r.release_id FROM lele.plugin_catalog p '
                    'JOIN lele.plugin_releases r ON r.release_id=p.active_release_id AND r.plugin_id=p.id WHERE p.id=%s', (plugin_id,))
        row = cur.fetchone()
        require(row is not None, 409, '请先安装插件版本。', 'plugin_dev_not_installed')
        return row
    return service.transaction(query)


def authorize_resource(service, token, surface, plugin_id):
    from .gateway import PluginGateway
    require(surface == 'parent', 403)
    def query(cur):
        user = service.authenticate(cur, token, surface)
        require(user[4] == 'active' and not user[5], 403)
        cur.execute('SELECT m.child_id FROM lele.memberships m JOIN lele.child_plugins p ON p.child_id=m.child_id '
                    'WHERE m.user_id=%s AND p.plugin_id=%s AND p.installed AND p.enabled ORDER BY m.child_id', (user[0], plugin_id))
        children = [row[0] for row in cur.fetchall()]
        for child_id in children:
            try:
                context, _ = PluginGateway(service)._authenticate(cur, plugin_id, child_id, token, None, None, surface, False)
                return context
            except ApiError:
                continue
        raise ApiError(403, '此应用未启用或不可用。', 'plugin_disabled')
    return service.transaction(query)


def proxy_target(registry, plugin_id, session, path, query):
    registry.guard()
    data = registry.read(plugin_id)
    require(data is not None and session == data['sessionId'], 409, '开发会话已失效。', 'plugin_dev_session_changed')
    registry.live({**data, 'state': 'ready'} if data.get('state') == 'draining' else data)
    # Vite owns module/fs allowlists. No URL can change the loopback authority.
    require(not any(c in path + query for c in ('\r', '\n', '\\', '\x00'))
            and not any(part in ('.', '..') for part in path.split('/')), 400)
    base = f'/__plugin-dev/{plugin_id}/{session}/'
    return data, f"http://127.0.0.1:{data['port']}{base}{path}" + ('?' + query if query else '')


def mount_proxy(app, service, registry, surface, cookie_name):
    import httpx
    from fastapi import Request, WebSocket
    from fastapi.responses import Response
    from starlette.concurrency import run_in_threadpool
    # Request annotations must be module globals for FastAPI's forward-ref resolver.
    globals().update(Request=Request, WebSocket=WebSocket)

    async def target(connection, plugin_id, session, resource):
        registry.guard()
        await run_in_threadpool(authorize_resource, service, connection.cookies.get(cookie_name), surface, plugin_id)
        return await run_in_threadpool(proxy_target, registry, plugin_id, session, resource,
                                       connection.scope.get('query_string', b'').decode('ascii'))

    @app.api_route('/__plugin-dev/{plugin_id}/{session}/{resource:path}', methods=['GET', 'HEAD'])
    async def http_proxy(plugin_id: str, session: str, resource: str, request: Request):
        _, url = await target(request, plugin_id, session, resource)
        # No cookies, authorization, forwarding headers or proxy env reach Vite.
        try:
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=15) as client:
                async with client.stream(request.method, url, headers={'Accept': request.headers.get('accept', '*/*')}) as response:
                    require(response.status_code < 300 or response.status_code >= 400, 502, '开发资源不能重定向。')
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        require(len(body) <= 32 * 1024 * 1024, 502, '开发资源过大。')
                    result = Response(bytes(body), status_code=response.status_code,
                                      headers={'Content-Type': response.headers.get('content-type', 'application/octet-stream')})
            # Revocation/session replacement before bytes are returned.
            await target(request, plugin_id, session, resource)
            return result
        except httpx.HTTPError:
            raise unavailable() from None

    @app.websocket('/__plugin-dev/{plugin_id}/{session}/{resource:path}')
    async def websocket_proxy(websocket: WebSocket, plugin_id: str, session: str, resource: str):
        tasks = []
        try:
            require(service.origin_trusted(websocket.headers.get('origin'), surface), 403)
            _, url = await target(websocket, plugin_id, session, resource)
            from websockets.asyncio.client import connect
            protocols = websocket.scope.get('subprotocols', [])
            require(protocols == ['vite-hmr'], 400)
            async with connect('ws' + url[4:], subprotocols=['vite-hmr'], proxy=None,
                               open_timeout=5, max_size=2 * 1024 * 1024) as upstream:
                await websocket.accept(subprotocol='vite-hmr')
                async def inbound():
                    while True:
                        message = await websocket.receive()
                        if message['type'] == 'websocket.disconnect':
                            return
                        await target(websocket, plugin_id, session, resource)
                        await upstream.send(message.get('text') if message.get('text') is not None else message['bytes'])
                async def outbound():
                    async for message in upstream:
                        await target(websocket, plugin_id, session, resource)
                        if isinstance(message, str):
                            await websocket.send_text(message)
                        else:
                            await websocket.send_bytes(message)
                async def recheck():
                    while True:
                        await asyncio.sleep(1)
                        await target(websocket, plugin_id, session, resource)
                tasks = [asyncio.create_task(fn()) for fn in (inbound, outbound, recheck)]
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
        except Exception:
            # Never expose upstream URLs, tokens, or server exception details.
            pass
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            with suppress(Exception):
                await websocket.close(code=1013)

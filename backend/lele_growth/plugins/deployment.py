"""Explicit single-plugin artifact preparation, activation and crash recovery.

Preview never writes files, installs packages, starts workers or changes DB state.
There are no parent/admin restarts and no schema/data migration callbacks.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid
import zipfile

from psycopg.types.json import Jsonb
from lele_growth.child_service import ApiError, require
from lele_growth.production_maintenance import target_details
from .catalog import register_release
from .configuration import EMPTY_SCHEMA, validate_schema
from .manifest import safe_relative_path, validate_manifest
from .policy import row_dict, rows_dict
from .supervisor import RuntimeClient, plugin_root, release_path

MAX_FILES = 2000
MAX_BYTES = 64 * 1024 * 1024
PHASES = ('prepare', 'updating', 'drain', 'activate', 'ready')


def inspect_package(package):
    """Validate bytes without extraction or executing package code."""
    package = Path(package)
    require(package.is_file() and package.stat().st_size <= MAX_BYTES, 400, '插件包不存在或过大。', 'plugin_invalid_package')
    files, total = {}, 0
    try:
        with tarfile.open(package, 'r:gz') as archive:
            for member in archive:
                name = member.name
                safe_relative_path(name.rstrip('/'))
                require(not member.issym() and not member.islnk() and (member.isfile() or member.isdir()), 400, '插件包不能包含链接或特殊文件。')
                if member.isdir():
                    continue
                require(name not in files and len(files) < MAX_FILES and 0 <= member.size <= MAX_BYTES, 400, '插件包文件重复或超限。')
                total += member.size
                require(total <= MAX_BYTES, 400, '插件包解压大小超限。')
                stream = archive.extractfile(member)
                files[name] = stream.read(member.size + 1)
                require(len(files[name]) == member.size, 400, '插件包文件长度不正确。')
        require({'plugin.json', 'artifact.json'} <= files.keys(), 400, '插件包缺少描述文件。')
        manifest = validate_manifest(json.loads(files['plugin.json']))
        descriptor = json.loads(files['artifact.json'])
        require(isinstance(descriptor, dict) and descriptor.get('format') == 1 and descriptor.get('pluginId') == manifest['id'] and descriptor.get('version') == manifest['version'], 400, '插件制品身份不匹配。')
        require(descriptor.get('purpose') in ('development', 'release') and isinstance(descriptor.get('sourceCommit'), str) and 0 < len(descriptor['sourceCommit']) <= 128, 400, '插件来源不正确。')
        hashes = descriptor.get('files')
        require(isinstance(hashes, dict) and set(hashes) == set(files) - {'artifact.json'}, 400, '插件摘要清单不完整。')
        for name, expected in hashes.items():
            require(isinstance(expected, str) and re.fullmatch(r'[a-f0-9]{64}', expected) and hashlib.sha256(files[name]).hexdigest() == expected, 400, '插件文件摘要不匹配。', 'plugin_hash_mismatch')
            require(name.startswith(('frontend/', 'assets/', 'schemas/', 'backend/', 'wheels/')) or name == 'plugin.json', 400, '插件包包含非白名单文件。')
        schema_ref = manifest.get('configSchema')
        schema = validate_schema(json.loads(files[schema_ref]) if isinstance(schema_ref, str) else schema_ref or EMPTY_SCHEMA)
        manifest = validate_manifest(manifest, config_schema=schema)
        require(all(icon in files and icon.endswith('.png') for icon in manifest.get('icons',[])),400,'插件图标资源缺失或格式不正确。')
        frontend = manifest.get('frontend')
        if frontend:
            require({frontend['entry'], *frontend.get('styles', []), *manifest.get('icons', [])} <= files.keys(), 400, '插件资源缺失。')
            for name, data in files.items():
                if name.endswith(('.js', '.css')):
                    text = data.decode()
                    require(not re.search(r'(?:import\s*\(|from\s*|url\(\s*)[\'"`]?https?://', text), 400, '插件不允许外部运行资源。')
                    for reference in re.findall(r'[\'"`]([^\'"`\s]+\.(?:js|css|woff2|png))[\'"`]', text):
                        resolved = (Path(name).parent / reference).as_posix()
                        safe_relative_path(resolved)
                        require(resolved in files, 400, '插件资源依赖缺失。')
        if manifest.get('backend'):
            build = descriptor.get('buildPlatform', {})
            require(build.get('purePython') is True, 400, '首期仅接受纯 Python 后端制品。', 'plugin_incompatible')
            wheels = {name: data for name, data in files.items() if name.startswith('wheels/')}
            require(len(wheels) >= 2 and any(re.fullmatch(r'lele_plugin_sdk-1\.(?:0\.0|1\.[01])-py3-none-any\.whl', Path(name).name) for name in wheels), 400, '插件缺少固定版本 SDK wheel。')
            module = manifest['backend']['entryModule'].replace('.', '/')
            require('backend/' + module + '.py' in files or 'backend/' + module + '/__init__.py' in files, 400, '插件后端入口缺失。')
            for name, data in wheels.items():
                require(name.endswith('-py3-none-any.whl'), 400, '插件含不兼容的原生 wheel。', 'plugin_incompatible')
                with zipfile.ZipFile(io.BytesIO(data)) as wheel:
                    wheel_total = 0
                    names = set()
                    for entry in wheel.infolist():
                        safe_relative_path(entry.filename.rstrip('/'))
                        require(entry.filename not in names and len(names) < MAX_FILES, 400, 'wheel 文件重复或超限。')
                        names.add(entry.filename)
                        require((entry.external_attr >> 16) & 0o170000 != 0o120000, 400, 'wheel 不能包含链接。')
                        wheel_total += entry.file_size
                        require(wheel_total <= MAX_BYTES, 400, 'wheel 解压超限。')
                    tags = [wheel.read(n).decode() for n in names if n.endswith('.dist-info/WHEEL')]
                    require(len(tags) == 1 and 'Tag: py3-none-any' in tags[0] and not re.search(r'Tag: (?!py3-none-any)', tags[0]), 400, 'wheel 平台标签不正确。')
        return {'manifest': manifest, 'descriptor': descriptor, 'configSchema': schema, 'sha256': hashlib.sha256(package.read_bytes()).hexdigest(), 'files': files}
    except (OSError, tarfile.TarError, zipfile.BadZipFile, ValueError, KeyError, UnicodeError):
        raise ApiError(400, '插件包格式无效或不完整。', 'plugin_invalid_package') from None


def prepare_release(info, root=None):
    """Install immutable release and its private no-index venv; never imports it."""
    manifest = info['manifest']
    destination = release_path(manifest['id'], manifest['version'], root)
    if destination.exists():
        require(not destination.is_symlink(), 409)
        require(all((destination / name).is_file() and not (destination / name).is_symlink() and hashlib.sha256((destination / name).read_bytes()).hexdigest() == expected for name, expected in info['descriptor']['files'].items()), 409, '已有版本内容不一致，禁止覆盖。', 'plugin_version_exists')
        if manifest.get('backend'):
            require((destination / '.venv/bin/python').is_file(), 409, '已有版本运行环境不完整。')
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    stage = Path(tempfile.mkdtemp(prefix='.prepare-', dir=destination.parent))
    try:
        for name, data in info['files'].items():
            file = stage / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
            file.chmod(0o444)
        if manifest.get('backend'):
            subprocess.run([sys.executable, '-m', 'venv', str(stage / '.venv')], check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            wheels = sorted(str(p) for p in (stage / 'wheels').glob('*.whl'))
            subprocess.run([str(stage / '.venv/bin/python'), '-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--no-deps', *wheels], check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           env={**os.environ, 'PIP_CONFIG_FILE': os.devnull, 'PIP_NO_INDEX': '1'})
            # Console scripts generated by pip refer to the temporary directory;
            # workers always use bin/python -m, so activation is relocation-safe.
        require(not destination.exists(), 409, '版本被并发创建。', 'plugin_version_exists')
        stage.rename(destination)
        return destination
    except (OSError, subprocess.SubprocessError):
        raise ApiError(503, '插件独立环境准备失败。', 'plugin_prepare_failed') from None
    finally:
        if stage.exists():
            shutil.rmtree(stage)


class PluginDeployment:
    def __init__(self, service, *, root=None, runtime=None, actor='operator', stage_hook=None):
        self.service = service
        self.root = Path(root or plugin_root()).resolve()
        self.runtime = runtime or RuntimeClient(self.root)
        self.actor, self.stage_hook = actor, stage_hook
        self.owner = str(uuid.uuid4())

    @contextmanager
    def _lock(self, plugin_id):
        # A process lock has no orphan lease on crash. The DB running-deployment
        # unique index additionally fences other operators sharing the database.
        directory = self.root / '.locks'
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        file = directory / (plugin_id + '.lock')
        require(not file.is_symlink(), 403)
        with file.open('a+') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ApiError(409, '此应用已有部署操作。', 'plugin_deployment_busy') from None
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def _read(self, plugin_id):
        def work(cur):
            cur.execute('SELECT * FROM lele.plugin_catalog WHERE id=%s', (plugin_id,))
            catalog = row_dict(cur)
            cur.execute('SELECT * FROM lele.plugin_releases WHERE plugin_id=%s ORDER BY created_at', (plugin_id,))
            releases = rows_dict(cur)
            cur.execute("SELECT * FROM lele.plugin_deployments WHERE plugin_id=%s ORDER BY created_at DESC LIMIT 10", (plugin_id,))
            return catalog, releases, rows_dict(cur)
        return self.service.transaction(work)

    def preview(self, action, *, package=None, plugin_id=None, version=None):
        require(action in ('inspect', 'deploy', 'rollback', 'recover'), 400)
        info = inspect_package(package) if package is not None else None
        if info:
            require(plugin_id is None or plugin_id == info['manifest']['id'], 400, '目标应用与包身份不一致。')
            plugin_id = info['manifest']['id']
            require(self.service.config['environment'] != 'production' or info['descriptor']['purpose'] == 'release', 403, '开发制品不能部署至生产。')
        require(isinstance(plugin_id, str) and re.fullmatch(r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*', plugin_id), 400, '需要插件 ID。')
        catalog, releases, deployments = self._read(plugin_id)
        old = next((r for r in releases if catalog and r['release_id'] == catalog['active_release_id']), None)
        candidate = next((r for r in releases if r['version'] == version), None) if version else None
        if action == 'rollback':
            require(candidate is not None, 404, '回退版本尚未登记。')
            self._verify_disk(candidate)
        candidate_schema = info['configSchema'] if info else candidate['config_schema'] if candidate else None
        candidate_data = info['manifest']['dataSchemaVersion'] if info else candidate['data_schema_version'] if candidate else None
        if candidate_schema is not None and old:
            require(candidate_data == old['data_schema_version'] and candidate_schema == old['config_schema'], 409, '此通道仅接受无需转换的兼容配置与数据版本。', 'plugin_incompatible_data')
        if info:
            same = next((r for r in releases if r['version'] == info['manifest']['version']), None)
            require(not same or same['artifact_sha256'] == info['sha256'], 409, '相同版本不可覆盖。', 'plugin_version_exists')
        return {'dryRun': True, 'action': action, 'target': target_details(self.service), 'pluginId': plugin_id,
                'currentVersion': old['version'] if old else None, 'candidateVersion': info['manifest']['version'] if info else version,
                'operationState': catalog['operation_state'] if catalog else 'unregistered', 'compatible': True,
                'deployment': self._public_deployment(deployments[0]) if deployments else None}, info

    @staticmethod
    def _public_deployment(deployment):
        return {key: deployment[key] for key in ('id', 'phase', 'status', 'old_release_id', 'new_release_id', 'error_code')}

    def _verify_disk(self, release):
        directory = release_path(release['plugin_id'], release['version'], self.root)
        try:
            descriptor = json.loads((directory / 'artifact.json').read_text())
            require(descriptor['pluginId'] == release['plugin_id'] and descriptor['version'] == release['version'], 409)
            for name, expected in descriptor['files'].items():
                safe_relative_path(name)
                file = directory / name
                require(directory.resolve() in file.resolve().parents and not file.is_symlink() and hashlib.sha256(file.read_bytes()).hexdigest() == expected, 409, '已准备的插件版本校验失败。')
            require(json.loads((directory / 'plugin.json').read_text()) == release['manifest'], 409)
        except (OSError, KeyError, ValueError):
            raise ApiError(409, '插件版本文件尚未准备或已损坏。', 'plugin_release_invalid') from None
        return directory

    def _phase(self, deployment_id, phase):
        def work(cur):
            cur.execute("UPDATE lele.plugin_deployments SET phase=%s,lease_owner=%s,lease_until=now()+interval '180 seconds',updated_at=now() WHERE id=%s AND status='running' AND lease_owner=%s RETURNING id", (phase, self.owner, deployment_id, self.owner))
            require(cur.fetchone() is not None, 409, '部署租约失效。', 'plugin_deployment_revoked')
        self.service.transaction(work)
        if self.stage_hook:
            self.stage_hook(phase)

    def execute(self, action, *, package=None, plugin_id=None, version=None, apply=False, confirm=None):
        preview, info = self.preview(action, package=package, plugin_id=plugin_id, version=version)
        if not apply or action == 'inspect':
            return preview
        require(confirm == preview['target']['targetId'], 403, '执行前必须使用预览中的 targetId 明确确认目标。')
        plugin_id = preview['pluginId']
        with self._lock(plugin_id):
            # Recheck after obtaining the operator lock, never activate a stale
            # preview or restore an installation snapshot taken before drain.
            preview, info = self.preview(action, package=package, plugin_id=plugin_id, version=version)
            if action == 'recover':
                return self._recover(plugin_id, preview)
            require(action in ('deploy', 'rollback') and (info is not None or action == 'rollback'), 400)
            def begin(cur):
                cur.execute("SELECT id FROM lele.plugin_deployments WHERE plugin_id=%s AND status='running'", (plugin_id,))
                require(cur.fetchone() is None, 409, '应用存在未完成部署，请先 recover。', 'plugin_deployment_busy')
                if info:
                    release = register_release(cur, info['manifest'], artifact_sha256=info['sha256'], source_commit=info['descriptor']['sourceCommit'], config_schema=info['configSchema'])
                else:
                    cur.execute('SELECT * FROM lele.plugin_releases WHERE plugin_id=%s AND version=%s', (plugin_id, version))
                    release = row_dict(cur)
                cur.execute('SELECT active_release_id FROM lele.plugin_catalog WHERE id=%s FOR UPDATE', (plugin_id,))
                old_id = cur.fetchone()[0]
                deployment_id = str(uuid.uuid4())
                cur.execute("INSERT INTO lele.plugin_deployments(id,plugin_id,actor,old_release_id,new_release_id,phase,lease_owner,lease_until,checks) VALUES(%s,%s,%s,%s,%s,'prepare',%s,now()+interval '180 seconds',%s)", (deployment_id, plugin_id, self.actor, old_id, release['release_id'], self.owner, Jsonb({'compatible': True})))
                return deployment_id, release, old_id
            deployment_id, release, old_id = self.service.transaction(begin)
            try:
                self._phase(deployment_id, 'prepare')
                if info:
                    prepare_release(info, self.root)
                self._verify_disk(release)
                if release['manifest'].get('backend'):
                    self.runtime.health(plugin_id, release['version'])
                self.service.transaction(lambda cur: cur.execute("UPDATE lele.plugin_catalog SET operation_state='updating',release_epoch=release_epoch+1,updated_at=now() WHERE id=%s", (plugin_id,)))
                self._phase(deployment_id, 'updating')
                self._phase(deployment_id, 'drain')
                self._drain(plugin_id, old_id, release['release_id'])
                self._phase(deployment_id, 'activate')
                self._activate(deployment_id, plugin_id, release['release_id'])
                self._phase(deployment_id, 'ready')
                self._finish(deployment_id, 'succeeded')
                return {**preview, 'dryRun': False, 'deploymentId': deployment_id, 'phase': 'ready', 'status': 'succeeded', 'releaseId': release['release_id']}
            except Exception:
                self._rollback_failure(deployment_id, plugin_id, old_id, release['release_id'])
                raise

    def _drain(self, plugin_id, old_id, new_id):
        if old_id and old_id != new_id:
            old = self.service.transaction(lambda cur: row_dict(cur.execute('SELECT * FROM lele.plugin_releases WHERE release_id=%s', (old_id,))))
            if old['manifest'].get('backend'):
                self.runtime.stop(plugin_id, old['version'], timeout=30)
        def work(cur):
            # Declarative record effects have no external uncertainty. Old workers
            # cannot commit after epoch changes; unfinished computations retry.
            cur.execute("UPDATE lele.plugin_jobs SET status=CASE WHEN payload->>'externalNonIdempotent'='true' THEN 'uncertain' ELSE 'retry' END,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE plugin_id=%s AND status='running'", (plugin_id,))
        self.service.transaction(work)

    def _activate(self, deployment_id, plugin_id, release_id):
        def work(cur):
            cur.execute("SELECT id FROM lele.plugin_deployments WHERE id=%s AND lease_owner=%s AND lease_until>now() AND status='running' FOR UPDATE", (deployment_id, self.owner))
            require(cur.fetchone() is not None, 409, '部署租约失效。')
            cur.execute("UPDATE lele.plugin_catalog SET active_release_id=%s,operation_state='ready',release_epoch=release_epoch+1,updated_at=now() WHERE id=%s", (release_id, plugin_id))
        self.service.transaction(work)

    def _finish(self, deployment_id, status, *, error_code=None):
        self.service.transaction(lambda cur: cur.execute('UPDATE lele.plugin_deployments SET status=%s,error_code=%s,completed_at=now(),lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=%s AND lease_owner=%s', (status, error_code, deployment_id, self.owner)))

    def _rollback_failure(self, deployment_id, plugin_id, old_id, new_id):
        try:
            if old_id:
                old = self.service.transaction(lambda cur: row_dict(cur.execute('SELECT * FROM lele.plugin_releases WHERE release_id=%s', (old_id,))))
                self._verify_disk(old)
                if old['manifest'].get('backend'):
                    self.runtime.health(plugin_id, old['version'])
                self._activate(deployment_id, plugin_id, old_id)
                self._finish(deployment_id, 'rolled_back', error_code='candidate_failed')
                if new_id != old_id:
                    self._stop_release(new_id)
                return 'rolled_back'
        except Exception:
            pass
        self.service.transaction(lambda cur: cur.execute("UPDATE lele.plugin_catalog SET operation_state='failed',release_epoch=release_epoch+1,updated_at=now() WHERE id=%s", (plugin_id,)))
        self._finish(deployment_id, 'failed', error_code='rollback_failed' if old_id else 'candidate_failed')
        self._stop_release(new_id)
        return 'failed'

    def _stop_release(self, release_id):
        try:
            release = self.service.transaction(lambda cur: row_dict(cur.execute('SELECT plugin_id,version FROM lele.plugin_releases WHERE release_id=%s', (release_id,))))
            if release:
                self.runtime.stop(release['plugin_id'], release['version'], timeout=0)
        except Exception:
            pass

    def _recover(self, plugin_id, preview):
        def take(cur):
            cur.execute("SELECT * FROM lele.plugin_deployments WHERE plugin_id=%s AND status='running' FOR UPDATE", (plugin_id,))
            deployment = row_dict(cur)
            require(deployment is not None, 409, '没有需要恢复的部署。')
            require(deployment['lease_until'] is None or deployment['lease_until'] <= datetime.now(timezone.utc), 409, '部署租约仍有效，请等待原操作结束。', 'plugin_deployment_busy')
            cur.execute("UPDATE lele.plugin_deployments SET lease_owner=%s,lease_until=now()+interval '180 seconds' WHERE id=%s", (self.owner, deployment['id']))
            cur.execute('SELECT * FROM lele.plugin_releases WHERE release_id=%s', (deployment['new_release_id'],))
            return deployment, row_dict(cur)
        deployment, release = self.service.transaction(take)
        try:
            self._verify_disk(release)
            if release['manifest'].get('backend'):
                self.runtime.health(plugin_id, release['version'])
            self.service.transaction(lambda cur: cur.execute("UPDATE lele.plugin_catalog SET operation_state='updating',release_epoch=release_epoch+1 WHERE id=%s", (plugin_id,)))
            self._phase(deployment['id'], 'drain')
            self._drain(plugin_id, deployment['old_release_id'], release['release_id'])
            self._phase(deployment['id'], 'activate')
            self._activate(deployment['id'], plugin_id, release['release_id'])
            self._phase(deployment['id'], 'ready')
            self._finish(deployment['id'], 'succeeded')
            status = 'succeeded'
        except Exception:
            status = self._rollback_failure(deployment['id'], plugin_id, deployment['old_release_id'], release['release_id'])
        return {**preview, 'dryRun': False, 'deploymentId': deployment['id'], 'status': status, 'phase': 'ready' if status != 'failed' else 'failed'}


DeploymentManager = PluginDeployment

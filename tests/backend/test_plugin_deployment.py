"""Artifact validation and real per-plugin deployment/failure/recovery tests."""
from concurrent.futures import ThreadPoolExecutor
import copy
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import threading
import unittest
import uuid

from lele_growth.child_service import ApiError
from lele_growth.plugins.deployment import PluginDeployment, inspect_package, prepare_release, PHASES
from lele_growth.plugins.gateway import ContextSigner
from lele_growth.plugins.policy import active_context
from lele_growth.plugins.supervisor import PluginSupervisor
from tests.backend.test_plugin_runtime import DatabaseFixture, make_package, manifest, WORKER


class PackageValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='plugin-package-')
        self.addCleanup(self.temp.cleanup)

    def test_real_package_hashes_and_pure_backend_wheels(self):
        package = make_package(self.temp.name)
        info = inspect_package(package)
        self.assertEqual(info['manifest']['version'], '1.0.0')
        self.assertEqual(len([p for p in info['files'] if p.endswith('.whl')]), 2)
        self.assertTrue(info['descriptor']['buildPlatform']['purePython'])

    def test_task_configuration_references_are_validated_before_prepare(self):
        data = manifest()
        data['tasks'] = [{'id': 'remind', 'schedule': {'configTime': 'missingTime'}, 'misfirePolicy': 'skip'}]
        package = make_package(self.temp.name, data)
        with self.assertRaises(ApiError): inspect_package(package)

    def test_links_traversal_duplicate_paths_and_hash_corruption_rejected(self):
        package = make_package(self.temp.name)
        with tarfile.open(package) as archive:
            contents = [(member, archive.extractfile(member).read()) for member in archive]
        for mode in ('link', 'traversal', 'duplicate', 'hash'):
            with self.subTest(mode=mode):
                target = Path(self.temp.name) / (mode + '.tar.gz')
                with tarfile.open(target, 'w:gz') as archive:
                    for member, data in contents:
                        if mode == 'hash' and member.name == 'plugin.json':
                            data = data.replace(b'1.0.0', b'1.0.9')
                        archive.addfile(member, io.BytesIO(data))
                    if mode == 'link':
                        member = tarfile.TarInfo('backend/link.py'); member.type = tarfile.SYMTYPE; member.linkname = '/etc/passwd'; archive.addfile(member)
                    if mode == 'traversal':
                        member = tarfile.TarInfo('../escape'); member.size = 1; archive.addfile(member, io.BytesIO(b'x'))
                    if mode == 'duplicate':
                        member, data = contents[0]; archive.addfile(member, io.BytesIO(data))
                with self.assertRaises(ApiError): inspect_package(target)


class DeploymentTests(DatabaseFixture):
    def setUp(self):
        super().setUp()
        self.temp = tempfile.TemporaryDirectory(prefix='plugin-deploy-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'runtime'
        self.supervisor = PluginSupervisor(self.root, start_timeout=2, call_timeout=2, drain_timeout=0.1)
        self.addCleanup(self.supervisor.close)
        self.plugin_id = 'deploy-' + uuid.uuid4().hex[:16]
        self.data = manifest(self.plugin_id)
        self.manager = PluginDeployment(self.service, root=self.root, runtime=self.supervisor, actor='test-operator')

    def package(self, version='1.0.0', *, plugin_id=None, worker=WORKER, schema=None):
        data = copy.deepcopy(self.data); data['version'] = version
        data['id'] = plugin_id or self.plugin_id
        return make_package(self.temp.name, data, worker=worker, schema=schema or self.schema)

    def deploy(self, package, manager=None):
        manager = manager or self.manager
        preview = manager.execute('deploy', package=package)
        return manager.execute('deploy', package=package, apply=True, confirm=preview['target']['targetId'])

    def enable(self, plugin_id=None):
        plugin_id = plugin_id or self.plugin_id
        def work(cur):
            cur.execute("UPDATE lele.plugin_catalog SET publication_status='published',name='管理员名称',description='保留资料',instructions='管理员说明',sort_order=43 WHERE id=%s", (plugin_id,))
            cur.execute('INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled) VALUES(%s,%s,true,true)', (self.child_id, plugin_id))
            cur.execute('INSERT INTO lele.child_plugin_configs(child_id,plugin_id,config,config_revision) VALUES(%s,%s,%s,1)', (self.child_id, plugin_id, __import__('psycopg').types.json.Jsonb({'message': 'shared'})))
        self.service.transaction(work)

    def current(self):
        return self.sql('SELECT r.version,p.operation_state,p.name,p.publication_status,p.sort_order FROM lele.plugin_catalog p LEFT JOIN lele.plugin_releases r ON r.release_id=p.active_release_id WHERE p.id=%s', (self.plugin_id,))[0]

    def test_target_preview_is_read_only_and_apply_requires_matching_confirmation(self):
        package = self.package()
        before = self.sql('SELECT count(*) FROM lele.plugin_catalog WHERE id=%s', (self.plugin_id,))
        preview = self.manager.execute('deploy', package=package)
        self.assertTrue(preview['dryRun']); self.assertFalse(self.root.exists())
        self.assertEqual(self.sql('SELECT count(*) FROM lele.plugin_catalog WHERE id=%s', (self.plugin_id,)), before)
        with self.assertRaises(ApiError): self.manager.execute('deploy', package=package, apply=True, confirm='wrong-target')
        self.assertFalse(self.root.exists())
        deployed = self.deploy(package)
        self.assertEqual(deployed['status'], 'succeeded')
        self.assertEqual(self.current()[3], 'pending')

    def test_real_update_and_rollback_keep_other_plugin_alive_metadata_and_records(self):
        self.deploy(self.package()); self.enable()
        other_id = 'other-' + uuid.uuid4().hex[:12]
        self.deploy(self.package(plugin_id=other_id)); self.enable(other_id)
        context = self.service.transaction(lambda cur: active_context(cur, other_id, self.child_id))
        signed = ContextSigner().issue(context)
        before = self.supervisor.call(signed, 'handle_request', {'path': 'ping'})['pid']
        self.sql("INSERT INTO lele.child_plugin_records(child_id,plugin_id,collection,record_id,payload) VALUES(%s,%s,'notes','kept','{\"text\":\"history\"}')", (self.child_id, self.plugin_id))
        phases = []
        def probe(phase):
            phases.append(phase)
            self.assertEqual(self.supervisor.call(signed, 'handle_request', {'path': 'ping'})['pid'], before)
            self.assertEqual(self.sql('SELECT 1'), [(1,)])
            if phase in ('updating', 'drain', 'activate'):
                with self.assertRaises(ApiError): self.service.transaction(lambda cur: active_context(cur, self.plugin_id, self.child_id))
        self.manager.stage_hook = probe
        updated = self.deploy(self.package('1.0.1'))
        self.assertEqual(phases, list(PHASES))
        self.assertEqual(self.current(), ('1.0.1', 'ready', '管理员名称', 'published', 43))
        self.assertEqual(self.sql('SELECT payload FROM lele.child_plugin_records WHERE plugin_id=%s', (self.plugin_id,)), [({'text': 'history'},)])
        self.manager.stage_hook = None
        preview = self.manager.execute('rollback', plugin_id=self.plugin_id, version='1.0.0')
        self.manager.execute('rollback', plugin_id=self.plugin_id, version='1.0.0', apply=True, confirm=preview['target']['targetId'])
        self.assertEqual(self.current()[0], '1.0.0')
        self.assertEqual(self.supervisor.call(signed, 'handle_request', {'path': 'ping'})['pid'], before)
        self.assertTrue((self.root / self.plugin_id / 'releases/1.0.1/plugin.json').is_file())

    def test_candidate_failure_rolls_back_without_overwriting_admin_choices(self):
        self.deploy(self.package()); self.enable()
        with self.assertRaises(ApiError): self.deploy(self.package('1.0.1', worker='raise RuntimeError("startup failed")'))
        self.assertEqual(self.current(), ('1.0.0', 'ready', '管理员名称', 'published', 43))
        self.assertEqual(self.sql('SELECT status,error_code FROM lele.plugin_deployments WHERE plugin_id=%s ORDER BY created_at DESC LIMIT 1', (self.plugin_id,)), [('rolled_back', 'candidate_failed')])

    def test_candidate_degrading_after_initial_health_is_never_activated(self):
        self.deploy(self.package()); self.enable()
        worker = '''checks = 0
def health():
    global checks
    checks += 1
    return {'ok': checks == 1}
'''
        with self.assertRaises(ApiError) as error:
            self.deploy(self.package('1.0.1', worker=worker))
        self.assertEqual(error.exception.kind, 'plugin_health_failed')
        self.assertEqual(self.current(), ('1.0.0', 'ready', '管理员名称', 'published', 43))
        self.assertEqual(self.sql('SELECT phase,status FROM lele.plugin_deployments WHERE plugin_id=%s ORDER BY created_at DESC LIMIT 1',
                                 (self.plugin_id,)), [('prepare', 'rolled_back')])

    def test_rollback_failure_leaves_only_target_failed(self):
        self.deploy(self.package()); self.enable()
        class FailingRuntime:
            def health(self, *args): raise ApiError(503, 'simulated health failure')
            def stop(self, *args, **kwargs): return {'ok': True}
        self.manager.runtime = FailingRuntime()
        with self.assertRaises(ApiError): self.deploy(self.package('1.0.1'))
        self.assertEqual(self.current()[1], 'failed')
        self.assertEqual(self.sql('SELECT status,error_code FROM lele.plugin_deployments WHERE plugin_id=%s ORDER BY created_at DESC LIMIT 1', (self.plugin_id,)), [('failed', 'rollback_failed')])
        self.assertEqual(self.sql('SELECT 1'), [(1,)])

    def test_admin_disable_during_update_is_preserved(self):
        self.deploy(self.package()); self.enable()
        def disable(phase):
            if phase == 'drain':
                self.sql('UPDATE lele.child_plugins SET enabled=false,generation=generation+1 WHERE plugin_id=%s AND child_id=%s', (self.plugin_id, self.child_id))
        self.manager.stage_hook = disable
        self.deploy(self.package('1.0.1'))
        self.assertEqual(self.sql('SELECT enabled,generation FROM lele.child_plugins WHERE plugin_id=%s AND child_id=%s', (self.plugin_id, self.child_id)), [(False, 2)])

    def test_concurrent_same_plugin_deploy_is_rejected_without_blocking(self):
        self.deploy(self.package()); self.enable()
        package = self.package('1.0.1')
        ready, proceed = threading.Event(), threading.Event()
        def pause(phase):
            if phase == 'drain':
                ready.set()
                if not proceed.wait(5): raise AssertionError('concurrency test timed out')
        self.manager.stage_hook = pause
        second = PluginDeployment(self.service, root=self.root, runtime=self.supervisor)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.deploy, package)
            self.assertTrue(ready.wait(5))
            try:
                with self.assertRaises(ApiError) as error: self.deploy(package, second)
                self.assertEqual(error.exception.kind, 'plugin_deployment_busy')
            finally:
                proceed.set()
            self.assertEqual(future.result(timeout=10)['status'], 'succeeded')

    def test_every_interrupted_phase_has_explicit_recovery(self):
        class Interrupted(BaseException): pass
        self.deploy(self.package()); self.enable()
        for number, phase in enumerate(PHASES, 1):
            with self.subTest(phase=phase):
                package = self.package('1.0.' + str(number))
                def interrupt(current):
                    if current == phase: raise Interrupted()
                self.manager.stage_hook = interrupt
                with self.assertRaises(Interrupted): self.deploy(package)
                recovery = PluginDeployment(self.service, root=self.root, runtime=self.supervisor)
                preview = recovery.execute('recover', plugin_id=self.plugin_id)
                with self.assertRaises(ApiError): recovery.execute('recover', plugin_id=self.plugin_id, apply=True, confirm=preview['target']['targetId'])
                self.sql("UPDATE lele.plugin_deployments SET lease_until=now()-interval '1 second' WHERE plugin_id=%s AND status='running'", (self.plugin_id,))
                recovered = recovery.execute('recover', plugin_id=self.plugin_id, apply=True, confirm=preview['target']['targetId'])
                self.assertIn(recovered['status'], ('succeeded', 'rolled_back'))
                self.assertEqual(self.current()[1], 'ready')
                self.assertEqual(self.sql("SELECT count(*) FROM lele.plugin_deployments WHERE plugin_id=%s AND status='running'", (self.plugin_id,)), [(0,)])
        self.assertEqual(self.current()[0], '1.0.5')

    def test_changed_same_version_and_incompatible_data_are_rejected_before_updating(self):
        self.deploy(self.package()); self.enable()
        with self.assertRaises(ApiError) as error: self.manager.execute('deploy', package=self.package(worker=WORKER + '\n#different'))
        self.assertEqual(error.exception.kind, 'plugin_version_exists')
        data = copy.deepcopy(self.data); data['version'] = '2.0.0'; data['dataSchemaVersion'] = 2
        package = make_package(self.temp.name, data, schema=self.schema)
        with self.assertRaises(ApiError) as error: self.manager.execute('deploy', package=package)
        self.assertEqual(error.exception.kind, 'plugin_incompatible_data')
        self.assertEqual(self.current()[1], 'ready')

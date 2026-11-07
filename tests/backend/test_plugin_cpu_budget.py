import errno
import logging
import os
from pathlib import Path
import tempfile
import unittest

from lele_growth.plugins.cpu_budget import SERVICE_NAME, CpuBudget


def tree(root, relative, controllers='cpu', subtree='cpu'):
    service = root.joinpath(*relative.split('/'))
    service.mkdir(parents=True)
    (service / 'cgroup.controllers').write_text(controllers + '\n')
    (service / 'cgroup.subtree_control').write_text(subtree + '\n')
    (service / 'cgroup.procs').write_text('')
    return service


class CpuBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cpu-budget-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.proc = self.root / 'proc-cgroup'

    def budget(self, line):
        self.proc.write_text(line + '\n')
        return CpuBudget(proc_cgroup=self.proc, cgroup_root=self.root)

    def test_missing_or_foreign_cgroup_is_silent(self):
        budget = CpuBudget(proc_cgroup=self.root / 'absent', cgroup_root=self.root)
        with self.assertNoLogs('lele_growth.plugins.cpu_budget', logging.WARNING):
            self.assertFalse(budget.prepare())
        tree(self.root, 'user.slice')
        budget = self.budget('0::/user.slice')
        with self.assertNoLogs('lele_growth.plugins.cpu_budget', logging.WARNING):
            self.assertFalse(budget.prepare())
            self.assertIsNone(budget.attach('runtime-demo', os.getpid()))

    def test_delegated_leaf_sets_weight_and_worker_quota(self):
        service = tree(self.root, f'system.slice/{SERVICE_NAME}')
        leaf = service / 'supervisor'
        leaf.mkdir()
        (leaf / 'cgroup.procs').write_text(str(os.getpid()) + '\n')
        (leaf / 'cpu.weight').write_text('100\n')
        budget = self.budget(f'0::/system.slice/{SERVICE_NAME}/supervisor')
        self.assertTrue(budget.prepare())
        self.assertEqual((leaf / 'cpu.weight').read_text(), '400\n')
        path = budget.attach('runtime-demo', 4321)
        self.assertEqual(path.parent, service.resolve())
        self.assertRegex(path.name, r'^w-runtime-demo-[0-9a-f]{8}$')
        self.assertEqual((path / 'cpu.max').read_text(), '100000 100000\n')
        self.assertEqual((path / 'cgroup.procs').read_text(), '4321\n')
        budget.release(path)
        self.assertFalse(path.exists())
        self.assertTrue(service.exists())

    def test_direct_service_process_migrates_before_enabling_cpu(self):
        service = tree(self.root, SERVICE_NAME, subtree='')
        budget = self.budget(f'0::/{SERVICE_NAME}')
        self.assertTrue(budget.prepare())
        leaf = service / 'supervisor'
        self.assertIn(str(os.getpid()), (leaf / 'cgroup.procs').read_text().split())
        self.assertEqual((service / 'cgroup.subtree_control').read_text().split(), ['+cpu'])

    def test_failed_attach_and_foreign_release_do_not_escape(self):
        service = tree(self.root, SERVICE_NAME)
        (service / 'supervisor').mkdir()
        ((service / 'supervisor') / 'cgroup.procs').write_text(str(os.getpid()) + '\n')
        budget = self.budget(f'0::/{SERVICE_NAME}/supervisor')
        self.assertTrue(budget.prepare())
        blocked = service / 'blocked'
        blocked.write_text('not a cgroup')
        budget.service_dir = blocked
        with self.assertLogs('lele_growth.plugins.cpu_budget', logging.WARNING) as seen:
            self.assertIsNone(budget.attach('runtime-demo', 99))
            self.assertIsNone(budget.attach('runtime-demo', 99))
        self.assertEqual(len(seen.records), 1)
        outside = self.root / 'outside'
        outside.mkdir()
        budget.release(outside)
        self.assertTrue(outside.exists())
        self.assertIsNone(budget.attach('../runtime-demo', 99))

    def test_release_retries_until_empty(self):
        service = tree(self.root, SERVICE_NAME)
        (service / 'supervisor').mkdir()
        ((service / 'supervisor') / 'cgroup.procs').write_text('1\n')
        budget = self.budget(f'0::/{SERVICE_NAME}/supervisor')
        self.assertTrue(budget.prepare())
        path = budget.attach('runtime-demo', 99)
        real = budget._discard
        calls = {'count': 0}

        def flaky(target):
            calls['count'] += 1
            if calls['count'] == 1:
                raise OSError(errno.ENOTEMPTY, 'busy')
            real(target)

        budget._discard = flaky
        budget.release(path)
        self.assertEqual(calls['count'], 2)
        self.assertFalse(path.exists())


class SupervisorCpuBudgetTests(unittest.TestCase):
    def test_start_and_stop_attach_and_release_the_same_group(self):
        from lele_growth.plugins.deployment import inspect_package, prepare_release
        from lele_growth.plugins.supervisor import PluginSupervisor
        from tests.backend.test_plugin_runtime import make_package

        class Recording:
            def __init__(self):
                self.actions = []

            def prepare(self):
                self.actions.append('prepare')
                return True

            def attach(self, plugin_id, pid):
                self.actions.append(('attach', plugin_id, pid))
                return Path('/allocated') / plugin_id

            def release(self, path):
                self.actions.append(('release', path))

        temp = tempfile.TemporaryDirectory(prefix='cpu-supervisor-')
        self.addCleanup(temp.cleanup)
        root = Path(temp.name) / 'runtime'
        prepare_release(inspect_package(make_package(temp.name)), root)
        budget = Recording()
        supervisor = PluginSupervisor(root, start_timeout=2, call_timeout=0.3, drain_timeout=0.1, cpu_budget=budget)
        self.addCleanup(supervisor.close)
        health = supervisor.health('runtime-demo', '1.0.0')
        worker = supervisor.workers[('runtime-demo', '1.0.0')]
        self.assertEqual(budget.actions[1], ('attach', 'runtime-demo', worker.process.pid))
        self.assertNotEqual(health['pid'], os.getpid())
        supervisor.stop('runtime-demo', timeout=0)
        self.assertEqual(budget.actions[-1], ('release', Path('/allocated/runtime-demo')))

    def test_real_worker_does_not_impose_cumulative_cpu_limit(self):
        import resource
        from lele_growth.plugins.deployment import inspect_package, prepare_release
        from lele_growth.plugins.gateway import ContextSigner
        from lele_growth.plugins.supervisor import PluginSupervisor
        from tests.backend.test_plugin_runtime import make_package, manifest, scope

        source = '''import resource
def health():
    return {'ok': True}
def handle_request(context, path, method, body):
    soft, hard = resource.getrlimit(resource.RLIMIT_CPU)
    return {'soft': soft, 'hard': hard}
'''
        temp = tempfile.TemporaryDirectory(prefix='cpu-worker-')
        self.addCleanup(temp.cleanup)
        root = Path(temp.name) / 'runtime'
        package = make_package(temp.name, manifest(version='1.0.1'), worker=source, sdk_version='1.1.2')
        prepare_release(inspect_package(package), root)
        supervisor = PluginSupervisor(root, start_timeout=2, call_timeout=1, drain_timeout=0.1)
        self.addCleanup(supervisor.close)
        signed = ContextSigner().issue({**scope(), 'version': '1.0.1'})
        result = supervisor.call(signed, 'handle_request', {'path': 'limits'})
        self.assertEqual((result['soft'], result['hard']), (resource.RLIM_INFINITY, resource.RLIM_INFINITY))

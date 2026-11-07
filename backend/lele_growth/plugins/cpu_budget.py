"""Optional per-worker CPU rate limits inside the delegated runtime cgroup."""
from __future__ import annotations

import errno
import logging
import os
from pathlib import Path
import re
import secrets
import time

SERVICE_NAME = 'lele-growth-plugin-runtime.service'
LEAF_NAME = 'supervisor'
WORKER_CPU_MAX = '100000 100000\n'
SUPERVISOR_CPU_WEIGHT = '400\n'
_PLUGIN_ID = re.compile(r'[a-z][a-z0-9-]{0,63}')
_GROUP_NAME = re.compile(r'w-[a-z][a-z0-9-]{0,63}-[0-9a-f]{8}')


class CpuBudget:
    def __init__(self, proc_cgroup='/proc/self/cgroup', cgroup_root='/sys/fs/cgroup',
                 worker_cpu_max=WORKER_CPU_MAX, supervisor_weight=SUPERVISOR_CPU_WEIGHT):
        self.proc_cgroup = Path(proc_cgroup)
        self.cgroup_root = Path(cgroup_root)
        self.worker_cpu_max = worker_cpu_max
        self.supervisor_weight = supervisor_weight
        self.service_dir = None
        self._warned = False

    def prepare(self):
        located = self._locate()
        if located is None:
            return False
        service, relative = located
        try:
            controllers = (service / 'cgroup.controllers').read_text().split()
            if 'cpu' not in controllers:
                self._warn()
                return False
            leaf = service / LEAF_NAME
            if relative == (SERVICE_NAME,):
                leaf.mkdir(mode=0o755, exist_ok=True)
                self._write(leaf / 'cgroup.procs', f'{os.getpid()}\n')
            elif relative != (SERVICE_NAME, LEAF_NAME):
                return False
            self._enable_cpu(service)
            self.service_dir = service
        except OSError:
            self.service_dir = None
            self._warn()
            return False
        self._set_weight(leaf)
        return True

    def attach(self, plugin_id, pid):
        if self.service_dir is None or not isinstance(pid, int) or pid <= 0 or not _PLUGIN_ID.fullmatch(str(plugin_id)):
            return None
        path = self.service_dir / f'w-{plugin_id}-{secrets.token_hex(4)}'
        try:
            path.mkdir(mode=0o755)
            self._write(path / 'cpu.max', self.worker_cpu_max)
            self._write(path / 'cgroup.procs', f'{pid}\n')
            return path
        except OSError:
            self._warn()
            try:
                if path.is_dir() and not any(path.iterdir()):
                    path.rmdir()
            except OSError:
                pass
            return None

    def release(self, path):
        if path is None or self.service_dir is None:
            return
        try:
            candidate = path.resolve()
            if candidate.parent != self.service_dir.resolve() or not _GROUP_NAME.fullmatch(candidate.name):
                self._warn()
                return
            for _ in range(20):
                try:
                    self._discard(candidate)
                    return
                except OSError as error:
                    if error.errno not in (errno.ENOTEMPTY, errno.EBUSY):
                        break
                    time.sleep(0.05)
            self._warn()
        except OSError:
            self._warn()

    def _locate(self):
        try:
            lines = self.proc_cgroup.read_text().splitlines()
        except OSError:
            return None
        matches = []
        for line in lines:
            hierarchy, controllers, path = (line.split(':', 2) + ['', ''])[:3]
            if hierarchy == '0' and controllers == '' and path.startswith('/'):
                matches.append([part for part in path.split('/') if part])
        if len(matches) != 1 or SERVICE_NAME not in matches[0]:
            return None
        parts = matches[0]
        index = parts.index(SERVICE_NAME)
        relative = tuple(parts[index:])
        if relative not in ((SERVICE_NAME,), (SERVICE_NAME, LEAF_NAME)):
            return None
        service = self.cgroup_root.joinpath(*parts[:index + 1]).resolve()
        root = self.cgroup_root.resolve()
        if service == root or not service.is_relative_to(root) or not (service / 'cgroup.controllers').is_file():
            return None
        return service, relative

    def _enable_cpu(self, service):
        control = service / 'cgroup.subtree_control'
        enabled = control.read_text().split() if control.is_file() else []
        if 'cpu' not in enabled:
            self._write(control, '+cpu\n')

    def _set_weight(self, leaf):
        try:
            weight = leaf / 'cpu.weight'
            if weight.is_file():
                self._write(weight, self.supervisor_weight)
        except OSError:
            self._warn()

    @staticmethod
    def _write(path, text):
        path.write_text(text)

    def _discard(self, path):
        # A real cgroup directory only accepts rmdir. Tests use ordinary files.
        if path.is_dir() and not (self.cgroup_root / 'cgroup.controllers').exists():
            for child in path.iterdir():
                if child.is_file():
                    child.unlink()
        os.rmdir(path)

    def _warn(self):
        if not self._warned:
            logging.getLogger(__name__).warning('插件 worker 的 CPU 分组不可用，已降级为服务总预算。')
            self._warned = True

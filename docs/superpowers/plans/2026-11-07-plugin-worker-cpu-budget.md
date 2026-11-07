# Plugin Worker CPU Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取消 worker 进程累计 `RLIMIT_CPU`，改为服务总预算、每个 worker 的 cgroup 速率限制和现有单次超时这三层保护。

**Architecture:** worker 继续留在 `lele-growth-plugin-runtime.service` 的 cgroup 里面，父级 `CPUQuota=150%` 仍然限制运行服务和全部插件进程的总和。systemd 用 `Delegate=cpu` 与 `DelegateSubgroup=supervisor` 把主进程放进叶子组；supervisor 为每个 worker 创建同级子组并写入 `cpu.max`。cgroup 不可用时只记录一次警告，worker 仍启动。单次请求和任务继续使用现有超时，超时后结束整个进程组。

**Tech Stack:** Python 3.13、systemd 257 cgroup v2、现有 `unittest`。本机 macOS 不能验证真实 cgroup。

---

## 已核对的事实

- `packages/plugin-sdk-python/src/lele_plugin_sdk/worker.py:120` 无条件执行 `RLIMIT_CPU=(60, 61)`。这是进程启动后的累计 CPU 时间；等待网络不计，JSON 和处理会计入。软限制默认发出 `SIGXCPU` 并终止，硬限制强制杀死。worker 没有对应信号处理器。
- 同一文件只在 Linux 设置 `RLIMIT_AS=512 MiB`。本次不修改、不降低这个限制。
- `deploy/lele-growth-plugin-runtime.service:29` 已有 `CPUQuota=150%`，同时有 `MemoryMax=512M`、`KillMode=control-group`、`User=lele`。没有 `Delegate=`，也没有 `ProtectControlGroups=`。
- `docs/update-release-2026-11-01.md` 记录生产 systemd 为 257。`DelegateSubgroup=` 自 systemd 254 起可用。执行前仍要在服务器上核对 `systemctl --version`，但不能把本机测试说成已经核对。
- supervisor 在 `backend/lele_growth/plugins/supervisor.py:178` 用 `start_new_session=True` 启动 worker，环境只继承 `PATH`、`LANG`、`LC_ALL`、`TZ`。因此不能靠 systemd 环境变量把配置传进插件进程。cgroup 必须由 supervisor 写 PID。
- `_terminate()` 是 `stop()`、`drain_development()`、启动失败和请求超时的共同清理点。分组目录只能在这里释放。
- 请求超时在 supervisor 的 Unix 调用；超时后把 worker 标为 stopping 并结束进程组。任务超时由 `scheduler.py` 按清单 `timeoutSeconds` 传入 `handle_job`，运行服务再按清单上限收紧。这两层已经存在，本次不改超时数值。
- 已安装插件的 worker 来自插件包内的 wheel，不来自源码树。当前允许的 wheel 是 SDK `1.0.0`、`1.1.0`、`1.1.1`。开发模式通过 `lele-plugin-dev.pth` 直接使用 `packages/plugin-sdk-python/src`。
- 当前分支 `codex/plugin-performance` 有未提交的媒体直连改动。实施时只能暂存本方案列出的文件。

## 不做什么

- 不把运行服务合并回家长端或管理端。
- 不降低 512 MiB 虚拟地址空间，也不修改 `CPUQuota=150%`、`MemoryMax=512M`。
- 不把 worker 放进同级 systemd scope。那样会逃出 150% 总预算，而且 `lele` 用户不能创建系统 scope。
- 不新增后台线程看门狗。cgroup 只限制 CPU 速率，不会杀掉空转线程；累计 `RLIMIT_CPU` 会误杀正常长期进程，所以不再用它充当看门狗。
- 不在本方案中打包、发布或重启生产插件。

## 目标行为

三层同时存在：

- 服务总预算：`CPUQuota=150%`，相当于最多 1.5 个 CPU，覆盖运行服务和全部 worker。
- 单个 worker：`cpu.max` 为 `100000 100000`，即每个 100 毫秒周期最多使用 100 毫秒，相当于 1 个 CPU。一个插件不能单独吃满 1.5 个 CPU。
- 运行服务余量：supervisor 叶子组 `cpu.weight=400`，每个 worker 保持默认权重 100。总预算饱和时，1 个忙 worker 大约给运行服务留下 0.5 个 CPU；多个忙 worker 时，运行服务仍按 400 比每个 worker 的 100 分配，而不是被等权挤掉。权重不降低空闲时的可用 CPU。
- 单次工作：页面请求沿用调用超时，任务沿用清单里的 `timeoutSeconds`。超时后现有逻辑结束 worker 进程组，避免超时计算继续占着名额。

`cpu.max` 不会让同一段计算变得更省 CPU。100% 的单插件上限只约束峰值；真正超过 1 个 CPU 的并发计算会变慢。

## 文件

- 新增 `backend/lele_growth/plugins/cpu_budget.py`：定位服务 cgroup、迁移主进程、创建和删除 worker 子组。
- 新增 `tests/backend/test_plugin_cpu_budget.py`：用临时目录模拟 cgroup，不接触 `/sys/fs/cgroup`。
- 修改 `backend/lele_growth/plugins/supervisor.py`：启动后加入子组，所有终止路径都释放子组。
- 修改 `packages/plugin-sdk-python/src/lele_plugin_sdk/worker.py`：删除 `RLIMIT_CPU`。
- 修改 `packages/plugin-sdk-python/pyproject.toml`：SDK `1.1.1` 升到 `1.1.2`。
- 修改 `backend/lele_growth/plugins/deployment.py` 和 `tests/backend/test_plugin_deployment.py`：接受 `1.1.2`，继续接受旧版，拒绝 `1.2.0`。
- 修改 `deploy/lele-growth-plugin-runtime.service`：委托 CPU 控制器。
- 修改 `docs/plugins/deployment.md`：记录三层预算和生效条件。

## 生效边界

- supervisor 与 systemd 单元属于运行服务。重启运行服务后，新旧 worker 都会被放入子组。
- `RLIMIT_CPU` 写在插件进程自己导入的 SDK 里。开发模式重启 worker 后即使用新源码；已经安装的美森 `1.0.35` 仍带 SDK `1.1.1`，仍会在累计 60 秒 CPU 后退出。
- 宿主必须先接受 `1.1.2`，随后单独打包并部署新插件版本，已安装进程才会去掉累计上限。插件版本号、打包和生产重启不属于本方案的代码改动。
- 本机开发和测试没有 systemd 委托时，cgroup 操作静默跳过，worker 照常启动。

---

### Task 1: CPU 分组助手

**Files:**

- Create: `backend/lele_growth/plugins/cpu_budget.py`
- Test: `tests/backend/test_plugin_cpu_budget.py`

- [x] **Step 1: 写失败测试**

创建 `tests/backend/test_plugin_cpu_budget.py`：

```python
import errno
import logging
import os
from pathlib import Path
import tempfile
import unittest

from lele_growth.plugins.cpu_budget import SERVICE_NAME, CpuBudget


def tree(root, relative, controllers="cpu", subtree="cpu"):
    service = root.joinpath(*relative.split("/"))
    service.mkdir(parents=True)
    (service / "cgroup.controllers").write_text(controllers + "\n")
    (service / "cgroup.subtree_control").write_text(subtree + "\n")
    (service / "cgroup.procs").write_text("")
    return service


class CpuBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cpu-budget-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.proc = self.root / "proc-cgroup"

    def budget(self, line):
        self.proc.write_text(line + "\n")
        return CpuBudget(proc_cgroup=self.proc, cgroup_root=self.root)

    def test_missing_or_foreign_cgroup_is_silent(self):
        budget = CpuBudget(proc_cgroup=self.root / "absent", cgroup_root=self.root)
        with self.assertNoLogs("lele_growth.plugins.cpu_budget", level=logging.WARNING):
            self.assertFalse(budget.prepare())
        tree(self.root, "user.slice")
        budget = self.budget("0::/user.slice")
        with self.assertNoLogs("lele_growth.plugins.cpu_budget", level=logging.WARNING):
            self.assertFalse(budget.prepare())
            self.assertIsNone(budget.attach("runtime-demo", os.getpid()))

    def test_delegated_leaf_sets_weight_and_worker_quota(self):
        service = tree(self.root, f"system.slice/{SERVICE_NAME}")
        leaf = service / "supervisor"
        leaf.mkdir()
        (leaf / "cgroup.procs").write_text(str(os.getpid()) + "\n")
        (leaf / "cpu.weight").write_text("100\n")
        budget = self.budget(f"0::/system.slice/{SERVICE_NAME}/supervisor")
        self.assertTrue(budget.prepare())
        self.assertEqual((leaf / "cpu.weight").read_text(), "400\n")
        path = budget.attach("runtime-demo", 4321)
        self.assertEqual(path.parent, service)
        self.assertRegex(path.name, r"^w-runtime-demo-[0-9a-f]{8}$")
        self.assertEqual((path / "cpu.max").read_text(), "100000 100000\n")
        self.assertEqual((path / "cgroup.procs").read_text(), "4321\n")
        budget.release(path)
        self.assertFalse(path.exists())
        self.assertTrue(service.exists())

    def test_direct_service_process_migrates_before_enabling_cpu(self):
        service = tree(self.root, SERVICE_NAME, subtree="")
        budget = self.budget(f"0::/{SERVICE_NAME}")
        self.assertTrue(budget.prepare())
        leaf = service / "supervisor"
        self.assertIn(str(os.getpid()), (leaf / "cgroup.procs").read_text().split())
        self.assertIn("cpu", (service / "cgroup.subtree_control").read_text().split())

    def test_failed_attach_and_foreign_release_do_not_escape(self):
        service = tree(self.root, SERVICE_NAME)
        (service / "supervisor").mkdir()
        ((service / "supervisor") / "cgroup.procs").write_text(str(os.getpid()) + "\n")
        budget = self.budget(f"0::/{SERVICE_NAME}/supervisor")
        self.assertTrue(budget.prepare())
        (service / "blocked").mkdir()
        budget.service_dir = service / "blocked"
        with self.assertLogs("lele_growth.plugins.cpu_budget", level=logging.WARNING) as seen:
            self.assertIsNone(budget.attach("runtime-demo", 99))
            budget.attach("runtime-demo", 99)
        self.assertEqual(len(seen.records), 1)
        outside = self.root / "outside"
        outside.mkdir()
        budget.release(outside)
        self.assertTrue(outside.exists())
        self.assertIsNone(budget.attach("../runtime-demo", 99))

    def test_release_retries_until_empty(self):
        service = tree(self.root, SERVICE_NAME)
        (service / "supervisor").mkdir()
        ((service / "supervisor") / "cgroup.procs").write_text("1\n")
        budget = self.budget(f"0::/{SERVICE_NAME}/supervisor")
        self.assertTrue(budget.prepare())
        path = budget.attach("runtime-demo", 99)
        real = budget._discard
        calls = {"count": 0}

        def flaky(target):
            calls["count"] += 1
            if calls["count"] == 1:
                raise OSError(errno.ENOTEMPTY, "busy")
            real(target)

        budget._discard = flaky
        budget.release(path)
        self.assertEqual(calls["count"], 2)
        self.assertFalse(path.exists())
```

测试里的 `release()` 依赖下一步实现的 `_discard()`：普通临时目录先删除自己创建的普通文件，再 `rmdir`。真实 cgroup 只调用 `os.rmdir`，不能删除 `cgroup.procs` 等内核文件。

- [x] **Step 2: 运行测试并确认失败**

Run: `PYTHONPATH=backend .venv/bin/python -m unittest tests.backend.test_plugin_cpu_budget -v`

Expected: FAIL，错误为无法导入 `lele_growth.plugins.cpu_budget`。

- [x] **Step 3: 写最小实现**

创建 `backend/lele_growth/plugins/cpu_budget.py`：

```python
"""Optional per-worker CPU rate limits inside the delegated runtime cgroup."""
from __future__ import annotations

import errno
import logging
import os
from pathlib import Path
import re
import secrets
import time

SERVICE_NAME = "lele-growth-plugin-runtime.service"
LEAF_NAME = "supervisor"
WORKER_CPU_MAX = "100000 100000\n"
SUPERVISOR_CPU_WEIGHT = "400\n"
_PLUGIN_ID = re.compile(r"[a-z][a-z0-9-]{0,63}")
_GROUP_NAME = re.compile(r"w-[a-z][a-z0-9-]{0,63}-[0-9a-f]{8}")


class CpuBudget:
    def __init__(self, proc_cgroup="/proc/self/cgroup", cgroup_root="/sys/fs/cgroup",
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
            controllers = (service / "cgroup.controllers").read_text().split()
            if "cpu" not in controllers:
                self._warn()
                return False
            leaf = service / LEAF_NAME
            if relative == (SERVICE_NAME,):
                leaf.mkdir(mode=0o755, exist_ok=True)
                self._write(leaf / "cgroup.procs", f"{os.getpid()}\n")
                self._enable_cpu(service)
            elif relative != (SERVICE_NAME, LEAF_NAME):
                return False
            weight = leaf / "cpu.weight"
            if weight.is_file():
                self._write(weight, self.supervisor_weight)
            self.service_dir = service
            return True
        except OSError:
            self.service_dir = None
            self._warn()
            return False

    def attach(self, plugin_id, pid):
        if self.service_dir is None or not isinstance(pid, int) or pid <= 0 or not _PLUGIN_ID.fullmatch(str(plugin_id)):
            return None
        path = self.service_dir / f"w-{plugin_id}-{secrets.token_hex(4)}"
        try:
            path.mkdir(mode=0o755)
            self._write(path / "cpu.max", self.worker_cpu_max)
            self._write(path / "cgroup.procs", f"{pid}\n")
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
            hierarchy, controllers, path = (line.split(":", 2) + ["", ""])[:3]
            if hierarchy == "0" and controllers == "" and path.startswith("/"):
                matches.append([part for part in path.split("/") if part])
        if len(matches) != 1 or SERVICE_NAME not in matches[0]:
            return None
        parts = matches[0]
        index = parts.index(SERVICE_NAME)
        relative = tuple(parts[index:])
        if relative not in ((SERVICE_NAME,), (SERVICE_NAME, LEAF_NAME)):
            return None
        service = self.cgroup_root.joinpath(*parts[:index + 1]).resolve()
        root = self.cgroup_root.resolve()
        if service == root or not service.is_relative_to(root) or not (service / "cgroup.controllers").is_file():
            return None
        return service, relative

    def _enable_cpu(self, service):
        control = service / "cgroup.subtree_control"
        enabled = control.read_text().split() if control.is_file() else []
        if "cpu" not in enabled:
            self._write(control, "+cpu\n")

    @staticmethod
    def _write(path, text):
        path.write_text(text)

    def _discard(self, path):
        # Real cgroupfs accepts rmdir for a controller directory with kernel
        # files. A fake directory used by tests contains ordinary files.
        if path.is_dir() and not (self.cgroup_root / "cgroup.controllers").exists():
            for child in path.iterdir():
                if child.is_file():
                    child.unlink()
        os.rmdir(path)

    def _warn(self):
        if not self._warned:
            logging.getLogger(__name__).warning("插件 worker 的 CPU 分组不可用，已降级为服务总预算。")
            self._warned = True
```

`_discard()` 的假目录判断要改成明确条件：只在 `path` 不是真实 cgroup 时清理普通文件。测试使用临时根目录，真实根目录 `/sys/fs/cgroup` 本身含有 `cgroup.controllers`。因此上面的条件正好让生产代码只执行 `os.rmdir`。不要在生产路径上 `unlink` 控制器文件。

- [x] **Step 4: 运行测试**

Run: `PYTHONPATH=backend .venv/bin/python -m unittest tests.backend.test_plugin_cpu_budget -v`

Expected: PASS，共 5 个测试。

- [x] **Step 5: 提交这一层**

只暂存上述两个新文件：

```bash
git add backend/lele_growth/plugins/cpu_budget.py tests/backend/test_plugin_cpu_budget.py
git commit -m "feat: add delegated per-worker CPU budgets"
```

---

### Task 2: 接入 supervisor 并去掉累计上限

**Files:**

- Modify: `backend/lele_growth/plugins/supervisor.py:104-181` 与 `:222-240`
- Modify: `packages/plugin-sdk-python/src/lele_plugin_sdk/worker.py:109-121`
- Modify: `packages/plugin-sdk-python/pyproject.toml:7`
- Modify: `backend/lele_growth/plugins/deployment.py:88`
- Modify: `tests/backend/test_plugin_deployment.py:34-39`
- Test: `tests/backend/test_plugin_cpu_budget.py`

- [x] **Step 1: 增加 supervisor 与 worker 限额测试**

把下面两个测试追加到 `CpuBudgetTests` 同一文件：

```python
class SupervisorCpuBudgetTests(unittest.TestCase):
    def test_start_and_stop_attach_and_release_the_same_group(self):
        import tempfile
        from lele_growth.plugins.deployment import inspect_package, prepare_release
        from lele_growth.plugins.supervisor import PluginSupervisor
        from tests.backend.test_plugin_runtime import make_package

        class Recording:
            def __init__(self):
                self.actions = []

            def prepare(self):
                self.actions.append("prepare")
                return True

            def attach(self, plugin_id, pid):
                self.actions.append(("attach", plugin_id, pid))
                return Path("/allocated") / plugin_id

            def release(self, path):
                self.actions.append(("release", path))

        temp = tempfile.TemporaryDirectory(prefix="cpu-supervisor-")
        self.addCleanup(temp.cleanup)
        root = Path(temp.name) / "runtime"
        prepare_release(inspect_package(make_package(temp.name)), root)
        budget = Recording()
        supervisor = PluginSupervisor(root, start_timeout=2, call_timeout=0.3, drain_timeout=0.1, cpu_budget=budget)
        self.addCleanup(supervisor.close)
        health = supervisor.health("runtime-demo", "1.0.0")
        worker = supervisor.workers[("runtime-demo", "1.0.0")]
        self.assertEqual(budget.actions[1], ("attach", "runtime-demo", worker.process.pid))
        self.assertNotEqual(health["pid"], os.getpid())
        supervisor.stop("runtime-demo", timeout=0)
        self.assertEqual(budget.actions[-1], ("release", Path("/allocated/runtime-demo")))

    def test_real_worker_does_not_impose_cumulative_cpu_limit(self):
        import resource
        import tempfile
        from lele_growth.plugins.deployment import inspect_package, prepare_release
        from lele_growth.plugins.gateway import ContextSigner
        from lele_growth.plugins.supervisor import PluginSupervisor
        from tests.backend.test_plugin_runtime import make_package, manifest, scope

        source = """import resource
def health():
    return {"ok": True}
def handle_request(context, path, method, body):
    soft, hard = resource.getrlimit(resource.RLIMIT_CPU)
    return {"soft": soft, "hard": hard}
"""
        temp = tempfile.TemporaryDirectory(prefix="cpu-worker-")
        self.addCleanup(temp.cleanup)
        root = Path(temp.name) / "runtime"
        package = make_package(temp.name, manifest(version="1.0.1"), worker=source, sdk_version="1.1.2")
        prepare_release(inspect_package(package), root)
        supervisor = PluginSupervisor(root, start_timeout=2, call_timeout=1, drain_timeout=0.1)
        self.addCleanup(supervisor.close)
        signed = ContextSigner().issue({**scope(), "version": "1.0.1"})
        result = supervisor.call(signed, "handle_request", {"path": "limits"})
        infinity = resource.RLIM_INFINITY
        self.assertEqual((result["soft"], result["hard"]), (infinity, infinity))
```

`make_package()` 会把当前源码目录打包进指定 SDK 版本名。此测试必须在 `deployment.py` 接受 `1.1.2` 后才能通过 `inspect_package()`。

- [x] **Step 2: 运行新测试并确认失败**

Run: `PYTHONPATH=backend .venv/bin/python -m unittest tests.backend.test_plugin_cpu_budget.SupervisorCpuBudgetTests -v`

Expected: FAIL。第一个失败点是 `PluginSupervisor` 不接受 `cpu_budget`；限额测试在允许新 wheel 前失败为 SDK 版本被拒绝，修改后、删除 `RLIMIT_CPU` 前失败为返回值等于 `(60, 61)`。

- [x] **Step 3: 修改 supervisor**

在 `supervisor.py` 顶部导入区增加：

```python
from lele_growth.plugins.cpu_budget import CpuBudget
```

`Worker` 增加字段：

```python
cgroup: Path | None = None
```

构造函数改为：

```python
def __init__(self, root=None, *, start_timeout=8, call_timeout=10, drain_timeout=30, cpu_budget=None):
    ...
    self.cpu_budget = CpuBudget() if cpu_budget is None else cpu_budget
    self.cpu_budget.prepare()
```

`Popen` 成功后、创建 `Worker` 时传入分组。分组失败返回 `None`，不得阻止启动：

```python
process = subprocess.Popen(...)
cgroup = self.cpu_budget.attach(plugin_id, process.pid)
worker = Worker(plugin_id, key[1], process, sock, cgroup=cgroup)
```

把 `_terminate` 从静态方法改为实例方法，现有信号和等待逻辑放进 `try`，清理放进 `finally`：

```python
def _terminate(self, worker):
    try:
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
    finally:
        worker.socket.unlink(missing_ok=True)
        self.cpu_budget.release(worker.cgroup)
        worker.cgroup = None
        if worker.log_thread:
            worker.log_thread.join(timeout=2)
```

不要在 `stop()` 或 `drain_development()` 单独释放；它们已经调用 `_terminate()`。超时分支也已经调用它。

- [x] **Step 4: 删除累计 CPU 限制并升级 SDK**

`worker.py` 删除 `resource.setrlimit(resource.RLIMIT_CPU, (60, 61))`。保留 `RLIMIT_CORE`、`RLIMIT_NOFILE`、Linux 上的 `RLIMIT_AS` 和 `RLIMIT_FSIZE`。把原注释改成：累计 CPU 限制会在正常请求累积后杀死缓存进程；CPU 速率由运行服务的 cgroup 控制。

`pyproject.toml` 的版本改为 `1.1.2`。

`deployment.py` 的 wheel 正则改为：

```python
r'lele_plugin_sdk-1\.(?:0\.0|1\.[0-2])-py3-none-any\.whl'
```

`test_supported_sdk_patch_keeps_previous_sdk_versions_compatible` 的版本元组改为 `('1.0.0', '1.1.0', '1.1.1', '1.1.2')`，继续单独断言 `1.2.0` 被拒绝。

- [x] **Step 5: 运行定向测试**

Run:

```bash
PYTHONPATH=backend .venv/bin/python -m unittest \
  tests.backend.test_plugin_cpu_budget \
  tests.backend.test_plugin_runtime.WorkerTests \
  tests.backend.test_plugin_deployment.PackageValidationTests -v
```

Expected: PASS。macOS 上真实 worker 测试不依赖 cgroup；默认 `prepare()` 因找不到服务 cgroup 而静默返回。

- [x] **Step 6: 提交这一层**

```bash
git add backend/lele_growth/plugins/supervisor.py \
  backend/lele_growth/plugins/deployment.py \
  packages/plugin-sdk-python/src/lele_plugin_sdk/worker.py \
  packages/plugin-sdk-python/pyproject.toml \
  tests/backend/test_plugin_cpu_budget.py \
  tests/backend/test_plugin_deployment.py
git commit -m "fix: remove cumulative worker CPU limits"
```

---

### Task 3: systemd 委托与部署说明

**Files:**

- Modify: `deploy/lele-growth-plugin-runtime.service:29`
- Modify: `docs/plugins/deployment.md` 中 SDK `1.1.1` 段落之后

- [x] **Step 1: 更新单元**

在现有 `CPUQuota=150%` 下增加，不改变配额：

```ini
# CPUQuota caps this service and all workers together at 1.5 CPUs.
# The supervisor creates one child cgroup per worker at 1 CPU.
# DelegateSubgroup keeps the main process on a leaf so children can use the cpu controller.
# Do not enable ProtectControlGroups; it would make this delegation read-only.
Delegate=cpu
DelegateSubgroup=supervisor
```

不增加 `ProtectControlGroups=true`。不使用 `systemd-run`，不改变 `User=`、`KillMode=`、`MemoryMax=` 或 `TasksMax=`。

- [x] **Step 2: 更新部署文档**

在 `docs/plugins/deployment.md` 的 SDK `1.1.1` 段落之后说明：

- SDK `1.1.2` 去掉 worker 累计 `RLIMIT_CPU`；宿主同时接受 `1.0.0`、`1.1.0`、`1.1.1`、`1.1.2`。
- 新 systemd 单元保持 `CPUQuota=150%`，并委托 CPU 控制器。每个 worker 限为 1 个 CPU，运行服务叶子组权重为 400。
- 虚拟地址空间仍是 Linux 512 MiB，实际内存预算仍是 systemd `MemoryMax=512M`，两者不是同一指标。
- 仅更新源码不会改变已安装插件。开发 worker 重启后读取源码；生产插件必须用包含 `1.1.2` wheel 的新版本重新打包部署。先升级接受新 wheel 的运行服务，再部署插件。
- 文档不宣称生产已经重新加载 systemd 或已经部署新插件。

- [x] **Step 3: 检查差异**

Run: `git diff --check -- deploy/lele-growth-plugin-runtime.service docs/plugins/deployment.md`

Expected: 无空白错误。

- [x] **Step 4: 提交文档和单元**

```bash
git add deploy/lele-growth-plugin-runtime.service docs/plugins/deployment.md
git commit -m "feat: delegate per-worker CPU control"
```

---

## 本机验证

必须通过：

```bash
PYTHONPATH=backend .venv/bin/python -m unittest \
  tests.backend.test_plugin_cpu_budget \
  tests.backend.test_plugin_runtime.WorkerTests \
  tests.backend.test_plugin_deployment.PackageValidationTests -v
git diff --check
```

这些测试证明：假 cgroup 的分组、配额、迁移、清理和失败降级；supervisor 成对调用 attach 与 release；真实 macOS worker 不再把 CPU 软硬限制改成 60/61；旧 SDK wheel 仍可安装，`1.2.0` 仍被拒绝。

不能在本机证明：systemd 是否接受这两个指令、服务用户能否写子组、真实 `cpu.max` 是否节流，以及生产进程是否仍被旧 wheel 限制。macOS 没有 cgroup v2。

## 生产核对清单

实施代码后单独进行，不纳入本次本地改动：

```bash
systemctl --version
systemctl show lele-growth-plugin-runtime.service \
  -p ControlGroup -p CPUQuotaPerSecUSec -p Delegate -p DelegateSubgroup
```

重新加载并重启运行服务后，主进程应在 `.../lele-growth-plugin-runtime.service/supervisor`，`cgroup.subtree_control` 包含 `cpu`。启动插件后，同级目录 `w-<plugin-id>-<8位十六进制>` 中的 `cpu.max` 应为 `100000 100000`，`cgroup.procs` 包含 worker PID。停止插件后该目录消失。

若委托失败，运行服务仍须保持可用，日志只出现一次“CPU 分组不可用”。在确认新插件包确实携带 SDK `1.1.2` 之前，旧美森进程仍会因累计 60 秒 CPU 退出；只重启运行服务不能消除这个旧 wheel 行为。

## 自查

- 覆盖累计限制删除、服务总预算、单 worker 速率、运行服务权重、请求和任务超时，以及分组创建、迁移、清理、失败降级。
- 没有降低内存或地址空间限制，没有把 worker 移出父 cgroup。
- 已安装 wheel 与开发源码的生效差异已单独写明。
- 本机结果与生产 systemd 核对没有混写。

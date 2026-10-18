#!/usr/bin/env python3
"""Operate a pinned local production release without the development checkout."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

LABEL = "com.lele.growth"
URL = "http://127.0.0.1:8787/"


def command(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, check=check, timeout=20)


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".lele-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Production:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.domain = f"gui/{os.getuid()}"
        self.service = f"{self.domain}/{LABEL}"
        self.plist = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"

    def release(self) -> tuple[dict, Path]:
        manifest = json.loads((self.root / "current.json").read_text())
        tag = manifest["tag"]
        if not re.fullmatch(r"local-prod-[A-Za-z0-9._-]+", tag):
            raise ValueError("发布标签无效")
        if not re.fullmatch(r"[0-9a-f]{40}", manifest["commit"]):
            raise ValueError("发布提交无效")
        release = self.root / "releases" / tag
        if release.is_symlink():
            raise ValueError("生产发布目录不能链接到工作区")
        required = {"server.py", "storage.py", "postgres_store.py", "index.html", "requirements.txt", "db/schema.sql", "scripts/local_production.py"}
        files = manifest["files"]
        if not required.issubset(files):
            raise ValueError("发布摘要缺少必要文件")
        for name, expected in files.items():
            relative = Path(name)
            path = release / relative
            if relative.is_absolute() or ".." in relative.parts or path.resolve() != path:
                raise ValueError("发布文件路径无效")
            if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise ValueError(f"生产文件校验失败：{name}")
        if hashlib.sha256((self.root / "control.py").read_bytes()).hexdigest() != files["scripts/local_production.py"]:
            raise ValueError("生产控制程序与发布版本不一致")
        return manifest, release

    def preflight(self) -> tuple[dict, Path]:
        manifest, release = self.release()
        if not (self.root / ".venv/bin/python").is_file():
            raise ValueError("独立生产 Python 环境缺失")
        data = self.root / "data"
        for name in ("rds-config.json", "storage-mode.json", "lele-lan-access.json"):
            path = data / name
            if path.is_symlink() or path.stat().st_mode & 0o077:
                raise ValueError(f"正式配置权限必须为 0600：{name}")
        if json.loads((data / "storage-mode.json").read_text()).get("storage") != "postgres":
            raise ValueError("生产只允许现有 PostgreSQL 存储，不允许自动回退")
        code = json.loads((data / "lele-lan-access.json").read_text()).get("code")
        if not isinstance(code, str) or len(code) != 11:
            raise ValueError("原局域网口令配置缺失或无效")
        return manifest, release

    def managed_pid(self) -> int | None:
        result = command(["/bin/launchctl", "print", self.service], check=False)
        match = re.search(r"^\s*pid = (\d+)\s*$", result.stdout, re.MULTILINE)
        return int(match[1]) if match and result.returncode == 0 else None

    def listener_pids(self) -> set[int]:
        result = command(["/usr/sbin/lsof", "-nP", "-tiTCP:8787", "-sTCP:LISTEN"], check=False)
        if result.returncode not in (0, 1):
            raise RuntimeError("无法核对 8787 端口归属")
        return {int(value) for value in result.stdout.split()}

    def ready(self, release: Path) -> bool:
        pid = self.managed_pid()
        if pid is None or self.listener_pids() != {pid}:
            return False
        process = command(["/bin/ps", "-p", str(pid), "-o", "command="], check=False).stdout
        expected = str(self.root / ".venv/bin/python") + " " + str(release / "server.py") + " "
        if not process.strip().startswith(expected):
            return False
        try:
            with urllib.request.urlopen(URL + "api/health", timeout=12) as response:
                health = json.load(response)
            return (health.get("service") == "lele-task-manager"
                    and health.get("storage") == "postgres" and health.get("databaseReady") is True)
        except (OSError, ValueError, urllib.error.URLError):
            return False

    def wait_ready(self, release: Path) -> None:
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if self.ready(release):
                return
            time.sleep(0.3)
        raise RuntimeError("生产服务未就绪")

    def start(self) -> dict:
        manifest, release = self.preflight()
        managed = self.managed_pid()
        listeners = self.listener_pids()
        if listeners and (managed is None or listeners != {managed}):
            raise RuntimeError("8787 被其他进程占用，未停止任何进程")
        logs = self.root / "data/logs"
        logs.mkdir(parents=True, exist_ok=True)
        stderr = logs / "launchd.stderr.log"
        if stderr.exists() and stderr.stat().st_size > 262144:
            stderr.replace(logs / "launchd.stderr.previous.log")
        record = {
            "Label": LABEL,
            "ProgramArguments": [str(self.root / ".venv/bin/python"), str(release / "server.py"),
                                 "--no-browser", "--log-dir", str(logs), "--storage", "postgres",
                                 "--db-config", str(self.root / "data/rds-config.json"),
                                 "--data-root", str(self.root)],
            "WorkingDirectory": str(release), "RunAtLoad": True, "KeepAlive": True,
            "ThrottleInterval": 5, "ProcessType": "Background", "StandardErrorPath": str(stderr),
            "EnvironmentVariables": {"PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"},
        }
        previous = self.plist.read_bytes() if self.plist.exists() else None
        if previous is not None:
            atomic_write(self.root / "backups" / f"launchd-{time.time_ns()}.plist", previous)
        try:
            command(["/bin/launchctl", "bootout", self.service], check=False)
            atomic_write(self.plist, plistlib.dumps(record))
            command(["/bin/launchctl", "bootstrap", self.domain, str(self.plist)])
            self.wait_ready(release)
        except Exception:
            command(["/bin/launchctl", "bootout", self.service], check=False)
            if previous is not None:
                atomic_write(self.plist, previous)
                restored = command(["/bin/launchctl", "bootstrap", self.domain, str(self.plist)], check=False)
                if restored.returncode:
                    raise RuntimeError("新服务启动失败，旧配置已恢复，但旧服务重启失败；请检查本机日志") from None
                raise RuntimeError("新服务启动失败，已恢复旧服务配置并提交重启，请检查旧服务健康状态") from None
            self.plist.unlink(missing_ok=True)
            raise RuntimeError("生产服务启动失败，已撤销本次注册") from None
        return {"state": "running", "tag": manifest["tag"], "commit": manifest["commit"], "url": URL}

    def stop(self) -> dict:
        result = command(["/bin/launchctl", "bootout", self.service], check=False)
        if self.managed_pid() is not None:
            raise RuntimeError("服务尚未停止，请检查 launchd 状态")
        if result.returncode and self.listener_pids():
            raise RuntimeError("受管服务未运行，但 8787 仍被占用；未终止其他进程")
        return {"state": "stopped"}

    def status(self) -> dict:
        manifest, release = self.release()
        return {"state": "running" if self.ready(release) else "not_ready",
                "tag": manifest["tag"], "commit": manifest["commit"], "root": str(self.root), "url": URL}


def main() -> int:
    parser = argparse.ArgumentParser(description="乐乐成长独立本地生产服务")
    parser.add_argument("action", choices=("start", "stop", "status"))
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    try:
        result = getattr(Production(args.root), args.action)()
        print(json.dumps(result, ensure_ascii=False))
        if args.open and args.action == "start":
            command(["/usr/bin/open", URL])
        return 0
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"操作失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

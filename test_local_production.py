"""Lifecycle boundary checks with temporary files and mocked macOS commands."""
import hashlib
import json
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.local_production import Production


class ProductionLifecycleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.release = self.root / "releases/local-prod-test"
        self.release.mkdir(parents=True)
        names = ("server.py", "storage.py", "postgres_store.py", "index.html", "requirements.txt", "db/schema.sql", "scripts/local_production.py")
        files = {}
        for name in names:
            path = self.release / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name)
            files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        (self.root / "control.py").write_bytes((self.release / "scripts/local_production.py").read_bytes())
        self.manifest = {"tag": "local-prod-test", "commit": "a" * 40, "files": files}
        self.save_manifest()
        data = self.root / "data"
        data.mkdir()
        for name, value in (("rds-config.json", {}), ("storage-mode.json", {"storage": "postgres"}),
                            ("lele-lan-access.json", {"code": "ABCDE-FGHJK"})):
            path = data / name
            path.write_text(json.dumps(value))
            path.chmod(0o600)
        python = self.root / ".venv/bin/python"
        python.parent.mkdir(parents=True)
        python.touch()
        self.production = Production(self.root)
        self.production.plist = self.root / "launchagents/service.plist"

    def save_manifest(self):
        (self.root / "current.json").write_text(json.dumps(self.manifest))

    def test_tampered_release_refuses_start_before_system_commands(self):
        (self.release / "server.py").write_text("changed")
        with patch("scripts.local_production.command") as run:
            with self.assertRaisesRegex(ValueError, "校验失败"):
                self.production.start()
            run.assert_not_called()

    def test_path_escape_refused(self):
        self.manifest["files"]["../escape"] = "0" * 64
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "路径无效"):
            self.production.release()

    def test_json_fallback_and_public_credentials_refused(self):
        mode = self.root / "data/storage-mode.json"
        mode.write_text('{"storage":"json"}')
        with self.assertRaisesRegex(ValueError, "PostgreSQL"):
            self.production.preflight()
        mode.write_text('{"storage":"postgres"}')
        (self.root / "data/rds-config.json").chmod(0o644)
        with self.assertRaisesRegex(ValueError, "0600"):
            self.production.preflight()

    def test_foreign_listener_never_stopped(self):
        with patch.object(self.production, "managed_pid", return_value=10), \
             patch.object(self.production, "listener_pids", return_value={20}), \
             patch("scripts.local_production.command") as run:
            with self.assertRaisesRegex(RuntimeError, "其他进程"):
                self.production.start()
            run.assert_not_called()

    def test_failed_readiness_restores_previous_plist_and_restarts(self):
        previous = plistlib.dumps({"Label": "com.lele.growth", "ProgramArguments": ["old"]})
        self.production.plist.parent.mkdir()
        self.production.plist.write_bytes(previous)
        with patch.object(self.production, "managed_pid", return_value=10), \
             patch.object(self.production, "listener_pids", return_value={10}), \
             patch.object(self.production, "wait_ready", side_effect=RuntimeError("failed")), \
             patch("scripts.local_production.command", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
            with self.assertRaisesRegex(RuntimeError, "已恢复旧服务配置"):
                self.production.start()
        self.assertEqual(self.production.plist.read_bytes(), previous)
        self.assertEqual(len(list((self.root / "backups").glob("*.plist"))), 1)
        self.assertEqual([call.args[0][1] for call in run.call_args_list], ["bootout", "bootstrap", "bootout", "bootstrap"])


if __name__ == "__main__":
    unittest.main()

"""Packaging and entrypoint regressions; no business writes or cloud access."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

from lele_growth.paths import DATABASE_ROOT, PROJECT_ROOT, WEB_ROOT
from lele_growth.accounts_app import create_app
from fastapi.testclient import TestClient
from scripts.package_release import package, release_files


class ProjectLayoutTests(unittest.TestCase):
    def test_reorganized_sources_and_configuration_are_not_public(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps({
                "environment": "development",
                "database": {"host": "127.0.0.1", "dbname": "lele_test_layout", "user": "test",
                             "sslmode": "disable", "allow_unencrypted": True},
                "parent_origin": "http://127.0.0.1:18787", "admin_origin": "http://127.0.0.1:18788",
            }))
            for surface in ("parent", "admin"):
                client = TestClient(create_app(config, surface))
                self.assertEqual(client.get("/").status_code, 200)
                for path in ("/backend/lele_growth/accounts_app.py", "/backend/lele_growth/db/schema_v2.sql",
                             "/frontend/parent/src/App.tsx", "/config/production.example.json",
                             "/deploy/run.py", "/data/development/config.json", "/release-manifest.json",
                             "/legacy/index.html", "/tests/fixtures/calendar-legacy.cjs"):
                    with self.subTest(surface=surface, path=path):
                        self.assertEqual(client.get(path).status_code, 404)

    def test_resources_resolve_from_an_unrelated_working_directory(self):
        script = (
            "from lele_growth.paths import DATABASE_ROOT, WEB_ROOT; "
            "assert (DATABASE_ROOT/'schema_v2.sql').is_file(); "
            "assert (DATABASE_ROOT/'migrate_v3_to_v4.sql').is_file(); "
            "assert (WEB_ROOT/'parent-dist/index.html').is_file(); "
            "assert (WEB_ROOT/'admin-dist/index.html').is_file()"
        )
        with tempfile.TemporaryDirectory() as directory:
            environment = {**os.environ, "PYTHONPATH": str(PROJECT_ROOT / "backend")}
            subprocess.run([sys.executable, "-c", script], cwd=directory,
                           env=environment, check=True, capture_output=True)
        self.assertEqual(DATABASE_ROOT.parent.name, "lele_growth")
        self.assertEqual(WEB_ROOT, PROJECT_ROOT / "web")

    def test_release_contains_runtime_resources_without_private_or_legacy_files(self):
        files = release_files(PROJECT_ROOT)
        relative = {file.relative_to(PROJECT_ROOT).as_posix() for file in files}
        self.assertIn("backend/lele_growth/accounts_app.py", relative)
        self.assertIn("backend/lele_growth/db/migrate_v3_to_v4.sql", relative)
        self.assertIn("config/production.example.json", relative)
        forbidden = {"data", ".venv", "node_modules", "tests", "output", "legacy", ".git"}
        self.assertFalse(any(Path(name).parts[0] in forbidden for name in relative))
        self.assertFalse(any("credentials" in name for name in relative))
        with tempfile.TemporaryDirectory() as directory:
            archive_path = package(PROJECT_ROOT, Path(directory))
            with tarfile.open(archive_path) as archive:
                self.assertEqual(set(archive.getnames()), relative | {"release-manifest.json"})
                manifest = json.load(archive.extractfile("release-manifest.json"))
                for name, expected in manifest["files"].items():
                    self.assertEqual(hashlib.sha256(archive.extractfile(name).read()).hexdigest(), expected)
                extracted = Path(directory) / "release"
                archive.extractall(extracted, filter="data")
            environment = {key: value for key, value in os.environ.items()
                           if key not in ("PYTHONPATH", "LELE_ACCOUNTS_CONFIG", "LELE_SURFACE")}
            result = subprocess.run([sys.executable, str(extracted / "deploy/run.py")],
                                    cwd=directory, env=environment, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Explicit production configuration", result.stderr)
            digest = archive_path.with_name(archive_path.name + ".sha256").read_text().split()[0]
            self.assertEqual(hashlib.sha256(archive_path.read_bytes()).hexdigest(), digest)

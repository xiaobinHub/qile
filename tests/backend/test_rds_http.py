"""HTTP integration and cutover configuration guards; disposable database only."""
import hashlib
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

from lele_growth.postgres_store import PostgresStore, load_config
from legacy.server import create_server
from lele_growth.storage import StoreError, resolve_storage_mode
from tests.backend.test_postgres_store import fixture

ROOT = Path(__file__).resolve().parents[2]


class StorageModeTests(unittest.TestCase):
    def test_migrated_missing_config_never_falls_back(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data").mkdir()
            self.assertEqual(resolve_storage_mode(root), "json")
            for marker in ("rds-config.json", "rds-cutover.json"):
                path = root / "data" / marker
                path.write_text("{}")
                with self.assertRaises(StoreError):
                    resolve_storage_mode(root)
                path.unlink()

    def test_explicit_modes_and_invalid_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data").mkdir()
            path = root / "data/storage-mode.json"
            path.write_text('{"storage":"postgres"}')
            self.assertEqual(resolve_storage_mode(root), "postgres")
            self.assertEqual(resolve_storage_mode(root, "json"), "json")
            for content in ("{broken", "{}", '[]', '{"storage":"fallback"}'):
                path.write_text(content)
                with self.assertRaises(StoreError):
                    resolve_storage_mode(root)


@unittest.skipUnless(os.environ.get("LELE_TEST_DB_CONFIG"), "explicit disposable PostgreSQL config required")
class PostgreSQLHTTPTests(unittest.TestCase):
    def setUp(self):
        import psycopg
        self.driver = psycopg
        self.config_path = Path(os.environ["LELE_TEST_DB_CONFIG"])
        self.config = load_config(self.config_path)
        if self.config["host"] not in {"localhost", "127.0.0.1"} or self.config["dbname"] != "lele_test":
            raise RuntimeError("HTTP tests refuse any non-disposable database")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "index.html").write_text("<!doctype html><title>isolated test</title>")
        self.store = PostgresStore(ROOT, self.config_path)
        with psycopg.connect(**self.config) as conn:
            conn.execute("DROP SCHEMA IF EXISTS lele CASCADE")
        self.store.initialize_schema()
        self.record = fixture()

    def imported(self):
        self.store.import_record(self.record, hashlib.sha256(json.dumps(self.record).encode()).hexdigest())

    def serve(self, remote=False, config_path=None):
        self.server = create_server(self.root, 0, storage="postgres", config_path=config_path or self.config_path)
        if remote:
            self.server.RequestHandlerClass._is_local_request = lambda handler: False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, payload=None, cookie=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=15)
        headers = {"Content-Type": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        conn.request(method, path, json.dumps(payload) if payload is not None else None, headers)
        response = conn.getresponse()
        raw = response.read()
        result = response.status, json.loads(raw), dict(response.getheaders())
        conn.close()
        return result

    def test_read_health_raw_and_save_conflict(self):
        self.imported()
        self.serve()
        status, body, _ = self.request("GET", "/api/health")
        self.assertEqual((status, body["storage"], body["databaseReady"]), (200, "postgres", True))
        self.assertEqual(self.request("GET", "/api/data")[1], self.record)
        self.assertEqual(self.request("GET", "/api/data/raw")[1], self.record)
        self.assertEqual(self.request("PUT", "/api/data", {"expectedRevision": 7, "data": self.record["data"]})[0], 200)
        self.assertEqual(self.request("PUT", "/api/data", {"expectedRevision": 7, "data": self.record["data"]})[0], 409)
        # HTTP response arrives before the handler's finally logs the outcome.
        deadline = time.monotonic() + 2
        statuses = []
        while len(statuses) < 2 and time.monotonic() < deadline:
            with self.driver.connect(**self.config) as conn:
                statuses = [row[0] for row in conn.execute("SELECT http_status FROM lele.request_logs ORDER BY id")]
            if len(statuses) < 2:
                time.sleep(0.01)
        self.assertEqual(statuses, [200, 409])
        self.assertFalse((self.root / "data/lele-task-manager.json").exists())

    def test_uninitialized_never_creates_default_data(self):
        self.serve()
        self.assertEqual(self.request("GET", "/api/health")[0], 503)
        self.assertEqual(self.request("GET", "/api/data")[0], 503)
        self.assertEqual(self.request("PUT", "/api/data", {"expectedRevision": 0, "data": self.record["data"]})[0], 503)
        with self.driver.connect(**self.config) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM lele.app_metadata").fetchone()[0], 0)
        self.assertFalse((self.root / "data/lele-task-manager.json").exists())

    def test_connection_failure_never_writes_local_json(self):
        self.imported()
        broken = self.root / "missing-rds-config.json"
        self.serve(config_path=broken)
        self.assertEqual(self.request("GET", "/api/health")[0], 503)
        self.assertEqual(self.request("GET", "/api/data")[0], 503)
        self.assertEqual(self.request("PUT", "/api/data", {"expectedRevision": 7, "data": self.record["data"]})[0], 503)
        self.assertEqual(self.store.read(), self.record)
        self.assertFalse((self.root / "data/lele-task-manager.json").exists())

    def test_lan_access_gate_remains_enforced(self):
        self.imported()
        self.serve(remote=True)
        self.assertEqual(self.request("GET", "/api/data")[0], 401)
        self.assertEqual(self.request("GET", "/api/data/raw")[0], 401)
        code = self.server.RequestHandlerClass.access.code()
        status, _, headers = self.request("POST", "/api/access/login", {"code": code})
        self.assertEqual(status, 200)
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        self.assertEqual(self.request("GET", "/api/data", cookie=cookie)[0], 200)
        self.assertEqual(self.request("POST", "/api/access/refresh", {}, cookie)[0], 403)


if __name__ == "__main__":
    unittest.main()

"""Real PostgreSQL tests: explicit opt-in, disposable local database only."""
import copy
import hashlib
import json
import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date, time
from http import HTTPStatus
from pathlib import Path
from unittest.mock import patch

from postgres_store import PostgresStore, TABLES, canonical_sha256, load_config
from storage import StoreError

ROOT = Path(__file__).resolve().parent
STAMP = "2026-10-15T08:09:10.123Z"


def fixture():
    task = {"id": "s1", "title": "练习", "categoryId": "c1", "points": 5,
            "startDate": "2026-10-15", "startTime": "08:00", "endTime": "08:30",
            "createdAt": STAMP, "updatedAt": None, "recurrence": None,
            "revisions": [{"id": "r1", "effectiveFrom": "2026-10-15", "title": "初版"},
                          {"id": "r2", "effectiveFrom": "2026-10-16", "note": None}],
            "custom": {"unknown": None}}
    snapshot = {"seriesId": "s1", "title": "练习", "categoryId": "c1", "points": 5,
                "date": "2026-10-15", "startTime": "08:00", "endTime": "08:30"}
    data = {"schemaVersion": 2, "settings": {"childName": "合成测试", "weekStartsOn": 1, "other": None},
            "categories": [{"id": "c2", "name": "运动", "color": "#abcdef", "active": False},
                           {"id": "c1", "name": "学习", "color": "#123456", "active": True}],
            "series": [task], "exceptions": [{"seriesId": "s1", "originalDate": "2026-10-17", "action": "cancel"}],
            "completions": [{"occurrenceKey": "s1@2026-10-15", "completed": True, "snapshot": snapshot}],
            "ledger": [{"id": "l1", "kind": "task-complete", "amount": 5, "date": "2026-10-15", "createdAt": STAMP},
                       {"id": "l2", "kind": "manual", "amount": 10, "reason": "合成测试调整", "date": "2026-10-15", "createdAt": STAMP}],
            "gifts": [{"id": "g1", "name": "测试礼品", "points": 3, "status": "available", "createdAt": STAMP, "updatedAt": STAMP, "redeemedAt": None}],
            "operationLog": [{"id": "o1", "action": "test", "revision": 1, "at": STAMP, "before": None}],
            "extra": {"ordered": [3, 1, 2], "null": None}}
    return {"format": "lele-task-manager-store", "version": 1, "revision": 7, "updatedAt": STAMP, "data": data, "futureStore": {"nullable": None}}


class ConfigTests(unittest.TestCase):
    def config(self, **kwargs):
        config = {"host": "localhost", "dbname": "lele_test", "user": "lele_test", "sslmode": "disable", "allow_unencrypted": True, **kwargs}
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "config.json"
        path.write_text(json.dumps(config))
        return path

    def test_tls_and_options(self):
        kwargs = load_config(self.config())
        self.assertNotIn("allow_unencrypted", kwargs)
        self.assertEqual(kwargs["connect_timeout"], 8)
        self.assertIn("statement_timeout=10000", kwargs["options"])
        for config in ({"allow_unencrypted": False}, {"sslmode": "prefer"}, {"sslmode": "verify-full"}, {"options": "unsafe"}):
            with self.assertRaises(StoreError) as error:
                load_config(self.config(**config))
            self.assertEqual(error.exception.status, 503)


class ErrorBoundaryTests(unittest.TestCase):
    def test_lost_commit_has_uncertain_message_without_retry(self):
        store = PostgresStore(ROOT)
        class Cursor:
            def __enter__(self): return self
            def __exit__(self, *args): pass
        class Connection:
            commits = 0
            rollbacks = 0
            closed = False
            def cursor(self): return Cursor()
            def commit(self):
                self.commits += 1
                raise OSError("private-secret-connection-details")
            def rollback(self): self.rollbacks += 1
            def close(self): self.closed = True
        connection = Connection()
        with patch.object(store, "_connect", return_value=connection):
            with self.assertRaises(StoreError) as error:
                store._transaction(lambda cursor: {"revision": 8})
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(error.exception.message, "保存结果暂未确认，请刷新检查。")
        self.assertEqual(connection.commits, 1)
        self.assertEqual(connection.rollbacks, 1)
        self.assertTrue(connection.closed)
        self.assertIsNone(error.exception.__cause__)

    def test_malformed_values_are_safe_bad_request(self):
        store = PostgresStore(ROOT)
        record = fixture()
        record["data"]["series"][0]["categoryId"] = {"invalid": "value"}
        with self.assertRaises(StoreError) as error:
            store.write(7, record["data"])
        self.assertEqual(error.exception.status, 400)


@unittest.skipUnless(os.getenv("LELE_TEST_DB_CONFIG"), "Set LELE_TEST_DB_CONFIG to explicitly opt into disposable local PostgreSQL tests")
class PostgreSQLTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config_path = Path(os.environ["LELE_TEST_DB_CONFIG"])
        cls.config = load_config(cls.config_path)
        if cls.config["host"] not in {"localhost", "127.0.0.1", "::1"} or cls.config["dbname"] != "lele_test":
            raise RuntimeError("Refusing destructive tests outside isolated localhost lele_test")
        import psycopg
        cls.driver = psycopg

    def setUp(self):
        self.store = PostgresStore(ROOT, self.config_path)
        self.sql("DROP SCHEMA IF EXISTS lele CASCADE")
        self.store.initialize_schema()
        self.record = fixture()
        self.sha = hashlib.sha256(json.dumps(self.record, ensure_ascii=False).encode()).hexdigest()

    def sql(self, statement, params=None):
        with self.driver.connect(**self.config) as connection:
            with connection.cursor() as cursor:
                cursor.execute(statement, params)
                return cursor.fetchall() if cursor.description else None

    def imported(self):
        return self.store.import_record(self.record, self.sha)

    def test_roundtrip_raw_native_and_sparse_revisions(self):
        report = self.imported()
        self.assertEqual(self.store.read(), self.record)
        self.assertEqual(json.loads(self.store.raw()), self.record)
        self.assertEqual(report["points"], 15)
        self.assertEqual(len(TABLES), 14)
        self.assertEqual(self.sql("SELECT title,start_time,effective_from,record_json FROM lele.task_revisions ORDER BY sort_order"), [
            ("初版", time(8), date(2026, 10, 15), self.record["data"]["series"][0]["revisions"][0]),
            ("练习", time(8), date(2026, 10, 16), self.record["data"]["series"][0]["revisions"][1])])
        self.assertNotIn("taskPresets", self.store.read()["data"])
        self.assertEqual(self.sql("SELECT count(*) FROM lele.request_logs")[0][0], 0)
        self.assertEqual(self.sql("SELECT count(*) FROM lele.data_snapshots")[0][0], 0)

    def test_missing_metadata_never_seeded_or_repaired(self):
        for action in (self.store.read, self.store.raw, lambda: self.store.write(0, self.record["data"], repair=True)):
            with self.assertRaises(StoreError) as error:
                action()
            self.assertEqual(error.exception.status, 503)
        self.assertFalse(self.store.health())
        self.assertEqual(self.sql("SELECT count(*) FROM lele.app_metadata")[0][0], 0)

    def test_read_uses_repeatable_read_read_only_without_mutations(self):
        self.imported()
        original = self.store._read
        observed = []
        def inspect_read(cursor, **kwargs):
            cursor.execute("SHOW transaction_read_only")
            observed.append(cursor.fetchone()[0])
            cursor.execute("SHOW transaction_isolation")
            observed.append(cursor.fetchone()[0])
            return original(cursor, **kwargs)
        with patch.object(self.store, "_read", inspect_read):
            self.store.read()
            self.store.raw()
        self.assertEqual(observed, ["on", "repeatable read", "on", "repeatable read"])
        self.assertEqual(self.sql("SELECT count(*) FROM lele.data_snapshots")[0][0], 0)
        self.assertEqual(self.sql("SELECT count(*) FROM lele.request_logs")[0][0], 0)

    def test_dirty_uninitialized_target_refuses_import(self):
        self.sql("INSERT INTO lele.request_logs(request_id,requested_at,client_address,http_status,result) VALUES('existing',%s,'127.0.0.1',200,'saved')", (STAMP,))
        with self.assertRaises(StoreError) as error:
            self.imported()
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.sql("SELECT count(*) FROM lele.app_metadata")[0][0], 0)
        self.assertEqual(self.sql("SELECT count(*) FROM lele.request_logs")[0][0], 1)

    def test_save_snapshot_and_conflict(self):
        self.imported()
        data = copy.deepcopy(self.record["data"])
        data["settings"]["childName"] = "更新"
        result = self.store.write(7, data)
        self.assertEqual(result["revision"], 8)
        self.assertEqual(result["futureStore"], self.record["futureStore"])
        snapshot = self.sql("SELECT snapshot_json,content_sha256 FROM lele.data_snapshots")[0]
        self.assertEqual(snapshot, (self.record, canonical_sha256(self.record)))
        with self.assertRaises(StoreError) as error:
            self.store.write(7, data)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.store.read(), result)
        self.assertEqual(self.sql("SELECT count(*) FROM lele.data_snapshots")[0][0], 1)

    def test_invalid_and_late_fk_rollback(self):
        self.imported()
        invalid = copy.deepcopy(self.record["data"])
        invalid["series"][0]["revisions"].reverse()
        with self.assertRaises(StoreError) as error:
            self.store.write(7, invalid)
        self.assertEqual(error.exception.status, 400)
        original_replace = self.store._replace_business
        def insert_late_fk(cursor, data):
            original_replace(cursor, data)
            cursor.execute("UPDATE lele.points_ledger SET record_json=record_json||'{\"relatedLedgerId\":\"missing\"}'::jsonb WHERE id='l1'")
        with patch.object(self.store, "_replace_business", insert_late_fk):
            with self.assertRaises(StoreError) as error:
                self.store.write(7, self.record["data"])
        self.assertEqual(error.exception.status, 400)
        self.assertEqual(self.store.read(), self.record)
        self.assertEqual(self.sql("SELECT count(*) FROM lele.data_snapshots")[0][0], 0)

    def test_invalid_override_cannot_change_raw_or_snapshot(self):
        self.imported()
        before = self.store.raw()
        for override in ({"date": "2026-10-17"},
                         {"id": "s1", "title": "覆盖", "date": "2026-10-17", "startTime": "09:00", "endTime": "08:00", "points": 5, "categoryId": "c1"},
                         {"id": "s1", "title": "覆盖", "date": "2026-10-17", "startTime": "08:00", "endTime": "09:00", "points": 5, "categoryId": "missing"}):
            data = copy.deepcopy(self.record["data"])
            data["exceptions"][0].update(action="override", data=override)
            with self.assertRaises(StoreError) as error:
                self.store.write(7, data)
            self.assertEqual(error.exception.status, 400)
            self.assertEqual(self.store.raw(), before)
            self.assertEqual(self.sql("SELECT count(*) FROM lele.data_snapshots")[0][0], 0)

    def test_frontend_unloadable_records_are_rejected_without_changes(self):
        self.imported()
        before = self.store.raw()
        invalid_cases = []
        for reason in (None, "", 123):
            invalid = copy.deepcopy(self.record["data"])
            invalid["ledger"][1]["reason"] = reason
            invalid_cases.append(invalid)
        for snapshot in (None, {}, {"name": "", "points": 3}, {"name": "礼品", "points": 4}, {"name": "礼品", "points": True}):
            invalid = copy.deepcopy(self.record["data"])
            invalid["ledger"].append({"id": "redeem", "kind": "gift-redeem", "amount": -3, "giftId": "g1", "date": "2026-10-15", "createdAt": STAMP, "giftSnapshot": snapshot})
            invalid_cases.append(invalid)
        invalid = copy.deepcopy(self.record["data"])
        invalid["completions"][0]["snapshot"].pop("seriesId")
        invalid_cases.append(invalid)
        invalid = copy.deepcopy(self.record["data"])
        invalid["completions"][0]["snapshot"]["categoryId"] = "missing"
        invalid_cases.append(invalid)
        for invalid in invalid_cases:
            with self.assertRaises(StoreError) as error:
                self.store.write(7, invalid)
            self.assertEqual(error.exception.status, 400)
            self.assertEqual(self.store.raw(), before)
            self.assertEqual(self.sql("SELECT count(*) FROM lele.data_snapshots")[0][0], 0)

    def test_backup_retention(self):
        self.imported()
        for revision in range(7, 39):
            self.store.write(revision, self.record["data"])
        self.assertEqual(self.sql("SELECT count(*),min(revision),max(revision) FROM lele.data_snapshots")[0], (30, 9, 38))

    def test_concurrent_writers(self):
        self.imported()
        barrier = threading.Barrier(2)
        def save():
            barrier.wait()
            try:
                return self.store.write(7, self.record["data"])["revision"]
            except StoreError as error:
                return int(error.status)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: save(), range(2)))
        self.assertEqual(sorted(results), [8, 409])
        self.assertEqual(self.sql("SELECT count(*) FROM lele.data_snapshots")[0][0], 1)

    def test_deleting_series_preserves_history(self):
        self.imported()
        data = copy.deepcopy(self.record["data"])
        data["series"] = []; data["exceptions"] = []
        result = self.store.write(7, data)
        self.assertEqual(result["data"]["completions"], self.record["data"]["completions"])
        self.assertEqual(result["data"]["ledger"], self.record["data"]["ledger"])
        self.assertEqual(self.store.read(), result)

    def test_revisions_absent_and_null(self):
        task = self.record["data"]["series"][0]
        task.pop("revisions")
        null_task = {**task, "id": "s2", "revisions": None}
        self.record["data"]["series"].append(null_task)
        self.imported()
        self.assertEqual(self.store.read(), self.record)
        self.assertEqual(self.sql("SELECT revisions_state FROM lele.task_series ORDER BY sort_order"), [("absent",), ("null",)])

    def test_gift_redemption_reversal_relationships(self):
        self.imported()
        data = copy.deepcopy(self.record["data"])
        redeem = {"id": "redeem", "kind": "gift-redeem", "amount": -3, "giftId": "g1", "giftSnapshot": {"name": "测试礼品", "points": 3}, "date": "2026-10-15", "createdAt": STAMP}
        data["ledger"].append(redeem)
        data["gifts"][0].update(status="redeemed", redeemedAt=STAMP, redemptionLedgerId="redeem")
        self.store.write(7, data)
        reversal = {**redeem, "id": "reversal", "kind": "gift-reversal", "amount": 3, "relatedLedgerId": "redeem"}
        data["ledger"].append(reversal)
        data["gifts"][0].update(status="available", redeemedAt=None, redemptionLedgerId=None)
        self.store.write(8, data)
        for field, value in (("amount", 4), ("giftId", "different"), ("relatedLedgerId", "l1")):
            invalid = copy.deepcopy(data)
            invalid["ledger"][-1][field] = value
            with self.assertRaises(StoreError) as error:
                self.store.write(9, invalid)
            self.assertEqual(error.exception.status, 400)
        self.assertEqual(self.store.read()["revision"], 9)

    def test_import_idempotent_advanced_and_dirty_refused(self):
        self.imported()
        advanced = self.store.write(7, self.record["data"])
        before = self.sql("SELECT (SELECT count(*) FROM lele.data_snapshots),(SELECT count(*) FROM lele.migration_runs)")
        report = self.imported()
        self.assertTrue(report["already_migrated"])
        self.assertEqual(report["target_revision"], 8)
        self.assertEqual(self.store.read(), advanced)
        self.assertEqual(self.sql("SELECT (SELECT count(*) FROM lele.data_snapshots),(SELECT count(*) FROM lele.migration_runs)"), before)
        with self.assertRaises(StoreError) as error:
            self.store.import_record(self.record, "b" * 64)
        self.assertEqual(error.exception.status, 409)

    def test_schema_init_never_overwrites_foreign_or_altered(self):
        self.store.initialize_schema()
        self.sql("ALTER TABLE lele.app_settings ADD COLUMN foreign_field text")
        with self.assertRaises(StoreError) as error:
            self.store.initialize_schema()
        self.assertEqual(error.exception.status, 409)
        self.sql("DROP SCHEMA lele CASCADE")
        self.sql("CREATE SCHEMA lele")
        self.sql("CREATE TABLE lele.foreign_table(id integer)")
        with self.assertRaises(StoreError) as error:
            self.store.initialize_schema()
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.sql("SELECT tablename FROM pg_tables WHERE schemaname='lele'"), [("foreign_table",)])

    def test_request_log_contains_metadata_only(self):
        self.imported()
        self.store.append_operation_log({"requestId": "request-test", "at": STAMP, "client": "127.0.0.1", "expectedRevision": 7, "currentRevision": 8, "result": "saved", "httpStatus": 200, "business": self.record})
        rows = self.sql("SELECT request_id,client_address::text,http_status,result FROM lele.request_logs")
        self.assertEqual(rows, [("request-test", "127.0.0.1/32", 200, "saved")])


if __name__ == "__main__":
    unittest.main()

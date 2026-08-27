import json
import tempfile
import unittest
from pathlib import Path

from server import BACKUP_LIMIT, JsonStore, StoreError


def app_data(label="任务"):
    return {"schemaVersion": 1, "settings": {"label": label}, "categories": [], "series": [], "exceptions": [], "completions": [], "ledger": []}


class JsonStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def test_write_persists_and_creates_backup(self):
        first = self.store.write(0, app_data("首次"))
        second = self.store.write(first["revision"], app_data("第二次"))
        self.assertEqual(second["revision"], 2)
        self.assertEqual(self.store.read()["data"]["settings"]["label"], "第二次")
        self.assertEqual(len(list(self.store.backup_dir.glob("*.json"))), 1)

    def test_conflict_never_replaces_current_file(self):
        self.store.write(0, app_data("当前"))
        with self.assertRaises(StoreError) as raised:
            self.store.write(0, app_data("过期"))
        self.assertEqual(raised.exception.status.value, 409)
        self.assertEqual(self.store.read()["data"]["settings"]["label"], "当前")

    def test_repair_preserves_corrupt_data(self):
        self.store.data_dir.mkdir(parents=True)
        self.store.data_file.write_text("{坏数据", encoding="utf-8")
        with self.assertRaises(StoreError):
            self.store.read()
        repaired = self.store.write(0, app_data("恢复"), repair=True)
        self.assertEqual(repaired["revision"], 1)
        self.assertEqual(self.store.read()["data"]["settings"]["label"], "恢复")
        self.assertEqual(len(list(self.store.backup_dir.glob("*corrupt.json"))), 1)

    def test_backup_retention(self):
        revision = 0
        for index in range(BACKUP_LIMIT + 4):
            record = self.store.write(revision, app_data(str(index)))
            revision = record["revision"]
        self.assertEqual(len(list(self.store.backup_dir.glob("*.json"))), BACKUP_LIMIT)


if __name__ == "__main__":
    unittest.main()

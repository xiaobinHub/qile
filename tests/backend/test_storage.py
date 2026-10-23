"""Shared record validation and storage helper regression; no legacy server."""
import json
import tempfile
import unittest
from pathlib import Path
from lele_growth.storage import BACKUP_LIMIT, JsonStore, StoreError


def app_data(label="任务"):
    return {"schemaVersion": 2, "settings": {"label": label}, "categories": [], "series": [], "exceptions": [], "completions": [], "ledger": [], "gifts": [], "operationLog": []}


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

    def test_old_app_schema_is_rejected_on_write(self):
        old = app_data()
        old["schemaVersion"] = 1
        with self.assertRaises(StoreError) as raised:
            self.store.write(0, old)
        self.assertEqual(raised.exception.status.value, 400)

    def test_task_presets_round_trip_and_legacy_compatibility(self):
        first = self.store.write(0, app_data())
        sample = app_data()
        sample["taskPresets"] = [{"id": "english", "title": "外教英语课", "startTime": "19:30", "endTime": "20:00", "points": 30}]
        self.store.write(first["revision"], sample)
        self.assertEqual(self.store.read()["data"]["taskPresets"], sample["taskPresets"])

    def test_task_preset_category_round_trip_and_reference_validation(self):
        sample = app_data()
        sample["categories"] = [{"id": "learning", "name": "学习", "color": "#5b8def", "active": True}]
        preset = {"id": "english", "title": "外教英语课", "categoryId": "learning", "startTime": "19:30", "endTime": "20:00", "points": 30}
        sample["taskPresets"] = [preset]
        saved = self.store.write(0, sample)
        self.assertEqual(JsonStore(Path(self.temp.name)).read()["data"]["taskPresets"][0]["categoryId"], "learning")
        for category_id in ["missing", None, 1, {}]:
            with self.subTest(category_id=category_id):
                invalid = {**sample, "taskPresets": [{**preset, "categoryId": category_id}]}
                with self.assertRaises(StoreError) as raised:
                    self.store.write(saved["revision"], invalid)
                self.assertEqual(raised.exception.status.value, 400)
                self.assertEqual(self.store.read()["data"], sample)
        sample["categories"][0]["active"] = False
        self.store.write(saved["revision"], sample)

    def test_invalid_task_presets_do_not_replace_saved_data(self):
        saved = app_data("保留")
        self.store.write(0, saved)
        preset = {"id": "english", "title": "外教英语课", "startTime": "19:30", "endTime": "20:00", "points": 30}
        invalid_lists = [None, {}, [None], [preset, preset]]
        for changes in [{"id": ""}, {"title": " "}, {"title": "课" * 81}, {"startTime": "24:00"}, {"endTime": "19:30"}, {"endTime": "18:00"}, {"points": -1}, {"points": 0.5}, {"points": True}, {"points": "30"}, {"points": 10000}]:
            invalid_lists.append([{**preset, **changes}])
        for presets in invalid_lists:
            with self.subTest(presets=presets):
                invalid = {**app_data(), "taskPresets": presets}
                with self.assertRaises(StoreError) as raised:
                    self.store.write(1, invalid)
                self.assertEqual(raised.exception.status.value, 400)
                self.assertEqual(self.store.read()["data"], saved)

    def test_recurring_task_cannot_end_before_its_start_date(self):
        invalid = app_data()
        invalid["series"] = [{
            "id": "daily-reading",
            "title": "阅读",
            "startDate": "2026-09-21",
            "recurrence": {"freq": "daily", "interval": 1, "endType": "until", "until": "2026-09-20"},
        }]
        with self.assertRaises(StoreError) as raised:
            self.store.write(0, invalid)
        self.assertEqual(raised.exception.status.value, 400)


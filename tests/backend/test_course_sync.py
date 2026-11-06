import copy
import unittest

from lele_growth.business_operations import apply_operation, default_data
from lele_growth.course_sync import (
    CourseSyncConflict,
    purge_incomplete,
    reconcile,
    reconcile_current,
    series_id,
)
from lele_growth.postgres_store import validate_data
from lele_growth.storage import StoreError

NOW = "2026-10-06T02:00:00+00:00"
ACCOUNT = "9001"
CONTRACT = "70001"


def lesson(cid, day, status="upcoming", start="19:00", end="19:25", teacher="合成老师", courseware="合成课件"):
    return {"cid": cid, "status": status, "date": day, "startTime": start, "endTime": end,
            "teacherName": teacher, "coursewareTitle": courseware}


class CourseSyncTest(unittest.TestCase):
    def setUp(self):
        self.data = default_data("测试孩子")
        self.manual = dict(title="手工阅读", note="", startDate="2026-10-06", startTime="19:00", endTime="19:30",
                           categoryId=self.data["categories"][0]["id"], points=3, recurrence=None)

    def sync(self, courses, **kwargs):
        options = dict(account_id=ACCOUNT, contract_id=CONTRACT, points=10, start_date="2026-10-01", now=NOW)
        options.update(kwargs)
        updated, summary = reconcile(self.data, courses, **options)
        validate_data(updated)
        return updated, summary

    def synced(self, data, cid):
        identity = series_id(ACCOUNT, CONTRACT, cid)
        return next(item for item in data["series"] if item["id"] == identity)

    def test_start_date_is_inclusive_and_manual_tasks_stay(self):
        self.data = apply_operation(self.data, "task.create", {"task": self.manual}, actor_id="tester", revision=1, now=NOW)
        original_manual = copy.deepcopy(self.data["series"])
        updated, summary = self.sync([
            lesson("1", "2026-09-30"),
            lesson("2", "2026-10-01", "completed"),
            lesson("3", "2026-10-06"),
            {"cid": None, "status": "upcoming", "date": "2026-10-02", "startTime": "19:00", "endTime": "19:25"},
            lesson("4", "2026-10-07", start="23:30", end="00:10"),
        ])
        self.assertEqual([item["startDate"] for item in updated["series"] if item.get("source")], ["2026-10-01", "2026-10-06"])
        self.assertEqual(updated["series"][0], original_manual[0])
        completed = next(item for item in updated["completions"] if item["completed"])
        self.assertEqual(completed["snapshot"]["points"], 10)
        self.assertEqual(sum(item["amount"] for item in updated["ledger"]), 10)
        self.assertEqual(summary["added"], 2)
        self.assertEqual(summary["addedAttended"], 1)
        self.assertEqual(summary["points"], 10)
        self.assertEqual(summary["skipped"], 2)
        self.assertEqual(updated["categories"][-1]["id"], "mison-course")
        self.assertFalse(updated["series"][-1].get("recurrence"))

    def test_later_boundary_claws_back_and_earlier_boundary_awards_again(self):
        updated, _ = self.sync([
            lesson("1", "2026-10-02", "completed"),
            lesson("2", "2026-10-03"),
            lesson("3", "2026-10-05", "completed", start="20:00", end="20:25"),
        ])
        self.data = updated
        moved, summary = self.sync([
            lesson("1", "2026-10-02", "completed"),
            lesson("2", "2026-10-03"),
            lesson("3", "2026-10-05", "completed", start="20:00", end="20:25"),
        ], start_date="2026-10-05")
        self.assertEqual([item["startDate"] for item in moved["series"] if item.get("source")], ["2026-10-05"])
        self.assertEqual(sum(item["amount"] for item in moved["ledger"]), 10)
        self.assertEqual(summary["removed"], 2)
        self.assertEqual(summary["clawback"], 10)
        self.assertTrue(all(not item["completed"] or item["snapshot"]["date"] == "2026-10-05" for item in moved["completions"]))
        self.data = moved
        restored, again = self.sync([
            lesson("1", "2026-10-02", "completed"),
            lesson("2", "2026-10-03"),
            lesson("3", "2026-10-05", "completed", start="20:00", end="20:25"),
        ], start_date="2026-10-01")
        self.assertEqual(sorted(item["startDate"] for item in restored["series"] if item.get("source")), ["2026-10-02", "2026-10-03", "2026-10-05"])
        self.assertEqual(again["points"], 10)
        self.assertEqual(sum(item["amount"] for item in restored["ledger"]), 20)
        october_five = self.synced(restored, "3")
        self.assertEqual(next(item["snapshot"]["points"] for item in restored["completions"] if item["occurrenceKey"].startswith(october_five["id"])), 10)

    def test_reschedule_uses_new_date_and_retargets_without_another_award(self):
        updated, _ = self.sync([lesson("1", "2026-10-03", "completed")])
        self.data = updated
        moved, summary = self.sync([lesson("1", "2026-10-06", "completed", start="18:00", end="18:25")], start_date="2026-10-05")
        series = self.synced(moved, "1")
        self.assertEqual(series["startDate"], "2026-10-06")
        self.assertEqual(summary["removed"], 0)
        self.assertEqual(summary["points"], 0)
        self.assertEqual(sum(item["amount"] for item in moved["ledger"]), 10)
        completion = moved["completions"][0]
        self.assertTrue(completion["completed"])
        self.assertEqual(completion["occurrenceKey"], series["id"] + "@2026-10-06")
        self.assertEqual(completion["snapshot"]["points"], 10)
        self.data = updated
        removed, _ = self.sync([lesson("1", "2026-10-04", "completed")], start_date="2026-10-05")
        self.assertEqual([item for item in removed["series"] if item.get("source")], [])
        self.assertEqual(sum(item["amount"] for item in removed["ledger"]), 0)

    def test_disable_and_reenable_do_not_duplicate_tasks_or_points(self):
        updated, _ = self.sync([lesson("1", "2026-10-02", "completed"), lesson("2", "2026-10-08")])
        purged, removed = purge_incomplete(updated)
        validate_data(purged)
        self.assertEqual(removed, 1)
        self.assertEqual([item["startDate"] for item in purged["series"] if item.get("source")], ["2026-10-02"])
        self.assertEqual(sum(item["amount"] for item in purged["ledger"]), 10)
        self.data = purged
        caught_up, summary = self.sync([lesson("1", "2026-10-02", "completed"), lesson("2", "2026-10-08", "completed")])
        self.assertEqual(len([item for item in caught_up["series"] if item.get("source")]), 2)
        self.assertEqual(summary["points"], 10)
        self.assertEqual(len([item for item in caught_up["series"] if item["id"] == series_id(ACCOUNT, CONTRACT, "1")]), 1)
        self.assertEqual(sum(item["amount"] for item in caught_up["ledger"]), 20)

    def test_point_change_does_not_rewrite_completed_courses(self):
        updated, _ = self.sync([lesson("1", "2026-10-02", "completed"), lesson("2", "2026-10-08")], points=10)
        self.data = updated
        repeated, repeated_summary = self.sync([lesson("1", "2026-10-02", "completed"), lesson("2", "2026-10-08")], points=10)
        self.assertEqual(repeated, updated)
        self.assertEqual(repeated_summary["added"], 0)
        self.assertEqual(repeated_summary["points"], 0)
        changed, summary = self.sync([lesson("1", "2026-10-02", "completed"), lesson("2", "2026-10-08")], points=20)
        self.assertEqual(summary["points"], 0)
        self.assertEqual(self.synced(changed, "1")["points"], 10)
        self.assertEqual(next(item["snapshot"]["points"] for item in changed["completions"] if item["completed"]), 10)
        self.assertEqual(self.synced(changed, "2")["points"], 20)

    def test_cancelled_course_reverses_points_and_missing_course_remains(self):
        updated, _ = self.sync([lesson("1", "2026-10-02", "completed"), lesson("2", "2026-10-08")])
        self.data = updated
        changed, summary = self.sync([lesson("1", "2026-10-02", "cancelled")])
        self.assertEqual(summary["removed"], 1)
        self.assertEqual(summary["clawback"], 10)
        self.assertEqual([item["startDate"] for item in changed["series"] if item.get("source")], ["2026-10-08"])
        self.assertEqual(sum(item["amount"] for item in changed["ledger"]), 0)

    def test_incomplete_archived_or_conflicting_reads_do_not_change_tasks(self):
        updated, _ = self.sync([lesson("1", "2026-10-08")])
        for kwargs in ({"list_complete": False}, {"archived": True}, {"contract_error": "multiple"}):
            paused, summary = reconcile_current(updated, [lesson("1", "2026-10-08", "cancelled")],
                                                 account_id=ACCOUNT, contract_id=CONTRACT, points=10,
                                                 start_date="2026-10-05", now=NOW, **kwargs)
            self.assertEqual(paused, updated)
            self.assertEqual(summary["state"], "paused")
        with self.assertRaises(CourseSyncConflict):
            self.sync([lesson("9", "2026-10-06", start="19:00", end="19:25"),
                       lesson("9", "2026-10-06", start="20:00", end="20:25")])

    def test_synced_course_rejects_manual_edit_completion_and_batch(self):
        updated, _ = self.sync([lesson("1", "2026-10-06")])
        key = series_id(ACCOUNT, CONTRACT, "1") + "@2026-10-06"
        task = {**self.manual, "title": "改掉同步课", "startDate": "2026-10-06"}
        for kind, payload in (
            ("task.edit", {"occurrenceKey": key, "scope": "only", "task": task}),
            ("task.delete", {"occurrenceKey": key, "scope": "only"}),
            ("completion.set", {"occurrenceKey": key, "completed": True}),
            ("task.batch", {"operations": [{"kind": "task.delete", "payload": {"occurrenceKey": key, "scope": "only"}}]}),
        ):
            with self.assertRaises(StoreError):
                apply_operation(updated, kind, payload, actor_id="tester", revision=1, now=NOW)


if __name__ == "__main__":
    unittest.main()

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "plugins/mison-booking/backend"), str(ROOT / "packages/plugin-sdk-python/src")]
from mison_booking.auth import AuthError
from mison_booking.course_sync import collect_lessons
from mison_booking import read_store


class FakeClient:
    def __init__(self):
        self.scope = ("child-a", 1, "credential-a")
        self.userid = 987654
        self.contracts = [{"id": 70001, "courseid": 90001, "gradeid": 60001, "gradestatus": "正常",
                           "endtime": "2099-01-01 00:00", "name": "测试一对一", "type": "合成课程"}]
        self.courses = [{"classid": 90001, "liveid": 70001, "new_liveid": 60001, "expire": False}]
        self.pages = {"upcoming": [{"cid": 11, "teachername": "甲老师", "datestart": "2026-10-01 19:00", "dateend": "19:25", "course_name": "拼音"}],
                      "completed": [{"cid": "12", "teachername": "乙老师", "datestart": "2026-10-02 20:00:00", "dateend": "20:25", "course_name": "阅读"}],
                      "cancelled": [{"dateTime": "2026-10-03 18:00-18:25", "teachername": "丙老师", "course_name": "无编号"},
                                    {"cid": 13, "dateTime": "2026-10-04 21:00-20:00", "teachername": "丁老师"}]}

    def call(self, endpoint, body):
        if endpoint == "myOneToOneList":
            return {"data": self.contracts}
        if endpoint == "myCourseList":
            return {"data": self.courses}
        if endpoint == "getLiveList":
            return {"data": {"list": self.pages["upcoming"], "allPage": 1, "lastPage": True}}
        if endpoint == "getBackList":
            return {"data": {"list": self.pages["completed"], "allPage": 1, "lastPage": True}}
        if endpoint == "onevoneGetCancelLesson":
            return {"data": self.pages["cancelled"], "count": len(self.pages["cancelled"])}
        raise AssertionError(endpoint)


class MisonCourseCollectionTest(unittest.TestCase):
    def setUp(self):
        read_store.memo.values.clear()
        read_store.memo.size = 0

    def test_missing_cid_and_invalid_time_are_skipped_without_guessing(self):
        lessons, contract = collect_lessons(FakeClient())
        self.assertEqual(contract["id"], "70001")
        valid = [lesson for lesson in lessons if not lesson["invalid"]]
        self.assertEqual([(lesson["cid"], lesson["status"], lesson["date"], lesson["endTime"]) for lesson in valid],
                         [("11", "upcoming", "2026-10-01", "19:25"), ("12", "completed", "2026-10-02", "20:25")])
        self.assertEqual(sum(lesson["invalid"] for lesson in lessons), 2)

    def test_multiple_contracts_pause_before_any_lesson_is_chosen(self):
        client = FakeClient()
        client.contracts.append(dict(client.contracts[0], id=70002))
        client.courses.append(dict(client.courses[0], liveid=70002))
        with self.assertRaises(AuthError) as caught:
            collect_lessons(client)
        self.assertEqual(caught.exception.code, "CONTRACT_SELECTION_REQUIRED")

    def test_cancellation_without_cid_preserves_composite_and_booking_evidence(self):
        client = FakeClient()
        client.pages['cancelled'] = [{'teachername': 'Miri', 'dateTime': '2026-11-10 20:00-20:25',
            'courseware_id': '6857', 'course_name': 'Food shopping', 'bid': 1788407996, 'courseid': '26110349376644'}]
        client.pages['upcoming'][0].update(tid=3864, courseware_id=6857, bid=1786364535, courseid='26110678668335')
        lessons, _ = collect_lessons(client)
        cancelled = next(row for row in lessons if row['status'] == 'cancelled')
        self.assertFalse(cancelled['invalid'])
        self.assertIsNone(cancelled['cid'])
        self.assertIsNone(cancelled['teacherId'])
        self.assertEqual(cancelled['coursewareId'], '6857')
        self.assertEqual(cancelled['bid'], '1788407996')
        self.assertEqual(cancelled['bookingId'], '26110349376644')
        upcoming = next(row for row in lessons if row['status'] == 'upcoming')
        self.assertEqual(upcoming['teacherId'], '3864')
        self.assertEqual(upcoming['coursewareId'], '6857')

    def test_incomplete_page_does_not_pretend_the_list_is_complete(self):
        client = FakeClient()
        client.pages["upcoming"] = [{"cid": 11, "teachername": "甲老师", "datestart": "2026-10-01 19:00", "dateend": "19:25", "course_name": "拼音"}]
        client.call = lambda endpoint, body: {"data": {"list": client.pages["upcoming"], "allPage": 9, "lastPage": False}} if endpoint == "getLiveList" else FakeClient.call(client, endpoint, body)
        with self.assertRaises(AuthError) as caught:
            collect_lessons(client, max_pages=1)
        self.assertEqual(caught.exception.code, "QUERY_TOO_LARGE")


if __name__ == "__main__":
    unittest.main()

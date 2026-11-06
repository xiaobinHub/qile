"""Course/slot identity regressions independent of the upstream service or DB."""
import copy
import unittest

from lele_growth.business_operations import default_data
from lele_growth.course_sync import series_id
from lele_growth.course_sync_identity import reconcile_identified
from lele_growth.postgres_store import validate_data

ACCOUNT, CONTRACT = '9001', '70001'
NOW = '2026-11-07T10:00:00+08:00'


def lesson(cid='1', status='upcoming', **changes):
    return {'cid': cid, 'status': status, 'teacherId': '100', 'teacherName': 'Miri',
            'coursewareId': '6857', 'coursewareTitle': 'Food shopping', 'bid': '201', 'bookingId': '301',
            'date': '2026-11-10', 'startTime': '20:00', 'endTime': '20:25', **changes}


class CourseIdentityTests(unittest.TestCase):
    def setUp(self):
        self.data = default_data('隔离测试')
        self.identities = {}

    def sync(self, courses):
        before, identities = copy.deepcopy(self.data), copy.deepcopy(self.identities)
        result, summary, records = reconcile_identified(self.data, courses, associations=self.identities,
            account_id=ACCOUNT, contract_id=CONTRACT, points=20, start_date='2026-11-01', now=NOW)
        self.assertEqual(self.data, before)
        self.assertEqual(self.identities, identities)
        validate_data(result)
        self.data, self.identities = result, records
        return summary

    def cids(self):
        return [row['source']['cid'] for row in self.data['series']]

    def test_missing_cid_cancellation_removes_only_full_composite_match(self):
        self.sync([lesson(), lesson('2', teacherId='200', teacherName='CessAnne', startTime='19:30', endTime='19:55')])
        summary = self.sync([lesson(None, 'cancelled', teacherId=None)])
        self.assertEqual(self.cids(), ['2'])
        self.assertEqual(summary['removed'], 1)
        self.assertEqual(summary['needsReview'], 0)
        self.assertTrue(self.identities['1']['cancelled'])
        self.assertEqual(self.sync([lesson(None, 'cancelled', teacherId=None)])['removed'], 0)

    def test_full_date_end_time_courseware_and_scope_are_required(self):
        self.sync([lesson()])
        for changes in ({'date': '2026-11-11'}, {'endTime': '20:30'}, {'coursewareId': '999'},
                        {'teacherId': '999', 'teacherName': 'Other'}):
            self.sync([lesson(None, 'cancelled', **changes)])
            self.assertEqual(self.cids(), ['1'])
        foreign = {**self.identities['1'], 'accountId': 'elsewhere', 'cid': 'foreign'}
        self.identities['foreign'] = foreign
        self.sync([lesson(None, 'cancelled', teacherId=None)])
        self.assertEqual(self.cids(), [])
        self.assertFalse(self.identities['foreign'].get('cancelled'))

    def test_courseware_change_same_slot_replaces_old_task_and_tombstones_old_cid(self):
        self.sync([lesson(status='completed')])
        summary = self.sync([lesson('2', coursewareId='7000', coursewareTitle='New course', bid='202', bookingId='302')])
        self.assertEqual(self.cids(), ['2'])
        self.assertEqual(summary['removed'], 1)
        self.assertEqual(summary['clawback'], 20)
        self.assertEqual(sum(row['amount'] for row in self.data['ledger']), 0)
        self.sync([lesson(status='completed')])
        self.assertEqual(self.cids(), ['2'])
        self.assertEqual(sum(row['amount'] for row in self.data['ledger']), 0)

    def test_same_cid_courseware_change_preserves_identity_and_awarded_history(self):
        self.sync([lesson(status='completed')])
        original_id = self.data['series'][0]['id']
        original_source = copy.deepcopy(self.data['completions'][0]['snapshot']['source'])
        summary = self.sync([lesson(status='completed', coursewareId='7000', coursewareTitle='New course')])
        self.assertEqual(self.data['series'][0]['id'], original_id)
        self.assertEqual(self.data['completions'][0]['snapshot']['source'], original_source)
        self.assertIn('New course', self.data['series'][0]['title'])
        self.assertEqual(summary['points'], 0)
        self.assertEqual(sum(row['amount'] for row in self.data['ledger']), 20)

    def test_cancel_rebook_identical_course_never_deletes_live_generation(self):
        self.sync([lesson()])
        cancelled = lesson(None, 'cancelled', teacherId=None)
        current = lesson('2', bid='202', bookingId='302')
        self.sync([cancelled, current])
        self.assertEqual(self.cids(), ['2'])
        self.sync([cancelled, current])
        self.assertEqual(self.cids(), ['2'])
        # Absence is not cancellation; the old cancellation must still refer to CID1.
        self.sync([cancelled])
        self.assertEqual(self.cids(), ['2'])
        new_cancel = lesson(None, 'cancelled', teacherId=None, bid='202', bookingId='302')
        self.sync([cancelled, new_cancel])
        self.assertEqual(self.cids(), [])

    def test_preexisting_cancel_without_known_old_cid_cannot_delete_a_later_missing_booking(self):
        # First sync starts after rebooking: only the new CID is ever observed.
        current = lesson('2', bid='202', bookingId='302')
        old_cancel = lesson(None, 'cancelled', teacherId=None)
        self.sync([current, old_cancel])
        self.assertEqual(self.cids(), ['2'])
        summary = self.sync([old_cancel])
        self.assertEqual(self.cids(), ['2'])
        self.assertEqual(summary['needsReview'], 1)
        self.sync([lesson(None, 'cancelled', teacherId=None, bid='202', bookingId='302')])
        self.assertEqual(self.cids(), [])

    def test_different_booking_evidence_is_ambiguous_even_when_old_cancellation_was_never_seen(self):
        self.sync([lesson('2', bid='202', bookingId='302')])
        summary = self.sync([lesson(None, 'cancelled', teacherId=None)])
        self.assertEqual(self.cids(), ['2'])
        self.assertEqual(summary['needsReview'], 1)

    def test_ambiguous_teacher_and_multiple_old_generations_are_preserved_for_review(self):
        self.sync([lesson(), lesson('2', teacherId='200', startTime='19:30', endTime='19:55')])
        summary = self.sync([lesson(None, 'cancelled', teacherId=None)])
        self.assertEqual(self.cids(), ['1', '2'])
        self.assertEqual(summary['needsReview'], 1)
        # Two historical CIDs in one course composite, with no generation evidence.
        self.identities['3'] = {**self.identities['1'], 'cid': '3', 'bid': None, 'bookingId': None}
        summary = self.sync([lesson(None, 'cancelled', bid=None, bookingId=None)])
        self.assertEqual(self.cids(), ['1', '2'])
        self.assertEqual(summary['needsReview'], 1)

    def test_legacy_task_backfill_requires_unique_resolved_teacher_and_courseware(self):
        self.sync([lesson(), lesson('2', teacherName='CessAnne', teacherId='200', startTime='19:30', endTime='19:55')])
        self.identities = {}
        old_id = series_id(ACCOUNT, CONTRACT, '2')
        summary = self.sync([lesson('3', status='completed', date='2026-11-02'),
                             lesson(None, 'cancelled', teacherId=None),
                             lesson('2', teacherName='CessAnne', teacherId='200', startTime='19:30', endTime='19:55')])
        self.assertNotIn('1', self.cids())
        self.assertEqual(summary['removed'], 1)
        self.assertEqual(next(row for row in self.data['series'] if row['source']['cid'] == '2')['id'], old_id)

    def test_unresolved_legacy_cancellation_is_not_guessed(self):
        self.sync([lesson()])
        self.identities = {}
        summary = self.sync([lesson(None, 'cancelled', teacherId=None)])
        self.assertEqual(self.cids(), ['1'])
        self.assertEqual(summary['needsReview'], 1)

    def test_completed_cancellation_claws_back_once_and_never_reawards_stale_cid(self):
        self.sync([lesson(status='completed')])
        cancelled = lesson(None, 'cancelled', teacherId=None)
        self.assertEqual(self.sync([cancelled, cancelled])['clawback'], 20)
        self.assertEqual(self.sync([cancelled])['clawback'], 0)
        self.assertEqual(self.sync([lesson(status='completed')])['points'], 0)
        self.assertEqual(self.cids(), [])
        self.assertEqual(sum(row['amount'] for row in self.data['ledger']), 0)

    def test_conflicting_live_slot_is_preserved_for_review(self):
        self.sync([lesson()])
        summary = self.sync([lesson(), lesson('2', coursewareId='999', coursewareTitle='Other')])
        self.assertEqual(self.cids(), ['1'])
        self.assertEqual(summary['needsReview'], 1)


if __name__ == '__main__':
    unittest.main()

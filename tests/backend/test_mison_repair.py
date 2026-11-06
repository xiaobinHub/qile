"""The local repair tool refuses any business change outside one incomplete task."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from lele_growth.child_service import ApiError

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('mison_repair_tests', ROOT/'scripts/repair_mison_incomplete_cancel.py')
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class MisonRepairGuardTests(unittest.TestCase):
    def setUp(self):
        self.before = {'series': [{'id': 'cancelled', 'title': 'Miri'}, {'id': 'valid', 'title': 'CessAnne'}],
                       'ledger': [], 'completions': [], 'operationLog': []}
        self.after = {**copy.deepcopy(self.before), 'series': [copy.deepcopy(self.before['series'][1])]}

    def test_exact_task_deletion_and_already_repaired_are_allowed(self):
        self.assertTrue(repair.check_delta(self.before, self.after, 'cancelled'))
        self.assertFalse(repair.check_delta(self.after, self.after, 'cancelled'))

    def test_other_task_points_or_completion_changes_are_rejected(self):
        for key, value in (('series', []), ('series', [{'id': 'valid', 'title': 'changed'}]),
                           ('ledger', [{'amount': 20}]), ('completions', [{'completed': True}])):
            with self.subTest(key=key, value=value), self.assertRaises(ApiError) as caught:
                repair.check_delta(self.before, {**self.after, key: value}, 'cancelled')
            self.assertEqual(caught.exception.kind, 'REPAIR_SCOPE_CHANGED')

    def test_production_remote_or_other_database_is_rejected_before_any_access(self):
        config = {'environment': 'development', '_connect': {'host': '127.0.0.1', 'dbname': 'lele_dev'}}
        for change in ({'environment': 'production'}, {'_connect': {'host': 'remote.invalid', 'dbname': 'lele_dev'}},
                       {'_connect': {'host': '127.0.0.1', 'dbname': 'another_db'}}):
            service = SimpleNamespace(config={**config, **change})
            with patch.object(repair, 'ChildService', return_value=service), self.assertRaises(ApiError) as caught:
                repair.repair('child', 'cid', '2026-11-10', apply=True, expected_revision=462)
            self.assertEqual(caught.exception.kind, 'REPAIR_ENVIRONMENT')

    def test_apply_requires_explicit_preview_revision(self):
        service = SimpleNamespace(config={'environment': 'development', '_connect': {'host': '127.0.0.1', 'dbname': 'lele_dev'}})
        with patch.object(repair, 'ChildService', return_value=service), self.assertRaises(ApiError) as caught:
            repair.repair('child', 'cid', '2026-11-10', apply=True)
        self.assertEqual(caught.exception.kind, 'REPAIR_REVISION_REQUIRED')

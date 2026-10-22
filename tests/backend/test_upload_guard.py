import unittest
from lele_growth.child_service import ApiError
from lele_growth.upload_guard import UploadGuard


class UploadGuardTests(unittest.TestCase):
    def test_account_window_and_failed_work_release_slots(self):
        clock=[0]
        guard=UploadGuard(concurrency=1,per_minute=2,clock=lambda:clock[0])
        with guard.acquire('a'):pass
        with self.assertRaises(RuntimeError):
            with guard.acquire('a'):raise RuntimeError('failed processing')
        with self.assertRaises(ApiError) as failure:
            with guard.acquire('a'):pass
        self.assertEqual(failure.exception.status,429)
        with guard.acquire('b'):pass
        clock[0]=61
        with guard.acquire('a'):pass
        self.assertEqual(len(guard.accounts),1)

    def test_concurrency_limit_is_nonblocking(self):
        guard=UploadGuard(concurrency=1)
        with guard.acquire('a'):
            with self.assertRaises(ApiError) as failure:
                with guard.acquire('b'):pass
            self.assertEqual(failure.exception.kind,'upload_busy')
        with guard.acquire('b'):pass

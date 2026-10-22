"""Bound image processing after authentication; no database/business state."""
from collections import OrderedDict, deque
from contextlib import contextmanager
from threading import BoundedSemaphore, Lock
from time import monotonic
from lele_growth.child_service import ApiError


class UploadGuard:
    def __init__(self, *, concurrency=4, per_minute=60, clock=monotonic):
        self.slots = BoundedSemaphore(concurrency)
        self.per_minute, self.clock = per_minute, clock
        self.lock = Lock()
        self.accounts = OrderedDict()

    @contextmanager
    def acquire(self, user_id):
        if not self.slots.acquire(blocking=False):
            raise ApiError(429, '图片处理繁忙，请稍后重试原上传。', 'upload_busy')
        try:
            with self.lock:
                now = self.clock()
                # Every access moves to the end; remove expired accounts as well.
                while self.accounts:
                    first = next(iter(self.accounts))
                    if self.accounts[first][-1] > now - 60:
                        break
                    self.accounts.popitem(last=False)
                if user_id not in self.accounts and len(self.accounts) >= 4096:
                    raise ApiError(429, '图片处理繁忙，请稍后重试原上传。', 'upload_busy')
                queue = self.accounts.setdefault(user_id, deque())
                while queue and queue[0] <= now - 60:
                    queue.popleft()
                if len(queue) >= self.per_minute:
                    raise ApiError(429, '图片上传过于频繁，请一分钟后重试原上传。', 'upload_rate_limited')
                queue.append(now)
                self.accounts.move_to_end(user_id)
            yield
        finally:
            self.slots.release()


UPLOAD_GUARD = UploadGuard()

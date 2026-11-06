"""Bounded, short-lived worker caches. No passwords or bearer tokens are cached."""
from collections import OrderedDict
from copy import deepcopy
import json
import re
import threading
import time
import uuid
from .auth import AuthError

class Cache:
    def __init__(self, entries=128, max_bytes=24 * 1024 * 1024):
        self.entries, self.max_bytes = entries, max_bytes
        self.values, self.size, self.lock = OrderedDict(), 0, threading.RLock()

    def get(self, key):
        with self.lock:
            item = self.values.get(key)
            if not item:
                return None
            until, value, size = item
            if until <= time.monotonic():
                self.values.pop(key); self.size -= size
                return None
            self.values.move_to_end(key)
            return deepcopy(value)

    def put(self, key, value, ttl=300):
        size = len(json.dumps(value, ensure_ascii=False).encode())
        if size > self.max_bytes:
            raise AuthError('QUERY_TOO_LARGE', '查询结果过大，请缩小日期范围。')
        with self.lock:
            old = self.values.pop(key, None)
            if old: self.size -= old[2]
            self.values[key] = (time.monotonic() + ttl, deepcopy(value), size)
            self.size += size
            while len(self.values) > self.entries or self.size > self.max_bytes:
                _, removed = self.values.popitem(last=False)
                self.size -= removed[2]
        return value

class TeacherCursors:
    """Teacher-list pagination. Time and other read cursors do not evict it."""

    def __init__(self, pages_per_scope=32, scopes=128, max_bytes=32 * 1024 * 1024):
        self.pages_per_scope, self.scopes, self.max_bytes = pages_per_scope, scopes, max_bytes
        self.buckets, self.index, self.sizes = OrderedDict(), {}, {}
        self.size, self.lock = 0, threading.RLock()

    def clear(self):
        with self.lock:
            self.buckets.clear(); self.index.clear(); self.sizes.clear(); self.size = 0

    def get(self, key):
        with self.lock:
            scope = self.index.get(key)
            if scope is None: return None
            pages = self.buckets[scope]
            self.buckets.move_to_end(scope); pages.move_to_end(key)
            return deepcopy(pages[key])

    def _drop(self, scope, key):
        self.buckets[scope].pop(key)
        self.index.pop(key, None)
        self.size -= self.sizes.pop(key)
        if not self.buckets[scope]: self.buckets.pop(scope)

    def put(self, key, state):
        payload = deepcopy(state)
        size = len(json.dumps(payload, ensure_ascii=False).encode())
        if size > self.max_bytes:
            raise AuthError('QUERY_TOO_LARGE', '查询结果过大，请缩小日期范围。')
        scope = tuple(state['scope'])
        with self.lock:
            if key in self.index: self._drop(self.index[key], key)
            pages = self.buckets.get(scope)
            if pages is None:
                pages = OrderedDict(); self.buckets[scope] = pages
            else: self.buckets.move_to_end(scope)
            pages[key] = payload; pages.move_to_end(key)
            self.index[key] = scope; self.sizes[key] = size; self.size += size
            while len(pages) > self.pages_per_scope:
                self._drop(scope, next(iter(pages)))
            while self._over_budget():
                if not self._evict_other(scope):
                    oldest = next(iter(pages))
                    if oldest == key: break
                    self._drop(scope, oldest)

    def _over_budget(self):
        return len(self.buckets) > self.scopes or self.size > self.max_bytes

    def _evict_other(self, scope):
        victim = next((item for item in self.buckets if item != scope), None)
        if victim is None: return False
        self._drop(victim, next(iter(self.buckets[victim])))
        return True

memo = Cache(256, 8 * 1024 * 1024)
cursors = Cache(64, 16 * 1024 * 1024)
teacher_cursors = TeacherCursors()

def scope(context, session):
    return (context['childId'], session['bindingRevision'], session['credentialId'])

def resume(client, kind, filters, cursor):
    if not cursor:
        return {'scope': list(client.scope), 'kind': kind, 'filters': filters, 'page': 1,
                'items': [], 'seen': [], 'complete': False, 'offset': 0, 'stalls': 0,
                'queryId': uuid.uuid4().hex}
    if not isinstance(cursor, str) or not re.fullmatch(r'[a-f0-9]{32}', cursor):
        raise AuthError('VALIDATION_ERROR', '查询游标不正确。')
    value = (teacher_cursors if kind == 'teachers' else cursors).get(cursor)
    if not value or value['scope'] != list(client.scope) or value['kind'] != kind or value['filters'] != filters:
        raise AuthError('QUERY_EXPIRED', '查询已过期或条件已改变，请刷新列表。')
    return value

def continuation(state):
    key = uuid.uuid4().hex
    (teacher_cursors if state['kind'] == 'teachers' else cursors).put(key, state)
    return key

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

memo = Cache(256, 8 * 1024 * 1024)
cursors = Cache(64, 16 * 1024 * 1024)

def scope(context, session):
    return (context['childId'], session['bindingRevision'], session['credentialId'])

def resume(client, kind, filters, cursor):
    if not cursor:
        return {'scope': list(client.scope), 'kind': kind, 'filters': filters, 'page': 1,
                'items': [], 'seen': [], 'complete': False, 'offset': 0, 'stalls': 0,
                'queryId': uuid.uuid4().hex}
    if not isinstance(cursor, str) or not re.fullmatch(r'[a-f0-9]{32}', cursor):
        raise AuthError('VALIDATION_ERROR', '查询游标不正确。')
    value = cursors.get(cursor)
    if not value or value['scope'] != list(client.scope) or value['kind'] != kind or value['filters'] != filters:
        raise AuthError('QUERY_EXPIRED', '查询已过期或条件已改变，请刷新列表。')
    return value

def continuation(state):
    key = uuid.uuid4().hex
    cursors.put(key, state)
    return key

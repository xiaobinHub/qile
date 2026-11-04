"""Private plugin records with strict child/plugin scoping and bounded size."""
from __future__ import annotations

import json
import re

from psycopg.types.json import Jsonb
from lele_growth.child_service import require
from .policy import row_dict

MAX_RECORD_BYTES = 64 * 1024


def namespace(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,511}', value) is not None,
            400, '私有记录标识不正确。', 'plugin_invalid_private_key')
    return value


def public(record):
    if record is None:
        return None
    return dict(payload=record['payload'], revision=record['revision'],
                expiresAt=record['expires_at'].isoformat() if record['expires_at'] else None)


def get(cur, current, collection, record_id, *, include_expired=False):
    namespace(collection), namespace(record_id)
    cur.execute('SELECT * FROM lele.plugin_private_records WHERE child_id=%s AND plugin_id=%s AND collection=%s AND record_id=%s',
                (current['child_id'], current['plugin_id'], collection, record_id))
    record = row_dict(cur)
    if not include_expired and record and record['expires_at'] and record['expires_at'] <= cur.execute('SELECT now()').fetchone()[0]:
        return None
    return public(record)


def put(cur, current, collection, record_id, payload, *, expected_revision=None, expires_at=None):
    namespace(collection), namespace(record_id)
    require(isinstance(payload, dict), 400, '私有记录内容必须为对象。', 'plugin_invalid_private_record')
    try:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError, OverflowError):
        raise require(False, 400, '私有记录必须为有效 JSON。', 'plugin_invalid_private_record')
    require(len(encoded.encode()) <= MAX_RECORD_BYTES, 400, '私有记录过大。', 'plugin_private_record_too_large')
    cur.execute('SELECT * FROM lele.plugin_private_records WHERE child_id=%s AND plugin_id=%s AND collection=%s AND record_id=%s FOR UPDATE',
                (current['child_id'], current['plugin_id'], collection, record_id))
    old = row_dict(cur)
    if expected_revision is not None:
        require(type(expected_revision) is int and expected_revision == (old['revision'] if old else 0),
                409, '私有记录已改变。', 'plugin_revision_conflict')
    cur.execute('''INSERT INTO lele.plugin_private_records(child_id,plugin_id,collection,record_id,payload,expires_at)
VALUES(%s,%s,%s,%s,%s,%s)
ON CONFLICT(child_id,plugin_id,collection,record_id) DO UPDATE
SET payload=EXCLUDED.payload,revision=lele.plugin_private_records.revision+1,expires_at=EXCLUDED.expires_at,updated_at=now() RETURNING *''',
                (current['child_id'], current['plugin_id'], collection, record_id, Jsonb(payload), expires_at))
    return public(row_dict(cur))


def delete(cur, current, collection, record_id, *, expected_revision):
    namespace(collection), namespace(record_id)
    cur.execute('SELECT revision FROM lele.plugin_private_records WHERE child_id=%s AND plugin_id=%s AND collection=%s AND record_id=%s FOR UPDATE',
                (current['child_id'], current['plugin_id'], collection, record_id))
    old = row_dict(cur)
    require(type(expected_revision) is int and expected_revision == (old['revision'] if old else 0),
            409, '私有记录已改变。', 'plugin_revision_conflict')
    cur.execute('DELETE FROM lele.plugin_private_records WHERE child_id=%s AND plugin_id=%s AND collection=%s AND record_id=%s',
                (current['child_id'], current['plugin_id'], collection, record_id))
    return {'deleted': old is not None}

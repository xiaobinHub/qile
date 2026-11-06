"""Host-owned Mison associations and collection revision, in the caller's transaction."""
from lele_growth.course_sync import series_id
from lele_growth.plugins import private_store

COLLECTION = 'course-sync-identities'
STATE_COLLECTION = 'course-sync'
STATE_RECORD = 'snapshot'


def snapshot(cur, scope):
    record = private_store.get(cur, scope, STATE_COLLECTION, STATE_RECORD)
    return (record['payload'], record['revision']) if record else ({}, 0)


def load(cur, scope, account_id, contract_id):
    cur.execute("""SELECT payload,revision FROM lele.plugin_private_records
WHERE child_id=%s AND plugin_id=%s AND collection=%s
AND payload->>'accountId'=%s AND payload->>'contractId'=%s""",
        (scope['child_id'], scope['plugin_id'], COLLECTION, str(account_id), str(contract_id)))
    return {row[0]['cid']: {'payload': row[0], 'revision': row[1]} for row in cur.fetchall()}


def save(cur, scope, before, records):
    for cid, payload in records.items():
        old = before.get(cid)
        if old is None or old['payload'] != payload:
            private_store.put(cur, scope, COLLECTION,
                series_id(payload['accountId'], payload['contractId'], cid), payload,
                expected_revision=old['revision'] if old else 0)


def advance(cur, scope, revision, summary):
    private_store.put(cur, scope, STATE_COLLECTION, STATE_RECORD,
        {'needsReview': summary.get('needsReview', 0), 'review': summary.get('review', [])},
        expected_revision=revision)

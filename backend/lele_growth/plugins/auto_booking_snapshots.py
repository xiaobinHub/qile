"""Store automatic booking snapshots one teacher and date at a time."""
from datetime import date, timedelta
import hashlib
import re

from lele_growth.child_service import require
from . import private_store

COLLECTION = 'auto-booking-snapshots'
MAX_DAYS = 60
CLOCK = re.compile(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]')


def snapshot_id(run_id):
    return hashlib.sha256(run_id.encode()).hexdigest()[:32]


def record_prefix(key, snapshot, teacher_id=None):
    prefix = f'{key}:{snapshot}'
    return prefix if teacher_id is None else f'{prefix}:{teacher_id}'


def scope(current):
    return current['child_id'], current['plugin_id'], COLLECTION


def read_records(cur, current, record_ids):
    if not record_ids:
        return {}
    cur.execute('''SELECT record_id,payload FROM lele.plugin_private_records
WHERE child_id=%s AND plugin_id=%s AND collection=%s AND record_id=ANY(%s)''',
                (*scope(current), record_ids))
    return dict(cur.fetchall())


def delete_snapshot(cur, current, key, snapshot):
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get('id'), str):
        return
    prefix = record_prefix(key, snapshot['id'])
    cur.execute('''DELETE FROM lele.plugin_private_records
WHERE child_id=%s AND plugin_id=%s AND collection=%s AND (record_id=%s OR record_id LIKE %s)''',
                (*scope(current), prefix, prefix + ':%'))


def snapshot_dates(base_date, count):
    start = date.fromisoformat(base_date)
    return [(start + timedelta(days=offset)).isoformat() for offset in range(count)]


def day_ids(prefix, base_date, count):
    return [f'{prefix}:{day}' for day in snapshot_dates(base_date, count)]


def validate_stage(payload, teacher_ids):
    teacher_id = payload.get('teacherId')
    base_date = payload.get('baseDate')
    count = payload.get('dayCount')
    days = payload.get('days')
    complete = payload.get('complete')
    unavailable = payload.get('bookingUnavailable')
    require(teacher_id in teacher_ids and type(count) is int and 0 <= count <= MAX_DAYS
            and isinstance(days, list) and len(days) <= count
            and type(complete) is bool and type(unavailable) is bool and (not unavailable or complete and not days),
            400, '排班快照不正确。', 'VALIDATION_ERROR')
    try:
        dates = set(snapshot_dates(base_date, count))
        require(date.fromisoformat(base_date).isoformat() == base_date, 400, '排班日期不正确。', 'VALIDATION_ERROR')
    except (TypeError, ValueError, OverflowError):
        require(False, 400, '排班日期不正确。', 'VALIDATION_ERROR')
    for day in days:
        require(isinstance(day, dict) and set(day) == {'date', 'state', 'slots'}
                and isinstance(day['date'], str) and day['date'] in dates
                and day['state'] in ('ready', 'unopened') and isinstance(day['slots'], list)
                and len(day['slots']) <= 48 and (day['state'] == 'ready' or not day['slots']),
                400, '排班快照不正确。', 'VALIDATION_ERROR')
        dates.remove(day['date'])
        starts = set()
        for slot in day['slots']:
            require(isinstance(slot, dict) and set(slot) == {'start', 'end', 'state'}
                    and all(isinstance(slot[field], str) and CLOCK.fullmatch(slot[field]) for field in ('start', 'end'))
                    and slot['start'] not in starts and slot['state'] in ('available', 'mine', 'occupied', 'unscheduled'),
                    400, '排班快照不正确。', 'VALIDATION_ERROR')
            starts.add(slot['start'])


def stage(cur, current, key, state, payload, checked_at):
    teachers = [teacher['id'] for teacher in state['config']['teachers']]
    validate_stage(payload, teachers)
    run = state['run']
    identifier = snapshot_id(run['id'])
    previous = state.get('snapshot') or {}
    if previous.get('id') == identifier:
        return  # The previous job may have published before saving its checkpoint.
    if run.get('stagedSnapshot') != identifier:
        # Keep the visible snapshot while replacing any abandoned partial round.
        cur.execute('''DELETE FROM lele.plugin_private_records
WHERE child_id=%s AND plugin_id=%s AND collection=%s AND record_id LIKE %s
AND split_part(record_id, ':', 2) <> ALL(%s)''',
                    (*scope(current), key + ':%', [identifier, previous.get('id', '')]))
        run['stagedSnapshot'] = identifier

    teacher_id = payload['teacherId']
    prefix = record_prefix(key, identifier, teacher_id)
    for day in payload['days']:
        private_store.put(cur, current, COLLECTION, f'{prefix}:{day["date"]}', day)
    if not payload['complete']:
        return

    metadata = {field: payload[field] for field in ('baseDate', 'dayCount', 'bookingUnavailable')}
    if not metadata['bookingUnavailable']:
        ids = day_ids(prefix, metadata['baseDate'], metadata['dayCount'])
        require(len(read_records(cur, current, ids)) == len(ids), 409, '排班快照尚未采集完整。', 'SNAPSHOT_CHANGED')
    private_store.put(cur, current, COLLECTION, prefix, metadata)
    if teacher_id != teachers[-1]:
        return

    prefixes = [record_prefix(key, identifier, teacher) for teacher in teachers]
    records = read_records(cur, current, prefixes)
    require(len(records) == len(prefixes), 409, '排班快照尚未采集完整。', 'SNAPSHOT_CHANGED')
    state['snapshot'] = {
        'id': identifier, 'checkedAt': checked_at, 'configRevision': state['configRevision'],
        'format': 'daily', 'teachers': [
            {'id': teacher, **records[prefix]} for teacher, prefix in zip(teachers, prefixes)
        ],
    }
    delete_snapshot(cur, current, key, previous)


def schedule(cur, current, key, snapshot, teacher, day=None):
    prefix = record_prefix(key, snapshot['id'], teacher['id'])
    ids = day_ids(prefix, teacher['baseDate'], teacher['dayCount'])
    if day is not None:
        requested = f'{prefix}:{day}'
        ids = [requested] if requested in ids else []
    if teacher['bookingUnavailable']:
        return [{'date': item.rsplit(':', 1)[-1], 'state': 'unopened', 'slots': []} for item in ids]
    records = read_records(cur, current, ids)
    require(len(records) == len(ids), 409, '排班快照已改变。', 'SNAPSHOT_CHANGED')
    return [records[item] for item in ids]

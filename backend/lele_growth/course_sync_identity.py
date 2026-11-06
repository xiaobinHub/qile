"""Resolve Mison course/slot identities without changing calendar source IDs.

CID is the task/booking generation. A slot is scoped by child (the caller),
account, contract, teacher ID, date, start and end; courseware ID completes the
course key. Names are only a way to recover an unambiguous known teacher ID.
"""
from __future__ import annotations

import copy
import hashlib
import json
from collections import defaultdict

from lele_growth.course_sync import (
    CourseSyncConflict, STATUS_RANK, _title, is_mison, normalize_courses, reconcile_current, refusal,
)

FIELDS = ('teacherId', 'teacherName', 'coursewareId', 'coursewareTitle', 'bid', 'bookingId')
POSITION = ('date', 'startTime', 'endTime')


def _name(value):
    return value.strip().casefold() if isinstance(value, str) else ''


def _id(value):
    return str(value) if type(value) in (str, int) and 0 < len(str(value)) <= 64 else None


def _slot(row):
    values = (row.get('teacherId'), *(row.get(key) for key in POSITION))
    return values if all(values) else None


def _course(row):
    slot = _slot(row)
    return (*slot, row['coursewareId']) if slot and row.get('coursewareId') else None


def _scoped(row, account_id, contract_id):
    return row.get('accountId') == str(account_id) and row.get('contractId') == str(contract_id)


def _parse(courses, account_id, contract_id):
    if not isinstance(courses, list):
        raise CourseSyncConflict('invalid-courses', '课程名单不正确。')
    result, skipped = [], 0
    for raw in courses:
        if not isinstance(raw, dict):
            skipped += 1
            continue
        cid = _id(raw.get('cid'))
        missing = not cid and raw.get('status') == 'cancelled'
        # Reuse the task reconciler's strict calendar/time validation.
        normalized, invalid = normalize_courses([{**raw, 'cid': cid or ('unresolved' if missing else None)}], account_id, contract_id)
        if invalid or (missing and not (raw.get('teacherId') or raw.get('teacherName'))):
            skipped += 1
            continue
        row = {key: normalized[0][key] for key in ('status', *POSITION)}
        row.update(cid=cid)
        for key in FIELDS:
            value = raw.get(key)
            row[key] = value.strip()[:300] if key.endswith(('Name', 'Title')) and isinstance(value, str) else _id(value)
        result.append(row)
    return result, skipped


def _association(row, old, account_id, contract_id):
    value = {**old, 'accountId': str(account_id), 'contractId': str(contract_id), 'cid': row['cid'],
             **{key: row[key] for key in POSITION}}
    for key in FIELDS:
        if row.get(key):
            value[key] = row[key]
        else:
            value.setdefault(key, None)
    # A renamed/changed teacher or course must not inherit another identity.
    for label, identity in (('teacherName', 'teacherId'), ('coursewareTitle', 'coursewareId')):
        if row.get(label) and _name(row[label]) != _name(old.get(label)) and not row.get(identity):
            value[identity] = None
    value.setdefault('cancelled', False)
    return value


def _same_evidence(row, candidate):
    """Both auxiliary fields must agree; neither field is treated as a CID."""
    return all(row.get(key) and row[key] == candidate.get(key) for key in ('bid', 'bookingId'))


def _cancel_event(row):
    return hashlib.sha256(json.dumps([_course(row), row.get('bid'), row.get('bookingId')],
                                    separators=(',', ':')).encode()).hexdigest()


def _legacy_tasks(data, account_id, contract_id):
    tasks = {}
    for task in [*data['series'], *(item.get('snapshot') or {} for item in data['completions'])]:
        if is_mison(task) and _scoped(task['source'], account_id, contract_id):
            tasks.setdefault(task['source']['cid'], {**task, 'date': task.get('startDate') or task.get('date')})
    return tasks


def resolve_courses(data, courses, *, account_id, contract_id, associations):
    """Return explicit-CID lessons, a new association map and bounded review info."""
    parsed, skipped = _parse(courses, account_id, contract_id)
    records = copy.deepcopy(associations)
    local = _legacy_tasks(data, account_id, contract_id)
    names = defaultdict(set)
    for row in [*(item for item in records.values() if _scoped(item, account_id, contract_id)), *parsed]:
        if row.get('teacherId') and _name(row.get('teacherName')):
            names[_name(row['teacherName'])].add(row['teacherId'])
    for row in parsed:
        matches = names[_name(row.get('teacherName'))]
        if not row['teacherId'] and len(matches) == 1:
            row['teacherId'] = next(iter(matches))

    live, cancellations = {}, []
    for row in parsed:
        if row['status'] == 'cancelled':
            cancellations.append(row)
            continue
        current = live.get(row['cid'])
        if current and current['status'] == row['status'] and current != row:
            raise CourseSyncConflict('conflict', '同一课时返回了互相冲突的课程信息，本次没有同步。')
        if current is None or STATUS_RANK[row['status']] > STATUS_RANK[current['status']]:
            live[row['cid']] = row
    for cid, row in live.items():
        if not records.get(cid, {}).get('cancelled'):
            records[cid] = _association(row, records.get(cid, {}), account_id, contract_id)

    # Older tasks have no identity metadata. Backfill only one complete course
    # composite with exactly the existing date, full slot and displayed title.
    legacy_candidates = defaultdict(list)
    for row in parsed:
        if _course(row):
            legacy_candidates[(*(row[field] for field in POSITION),
                               _title(row.get('teacherName'), row.get('coursewareTitle')))].append(row)
    for cid, task in local.items():
        if cid in records:
            continue
        candidates = legacy_candidates[(*(task.get(field) for field in POSITION), task.get('title'))]
        if len({_course(row) for row in candidates}) == 1:
            candidate = {**candidates[0], 'cid': cid}
            if len({(row.get('bid'), row.get('bookingId')) for row in candidates}) > 1:
                candidate.update(bid=None, bookingId=None)
            records[cid] = _association(candidate, {}, account_id, contract_id)

    scoped = {cid: row for cid, row in records.items() if _scoped(row, account_id, contract_id)}
    issues = {}
    by_slot, by_course = defaultdict(set), defaultdict(set)

    def index(cid, row):
        if _slot(row):
            by_slot[_slot(row)].add(cid)
        if _course(row):
            by_course[_course(row)].add(cid)

    for cid, row in scoped.items():
        index(cid, row)

    def review(reason, row):
        info = {'reason': reason, 'date': row.get('date'), 'startTime': row.get('startTime'),
                'endTime': row.get('endTime'), 'teacherName': row.get('teacherName'),
                'coursewareId': row.get('coursewareId')}
        issues.setdefault(tuple(info.values()), info)

    def cancel(cid, row, reason='cancelled'):
        old = scoped.get(cid, {})
        value = _association({**row, 'cid': cid}, old, account_id, contract_id)
        value.update(cancelled=True, cancelReason=reason)
        if reason == 'cancelled':
            value['cancellation'] = {key: row.get(key) for key in ('bid', 'bookingId')}
        records[cid] = scoped[cid] = value
        index(cid, value)

    groups = defaultdict(list)
    for cid, row in live.items():
        if _slot(row) and not scoped[cid].get('cancelled'):
            groups[_slot(row)].append(row)
    blocked = set()
    for rows in groups.values():
        if len(rows) > 1:
            blocked.update(row['cid'] for row in rows)
            review('multiple-live-courses', rows[0])
    for cid, row in live.items():
        if cid in blocked or scoped[cid].get('cancelled') or not _course(row):
            continue
        for old_cid in list(by_slot[_slot(row)]):
            old = scoped[old_cid]
            if (old_cid not in live and not old.get('cancelled') and _course(old)
                    and _slot(old) == _slot(row) and old['coursewareId'] != row['coursewareId']):
                cancel(old_cid, old, 'replaced')

    for row in cancellations:
        if row['cid']:
            cancel(row['cid'], row)
            continue
        key = _course(row)
        if not key:
            possible = any(all(task.get(field) == row.get(field) for field in POSITION)
                           and task.get('title') == _title(row.get('teacherName'), row.get('coursewareTitle'))
                           for task in local.values())
            possible |= any(all(old.get(field) == row.get(field) for field in POSITION)
                            and _name(old.get('teacherName')) == _name(row.get('teacherName'))
                            and not old.get('cancelled') for old in scoped.values())
            if possible:
                review('teacher-or-courseware-unresolved', row)
            continue
        candidates = [(cid, scoped[cid]) for cid in sorted(by_course[key]) if _course(scoped[cid]) == key]
        event = _cancel_event(row)
        for cid, old in candidates:
            if cid in live and not _same_evidence(row, old):
                history = set(old.get('priorCancellations', []))
                history.add(event)
                # Bounded per-record state. On overflow, fail closed for an
                # ambiguous future CID-less cancellation instead of forgetting.
                if len(history) > 128:
                    old['cancellationHistoryOverflow'] = True
                else:
                    old['priorCancellations'] = sorted(history)

        def predates(old):
            return event in old.get('priorCancellations', []) or old.get('cancellationHistoryOverflow') is True

        exact = [(cid, old) for cid, old in candidates if _same_evidence(row, old)
                 or _same_evidence(row, old.get('cancellation') or {})]
        if len(exact) == 1:
            cid, old = exact[0]
            if cid not in live:
                if predates(old) and not old.get('cancelled'):
                    review('cancellation-predates-booking', row)
                else:
                    cancel(cid, row)
            continue
        inactive = [(cid, old) for cid, old in candidates if cid not in live]
        # An old cancellation cannot be reassigned to a later generation when
        # its auxiliary evidence is unavailable. Absence alone is not a cancel.
        pending = [(cid, old) for cid, old in inactive if not old.get('cancelled')]
        historical = any(old.get('cancelled') for _, old in candidates)
        conflicting_generation = len(inactive) == 1 and any(
            row.get(field) and inactive[0][1].get(field) and row[field] != inactive[0][1][field]
            for field in ('bid', 'bookingId'))
        if (len(inactive) == 1 and not historical and not exact and not predates(inactive[0][1])
                and not conflicting_generation):
            cancel(inactive[0][0], row)
        elif pending or len(exact) > 1:
            review('booking-generation-unresolved', row)

    resolved = [row for cid, row in live.items() if cid not in blocked and not scoped[cid].get('cancelled')]
    resolved.extend({**row, 'status': 'cancelled'} for row in scoped.values() if row.get('cancelled'))
    return resolved, records, {'skipped': skipped, 'needsReview': len(issues), 'review': list(issues.values())[:50]}


def reconcile_identified(data, courses, *, associations=None, **options):
    associations = associations or {}
    if refusal(archived=options.get('archived', False), list_complete=options.get('list_complete', True),
               contract_error=options.get('contract_error')):
        updated, summary = reconcile_current(data, [], **options)
        return updated, summary, copy.deepcopy(associations)
    resolved, records, info = resolve_courses(data, courses, associations=associations,
        account_id=options['account_id'], contract_id=options['contract_id'])
    updated, summary = reconcile_current(data, resolved, **options)
    summary['skipped'] += info.pop('skipped')
    summary.update(info)
    return updated, summary, records

"""Bounded automatic booking reads, matching and existing write orchestration."""
from copy import deepcopy
from datetime import datetime, timedelta
import hashlib
import json
import re
import time
import uuid

from .auth import AuthError, bridge
from . import bark, course_sync, drafts, operations, read_api
from .upstream import Client

STOP_ERRORS = {'RECONNECT_REQUIRED', 'CONTRACT_SELECTION_REQUIRED', 'NO_ACTIVE_CONTRACT',
               'COURSEWARE_REQUIRED', 'COURSEWARE_UNAVAILABLE', 'QUERY_TOO_LARGE', 'OWNER_REQUIRED', 'BINDING_CHANGED', 'AUTO_BOOKING_ACCOUNT_BUSY'}
TEACHER_UNAVAILABLE_MESSAGE = '该老师由于个人原因暂时无法预约'


def host(context, action, payload=None):
    return bridge(context, 'autoBooking.' + action, payload or {})


class AutoBookingClient(Client):
    """Fresh host admission for every automatic Mison request, including receipts."""
    def __init__(self, context, run_id):
        super().__init__(context)
        self.run_id = run_id

    def admit(self):
        if not host(self.context, 'read-guard', {'runId': self.run_id})['allowed']:
            raise AuthError('AUTO_BOOKING_SLEEPING', '当前不在检查时间内。')

    def call(self, endpoint, body):
        self.admit()
        return super().call(endpoint, body)

    def mutate(self, endpoint, body):
        try:
            self.admit()
            host(self.context, 'guard', {'runId': self.run_id})
        except AuthError as error:
            raise operations.NotDispatched(error.code, str(error), error.operation_id,
                                           retry_after=error.retry_after) from error
        # Transport errors must retain their uncertainty; only local admission
        # above can prove that the write was never sent.
        return super().mutate(endpoint, body)


def get(context):
    return host(context, 'get')


def save(context, body):
    fields = {'teachers', 'dates', 'weekdaySlots', 'minNoticeHours', 'dailyLessons', 'rebookCancelled', 'checkInterval', 'sleep', 'notifications'}
    body = {**body, 'checkInterval': body.get('checkInterval', {'minMinutes': 4, 'maxMinutes': 6})}
    current = get(context)['config']
    body.setdefault('notifications', current['notifications'])
    if set(body) != fields | {'operationId', 'bindingRevision', 'expectedRevision'}:
        read_api.invalid('自动约课设置不正确。')
    if not current['canManage']:
        raise AuthError('OWNER_REQUIRED', '只有儿童负责人可以修改自动约课。')
    new_ids = {teacher.get('id') for teacher in body['teachers'] if isinstance(teacher, dict)} - {teacher['id'] for teacher in current['teachers']} if isinstance(body.get('teachers'), list) else set()
    if new_ids:
        client = Client(context)
        favorites = {read_api.identifier(row.get('tid')): row for row in read_api.rows(client.call('getTeacherCollect', {'userid': client.userid}).get('data'))}
        if new_ids - set(favorites):
            read_api.invalid('只能从收藏列表添加目标老师。')
    return host(context, 'save', {key: body[key] for key in ('operationId', 'bindingRevision', 'expectedRevision')} | {'config': {key: body[key] for key in fields}})


def control(context, action, body):
    expected = {'operationId', 'bindingRevision'} | ({'expectedRevision'} if action == 'start' else set())
    if set(body) != expected:
        read_api.invalid()
    if not get(context)['config']['canManage']:
        raise AuthError('OWNER_REQUIRED', '只有儿童负责人可以启停自动约课。')
    if action == 'start':
        read_api.contracts(Client(context))
    return host(context, action, body)


def exclusion(config, day, slot, booked):
    if slot['state'] != 'available':
        return slot.get('reason') or '该时段不可约。'
    if day not in config['dates']:
        return '未选择该日期。'
    if booked and config.get('dailyLessons', 1) == 1:
        return '当天已有课程。'
    weekday = str(datetime.fromisoformat(day).isoweekday())
    if slot['start'] not in config['weekdaySlots'][weekday]:
        return '未选择该时段。'
    starts = datetime.fromisoformat(day + 'T' + slot['start']).replace(tzinfo=read_api.TZ)
    if starts <= read_api.now() or starts < read_api.now() + timedelta(hours=config['minNoticeHours']):
        return '距离开课不足设置的提前量。'
    return None


def matches_identity(first, second):
    if first.get('bid') and second.get('bid') and first['bid'] != second['bid']:
        return False
    if first.get('cid') and second.get('cid'):
        return first['cid'] == second['cid'] and not (first.get('bookingId') and second.get('bookingId') and first['bookingId'] != second['bookingId'])
    return bool(first.get('bookingId') and first.get('bookingId') == second.get('bookingId'))


def evidence(row):
    return {key: row.get(key) for key in ('cid', 'date', 'startTime', 'teacherId', 'teacherName', 'coursewareId', 'bookingId', 'bid')}


def initial_cursor(state):
    return {'phase': 'inventory', 'status': 0, 'page': 1, 'rows': 0, 'occupied': [], 'observed': {},
            'cancelled': [], 'dateIndex': 0, 'teacherIndex': 0, 'holds': deepcopy(state.get('holds', {})),
            'outcomes': []}


def remember(cursor, kind, **details):
    cursor.setdefault('outcomes', []).append({'kind': kind, **details})


def course_label(day, teacher, time):
    month, date = day[5:7].lstrip('0'), day[8:10].lstrip('0')
    return f'{teacher} {month}/{date} {time}'


def round_message(cursor, fallback):
    outcomes = cursor.get('outcomes', [])
    priority = ('booked', 'uncertain', 'rejected', 'occupied')
    selected = next((item for kind in priority for item in outcomes if item['kind'] == kind), None)
    if selected is None:
        return fallback
    others = sum(item['kind'] == 'none' for item in outcomes)
    suffix = f'；其余 {others} 个目标日没有符合条件' if selected['kind'] == 'booked' and others else ''
    if selected['kind'] == 'booked':
        return f"已预约 {course_label(selected['date'], selected['teacherName'], selected['time'])}{suffix}。"
    if selected['kind'] == 'uncertain':
        return f"已提交 {course_label(selected['date'], selected['teacherName'], selected['time'])}，结果待核对。"
    if selected['kind'] == 'rejected':
        return f"{course_label(selected['date'], selected['teacherName'], selected['time'])} 未约成：{selected['message']}"
    existing = selected.get('existing') or {}
    return f"{selected['date'][5:7].lstrip('0')}/{selected['date'][8:10].lstrip('0')} 已有 {existing.get('teacherName') or '课程'} {existing.get('time') or ''}，未再提交预约。".replace('  ，', '，')


def checkpoint(context, state, cursor):
    return save_progress(context, 'checkpoint', {'runId': state['run']['id'], 'cursor': cursor})


def save_progress(context, action, payload):
    try:
        return host(context, action, payload)
    except AuthError as error:
        if error.code in ('UPSTREAM_UNAVAILABLE', 'plugin_bridge_failed'):
            # The write may already be committed. A scheduler retry can reload
            # its progress, whereas finish would discard it.
            raise RuntimeError('自动约课进度暂未确认。') from error
        raise


def finish(context, state, cursor, message=None, *, stop=False, retry_after=None):
    if message is None:
        viable = any(datetime.fromisoformat(day + 'T' + start).replace(tzinfo=read_api.TZ) > read_api.now() + timedelta(hours=state['config']['minNoticeHours'])
                     for day in state['config']['dates'] for start in state['config']['weekdaySlots'][str(datetime.fromisoformat(day).isoweekday())])
        none = sum(item['kind'] == 'none' for item in cursor.get('outcomes', []))
        message = f'{none} 个目标日都没有符合条件的时段。' if none else '目标日期已结束。' if not viable else '本轮没有可提交的预约。'
        stop = stop or not viable
    message = round_message(cursor, message)
    payload = {'runId': state['run']['id'], 'fulfilledDates': cursor.get('occupied', []),
               'holds': cursor.get('holds', {}), 'message': message, 'stop': stop, 'retryAfter': retry_after}
    if cursor.get('consolidated'):
        payload['completedLessonCounts'] = completed_lesson_counts(state, cursor)
    return host(context, 'finish', payload)


def inventory(client, state, cursor):
    contract = read_api.contracts(client)
    statuses = ('upcoming', 'completed', 'cancelled')
    for _ in range(2):
        status = statuses[cursor['status']]
        source, complete = course_sync._page(client, contract, status, cursor['page'])
        cursor['rows'] += len(source)
        if cursor['rows'] > 5000 or cursor['page'] > 100:
            raise AuthError('QUERY_TOO_LARGE', '课程记录过多，未提交自动预约。')
        for raw in source:
            row = course_sync._lesson(raw, status)
            if status == 'cancelled':
                relevant = [item for values in cursor['holds'].values() for item in values]
                relevant += [item.get('evidence', {}) for item in state['ledger'].values()]
                if row['date'] in state['config']['dates'] or any(matches_identity(item, row) for item in relevant):
                    cursor['cancelled'].append(evidence(row))
            else:
                if row['date'] is None:
                    read_api.schema('已有课程缺少日期，未提交自动预约。')
                read_api.date_arg(row['date'])
            if status != 'cancelled' and row['date'] in state['config']['dates']:
                if row['invalid']:
                    raise AuthError('UPSTREAM_SCHEMA_CHANGED', '课程记录不完整，本轮未自动预约。')
                cursor['occupied'] = sorted(set(cursor['occupied'] + [row['date']]))
                observed = cursor['observed'].setdefault(row['date'], [])
                if not any(matches_identity(item, row) for item in observed):
                    observed.append(evidence(row))
        if complete:
            cursor['status'] += 1
            cursor['page'] = 1
        else:
            cursor['page'] += 1
        if cursor['status'] == len(statuses):
            cursor['phase'] = 'snapshot'
            break
        if client.deadline - time.monotonic() < 15:
            break
    return cursor


def consolidate(context, state, cursor):
    cancelled = cursor['cancelled']
    holds = {}
    for day, values in cursor['holds'].items():
        if day < read_api.now().date().isoformat():
            continue
        kept = [item for item in values if not any(matches_identity(item, row) for row in cancelled)]
        if kept:
            holds[day] = kept
    for day, values in cursor['observed'].items():
        retained = holds.setdefault(day, [])
        for value in values:
            previous = next((item for item in retained if matches_identity(item, value)), None)
            if previous is None:
                retained.append(value)
            else:
                previous.update({key: field for key, field in value.items() if field is not None})
    for day, item in state['ledger'].items():
        if day not in state['config']['dates'] or day < read_api.now().date().isoformat():
            continue
        found = [row for row in cursor['observed'].get(day, [])
                 if row['startTime'] == item['time'] and row['coursewareId'] == item.get('coursewareId')
                 and (row['teacherId'] == item['teacher']['id'] if row['teacherId'] else row['teacherName'] == item['teacher']['name'])]
        if len(found) == 1:
            host(context, 'observe', {'date': day, 'operationId': item['operationId'], 'evidence': found[0]})
        elif item.get('evidence') and any(matches_identity(item['evidence'], row)
                and cancellation_key(row) not in item.get('cancelBaseline', []) for row in cancelled):
            if state['config'].get('rebookCancelled', True):
                host(context, 'release', {'date': day, 'operationId': item['operationId']})
            else:
                cursor['occupied'] = sorted(set(cursor['occupied'] + [day]))
        elif not item.get('evidence') and item.get('cancelBaseline') is not None and len([row for row in cancelled
                 if row['date'] == day and row['startTime'] == item['time'] and row['coursewareId'] == item.get('coursewareId')
                 and (row['teacherId'] == item['teacher']['id'] if row['teacherId'] else row['teacherName'] == item['teacher']['name'])
                 and (row['cid'] or row['bookingId']) and cancellation_key(row) not in item['cancelBaseline']]) == 1:
            if state['config'].get('rebookCancelled', True):
                host(context, 'release', {'date': day, 'operationId': item['operationId']})
            else:
                cursor['occupied'] = sorted(set(cursor['occupied'] + [day]))
        else:
            cursor['occupied'] = sorted(set(cursor['occupied'] + [day]))
    cursor['holds'] = holds
    cursor['occupied'] = sorted(set(cursor['occupied']) | set(holds))
    cursor['consolidated'] = True


def reconcile(context, client, state):
    pending = state['pending']
    try:
        operation = operations.raw_get(client, pending['operationId'])
    except AuthError as error:
        if error.code != 'OPERATION_NOT_FOUND':
            raise
        return host(context, 'outcome', {'operationId': pending['operationId'], 'outcome': 'failed', 'message': '操作未发送，下一轮重新检查。'})
    if operation['state'] == 'cancelled':
        return host(context, 'outcome', {'operationId': pending['operationId'], 'outcome': 'cancelled'})
    if operation['state'] == 'prepared':
        operation = operations.finish(client, operation, 'failed', '中断发生在发送前，未提交预约。')
        result = operations.output(client, operation)
    else:
        result = operations.get(client, pending['operationId'])
    outcome = result['state'] if result['state'] in ('succeeded', 'failed') else 'uncertain'
    return record_outcome(context, {'operationId': pending['operationId'], 'outcome': outcome,
                                   'bookingKeys': (result.get('result') or {}).get('bookingKeys', []),
                                   'evidence': next(iter((result.get('result') or {}).get('bookingEvidence', [])), None)})


def cancellation_key(row):
    return hashlib.sha256(json.dumps(evidence(row), sort_keys=True).encode()).hexdigest()


def matches_booking_slot(row, teacher, start, courseware):
    return row['startTime'] == start and row['coursewareId'] == courseware and (
        row['teacherId'] == teacher['id'] if row['teacherId'] else row['teacherName'] == teacher['name']
    )


def completed_lesson_counts(state, cursor):
    target_dates = set(state['config']['dates'])
    holds = cursor['holds']
    counts = {day: len(lessons) for day, lessons in holds.items() if day in target_dates}
    for day, booking in state['ledger'].items():
        if day not in target_dates:
            continue
        # Receipts can precede the next complete course list. Count their
        # remaining lessons once, alongside the distinct lessons in that list.
        active = holds.get(day, [])
        baseline = set(booking.get('cancelBaseline', []))
        teacher = booking['teacher']
        tracked = booking.get('evidence') or {}
        cancelled = [row for row in cursor['cancelled']
                     if (row['date'] == day or matches_identity(tracked, row)) and cancellation_key(row) not in baseline]
        for start, courseware in zip(booking.get('times', [booking['time']]),
                                     booking.get('coursewareIds', [booking['coursewareId']])):
            known = tracked if start == tracked.get('startTime', booking['time']) else None
            if any(matches_booking_slot(row, teacher, start, courseware)
                   or known and matches_identity(known, row) for row in active):
                continue
            if known:
                removed = any(matches_identity(known, row) for row in cancelled)
            else:
                matches = [row for row in cancelled if row['date'] == day and (row['cid'] or row['bookingId'])
                           and matches_booking_slot(row, teacher, start, courseware)]
                removed = len(matches) == 1
            if not removed:
                counts[day] = counts.get(day, 0) + 1
    return counts


def consecutive(starts, count):
    priorities = {int(slot[:2]) * 60 + int(slot[3:]): rank for rank, slot in enumerate(starts)}
    groups = (range(start, start + count * 30, 30) for start in priorities)
    eligible = (group for group in groups if all(slot in priorities for slot in group))
    # Compare the best-ranked member of each group first, then the remaining ranks.
    best = min(eligible, key=lambda group: sorted(priorities[slot] for slot in group), default=None)
    return [starts[priorities[slot]] for slot in best] if best is not None else None


def book_candidate(context, client, state, cursor):
    candidate = cursor['candidate']
    times = candidate.get('times', [candidate['time']])
    if candidate['date'] in state['ledger'] and len(times) == 1:
        cursor['occupied'] = sorted(set(cursor['occupied'] + [candidate['date']]))
        cursor.pop('candidate')
        cursor.update(phase='matching', dateIndex=cursor['dateIndex'] + 1, teacherIndex=0)
        return checkpoint(context, state, cursor)
    host(context, 'guard', {'runId': state['run']['id']})
    day, teacher = candidate['date'], candidate['teacher']
    operation_id = str(uuid.uuid4())
    draft = drafts.create(client, {'operationId': str(uuid.uuid4()), 'bindingRevision': client.session['bindingRevision'],
                                  'teacherId': teacher['id'], 'date': day, 'slotStarts': times})
    if not draft['valid']:
        raise AuthError('COURSEWARE_REQUIRED', '美森未提供可用推荐课件，任务已停止。')
    pending = {'operationId': operation_id, 'date': day, 'teacher': {'id': teacher['id'], 'name': teacher['name']},
               'time': times[0], 'times': times,
               'coursewareId': draft['lessons'][0]['courseware']['id'],
               'coursewareIds': [lesson['courseware']['id'] for lesson in draft['lessons']],
               'cancelBaseline': [cancellation_key(row) for row in cursor['cancelled'] if row['date'] == day]}
    host(context, 'prepare', {'runId': state['run']['id'], 'pending': pending})
    try:
        result = operations.book(client, {'operationId': operation_id, 'bindingRevision': client.session['bindingRevision'],
                                          'draftId': draft['id'], 'expectedRevision': draft['revision']})
    except AuthError as error:
        if error.code in ('SLOT_UNAVAILABLE', 'COURSEWARE_REQUIRED', 'COURSEWARE_UNAVAILABLE'):
            host(context, 'outcome', {'operationId': operation_id, 'outcome': 'failed', 'message': str(error)})
        raise
    outcome = result['state'] if result['state'] in ('succeeded', 'failed') else 'uncertain'
    record_outcome(context, {'operationId': operation_id, 'outcome': outcome,
                            'bookingKeys': (result.get('result') or {}).get('bookingKeys', []),
                            'evidence': next(iter((result.get('result') or {}).get('bookingEvidence', [])), None),
                            'message': result.get('message', '预约未完成。')})
    cursor.pop('candidate')
    cursor['phase'] = 'matching'
    label = {'date': day, 'teacherName': teacher['name'], 'time': '、'.join(times)}
    if outcome == 'succeeded':
        remember(cursor, 'booked', **label)
        cursor['occupied'] = sorted(set(cursor['occupied'] + [day]))
        cursor['dateIndex'] += 1
        cursor['teacherIndex'] = 0
    elif outcome == 'failed':
        cursor.setdefault('rejected', []).append([day, teacher['id'], *times])
        message = result.get('message', '预约未完成。')
        remember(cursor, 'rejected', message=message, **label)
        if (result.get('result') or {}).get('errorCode') == 'UPSTREAM_RATE_LIMITED':
            return finish(context, state, cursor, message, retry_after=result['result'].get('retryAfter'))
        if re.search(r'课时不足|余额不足|额度不足|课时.*用完|合[约同].*(?:失效|到期)', message):
            return finish(context, state, cursor, message, stop=True)
    else:
        remember(cursor, 'uncertain', **label)
        return finish(context, state, cursor)
    return checkpoint(context, state, cursor)


def teacher_unavailable(error):
    return error.code == 'UPSTREAM_REJECTED' and str(error).strip().rstrip('。！!') == TEACHER_UNAVAILABLE_MESSAGE


def teacher_info(client, teacher_id, day):
    return client.call('onevoneGetTeacherInfo', {'tid': int(teacher_id), 'userid': client.userid, 'ddate': day}).get('data')


def get_snapshot(context, body):
    result = host(context, 'snapshot', body)
    teacher = result['teacher']
    if 'bookingUnavailable' not in teacher and all(day['state'] == 'unopened' for day in teacher['days']):
        try:
            teacher_info(Client(context), teacher['id'], read_api.now().date().isoformat())
        except AuthError as error:
            if teacher_unavailable(error):
                return {**result, 'teacher': {**teacher, 'bookingUnavailable': True}}
    return result


def capture(context, client, state, cursor):
    config = state['config']
    snapshot_id = hashlib.sha256(state['run']['id'].encode()).hexdigest()[:32]
    snapshot = cursor.setdefault('capture', {'baseDate': read_api.now().date().isoformat(),
                                             'teacherIndex': 0, 'dayIndex': 0, 'window': None})
    published = (state.get('snapshot') or {}).get('id') == snapshot_id
    while not published and snapshot['teacherIndex'] < len(config['teachers']):
        teacher = config['teachers'][snapshot['teacherIndex']]
        window_days = snapshot.get('window')
        booking_unavailable = False
        if window_days is None:
            host(context, 'guard', {'runId': state['run']['id']})
            try:
                window_days = client.call('onevoneGetDaysAvailable', {'tid': int(teacher['id']), 'userid': client.userid}).get('data')
            except AuthError as error:
                if not teacher_unavailable(error):
                    raise
                window_days, booking_unavailable = [], True
            if not isinstance(window_days, list) or len(window_days) > 60 or not all(type(value) is int and value in (0, 1) for value in window_days):
                read_api.schema()
            snapshot['window'] = window_days
            snapshot['dayIndex'] = 0
        base_date = datetime.fromisoformat(snapshot['baseDate']).date()
        days = []
        try:
            if not booking_unavailable and not any(window_days) and not snapshot['dayIndex']:
                if client.deadline - time.monotonic() < 12:
                    return checkpoint(context, state, cursor)
                host(context, 'guard', {'runId': state['run']['id']})
                teacher_info(client, teacher['id'], snapshot['baseDate'])
            while snapshot['dayIndex'] < len(window_days):
                offset = snapshot['dayIndex']
                day = (base_date + timedelta(days=offset)).isoformat()
                if window_days[offset] == 0:
                    days.append({'date': day, 'state': 'unopened', 'slots': []})
                else:
                    if client.deadline - time.monotonic() < 12:
                        if days:
                            return stage_teacher(context, state, cursor, snapshot_id, teacher, days, complete=False)
                        return checkpoint(context, state, cursor)
                    host(context, 'guard', {'runId': state['run']['id']})
                    days.append({'date': day, 'state': 'ready', 'slots': visible_slots(day_slots(client, teacher['id'], day))})
                snapshot['dayIndex'] += 1
        except AuthError as error:
            if not teacher_unavailable(error):
                raise
            booking_unavailable = True
            days = []
        result = stage_teacher(context, state, cursor, snapshot_id, teacher, days, complete=True,
                               booking_unavailable=booking_unavailable)
        if cursor['phase'] == 'matching':
            return result
    mark_snapshot_ready(state, cursor, snapshot_id)
    return checkpoint(context, state, cursor)


def mark_snapshot_ready(state, cursor, snapshot_id):
    cursor['snapshot'] = {'id': snapshot_id, 'configRevision': state['configRevision']}
    cursor.pop('capture')
    cursor['phase'] = 'matching'


def stage_teacher(context, state, cursor, snapshot_id, teacher, days, *, complete, booking_unavailable=False):
    snapshot = cursor['capture']
    payload = {
        'runId': state['run']['id'], 'teacherId': teacher['id'], 'baseDate': snapshot['baseDate'],
        'dayCount': len(snapshot['window']), 'days': days, 'complete': complete,
        'bookingUnavailable': booking_unavailable,
    }
    if complete:
        snapshot.update(teacherIndex=snapshot['teacherIndex'] + 1, dayIndex=0, window=None)
        if snapshot['teacherIndex'] == len(state['config']['teachers']):
            mark_snapshot_ready(state, cursor, snapshot_id)
    return save_progress(context, 'snapshot-stage', {
        **payload, 'cursor': cursor, 'yieldAfter': not complete or cursor['phase'] == 'matching',
    })


def visible_slots(slots):
    return [slot for slot in slots if slot['state'] != 'unscheduled']



def day_slots(client, teacher_id, day):
    value = teacher_info(client, teacher_id, day)
    if not isinstance(value, dict) or str(value.get('tid')) != str(teacher_id):
        read_api.schema()
    duration = read_api.teacher(client, value)['lessonMinutes']
    if not duration:
        read_api.schema('美森未返回有效课时时长。')
    slots = []
    for item in read_api.rows(value.get('all_date')):
        start, occupied = item.get('dtime'), item.get('is_dated')
        if not isinstance(start, str) or not re.fullmatch(r'(?:[01][0-9]|2[0-3]):[03]0', start) or type(occupied) is not int:
            read_api.schema()
        stamp = datetime.fromisoformat(day + 'T' + start).replace(tzinfo=read_api.TZ)
        state = 'unscheduled' if occupied < 0 else 'available' if occupied == 0 else 'mine' if occupied == client.userid else 'occupied'
        if state == 'available' and stamp <= read_api.now():
            state = 'unscheduled'
        slots.append({'start': start, 'end': (stamp + timedelta(minutes=duration)).strftime('%H:%M'), 'state': state})
    if len({slot['start'] for slot in slots}) != len(slots):
        read_api.schema()
    return sorted(slots, key=lambda slot: slot['start'])


def matching(context, client, state, cursor):
    config = state['config']
    dates = sorted(config['dates'])
    if not cursor.get('consolidated'):
        consolidate(context, state, cursor)
    pointer = cursor.get('snapshot')
    if not pointer or pointer.get('configRevision') != state['configRevision']:
        raise AuthError('AUTO_BOOKING_CHANGED', '排班快照不属于当前配置。')
    while cursor['dateIndex'] < len(dates):
        day = dates[cursor['dateIndex']]
        slots = config['weekdaySlots'][str(datetime.fromisoformat(day).isoweekday())]
        if day in cursor['occupied'] or not slots or day < read_api.now().date().isoformat():
            if day in cursor['occupied']:
                existing = next(iter(cursor.get('holds', {}).get(day, [])), {})
                remember(cursor, 'occupied', date=day, existing={'teacherName': existing.get('teacherName'), 'time': existing.get('startTime')})
            cursor['dateIndex'] += 1
            cursor['teacherIndex'] = 0
            continue
        if day in state.get('closedDates', []):
            cursor['dateIndex'] += 1
            cursor['teacherIndex'] = 0
            continue
        if cursor['teacherIndex'] >= len(config['teachers']):
            cursor['dateIndex'] += 1
            cursor['teacherIndex'] = 0
            continue
        teacher = config['teachers'][cursor['teacherIndex']]
        source = host(context, 'snapshot-day', {
            'runId': state['run']['id'], 'snapshotId': pointer['id'],
            'teacherId': teacher['id'], 'date': day,
        })
        if source and source['state'] == 'ready':
            mine = [slot['start'] for slot in source['slots'] if slot['state'] == 'mine']
            if len(mine) >= config.get('dailyLessons', 1):
                remember(cursor, 'occupied', date=day, existing={'teacherName': teacher['name'], 'time': mine[0]})
                cursor['occupied'] = sorted(set(cursor['occupied'] + [day]))
                continue
            available = {slot['start']: {**slot, 'reason': None if slot['state'] == 'available' else '该时段不可约。'} for slot in source['slots']}
            count = config.get('dailyLessons', 1)
            eligible = [start for start in slots if available.get(start)
                        and exclusion(config, day, available[start], False) is None]
            group = consecutive(eligible, count)
            if group and [day, teacher['id'], *group] not in cursor.get('rejected', []):
                cursor.update(phase='booking', candidate={
                    'date': day, 'teacher': {'id': teacher['id'], 'name': teacher['name']},
                    'time': group[0], 'times': group,
                })
                return checkpoint(context, state, cursor)
        cursor['teacherIndex'] += 1
        if cursor['teacherIndex'] >= len(config['teachers']):
            remember(cursor, 'none', date=day)
        if client.deadline - time.monotonic() < 8:
            return checkpoint(context, state, cursor)
    return finish(context, state, cursor)


def _run(context):
    state = host(context, 'begin', {'cursorVersion': 2})
    if state.get('skip'):
        return {'state': 'skipped'}
    cursor = deepcopy(state['run']['cursor']) or initial_cursor(state)
    try:
        client = AutoBookingClient(context, state['run']['id'])
        if state['pending']:
            pending = state['pending']
            updated = reconcile(context, client, state)
            if updated['pending']:
                remember(cursor, 'uncertain', date=pending['date'], teacherName=pending['teacher']['name'], time=pending['time'])
                return finish(context, state, cursor)
            if not updated.get('run'):
                return updated
            return checkpoint(context, state, cursor) if state['enabled'] else finish(context, state, cursor, '已核对上次预约，任务已停止。')
        if cursor['phase'] == 'inventory':
            inventory(client, state, cursor)
            return checkpoint(context, state, cursor)
        if cursor['phase'] == 'snapshot':
            return capture(context, client, state, cursor)
        if cursor['phase'] == 'booking':
            return book_candidate(context, client, state, cursor)
        return matching(context, client, state, cursor)
    except AuthError as error:
        if error.code == 'AUTO_BOOKING_SLEEPING':
            # Existing write/round guards can reject before a client request.
            # Commit the same deferral unless another admission already did so.
            try:
                host(context, 'read-guard', {'runId': state['run']['id']})
            except AuthError:
                pass
        if error.code in ('AUTO_BOOKING_CHANGED', 'AUTO_BOOKING_SLEEPING', 'plugin_job_revoked'):
            return {'state': 'changed'}
        return finish(context, state, cursor, str(error), stop=error.code in STOP_ERRORS, retry_after=error.retry_after)


def flush_notifications(context):
    try:
        for _ in range(3):
            notification = host(context, 'notification-claim')
            if not notification:
                break
            try:
                outcome = bark.push(notification)
            except Exception:
                outcome = 'uncertain'
            host(context, 'notification-finish', {'operationId': notification['operationId'],
                                                'claimId': notification['claimId'], 'state': outcome})
    except AuthError:
        # Delivery admission/receipt errors must not replay a successful booking.
        pass


def record_outcome(context, payload):
    state = host(context, 'outcome', payload)
    if payload['outcome'] == 'succeeded':
        flush_notifications(context)
    return state


def run(context):
    flush_notifications(context)
    result = _run(context)
    if 'checks' not in result:
        return result
    return {'state': 'continuing' if result.get('run') else 'waiting' if result['enabled'] else 'stopped',
            'phase': result['phase'], 'checks': result['checks'], 'totalBooked': result['totalBooked']}

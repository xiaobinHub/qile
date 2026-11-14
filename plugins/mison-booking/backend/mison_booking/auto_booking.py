"""Bounded automatic booking reads, matching and existing write orchestration."""
from copy import deepcopy
from datetime import datetime, timedelta
import hashlib
import json
import re
import time
import uuid

from .auth import AuthError, bridge
from . import course_sync, drafts, operations, read_api
from .upstream import Client

STOP_ERRORS = {'RECONNECT_REQUIRED', 'CONTRACT_SELECTION_REQUIRED', 'NO_ACTIVE_CONTRACT',
               'COURSEWARE_REQUIRED', 'COURSEWARE_UNAVAILABLE', 'QUERY_TOO_LARGE', 'OWNER_REQUIRED', 'BINDING_CHANGED', 'AUTO_BOOKING_ACCOUNT_BUSY'}


def host(context, action, payload=None):
    return bridge(context, 'autoBooking.' + action, payload or {})


def get(context):
    return host(context, 'get')


def save(context, body):
    fields = {'teachers', 'dates', 'weekdaySlots', 'minNoticeHours', 'dailyLessons', 'rebookCancelled', 'sleep'}
    if set(body) != fields | {'operationId', 'bindingRevision', 'expectedRevision'}:
        read_api.invalid('自动约课设置不正确。')
    current = get(context)['config']
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


def schedules(context, query):
    if set(query) - {'teacherId', 'from', 'to', 'cursor'}:
        read_api.invalid()
    config = get(context)['config']
    teacher_id = read_api.identifier(query.get('teacherId'))
    if teacher_id not in {teacher['id'] for teacher in config['teachers']}:
        read_api.invalid('请选择目标老师。')
    start = read_api.date_arg(query.get('from'))
    end = read_api.date_arg(query.get('to'))
    count = (datetime.fromisoformat(end) - datetime.fromisoformat(start)).days + 1
    if not 1 <= count <= 31:
        read_api.invalid('一次最多查看31天排班。')
    scope = hashlib.sha256(json.dumps([context['childId'], config['bindingRevision'], teacher_id, start, end]).encode()).hexdigest()[:16]
    try:
        cursor = query.get('cursor', '')
        offset = int(cursor.split(':')[1]) if cursor else 0
        if cursor and cursor.split(':')[0] != scope:
            raise ValueError()
    except (ValueError, IndexError, AttributeError):
        read_api.invalid('排班游标已失效，请刷新。')
    if not 0 <= offset < count:
        read_api.invalid()
    client = Client(context)
    state = get(context)['status']
    occupancy_key = ('auto-booking-occupancy', *client.scope)
    fresh_occupancy = read_api.memo.get(occupancy_key)
    if fresh_occupancy is None:
        fresh_occupancy = sorted({read_api.booking(client, read_api.contracts(client), status, row)['startsAt'][:10]
                                  for status in ('upcoming', 'completed') for row in operations.live_rows(client, status, max_pages=100)})
        read_api.memo.put(occupancy_key, fresh_occupancy, 15)
    occupied = set(state['fulfilledDates']) | set(fresh_occupancy)
    days = []
    for index in range(offset, min(count, offset + 2)):
        day = (datetime.fromisoformat(start) + timedelta(days=index)).date().isoformat()
        target = day in config['dates']
        result = {'date': day, 'target': target, 'booked': day in occupied, 'slots': [], 'state': 'ready'}
        try:
            available = window(client, teacher_id)
            if day not in available:
                result.update(state='unopened', message='该日期尚未开放排班。')
            else:
                schedule = read_api.schedule(client, teacher_id, {'date': day})
                mine = any(slot['state'] == 'mine' for slot in schedule['slots'])
                result['booked'] = result['booked'] or mine
                for slot in schedule['slots']:
                    reason = exclusion(config, day, slot, result['booked'])
                    result['slots'].append({**slot, 'matches': reason is None, 'reason': reason})
        except AuthError as error:
            if error.code == 'RECONNECT_REQUIRED':
                raise
            result.update(state='error', message=str(error))
        days.append(result)
    next_offset = offset + len(days)
    return {'teacherId': teacher_id, 'days': days, 'nextCursor': scope + ':' + str(next_offset) if next_offset < count else None,
            'updatedAt': read_api.now().isoformat(timespec='seconds')}


def window(client, teacher_id):
    key = ('days', *client.scope, teacher_id, read_api.now().date().isoformat())
    days = read_api.memo.get(key)
    if days is None:
        days = client.call('onevoneGetDaysAvailable', {'tid': int(teacher_id), 'userid': client.userid}).get('data')
        if not isinstance(days, list) or len(days) > 60 or not all(type(value) is int and value in (0, 1) for value in days):
            read_api.schema()
        read_api.memo.put(key, days, 30)
    return {(read_api.now().date() + timedelta(days=index)).isoformat() for index in range(len(days))}


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
            'cancelled': [], 'dateIndex': 0, 'teacherIndex': 0, 'holds': deepcopy(state.get('holds', {}))}


def checkpoint(context, state, cursor):
    return host(context, 'checkpoint', {'runId': state['run']['id'], 'cursor': cursor})


def finish(context, state, cursor, message='本轮检查完成。', *, stop=False, retry_after=None):
    return host(context, 'finish', {'runId': state['run']['id'], 'fulfilledDates': cursor.get('occupied', []),
                                  'holds': cursor.get('holds', {}), 'message': message, 'stop': stop, 'retryAfter': retry_after})


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
            cursor['phase'] = 'matching'
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
    if operation['state'] == 'prepared':
        operation = operations.finish(client, operation, 'failed', '中断发生在发送前，未提交预约。')
        result = operations.output(client, operation)
    else:
        result = operations.get(client, pending['operationId'])
    outcome = result['state'] if result['state'] in ('succeeded', 'failed') else 'uncertain'
    return host(context, 'outcome', {'operationId': pending['operationId'], 'outcome': outcome,
                                   'bookingKeys': (result.get('result') or {}).get('bookingKeys', []),
                                   'evidence': next(iter((result.get('result') or {}).get('bookingEvidence', [])), None)})


def cancellation_key(row):
    return hashlib.sha256(json.dumps(evidence(row), sort_keys=True).encode()).hexdigest()


def consecutive(starts, count):
    minutes = lambda value: int(value[:2]) * 60 + int(value[3:])
    for index in range(len(starts) - count + 1):
        group = starts[index:index + count]
        if all(minutes(second) - minutes(first) == 30 for first, second in zip(group, group[1:])):
            return group
    return None


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
        if error.code in ('AUTO_BOOKING_CHANGED', 'AUTO_BOOKING_SLEEPING', 'SLOT_UNAVAILABLE', 'COURSEWARE_REQUIRED', 'COURSEWARE_UNAVAILABLE'):
            host(context, 'outcome', {'operationId': operation_id, 'outcome': 'failed', 'message': str(error)})
        raise
    outcome = result['state'] if result['state'] in ('succeeded', 'failed') else 'uncertain'
    host(context, 'outcome', {'operationId': operation_id, 'outcome': outcome,
                            'bookingKeys': (result.get('result') or {}).get('bookingKeys', []),
                            'evidence': next(iter((result.get('result') or {}).get('bookingEvidence', [])), None),
                            'message': result.get('message', '预约未完成。')})
    cursor.pop('candidate')
    cursor['phase'] = 'matching'
    if outcome == 'succeeded':
        cursor['occupied'] = sorted(set(cursor['occupied'] + [day]))
        cursor['dateIndex'] += 1
        cursor['teacherIndex'] = 0
    elif outcome == 'failed':
        cursor.setdefault('rejected', []).append([day, teacher['id'], *times])
        message = result.get('message', '')
        if (result.get('result') or {}).get('errorCode') == 'UPSTREAM_RATE_LIMITED':
            return finish(context, state, cursor, message, retry_after=result['result'].get('retryAfter'))
        if re.search(r'课时不足|余额不足|额度不足|课时.*用完|合[约同].*(?:失效|到期)', message):
            return finish(context, state, cursor, message, stop=True)
    else:
        return finish(context, state, cursor, '预约结果待核对，未继续提交其他课程。')
    return checkpoint(context, state, cursor)


def matching(context, client, state, cursor):
    config = state['config']
    dates = sorted(config['dates'])
    if not cursor.get('consolidated'):
        consolidate(context, state, cursor)
    while cursor['dateIndex'] < len(dates):
        day = dates[cursor['dateIndex']]
        slots = config['weekdaySlots'][str(datetime.fromisoformat(day).isoweekday())]
        if day in cursor['occupied'] or not slots or day < read_api.now().date().isoformat():
            cursor['dateIndex'] += 1
            cursor['teacherIndex'] = 0
            continue
        if cursor['teacherIndex'] >= len(config['teachers']):
            cursor['dateIndex'] += 1
            cursor['teacherIndex'] = 0
            continue
        host(context, 'guard', {'runId': state['run']['id']})
        teacher = config['teachers'][cursor['teacherIndex']]
        if day in window(client, teacher['id']):
            schedule = read_api.schedule(client, teacher['id'], {'date': day})
            mine = [slot['start'] for slot in schedule['slots'] if slot['state'] == 'mine']
            if len(mine) >= config.get('dailyLessons', 1):
                cursor['occupied'] = sorted(set(cursor['occupied'] + [day]))
                continue
            available = {slot['start']: slot for slot in schedule['slots']}
            count = config.get('dailyLessons', 1)
            eligible = [start for start in slots if available.get(start)
                        and exclusion(config, day, available[start], False) is None]
            group = consecutive(eligible, count)
            if group and [day, teacher['id'], *group] not in cursor.get('rejected', []):
                cursor.update(phase='booking', candidate={'date': day, 'teacher': teacher, 'time': group[0], 'times': group})
                return checkpoint(context, state, cursor)
        cursor['teacherIndex'] += 1
        if client.deadline - time.monotonic() < 23:
            return checkpoint(context, state, cursor)
    viable = any(datetime.fromisoformat(day + 'T' + start).replace(tzinfo=read_api.TZ) > read_api.now() + timedelta(hours=config['minNoticeHours'])
                 for day in dates for start in config['weekdaySlots'][str(datetime.fromisoformat(day).isoweekday())])
    return finish(context, state, cursor, '本轮检查完成，等待下次检查。' if viable else '目标日期已结束。', stop=not viable)


def _run(context):
    state = host(context, 'begin')
    if state.get('skip'):
        return {'state': 'skipped'}
    cursor = deepcopy(state['run']['cursor']) or initial_cursor(state)
    try:
        client = Client(context)
        if state['pending']:
            updated = reconcile(context, client, state)
            if updated['pending']:
                return finish(context, state, cursor, '预约结果待核对，未重复提交。')
            return checkpoint(context, state, cursor) if state['enabled'] else finish(context, state, cursor, '任务已停止，已完成预约结果核对。')
        if cursor['phase'] == 'inventory':
            inventory(client, state, cursor)
            return checkpoint(context, state, cursor)
        if cursor['phase'] == 'booking':
            return book_candidate(context, client, state, cursor)
        return matching(context, client, state, cursor)
    except AuthError as error:
        if error.code in ('AUTO_BOOKING_CHANGED', 'AUTO_BOOKING_SLEEPING', 'plugin_job_revoked'):
            return {'state': 'changed'}
        return finish(context, state, cursor, str(error), stop=error.code in STOP_ERRORS, retry_after=error.retry_after)


def run(context):
    result = _run(context)
    if 'checks' not in result:
        return result
    return {'state': 'continuing' if result.get('run') else 'waiting' if result['enabled'] else 'stopped',
            'phase': result['phase'], 'checks': result['checks'], 'totalBooked': result['totalBooked']}

"""Host-owned automatic booking state and write admission."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import secrets
import uuid

from lele_growth.child_service import require
from . import private_store
from .policy import row_dict

COLLECTION = 'auto-booking'
TASK = 'auto-booking'
TZ = timezone(timedelta(hours=8))


def now():
    return datetime.now(TZ)


def stamp(moment=None):
    return (moment or now()).isoformat(timespec='seconds')


def defaults():
    return {'teachers': [], 'dates': [], 'weekdaySlots': {str(day): [] for day in range(1, 8)},
            'minNoticeHours': 25, 'dailyLessons': 1, 'rebookCancelled': True,
            'sleep': {'enabled': True, 'start': '23:00', 'end': '08:00'}}
def normalize_config(value):
    if isinstance(value, dict) and 'dailyLessons' not in value and 'rebookCancelled' not in value:
        value = {**value, 'dailyLessons': 1, 'rebookCancelled': True}
    return value


def quiet_until(config, moment=None):
    moment = (moment or now()).astimezone(TZ)
    sleep = config['sleep']
    if not sleep['enabled']:
        return None
    start, end = sleep['start'], sleep['end']
    clock = moment.strftime('%H:%M')
    inside = start <= clock < end if start < end else clock >= start or clock < end
    if not inside:
        return None
    hour, minute = map(int, end.split(':'))
    resume = moment.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return resume + timedelta(days=1) if resume <= moment else resume


def validate_config(value):
    value = normalize_config(value)
    require(isinstance(value, dict) and set(value) == set(defaults()), 400, '自动约课配置字段不正确。', 'VALIDATION_ERROR')
    teachers, dates, weekdays, notice, daily, rebook, sleep = (value[key] for key in defaults())
    require(isinstance(teachers, list) and len(teachers) <= 20, 400, '最多选择20位老师。', 'VALIDATION_ERROR')
    identifiers = []
    for teacher in teachers:
        require(isinstance(teacher, dict) and set(teacher) == {'id', 'name', 'avatarUrl'}, 400, '老师配置不正确。', 'VALIDATION_ERROR')
        require(isinstance(teacher['id'], str) and re.fullmatch(r'[1-9][0-9]{0,17}', teacher['id']) is not None
                and isinstance(teacher['name'], str) and 0 < len(teacher['name']) <= 200
                and (teacher['avatarUrl'] is None or isinstance(teacher['avatarUrl'], str) and len(teacher['avatarUrl']) <= 2000),
                400, '老师配置不正确。', 'VALIDATION_ERROR')
        identifiers.append(teacher['id'])
    require(len(set(identifiers)) == len(identifiers), 400, '老师不能重复。', 'VALIDATION_ERROR')
    require(isinstance(dates, list) and len(dates) <= 120 and all(isinstance(day, str) for day in dates)
            and len(set(dates)) == len(dates), 400, '最多选择120个不重复的日期。', 'VALIDATION_ERROR')
    for day in dates:
        try:
            require(datetime.strptime(day, '%Y-%m-%d').strftime('%Y-%m-%d') == day, 400, '日期不正确。', 'VALIDATION_ERROR')
        except ValueError:
            require(False, 400, '日期不正确。', 'VALIDATION_ERROR')
    require(isinstance(weekdays, dict) and set(weekdays) == {str(day) for day in range(1, 8)}, 400, '每周时段不正确。', 'VALIDATION_ERROR')
    for slots in weekdays.values():
        require(isinstance(slots, list) and len(slots) <= 48
                and all(isinstance(slot, str) and re.fullmatch(r'(?:[01][0-9]|2[0-3]):[03]0', slot) for slot in slots)
                and len(set(slots)) == len(slots), 400, '请选择有效且不重复的半小时时段。', 'VALIDATION_ERROR')
    require(type(notice) is int and 0 <= notice <= 8760, 400, '提前小时数应为0至8760的整数。', 'VALIDATION_ERROR')
    require(type(daily) is int and 1 <= daily <= 4, 400, '每天预约节数应为1至4的整数。', 'VALIDATION_ERROR')
    require(type(rebook) is bool, 400, '取消后补约设置不正确。', 'VALIDATION_ERROR')
    require(isinstance(sleep, dict) and set(sleep) == {'enabled', 'start', 'end'} and type(sleep['enabled']) is bool
            and all(isinstance(sleep[key], str) and re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]', sleep[key]) for key in ('start', 'end'))
            and sleep['start'] != sleep['end'], 400, '休眠起止时间必须有效且不同。', 'VALIDATION_ERROR')
    return {**deepcopy(value), 'dates': sorted(dates)}


def viable(config, moment=None):
    moment = moment or now()
    return [day for day in config['dates'] if any(
        datetime.fromisoformat(day + 'T' + slot).replace(tzinfo=TZ) > moment
        and datetime.fromisoformat(day + 'T' + slot).replace(tzinfo=TZ) >= moment + timedelta(hours=config['minNoticeHours'])
        for slot in config['weekdaySlots'][str(datetime.fromisoformat(day).isoweekday())])]


def owner(cur, current, actor):
    cur.execute('''SELECT 1 FROM lele.children c JOIN lele.memberships m ON m.child_id=c.id
JOIN lele.users u ON u.id=m.user_id WHERE c.id=%s AND c.owner_id=%s AND m.user_id=%s AND u.status='active' ''',
                (current['child_id'], actor, actor))
    return cur.fetchone() is not None


def load(cur, current):
    saved = private_store.get(cur, current, 'login-session', 'current')
    binding = saved['payload'] if saved else {}
    account = str(binding.get('userid') or 'unbound')
    key = hashlib.sha256(account.encode()).hexdigest()
    cur.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (current['plugin_id'] + ':auto:' + key,))
    record = private_store.get(cur, current, COLLECTION, key)
    state = record['payload'] if record else {
        'account': account, 'bindingRevision': binding.get('bindingRevision', 0), 'config': defaults(), 'configRevision': 0,
        'enabled': False, 'ownerId': None, 'epoch': str(uuid.uuid4()), 'step': 0, 'nextCheckAt': None,
        'lastCheckAt': None, 'checks': 0, 'totalBooked': 0, 'fulfilledDates': [], 'phase': 'stopped',
        'message': '请先配置约课条件。', 'run': None, 'pending': None, 'ledger': {}, 'receipts': {}, 'latestEvent': None}
    state['config'] = normalize_config(state.get('config', defaults()))
    return key, record, state, binding


def save(cur, current, key, record, state):
    state['ledger'] = {day: item for day, item in state['ledger'].items() if day >= now().date().isoformat()}
    return private_store.put(cur, current, COLLECTION, key, state, expected_revision=record['revision'] if record else 0)


def event(cur, current, key, state, kind, message, **details):
    item = {'id': str(uuid.uuid4()), 'at': stamp(), 'kind': kind, 'message': message, **details}
    state['latestEvent'] = item
    record_id = key + ':' + now().isoformat(timespec='microseconds') + ':' + item['id']
    private_store.put(cur, current, 'auto-booking-log', record_id, item, expected_revision=0, expires_at=now() + timedelta(days=30))
    return item


def public_config(state, can_manage):
    return {**deepcopy(state['config']), 'revision': state['configRevision'],
            'bindingRevision': state['bindingRevision'], 'canManage': can_manage}


def public_status(state, can_manage):
    sleeping = state['enabled'] and quiet_until(state['config'])
    return {'state': 'stopped' if state['pending'] and state['phase'] == 'reconciling' else 'sleeping' if sleeping else 'running' if state['enabled'] else 'stopped',
            'enabled': state['enabled'], 'phase': state['phase'], 'message': state['message'],
            'checks': state['checks'], 'totalBooked': state['totalBooked'],
            'nextCheckAt': stamp(sleeping) if sleeping else state['nextCheckAt'], 'lastCheckAt': state['lastCheckAt'],
            'fulfilledDates': [day for day in state['fulfilledDates'] if day in state['config']['dates']],
            'targetDates': state['config']['dates'], 'latestEvent': state['latestEvent'], 'canManage': can_manage}


def assert_binding(state, binding, payload):
    require(type(payload.get('bindingRevision')) is int and payload['bindingRevision'] == binding.get('bindingRevision'),
            409, '账号状态已改变，请刷新。', 'BINDING_CHANGED')


def authorized(cur, current, state, binding, *, writing=False):
    require(owner(cur, current, state.get('ownerId')), 403, '开启人的权限已失效，请负责人重新开启。', 'OWNER_REQUIRED')
    require(state['bindingRevision'] == binding.get('bindingRevision') and state['account'] == str(binding.get('userid')),
            409, '账号状态已改变，请重新开启任务。', 'BINDING_CHANGED')
    if writing:
        require(state['enabled'] and state['run'] and state['run']['configRevision'] == state['configRevision'],
                409, '任务已停止或约课条件已改变。', 'AUTO_BOOKING_CHANGED')
        require(state.get('generation') == current['generation'], 409, '插件已重新启用，请重新开启任务。', 'AUTO_BOOKING_CHANGED')
        require(not other_active(cur, current, state['account']), 409, '该账号已有其他自动约课任务。', 'AUTO_BOOKING_ACCOUNT_BUSY')
        require(quiet_until(state['config']) is None, 409, '当前处于休眠时间。', 'AUTO_BOOKING_SLEEPING')


def other_active(cur, current, account):
    key = hashlib.sha256(account.encode()).hexdigest()
    cur.execute("""SELECT records.child_id FROM lele.plugin_private_records records
JOIN lele.child_plugins installed ON installed.child_id=records.child_id AND installed.plugin_id=records.plugin_id
JOIN lele.children child ON child.id=records.child_id
WHERE records.plugin_id=%s AND records.collection=%s AND records.record_id=%s
AND records.child_id<>%s AND records.payload->>'enabled'='true'
AND (records.payload->>'generation')::bigint=installed.generation
AND installed.installed AND installed.enabled AND NOT child.archived AND child.deleted_at IS NULL LIMIT 1""",
                (current['plugin_id'], COLLECTION, key, current['child_id']))
    return cur.fetchone() is not None


def due(cur, current, moment):
    key, record, state, binding = load(cur, current)
    if not record or not (state['enabled'] or state['pending']):
        return None
    changed = (state['bindingRevision'] != binding.get('bindingRevision') or not owner(cur, current, state['ownerId'])
               or state.get('generation') != current['generation'])
    if changed and state['pending'] and binding.get('credentialId'):
        cur.execute('SELECT owner_id FROM lele.children WHERE id=%s', (current['child_id'],))
        responsible = cur.fetchone()[0]
        if owner(cur, current, str(responsible)):
            state.update(ownerId=str(responsible), bindingRevision=binding['bindingRevision'], generation=current['generation'], enabled=False,
                         run=None, phase='reconciling', step=state['step'] + 1, nextCheckAt=stamp(moment),
                         message='账号或权限已改变，仅核对已发送的预约。')
            record = save(cur, current, key, record, state)
            changed = False
    if changed or state.get('generation') != current['generation'] or state['enabled'] and other_active(cur, current, state['account']):
        state.update(enabled=False, nextCheckAt=None, run=None, phase='stopped', message='账号或开启人权限已改变，请重新开启。')
        save(cur, current, key, record, state)
        return None
    resume = quiet_until(state['config'], moment) if state['enabled'] else None
    if resume and not state['pending']:
        if state['nextCheckAt'] != stamp(resume):
            state.update(nextCheckAt=stamp(resume), phase='sleeping', run=None)
            save(cur, current, key, record, state)
        return None
    if state['nextCheckAt'] is None:
        return None
    due_at = datetime.fromisoformat(state['nextCheckAt'])
    if due_at > moment:
        return None
    occurrence_key = state['epoch'] + ':' + str(state['step'])
    cur.execute("""SELECT status FROM lele.plugin_jobs WHERE child_id=%s AND plugin_id=%s AND task_id='auto-booking' AND occurrence_key=%s""",
                (current['child_id'], current['plugin_id'], occurrence_key))
    previous = cur.fetchone()
    if previous and previous[0] in ('failed', 'uncertain', 'cancelled', 'skipped'):
        state.update(step=state['step'] + 1, run=None, phase='reconciling' if state['pending'] else 'waiting',
                     nextCheckAt=stamp(moment + timedelta(seconds=30 if state['pending'] else 240 + secrets.randbelow(121))),
                     checks=state['checks'] + 1, lastCheckAt=stamp(moment), message='上轮检查中断，等待恢复。')
        event(cur, current, key, state, 'error', state['message'])
        save(cur, current, key, record, state)
        return None
    return occurrence_key, due_at


def guard(cur, current, context, payload):
    key, record, state, binding = load(cur, current)
    authorized(cur, current, state, binding, writing=True)
    require(state['run']['jobId'] == context.get('jobId'), 409, '检查轮次已被接管。', 'AUTO_BOOKING_CHANGED')
    require(payload.get('runId', state['run']['id']) == state['run']['id'], 409, '检查轮次已改变。', 'AUTO_BOOKING_CHANGED')
    return key, record, state, binding


def handle(cur, current, context, action, payload):
    key, record, state, binding = load(cur, current)
    job = context.get('actorId') is None and bool(context.get('jobId'))
    can_manage = not job and owner(cur, current, context.get('actorId'))
    if action == 'autoBooking.get':
        if not job:
            state['bindingRevision'] = binding.get('bindingRevision', 0)
        return {'ok': True, 'data': deepcopy(state) if job else {'config': public_config(state, can_manage), 'status': public_status(state, can_manage)}}
    if action == 'autoBooking.logs':
        cursor = payload.get('cursor')
        require(cursor is None or cursor == '' or isinstance(cursor, str) and cursor.startswith(key + ':') and len(cursor) <= 160,
                400, '日志游标不正确。', 'VALIDATION_ERROR')
        cur.execute('''SELECT record_id,payload FROM lele.plugin_private_records
WHERE child_id=%s AND plugin_id=%s AND collection='auto-booking-log' AND record_id LIKE %s
AND expires_at>%s AND (%s::text IS NULL OR record_id<%s) ORDER BY record_id DESC LIMIT 31''',
                    (current['child_id'], current['plugin_id'], key + ':%', now(), cursor or None, cursor or None))
        rows = cur.fetchall()
        return {'ok': True, 'data': {'items': [row[1] for row in rows[:30]], 'nextCursor': rows[29][0] if len(rows) > 30 else None}}
    if action in ('autoBooking.save', 'autoBooking.start', 'autoBooking.stop'):
        require(can_manage, 403, '只有儿童负责人可以配置和启停自动约课。', 'OWNER_REQUIRED')
        assert_binding(state, binding, payload)
        try:
            operation_id = str(uuid.UUID(payload.get('operationId')))
        except (TypeError, ValueError, AttributeError):
            require(False, 400, '操作标识不正确。', 'VALIDATION_ERROR')
        digest = hashlib.sha256(json.dumps({'action': action, 'body': payload}, sort_keys=True).encode()).hexdigest()
        previous = state['receipts'].get(operation_id)
        if previous:
            require(previous == digest, 409, '操作标识已用于其他请求。', 'OPERATION_CONFLICT')
            return {'ok': True, 'data': public_config(state, can_manage) if action.endswith('save') else public_status(state, can_manage)}
        if action != 'autoBooking.stop':
            require(type(payload.get('expectedRevision')) is int and payload['expectedRevision'] == state['configRevision'],
                    409, '约课条件已在其他页面修改，请重新加载。', 'REVISION_CONFLICT')
        if action == 'autoBooking.save':
            state['config'] = validate_config(payload['config'])
            state['bindingRevision'] = binding.get('bindingRevision', 0)
            state['configRevision'] += 1
            state['run'] = None
            state['step'] += 1
            if state['enabled']:
                state['nextCheckAt'] = stamp(quiet_until(state['config']) or now())
                if not state['config']['teachers'] or not viable(state['config']):
                    state.update(enabled=False, phase='stopped', message='约课条件不完整或目标日期已结束，任务已停止。',
                                 nextCheckAt=stamp() if state['pending'] else None)
            event(cur, current, key, state, 'config', '已保存自动约课条件。')
        elif action == 'autoBooking.start':
            require(binding.get('credentialId') and state['account'] != 'unbound', 409, '请先连接美森账号。', 'RECONNECT_REQUIRED')
            require(state['config']['teachers'] and viable(state['config']), 400, '请选择老师、未来日期和对应星期的时段。', 'VALIDATION_ERROR')
            require(not state['pending'], 409, '存在待核对预约，请先核对运行记录。', 'RESULT_UNCERTAIN')
            require(not other_active(cur, current, state['account']), 409, '该美森账号已在另一个儿童开启自动约课。', 'AUTO_BOOKING_ACCOUNT_BUSY')
            if not state['enabled']:
                state.update(enabled=True, ownerId=context['actorId'], bindingRevision=binding['bindingRevision'],
                             generation=current['generation'],
                             epoch=str(uuid.uuid4()), step=0, run=None, phase='waiting', message='等待检查。',
                             nextCheckAt=stamp(quiet_until(state['config']) or now()))
                event(cur, current, key, state, 'started', '已开启自动约课。')
        else:
            state.update(enabled=False, phase='stopped', message='任务已停止。',
                         nextCheckAt=stamp() if state['pending'] else None, run=None)
            state['step'] += 1
            event(cur, current, key, state, 'stopped', '已停止任务；已发送的预约会继续核对。')
        state['receipts'] = dict(list(state['receipts'].items())[-29:] + [(operation_id, digest)])
        save(cur, current, key, record, state)
        return {'ok': True, 'data': public_config(state, can_manage) if action.endswith('save') else public_status(state, can_manage)}
    require(job, 403, '此动作仅允许受限后台任务使用。', 'plugin_capability_denied')
    authorized(cur, current, state, binding)
    if action == 'autoBooking.begin':
        cur.execute('SELECT occurrence_key FROM lele.plugin_jobs WHERE id=%s', (context['jobId'],))
        require(cur.fetchone()[0] == state['epoch'] + ':' + str(state['step']), 409, '任务计划已改变。', 'AUTO_BOOKING_CHANGED')
        if not state['enabled'] and not state['pending']:
            return {'ok': True, 'data': {'skip': True}}
        if state['enabled'] and quiet_until(state['config']) and not state['pending']:
            return {'ok': True, 'data': {'skip': True}}
        if state['run'] and state['run']['configRevision'] != state['configRevision']:
            state['run'] = None
        if state['run'] and state['run'].get('jobId') != context['jobId']:
            cur.execute("SELECT 1 FROM lele.plugin_jobs WHERE id=%s AND status='running' AND lease_until>now() AND NOT cancel_requested", (state['run'].get('jobId'),))
            require(cur.fetchone() is None, 409, '另一轮检查仍在运行。', 'AUTO_BOOKING_CHANGED')
        if not state['run']:
            state['run'] = {'id': str(uuid.uuid4()), 'configRevision': state['configRevision'], 'cursor': {}, 'startedAt': stamp()}
        state['run']['jobId'] = context['jobId']
        state['phase'] = 'reconciling' if state['pending'] else 'checking'
        save(cur, current, key, record, state)
        return {'ok': True, 'data': deepcopy(state)}
    if action == 'autoBooking.guard':
        guard(cur, current, context, payload)
        return {'ok': True, 'data': {'ok': True}}
    if action == 'autoBooking.prepare':
        key, record, state, binding = guard(cur, current, context, payload)
        require(not state['pending'], 409, '已有预约待核对。', 'RESULT_UNCERTAIN')
        pending = payload['pending']
        times = pending.get('times') if isinstance(pending.get('times'), list) else [pending.get('time')]
        weekday = str(datetime.fromisoformat(pending['date']).isoweekday())
        require(pending['date'] in state['config']['dates']
                and pending['teacher']['id'] in [teacher['id'] for teacher in state['config']['teachers']]
                and times and len(times) == state['config'].get('dailyLessons', 1)
                and all(time in state['config']['weekdaySlots'][weekday] for time in times),
                409, '候选课程不再符合配置。', 'AUTO_BOOKING_CHANGED')
        starts = datetime.fromisoformat(pending['date'] + 'T' + times[0]).replace(tzinfo=TZ)
        require(starts > now() and starts >= now() + timedelta(hours=state['config']['minNoticeHours']),
                409, '课程提前量不足。', 'AUTO_BOOKING_CHANGED')
        state.update(pending={**deepcopy(pending), 'configRevision': state['configRevision'], 'runId': state['run']['id']}, phase='booking')
    elif action == 'autoBooking.checkpoint':
        require(state['run'] and state['run']['id'] == payload.get('runId') and state['run']['jobId'] == context['jobId'],
                409, '检查轮次已改变。', 'AUTO_BOOKING_CHANGED')
        state['run']['cursor'] = payload['cursor']
        state['step'] += 1
        state['nextCheckAt'] = stamp(now() + timedelta(seconds=1))
    elif action == 'autoBooking.finish':
        require(state['run'] and state['run']['id'] == payload.get('runId') and state['run']['jobId'] == context['jobId'],
                409, '检查轮次已改变。', 'AUTO_BOOKING_CHANGED')
        state.update(checks=state['checks'] + 1, lastCheckAt=stamp(), run=None)
        state['step'] += 1
        state['fulfilledDates'] = sorted(set(payload.get('fulfilledDates', [])))
        state['holds'] = payload.get('holds', state.get('holds', {}))
        message = payload.get('message', '本轮检查完成。')[:300]
        if payload.get('stop'):
            state.update(enabled=False, phase='stopped', message=message)
        else:
            state.update(phase='waiting' if state['enabled'] else 'stopped', message=message)
        state['nextCheckAt'] = stamp(now() + timedelta(seconds=240 + secrets.randbelow(121))) if state['enabled'] else None
        if state['enabled'] and type(payload.get('retryAfter')) is int:
            state['nextCheckAt'] = stamp(now() + timedelta(seconds=max(360, min(86400, payload['retryAfter']))))
        if state['pending']:
            state.update(phase='reconciling', message='预约结果待核对，期间不会发送新预约。', nextCheckAt=stamp(now() + timedelta(seconds=30)))
        event(cur, current, key, state, 'error' if payload.get('stop') else 'checked', message)
    elif action == 'autoBooking.outcome':
        pending = state['pending']
        require(pending and pending['operationId'] == payload.get('operationId'), 409, '预约操作已改变。', 'AUTO_BOOKING_CHANGED')
        outcome = payload.get('outcome')
        require(outcome in ('succeeded', 'failed', 'uncertain'), 400, '预约结果不正确。', 'VALIDATION_ERROR')
        if outcome == 'succeeded':
            old = state['ledger'].get(pending['date'])
            if not old or old['operationId'] != pending['operationId']:
                state['totalBooked'] += 1
                state['ledger'][pending['date']] = {**pending, 'bookingKeys': payload.get('bookingKeys', []), 'confirmedAt': stamp()}
                if payload.get('evidence'):
                    state['ledger'][pending['date']]['evidence'] = payload['evidence']
                state['fulfilledDates'] = sorted(set(state['fulfilledDates'] + [pending['date']]))
                event(cur, current, key, state, 'booked', '预约成功。', date=pending['date'], teacherName=pending['teacher']['name'], time=pending['time'])
            state['pending'] = None
        elif outcome == 'failed':
            state['pending'] = None
            event(cur, current, key, state, 'rejected', payload.get('message', '预约未完成。')[:300], date=pending['date'])
        else:
            state.update(phase='reconciling', message='预约结果待核对，期间不会发送新预约。')
        if not state['enabled']:
            state['nextCheckAt'] = stamp(now() + timedelta(seconds=30)) if state['pending'] else None
    elif action == 'autoBooking.observe':
        item = state['ledger'].get(payload.get('date'))
        require(item and item['operationId'] == payload.get('operationId'), 409, '预约记录已改变。', 'AUTO_BOOKING_CHANGED')
        item['evidence'] = payload['evidence']
    elif action == 'autoBooking.release':
        item = state['ledger'].get(payload.get('date'))
        require(item and item['operationId'] == payload.get('operationId'), 409, '预约记录已改变。', 'AUTO_BOOKING_CHANGED')
        state['ledger'].pop(payload['date'])
    else:
        require(False, 400, '自动约课动作不正确。', 'VALIDATION_ERROR')
    save(cur, current, key, record, state)
    return {'ok': True, 'data': deepcopy(state)}


def operation_context(cur, current, context, action, payload):
    key, record, state, binding = load(cur, current)
    authorized(cur, current, state, binding)
    pending = state['pending']
    require(pending and pending['operationId'] == payload.get('operationId'), 403, '后台任务只能访问当前自动预约。', 'plugin_capability_denied')
    if action in ('operation.begin', 'operation.mark-dispatch'):
        guard(cur, current, context, {})
        require(pending['configRevision'] == state['configRevision'], 409, '约课条件已改变。', 'AUTO_BOOKING_CHANGED')
        starts = datetime.fromisoformat(pending['date'] + 'T' + pending.get('times', [pending['time']])[0]).replace(tzinfo=TZ)
        require(starts > now() and starts >= now() + timedelta(hours=state['config']['minNoticeHours']),
                409, '课程提前量不足。', 'AUTO_BOOKING_CHANGED')
        if action == 'operation.begin':
            require(payload.get('kind') == 'book', 403, '后台任务只能提交自动预约。', 'plugin_capability_denied')
            details = payload.get('canonicalRequest', {}).get('details', {})
            lessons = details.get('lessons', [])
            expected_times = pending.get('times', [pending['time']])
            expected_courseware = pending.get('coursewareIds', [pending['coursewareId']])
            require(details.get('date') == pending['date'] and details.get('teacher', {}).get('id') == pending['teacher']['id']
                    and len(lessons) == len(expected_times)
                    and [lesson.get('start') for lesson in lessons] == expected_times
                    and [(lesson.get('courseware') or {}).get('id') for lesson in lessons] == expected_courseware,
                    403, '后台预约必须符合已核验候选课程。', 'plugin_capability_denied')
    return {**context, 'actorId': state['ownerId']}


def disconnect(cur, current):
    key, record, state, _ = load(cur, current)
    if record:
        state.update(enabled=False, nextCheckAt=None, run=None, phase='stopped', message='账号连接已改变，请重新开启任务。')
        save(cur, current, key, record, state)

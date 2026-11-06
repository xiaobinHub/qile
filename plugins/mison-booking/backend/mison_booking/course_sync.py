"""Collect Mison lessons and ask the host to reconcile them into calendar tasks."""
import json
import re
from .auth import AuthError, bridge
from .read_api import contracts, rows, schema

TIME_RE = re.compile(r'(?:[01]\d|2[0-3]):[0-5]\d')
RANGE_RE = re.compile(r'(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?(?:[-–](\d{2}:\d{2}))?')
PAUSE = {'RECONNECT_REQUIRED': 'reconnect', 'CONTRACT_SELECTION_REQUIRED': 'multiple',
         'NO_ACTIVE_CONTRACT': 'missing-contract', 'QUERY_TOO_LARGE': 'incomplete'}


def _plain(value, limit):
    return re.sub(r'<[^>]*>', '', value).strip()[:limit] if isinstance(value, str) else ''


def _id(value):
    return str(value) if type(value) in (str, int) and re.fullmatch(r'[1-9][0-9]{0,17}', str(value)) else None


def _lesson(row, status):
    row = row if isinstance(row, dict) else {}
    cid = _id(row.get('cid'))
    raw = row.get('dateTime') if isinstance(row, dict) and status == 'cancelled' else row.get('datestart') if isinstance(row, dict) else None
    match = RANGE_RE.fullmatch(raw.strip()) if isinstance(raw, str) else None
    end = match[3] if match else None
    if not end and isinstance(row, dict) and isinstance(row.get('dateend'), str):
        found = re.search(r'(\d{2}:\d{2})(?::\d{2})?$', row['dateend'].strip())
        end = found[1] if found else None
    start = match[2] if match else None
    lesson_date = match[1] if match else None
    courseware_id = _id(row.get('courseware_id'))
    teacher_id = _id(row.get('tid'))
    teacher_name = _plain(row.get('teachername'), 100)
    identity = cid or (status == 'cancelled' and courseware_id and (teacher_id or teacher_name))
    valid = bool(identity and lesson_date and start and end and TIME_RE.fullmatch(start) and TIME_RE.fullmatch(end) and start < end)
    return {'cid': cid, 'status': status, 'date': lesson_date, 'startTime': start, 'endTime': end,
            'teacherId': teacher_id, 'teacherName': teacher_name, 'coursewareId': courseware_id,
            'coursewareTitle': _plain(row.get('course_name'), 300),
            'bid': _id(row.get('bid')), 'bookingId': _id(row.get('courseid')),
            'invalid': not valid}


def _page(client, contract, status, page):
    if status == 'cancelled':
        response = client.call('onevoneGetCancelLesson', {'userid': client.userid, 'classid': contract['id'], 'page': page, 'limit': 100})
        source = rows(response.get('data'))
        count = response.get('count')
        complete = page * 100 >= count if type(count) is int else len(source) < 100
        return source, complete
    response = client.call('getLiveList' if status == 'upcoming' else 'getBackList',
                           {'classid': contract['classId'], 'page_size': 100, 'page_no': page, 'courseway': 0, 'blockid': 0,
                            **({'is_lesson_status': 1} if status == 'completed' else {})})
    data = response.get('data')
    if not isinstance(data, dict) or type(data.get('allPage')) is not int:
        schema()
    source = rows(data.get('list'))
    return source, data.get('lastPage') is True or page >= data['allPage']


def collect_lessons(client, *, max_pages=100, max_rows=5000):
    contract = contracts(client)
    lessons = []
    for status in ('upcoming', 'completed', 'cancelled'):
        page = 1
        while True:
            source, complete = _page(client, contract, status, page)
            lessons.extend(_lesson(row, status) for row in source)
            if len(lessons) > max_rows or (not complete and page >= max_pages):
                raise AuthError('QUERY_TOO_LARGE', '课程历史过多，暂不能完成本次同步。')
            if complete:
                break
            page += 1
    encoded = json.dumps(lessons, ensure_ascii=False).encode()
    if len(encoded) > 700_000:
        raise AuthError('QUERY_TOO_LARGE', '课程历史过多，暂不能完成本次同步。')
    return lessons, contract


def _paused(error):
    reason = PAUSE.get(error.code)
    if reason:
        return {'state': 'paused', 'reason': reason}
    raise error


def get_settings(context):
    return bridge(context, 'courseSync.get', {})


def _connected(context):
    from .upstream import Client
    try:
        return Client(context)
    except AuthError as error:
        paused = _paused(error)
        if paused.get('reason') == 'reconnect':
            return paused
        raise


def _sync_payload(context, body, *, enabled):
    # Capture before the first upstream read; a concurrent commit invalidates
    # this complete snapshot even when settings/binding have not changed.
    snapshot_revision = get_settings(context)['snapshotRevision']
    client = _connected(context)
    if isinstance(client, dict):
        return client
    try:
        lessons, contract = collect_lessons(client)
    except AuthError as error:
        return _paused(error)
    return {'enabled': enabled, 'courses': lessons, 'accountId': str(client.session['userid']),
            'contractId': contract['id'], 'listComplete': True,
            'snapshotRevision': snapshot_revision,
            'credentialId': client.session['credentialId'], 'credentialRevision': client.session['credentialRevision'],
            'bindingRevision': client.session['bindingRevision'],
            **{key: body[key] for key in ('points', 'startDate') if key in body}}


def _raise_paused(payload):
    reason = payload.get('reason')
    if reason == 'incomplete':
        raise AuthError('QUERY_TOO_LARGE', '课程名单不完整，没有开启同步，也没有发放积分。')
    if reason == 'reconnect':
        raise AuthError('RECONNECT_REQUIRED', '请先登录美森网课账号。')
    if reason == 'missing-contract':
        raise AuthError('NO_ACTIVE_CONTRACT', '当前美森账号没有可用的一对一课程。')
    raise AuthError('CONTRACT_SELECTION_REQUIRED', '当前账号有多个有效一对一课程，暂不能同步。')


def preview(context, body):
    if set(body) != {'points', 'startDate'}:
        raise AuthError('VALIDATION_ERROR', '同步设置不正确。')
    for attempt in range(2):
        payload = _sync_payload(context, body, enabled=True)
        if payload.get('state') == 'paused':
            _raise_paused(payload)
        try:
            return bridge(context, 'courseSync.preview', payload)
        except AuthError as error:
            if error.code != 'SYNC_SNAPSHOT_CHANGED' or attempt:
                raise


def save(context, body):
    if set(body) != {'operationId', 'expectedRevision', 'bindingRevision', 'enabled', 'points', 'startDate'} or type(body.get('enabled')) is not bool:
        raise AuthError('VALIDATION_ERROR', '同步设置不正确。')
    from . import drafts
    drafts.uid(body['operationId'])
    for attempt in range(2):
        checked = bridge(context, 'courseSync.check', {'request': body})
        if checked['replay']:
            return checked['result']
        if body['enabled'] is False:
            return bridge(context, 'courseSync.save', {'request': body})
        payload = _sync_payload(context, body, enabled=True)
        if payload.get('state') == 'paused':
            _raise_paused(payload)
        try:
            return bridge(context, 'courseSync.save', {**payload, 'request': body})
        except AuthError as error:
            if error.code != 'SYNC_SNAPSHOT_CHANGED' or attempt:
                raise


def _run(context):
    for _ in range(2):
        settings = get_settings(context)
        if not settings.get('enabled'):
            return {'state': 'disabled'}
        payload = _sync_payload(context, {}, enabled=True)
        if payload.get('state') == 'paused':
            return payload
        result = bridge(context, 'courseSync.run', {**payload, 'settingsRevision': settings['revision']})
        if result.get('reason') != 'snapshot-changed':
            return result
    return result


def run_now(context, body):
    if set(body) != {'operationId'}:
        raise AuthError('VALIDATION_ERROR', '同步请求不正确。')
    from . import drafts
    drafts.uid(body['operationId'])
    return _run(context)


def handle_job(context, task, payload):
    if task != 'sync-courses':
        return {}
    return _run(context)

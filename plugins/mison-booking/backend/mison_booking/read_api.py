"""Read-only adapters for the existing PC plugin DTOs."""
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import re
from .auth import AuthError
from .upstream import Client
from .read_store import memo, resume, continuation
from . import images

TZ = timezone(timedelta(hours=8))

def now(): return datetime.now(TZ)
def invalid(message='查询条件不正确。'): raise AuthError('VALIDATION_ERROR', message)
def schema(message='美森查询数据格式已改变，请稍后重试。'): raise AuthError('UPSTREAM_SCHEMA_CHANGED', message)
def identifier(value):
    text = str(value) if type(value) in (str, int) else ''
    if not re.fullmatch(r'[1-9][0-9]{0,17}', text): schema()
    return text

def text(value, limit=2000):
    return re.sub(r'<[^>]*>', '', value)[:limit] if isinstance(value, str) else ''

def date_arg(value):
    if not isinstance(value, str): invalid('日期格式不正确。')
    try:
        if date.fromisoformat(value).isoformat() != value: invalid('日期格式不正确。')
    except ValueError: invalid('日期格式不正确。')
    return value

def rows(value):
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value): schema()
    return value

def contracts(client):
    key = ('contract', *client.scope)
    saved = memo.get(key)
    if saved: return saved
    one = rows(client.call('myOneToOneList', {})['data'])
    courses = rows(client.call('myCourseList', {})['data'])
    candidates = []
    for item in one:
        if item.get('gradestatus') != '正常': continue
        try:
            ends = datetime.fromisoformat(item['endtime']).replace(tzinfo=TZ)
        except (KeyError, ValueError, TypeError): schema('美森课程有效期格式不正确。')
        if ends <= now(): continue
        linked = [course for course in courses if str(course.get('classid')) == str(item.get('courseid'))
                  and str(course.get('liveid')) == str(item.get('id'))
                  and str(course.get('new_liveid')) == str(item.get('gradeid'))
                  and course.get('expire') is False]
        if len(linked) != 1: continue
        course = linked[0]
        candidates.append({'id': identifier(item['id']), 'classId': identifier(course['classid']),
                           'liveId': identifier(item['gradeid']), 'name': text(item.get('name'), 300),
                           'courseName': text(item.get('type') or item.get('name'), 300), 'teacherType': 2})
    if not candidates: raise AuthError('NO_ACTIVE_CONTRACT', '当前美森账号没有可用的一对一课程。')
    if len(candidates) > 1: raise AuthError('CONTRACT_SELECTION_REQUIRED', '当前账号有多个有效一对一课程，需先明确使用的课程。')
    return memo.put(key, candidates[0])

def public_contract(contract):
    return {key: contract[key] for key in ('id', 'name', 'courseName')}

def bootstrap_details(context):
    client = Client(context)
    contract = contracts(client)
    data = client.call('getLiveList', {'classid': contract['classId'], 'page_size': 1, 'page_no': 1, 'courseway': 0, 'blockid': 0}).get('data')
    if not isinstance(data, dict): schema()
    total = data.get('allRow')
    return public_contract(contract), total if type(total) is int and total >= 0 else None

def filters(client):
    key = ('filters', *client.scope)
    saved = memo.get(key)
    if saved: return saved
    groups = rows(client.call('getTeacherLabelGroups', {})['data'])
    times = client.call('onevoneTimeTemplateV2', {})['data']
    if not isinstance(times, list) or not all(isinstance(t, str) and re.fullmatch(r'(?:[01][0-9]|2[0-3]):[03]0', t) for t in times): schema()
    result = {'labelGroups': [{'id': identifier(g['category_id']), 'name': text(g.get('name'), 100),
               'labels': [{'id': identifier(label['label_id']), 'name': text(label.get('name'), 100)} for label in rows(g.get('list'))]}
               for g in groups], 'timeSlots': times}
    return memo.put(key, result)

def labels(client, values):
    if not isinstance(values, list): return []
    mapping = {}
    for group in filters(client)['labelGroups']:
        for label in group['labels']:
            name = label['name']
            mapping[name] = label['id'] if name not in mapping else None
    result = []
    for value in values:
        if isinstance(value, str):
            name = text(value, 100)
            label_id = mapping.get(name) or 'name-' + hashlib.sha256(name.encode()).hexdigest()[:12]
        elif isinstance(value, dict):
            name = text(value.get('name'), 100)
            label_id = identifier(value.get('label_id', value.get('id')))
        else: continue
        result.append({'id': label_id, 'name': name})
    return result

def lesson_minutes(row):
    value = str(row.get('lessonTime', ''))
    match = re.search(r'([0-9]+)\s*分钟', value)
    return int(match[1]) if match and 0 < int(match[1]) <= 120 else None

def teacher(client, row, favorites=None):
    tid = identifier(row.get('tid'))
    ddate, dtime = row.get('ddate'), row.get('dtime')
    available = {'date': ddate, 'time': dtime} if isinstance(ddate, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', ddate) and isinstance(dtime, str) and re.fullmatch(r'\d{2}:\d{2}', dtime) else None
    return {'id': tid, 'name': text(row.get('name') or row.get('nickname'), 100) or '老师',
            'intro': text(row.get('intro')), 'avatarUrl': images.public_url(row.get('headerUrl') or row.get('headerUrl2')),
            'labels': labels(client, row.get('labels')), 'favorite': tid in favorites if favorites is not None else row.get('collect') in (1, '1'),
            'favoriteAvailable': True, 'recommended': row.get('is_smart_matching') in (1, '1'),
            'nextAvailable': available, 'lessonMinutes': lesson_minutes(row)}

def teacher_query(client, query):
    if set(query) - {'nickname', 'date', 'times', 'labelIds', 'favoritesOnly', 'cursor'}: invalid()
    nickname = query.get('nickname', '')
    if not isinstance(nickname, str) or len(nickname) > 128: invalid()
    date_filter = date_arg(query['date']) if query.get('date') else ''
    times = query.get('times', '')
    label_ids = query.get('labelIds', '')
    if not isinstance(times, str) or not isinstance(label_ids, str): invalid()
    times_set, label_set = set(filter(None, times.split(','))), set(filter(None, label_ids.split(',')))
    options = filters(client)
    if times_set - set(options['timeSlots']) or label_set - {l['id'] for g in options['labelGroups'] for l in g['labels']}: invalid()
    if query.get('favoritesOnly', '0') not in ('0', '1'): invalid()
    contract = contracts(client)
    conditions = {'nickname': nickname.strip(), 'date': date_filter, 'times': sorted(times_set),
                  'labels': sorted(label_set), 'favorites': query.get('favoritesOnly') == '1', 'contractId': contract['id']}
    state = resume(client, 'teachers', conditions, query.get('cursor'))
    favorites = None
    if conditions['favorites']:
        favorites = {identifier(row['tid']): row for row in rows(client.call('getTeacherCollect', {'userid': client.userid})['data'])}
    if favorites is not None and not date_filter and not times_set and not state['complete']:
        found = [teacher(client, row, favorites) for row in favorites.values()]
        state['items'] = [row for row in found if conditions['nickname'].casefold() in row['name'].casefold()
                          and label_set <= {label['id'] for label in row['labels']}]
        state['matched'] = len(state['items']); state['complete'] = True
    for _ in range(3):
        if len(state['items']) >= 20 or state['complete']: break
        value = client.call('onevoneSearchTeacher', {'t_type': contract['teacherType'], 'user1v1_id': contract['id'], 'can_date': 1,
                    'ddate': date_filter, 'dtime': ','.join(sorted(times_set)), 'nickname': conditions['nickname'],
                    'label_id': ','.join(sorted(label_set)), 'page': state['page'], 'limit': 10})
        source = rows(value.get('data'))
        smart_count = value.get('smart_count')
        if type(smart_count) is not int or smart_count < 0: schema()
        seen = set(state['seen']); added = 0
        for row in source:
            tid = identifier(row.get('tid'))
            if tid in seen: continue
            seen.add(tid); added += 1
            if favorites is None or tid in favorites:
                state['items'].append(teacher(client, row, favorites))
                state['matched'] = state.get('matched', 0) + 1
        state['seen'] = list(seen)
        state['complete'] = state['page'] * 10 >= smart_count
        state['stalls'] = 0 if added else state['stalls'] + 1
        if state['stalls'] >= 2 and not state['complete']: schema('美森教师分页未推进，请刷新列表。')
        state['page'] += 1
        if len(seen) > 5000 or state['page'] > 500: raise AuthError('QUERY_TOO_LARGE', '教师结果过多，请增加筛选条件。')
    result = state['items'][:20]
    state['items'] = state['items'][20:]
    next_cursor = continuation(state) if state['items'] or not state['complete'] else None
    return {'queryId': state['queryId'], 'items': result, 'nextCursor': next_cursor, 'complete': next_cursor is None,
            'total': state.get('matched', 0) if state['complete'] else None, 'fetchedAt': now().isoformat()}

def schedule(client, tid, query):
    tid = identifier(tid)
    if set(query) - {'date'}: invalid()
    base = now().date()
    key = ('days', *client.scope, tid, base.isoformat())
    days = memo.get(key)
    if days is None:
        days = client.call('onevoneGetDaysAvailable', {'tid': int(tid), 'userid': client.userid}).get('data')
        if not isinstance(days, list) or len(days) > 60 or not all(type(v) is int and v in (0, 1) for v in days): schema()
        memo.put(key, days, 30)
    dates = [{'date': (base + timedelta(days=i)).isoformat(), 'available': bool(v)} for i, v in enumerate(days)]
    chosen = date_arg(query['date']) if query.get('date') else next((d['date'] for d in dates if d['available']), base.isoformat())
    if dates and chosen not in {d['date'] for d in dates}: invalid('所选日期不在当前可查询窗口内。')
    value = client.call('onevoneGetTeacherInfo', {'tid': int(tid), 'userid': client.userid, 'ddate': chosen}).get('data')
    if not isinstance(value, dict) or str(value.get('tid')) != tid: schema()
    info = teacher(client, value)
    duration = info['lessonMinutes']
    if not duration: schema('美森未返回有效课时时长。')
    slots = []
    for item in rows(value.get('all_date')):
        start, occupied = item.get('dtime'), item.get('is_dated')
        if not isinstance(start, str) or not re.fullmatch(r'(?:[01][0-9]|2[0-3]):[03]0', start) or type(occupied) is not int: schema()
        stamp = datetime.fromisoformat(chosen + 'T' + start).replace(tzinfo=TZ)
        state = 'unscheduled' if occupied < 0 else 'available' if occupied == 0 else 'mine' if occupied == client.userid else 'occupied'
        reason = {'unscheduled': '未排班', 'available': None, 'mine': '本人已约', 'occupied': '已被预约'}[state]
        if state == 'available' and stamp <= now(): state, reason = 'unscheduled', '该时段已过'
        slots.append({'start': start, 'end': (stamp + timedelta(minutes=duration)).strftime('%H:%M'), 'state': state, 'reason': reason})
    slots.sort(key=lambda row: row['start'])
    if len({s['start'] for s in slots}) != len(slots): schema()
    first = next((s for s in slots if s['state'] == 'available'), None)
    info['nextAvailable'] = {'date': chosen, 'time': first['start']} if first else None
    return {'teacher': info, 'date': chosen, 'baseDate': base.isoformat(), 'days': dates,
            'lessonMinutes': duration, 'slotStepMinutes': 30, 'slots': slots if any(days) or query.get('date') else []}

def profile(client, tid):
    tid = identifier(tid)
    raw = client.call('onevoneGetTeacherInfo', {'tid': int(tid), 'userid': client.userid, 'ddate': now().date().isoformat()}).get('data')
    if not isinstance(raw, dict) or str(raw.get('tid')) != tid: schema()
    value = teacher(client, raw)
    video = None
    if raw.get('intro_video'):
        from .media import public_media_url
        url = public_media_url(raw['intro_video'], 'video')
        if not url:
            invalid('视频地址不正确。')
        video = {'id': 'teacher-video-' + tid, 'title': '老师介绍视频', 'action': 'inline',
                 'url': url, 'mimeType': 'video/mp4', 'instructions': None, 'reason': None}
    return {**value, 'introVideo': video}

def booking(client, contract, status, row):
    cid = identifier(row['cid']) if row.get('cid') else None
    raw_time = row.get('dateTime') if status == 'cancelled' else row.get('datestart')
    start, end = None, ''
    if isinstance(raw_time, str):
        match = re.fullmatch(r'(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?(?:[-–](\d{2}:\d{2}))?', raw_time)
        if match:
            try: start = datetime.fromisoformat(match[1] + 'T' + match[2]).replace(tzinfo=TZ).isoformat(timespec='seconds')
            except ValueError: schema()
            end_match = re.search(r'(\d{2}:\d{2})(?::\d{2})?$', text(row.get('dateend'), 40))
            end = match[3] or (end_match[1] if end_match else '')
    if not start: schema('美森课程日期格式已改变。')
    fingerprint = cid or hashlib.sha256(json.dumps([raw_time, row.get('teachername'), row.get('courseware_id'), row.get('courseid'), row.get('bid')], ensure_ascii=False).encode()).hexdigest()
    key = hashlib.sha256(json.dumps([*client.scope, contract['id'], status, fingerprint]).encode()).hexdigest()
    course_id = str(row.get('courseware_id') or '')
    result = {'key': key, 'cid': cid, 'teacher': {'id': identifier(row['tid']) if row.get('tid') else None,
              'name': text(row.get('teachername'), 100) or '老师', 'avatarUrl': row.get('headerUrl') if isinstance(row.get('headerUrl'), str) else None},
              'courseware': {'id': course_id, 'title': text(row.get('course_name'), 300), 'categoryName': ''} if row.get('course_name') else None,
              'status': status, 'startsAt': start, 'timeLabel': start[11:16] + ('–' + end if end else ''), 'actions': {}}
    if status != 'cancelled':
        future = datetime.fromisoformat(start) > now() + timedelta(hours=3)
        result['actions'] = {
            'cancel': {'allowed': status == 'upcoming' and bool(cid) and future, 'mode': 'native', 'reason': None if future else '临近上课，请在美森App确认取消规则。'},
            'materials': {'allowed': bool(cid), 'mode': 'native', 'reason': None},
            'classroom' if status == 'upcoming' else 'replay': {'allowed': True, 'mode': 'instructions', 'reason': '请在美森App继续。'},
        }
        if status == 'completed': result['actions']['homework'] = {'allowed': True, 'mode': 'instructions', 'reason': '请在美森App继续。'}
    result['snapshotVersion'] = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    return result

def bookings(client, query):
    if set(query) - {'status', 'from', 'to', 'cursor', 'pageSize'}: invalid()
    status = query.get('status', 'upcoming')
    if status not in ('upcoming', 'completed', 'cancelled'): invalid()
    start, end = date_arg(query['from']) if query.get('from') else '', date_arg(query['to']) if query.get('to') else ''
    if start and end and start > end: invalid('开始日期不能晚于结束日期。')
    raw_size = query.get('pageSize', '20')
    if not isinstance(raw_size, (str, int)) or isinstance(raw_size, bool) or not str(raw_size).isdecimal() or not 1 <= int(raw_size) <= 50: invalid()
    size = int(raw_size)
    contract = contracts(client)
    conditions = {'status': status, 'from': start, 'to': end, 'size': size, 'contractId': contract['id']}
    state = resume(client, 'bookings', conditions, query.get('cursor'))
    for _ in range(3):
        if state['complete']: break
        if status == 'cancelled':
            response = client.call('onevoneGetCancelLesson', {'userid': client.userid, 'classid': contract['id'], 'page': state['page'], 'limit': 100})
            source = rows(response.get('data'))
            count = response.get('count')
            complete = state['page'] * 100 >= count if type(count) is int else len(source) < 100
        else:
            response = client.call('getLiveList' if status == 'upcoming' else 'getBackList',
                {'classid': contract['classId'], 'page_size': 100, 'page_no': state['page'], 'courseway': 0, 'blockid': 0,
                 **({'is_lesson_status': 1} if status == 'completed' else {})})
            data = response.get('data')
            if not isinstance(data, dict): schema()
            source = rows(data.get('list'))
            if type(data.get('allPage')) is not int or data['allPage'] < 0: schema()
            complete = data.get('lastPage') is True or state['page'] >= data['allPage']
        seen = set(state['seen']); added = 0
        for row in source:
            value = booking(client, contract, status, row)
            if value['key'] in seen: continue
            seen.add(value['key']); added += 1
            day = value['startsAt'][:10]
            if (not start or day >= start) and (not end or day <= end): state['items'].append(value)
        state['seen'], state['complete'] = list(seen), complete
        state['stalls'] = 0 if added else state['stalls'] + 1
        if state['stalls'] >= 2 and not complete: schema('美森课程分页未推进，请刷新列表。')
        state['page'] += 1
        if len(seen) > 5000 or state['page'] > 100: raise AuthError('QUERY_TOO_LARGE', '课程历史过多，暂时无法完成本次查询。')
    if not state['complete']:
        return {'queryId': state['queryId'], 'state': 'building', 'items': [], 'nextCursor': continuation(state), 'total': None, 'sourceComplete': False}
    state['items'].sort(key=lambda row: (row['startsAt'], row['key']), reverse=status != 'upcoming')
    offset = state['offset']; selected = state['items'][offset:offset + size]
    state['offset'] += len(selected)
    next_cursor = continuation(state) if state['offset'] < len(state['items']) else None
    for item in selected:
        item['teacher']['avatarUrl'] = images.public_url(item['teacher']['avatarUrl'])
    return {'queryId': state['queryId'], 'state': 'ready', 'items': selected,
            'nextCursor': next_cursor,
            'total': len(state['items']), 'sourceComplete': True}


def _ordered(status, items):
    stamps = [item['startsAt'] for item in items]
    pairs = zip(stamps, stamps[1:])
    ordered = all(left <= right for left, right in pairs) if status == 'upcoming' else all(left >= right for left, right in pairs)
    if not ordered: schema('美森课程顺序已改变，请刷新列表。')

def _listed_complete(data, page):
    last, total = data.get('lastPage'), data['allPage']
    if (last is True and page < total) or (last is False and page >= total):
        schema('美森课程分页信息不一致，请刷新列表。')
    return last is True or page >= total

def booking_page(client, query):
    if set(query) - {'status', 'page'}: invalid()
    status = query.get('status', 'upcoming')
    if status not in ('upcoming', 'completed', 'cancelled'): invalid()
    raw_page = query.get('page', '1')
    if not isinstance(raw_page, (str, int)) or isinstance(raw_page, bool) or not str(raw_page).isdecimal() or not 1 <= int(raw_page) <= 100: invalid()
    page = int(raw_page)
    contract = contracts(client)
    if status == 'cancelled':
        response = client.call('onevoneGetCancelLesson', {'userid': client.userid, 'classid': contract['id'], 'page': page, 'limit': 100})
        source = rows(response.get('data'))
        count = response.get('count')
        complete = page * 100 >= count if type(count) is int else len(source) < 100
    else:
        response = client.call('getLiveList' if status == 'upcoming' else 'getBackList',
            {'classid': contract['classId'], 'page_size': 100, 'page_no': page, 'courseway': 0, 'blockid': 0,
             **({'is_lesson_status': 1} if status == 'completed' else {})})
        data = response.get('data')
        if not isinstance(data, dict) or type(data.get('allPage')) is not int or data['allPage'] < 0: schema()
        source = rows(data.get('list'))
        complete = _listed_complete(data, page)
    items, seen = [], set()
    for row in source:
        value = booking(client, contract, status, row)
        if value['key'] in seen: continue
        seen.add(value['key']); items.append(value)
    _ordered(status, items)
    for item in items: item['teacher']['avatarUrl'] = images.public_url(item['teacher']['avatarUrl'])
    if not items and not complete: schema('美森课程分页信息不一致，请刷新列表。')
    return {'status': status, 'page': page, 'pageSize': 100, 'complete': complete, 'items': items}

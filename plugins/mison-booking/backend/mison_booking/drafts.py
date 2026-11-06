"""Private CAS booking drafts; no upstream mutation while choosing courseware."""
from copy import deepcopy
import hashlib
import json
import re
import uuid
from .auth import AuthError, bridge
from . import courseware
from .read_api import contracts, schedule, date_arg, identifier, invalid

COLLECTION = 'booking-draft'
MAX_LESSONS = 38  # bounded by the actual 30-minute day template; not an upstream guarantee.

def uid(value):
    try: return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError): invalid('操作或草稿标识不正确。')

def binding(client, value):
    if type(value) is not int or value != client.session['bindingRevision']:
        raise AuthError('BINDING_CHANGED', '账号状态已改变，请刷新页面。')

def find_record(client, draft_id):
    # Old drafts have a database TTL as well as a payload expiresAt. Read them
    # explicitly without TTL filtering; child/plugin and account fences still apply.
    record = bridge(client.context, 'private.get', {
        'collection': COLLECTION, 'recordId': uid(draft_id), 'includeExpired': True})['record']
    if record:
        record['payload']['expiresAt'] = None
    return record

def get_record(client, draft_id):
    record = find_record(client, draft_id)
    if not record or record['payload'].get('_scope') != list(client.scope):
        raise AuthError('DRAFT_EXPIRED', '预约草稿不存在或账号已改变，请重新选择时段。')
    return record

def public(draft): return {key: deepcopy(value) for key, value in draft.items() if not key.startswith('_')}

def check_editable(client, draft):
    if draft.get('_lockedBy'):
        operation = bridge(client.context, 'operation.get', {'operationId': draft['_lockedBy']})
        if operation['state'] not in ('failed', 'cancelled'):
            raise AuthError('DRAFT_IN_USE', '该草稿已提交或结果待核对，请勿重复预约。', operation['operationId'])

def expected(draft, revision):
    if type(revision) is not int or revision != draft['revision']:
        raise AuthError('REVISION_CONFLICT', '课件选择已改变，请刷新草稿。')

def put(client, draft, record_revision):
    draft['expiresAt'] = None
    return bridge(client.context, 'private.put', {'collection': COLLECTION, 'recordId': draft['id'],
                  'payload': draft, 'expectedRevision': record_revision, 'expiresAt': None})['record']

def slots(client, tid, day, starts):
    if not isinstance(starts, list) or not 1 <= len(starts) <= MAX_LESSONS or any(not isinstance(v, str) or not re.fullmatch(r'(?:[01][0-9]|2[0-3]):[03]0', v) for v in starts) or len(set(starts)) != len(starts):
        invalid('请选择有效且不重复的上课时段。')
    starts = sorted(starts)
    minutes = lambda value: int(value[:2])*60+int(value[3:])
    if any(minutes(b)-minutes(a) != 30 for a,b in zip(starts, starts[1:])):
        raise AuthError('NON_CONTIGUOUS_SLOTS', '请选择同一天的连续时段。')
    result = schedule(client, identifier(tid), {'date': date_arg(day)})
    available = {item['start']: item for item in result['slots'] if item['state'] == 'available'}
    if any(start not in available for start in starts):
        raise AuthError('SLOT_UNAVAILABLE', '部分时段已不可约，请返回重新选择。')
    return result, [available[start] for start in starts]

def refresh_valid(draft):
    issues = []
    ids = []
    for lesson in draft['lessons']:
        selected = lesson['courseware']
        if not selected or not selected['active'] or selected['selectedElsewhere']:
            issues.append({'code': 'COURSEWARE_REQUIRED', 'slotStart': lesson['start'], 'message': '请为该课时选择有效课件。'})
        elif selected['id'] in ids:
            issues.append({'code': 'COURSEWARE_DUPLICATE', 'slotStart': lesson['start'], 'message': '同一课件不能用于本次多个课时。'})
        if selected: ids.append(selected['id'])
    draft['issues'], draft['valid'] = issues, not issues

def asset(client, course):
    row = courseware.raw(client, course['id'])
    return {k: row[k] for k in ('id', 'title', 'status', 'category_id', 'student_file_url', 'teaching_file_url',
            'training_file_url1', 'training_file_url2', '_page') if k in row}

def digest(body): return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def create(client, body):
    if set(body) != {'operationId', 'bindingRevision', 'teacherId', 'date', 'slotStarts'}: invalid()
    binding(client, body['bindingRevision'])
    draft_id = uid(body['operationId'])
    old = find_record(client, draft_id)
    if old:
        draft = get_record(client, draft_id)['payload']
        if draft['_createHash'] != digest(body): raise AuthError('OPERATION_CONFLICT', '操作标识已用于其他草稿。')
        return public(draft)
    sched, selected = slots(client, body['teacherId'], body['date'], body['slotStarts'])
    recommended, previous = courseware.recommend(client, len(selected))
    lessons = []
    for i, slot in enumerate(selected):
        course = recommended[i] if i < len(recommended) else None
        lessons.append({'start': slot['start'], 'end': slot['end'], 'courseware': course, 'origin': 'recommended'})
    draft = {'id': draft_id, 'revision': 1, 'teacher': {k: sched['teacher'][k] for k in ('id', 'name', 'avatarUrl')},
             'date': sched['date'], 'lastLearned': previous, 'lessons': lessons, 'quota': None,
             'expiresAt': None, '_scope': list(client.scope),
             '_createHash': digest(body), '_receipts': {}, '_assets': {r['id']: asset(client,r) for r in recommended}, '_lockedBy': None}
    refresh_valid(draft)
    put(client, draft, 0)
    return public(draft)

def update_slots(client, draft_id, body):
    if set(body) != {'operationId', 'bindingRevision', 'expectedRevision', 'slotStarts'}: invalid()
    binding(client, body['bindingRevision']); operation_id = uid(body['operationId'])
    record = get_record(client, draft_id); draft = record['payload']; check_editable(client,draft)
    if operation_id in draft['_receipts']:
        if draft['_receipts'][operation_id] != digest(body): raise AuthError('OPERATION_CONFLICT', '操作标识已用于其他选择。')
        return public(draft)
    expected(draft, body['expectedRevision'])
    sched, selected = slots(client,draft['teacher']['id'],draft['date'],body['slotStarts'])
    recommended, previous = courseware.recommend(client,len(selected))
    old = {item['start']:item for item in draft['lessons']}
    lessons = []
    for i,slot in enumerate(selected):
        item = old.get(slot['start']) or {'start':slot['start'],'end':slot['end'],'courseware':recommended[i] if i<len(recommended) else None,'origin':'recommended'}
        lessons.append(item)
    draft['lessons'],draft['quota'],draft['lastLearned'] = lessons,None,previous
    draft['_assets'].update({r['id']:asset(client,r) for r in recommended})
    draft['revision'] += 1; draft['_lockedBy'] = None
    draft['_receipts'] = dict(list(draft['_receipts'].items())[-15:] + [(operation_id,digest(body))])
    refresh_valid(draft); put(client,draft,record['revision'])
    return public(draft)

def lock(client, record, operation_id):
    draft = record['payload']; check_editable(client,draft)
    draft['_lockedBy'] = operation_id
    return put(client,draft,record['revision'])

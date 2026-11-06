"""Documented courseware reads. Raw student assets stay private to the worker."""
import hashlib
from .auth import AuthError
from .read_api import contracts, identifier, rows, text, invalid, schema
from .read_store import memo, resume, continuation


def quota(client):
    contract = contracts(client)
    data = client.call('onevoneGetChangeCoursewareTimes', {'userid': client.userid, 'user1v1_id': contract['id']}).get('data')
    if not isinstance(data, dict) or any(type(data.get(k)) is not int or data[k] < 0 for k in ('leftTimes', 'allTimes')) or data['leftTimes'] > data['allTimes']:
        schema('美森未返回有效的课件预览额度。')
    return {'remaining': data['leftTimes'], 'total': data['allTimes']}


def dto(row):
    category = row.get('category') if isinstance(row.get('category'), dict) else {}
    return {'id': identifier(row.get('id')), 'title': text(row.get('title'), 300),
            'categoryName': text(row.get('category_name') or category.get('category_name'), 200),
            'learned': None, 'active': row.get('status') in (1, '1') and row.get('category_inactive') not in (True, 1, '1') and row.get('category_is_active', 1) in (1, '1'),
            'selectedElsewhere': row.get('choosed') in (1, '1'), 'previewAvailable': bool(row.get('student_file_url'))}


def remember(client, row):
    value = dto(row)
    memo.put(('courseware', *client.scope, value['id']), row)
    return value


def raw(client, course_id):
    value = memo.get(('courseware', *client.scope, identifier(course_id)))
    if not value: raise AuthError('QUERY_EXPIRED', '课件列表已过期，请重新选择课件。')
    return value


def categories(client):
    contract = contracts(client)
    key = ('categories', *client.scope, contract['id'])
    value = memo.get(key)
    if value is not None: return value
    data = client.call('getCoursewareCategoryTree', {'liveid': contract['liveId']}).get('data')
    if not isinstance(data, dict): schema()
    seen = set()
    def convert(nodes, depth=0):
        if depth > 12 or len(seen) > 4000: schema('课件分类过多。')
        result = []
        for row in rows(nodes):
            key = identifier(row.get('id'))
            if key in seen: schema('课件分类重复。')
            seen.add(key)
            result.append({'id': key, 'name': text(row.get('name'), 150), 'children': convert(row.get('children', []), depth + 1)})
        return result
    value = {'nodes': convert(data.get('tree'))}
    return memo.put(key, value)


def recommend(client, count):
    contract = contracts(client)
    data = client.call('getRecommendCourseware', {'user1v1_id': contract['id'], 'userid': client.userid, 'count': count}).get('data')
    if not isinstance(data, dict) or data.get('status') not in (0, 1): schema()
    result = [remember(client, row) for row in rows(data.get('list', []))]
    last = data.get('lastCourse')
    previous = dto(last) if isinstance(last, dict) and last.get('id') else None
    return result, ({k: previous[k] for k in ('id', 'title', 'categoryName')} if previous else None)


def query(client, params, draft):
    if set(params) - {'categoryId', 'draftId', 'slotStart', 'cursor', 'source'}: invalid()
    source = params.get('source', 'category')
    category_id = str(params.get('categoryId', ''))
    if source == 'category':
        def leaves(nodes):
            return {n['id'] for n in nodes if not n['children']} | set().union(*(leaves(n['children']) for n in nodes))
        if category_id not in leaves(categories(client)['nodes']): invalid('请选择有效的叶子分类。')
    elif source != 'unlearned': invalid()
    start = params.get('slotStart')
    if start not in {lesson['start'] for lesson in draft['lessons']}: invalid()
    conditions = {'category': category_id, 'source': source, 'draft': draft['id'], 'revision': draft['revision'], 'slot': start}
    state = resume(client, 'courseware', conditions, params.get('cursor'))
    contract = contracts(client)
    if source == 'unlearned':
        result = client.call('onevoneGetCancelCourseware', {'user1v1_id': contract['id'], 'userid': client.userid, 'page': state['page'], 'limit': 20})
    else:
        result = client.call('getCoursewareList', {'category_id': int(category_id), 'page': state['page'], 'limit': 20, 'user1v1_id': contract['id'], 'splitPage': 1})
    raw_items = rows(result.get('data'))
    items = [remember(client, {**row, '_page': state['page']}) for row in raw_items]
    taken = {lesson['courseware']['id'] for lesson in draft['lessons'] if lesson['start'] != start and lesson['courseware']}
    for item in items: item['selectedElsewhere'] = item['selectedElsewhere'] or item['id'] in taken
    count = result.get('count')
    complete = state['page'] * 20 >= count if type(count) is int else len(raw_items) < 20
    state['page'] += 1
    if state['page'] > 251: raise AuthError('QUERY_TOO_LARGE', '课件列表过大，请调整分类。')
    return {'items': items, 'nextCursor': None if complete else continuation(state)}

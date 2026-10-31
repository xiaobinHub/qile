"""Read-only, query-bound keyset pagination for administrator child selection."""
import base64
import binascii
import hashlib
import json

from lele_growth.child_service import require
from .policy import rows_dict

PAGE_SIZE = 50


def list_plugin_children(cur, search, cursor=''):
    require(isinstance(search, str) and len(search) <= 200, 400, '搜索内容过长。')
    require(isinstance(cursor, str) and len(cursor) <= 512, 400, '儿童列表游标不正确。')
    signature = hashlib.sha256(search.encode()).hexdigest()[:16]
    last = None
    if cursor:
        try:
            value = json.loads(base64.b64decode(cursor + '=' * (-len(cursor) % 4), altchars=b'-_', validate=True))
        except (ValueError, UnicodeError, binascii.Error):
            require(False, 400, '儿童列表游标不正确。')
        require(isinstance(value, list) and len(value) == 3
                and all(isinstance(item, str) for item in value)
                and 0 < len(value[0]) <= 100 and 0 < len(value[1]) <= 128
                and value[2] == signature, 400, '儿童列表游标与搜索不匹配。')
        last = value[:2]
    sql = ('SELECT c.id,c.name,u.nickname AS "ownerName" FROM lele.children c '
           'JOIN lele.users u ON u.id=c.owner_id WHERE c.deleted_at IS NULL AND '
           '(strpos(lower(c.name),lower(%s))>0 OR strpos(lower(u.nickname),lower(%s))>0 '
           'OR strpos(lower(c.id),lower(%s))>0)')
    params = [search, search, search]
    if last:
        sql += ' AND (c.name,c.id)>(%s,%s)'
        params.extend(last)
    cur.execute(sql + ' ORDER BY c.name,c.id LIMIT %s', (*params, PAGE_SIZE + 1))
    rows = rows_dict(cur)
    children = rows[:PAGE_SIZE]
    next_cursor = None
    if len(rows) > PAGE_SIZE:
        tail = children[-1]
        next_cursor = base64.urlsafe_b64encode(json.dumps(
            [tail['name'], tail['id'], signature], ensure_ascii=False).encode()).decode().rstrip('=')
    return {'children': children, 'nextCursor': next_cursor}

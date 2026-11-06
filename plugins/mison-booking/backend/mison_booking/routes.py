from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
import re
from urllib.parse import urlsplit, parse_qs


class PluginError(Exception):
    def __init__(self, code, message, retry="none", operation_id=None):
        super().__init__(message)
        self.code, self.message, self.retry, self.operation_id = code, message, retry, operation_id

    def result(self):
        from . import _now
        error = {"code": self.code, "message": self.message, "retry": self.retry}
        if self.operation_id:
            error["operationId"] = self.operation_id
        return {"ok": False, "error": error, "requestId": "local", "serverTime": _now()}


def handle(context, path, method, body):
    parsed = urlsplit(path)
    path = parsed.path
    body = {**body, **{key: values[0] for key, values in parse_qs(parsed.query).items()}}
    if path == "bootstrap" and method == "GET":
        return success(_bootstrap(context))
    if path == "connection/login" and method == "POST":
        from .auth import login
        return success(login(context, body))
    if path == "connection" and method == "DELETE":
        from .auth import bridge, public_connection
        return success(public_connection(bridge(context, 'session.disconnect', body)))
    if path == "course-sync" and method == "GET":
        from .course_sync import get_settings
        return success(get_settings(context))
    if path == "course-sync/preview" and method == "POST":
        from .course_sync import preview
        return success(preview(context, body))
    if path == "course-sync" and method == "POST":
        from .course_sync import save
        return success(save(context, body))
    if path == "course-sync/run" and method == "POST":
        from .course_sync import run_now
        return success(run_now(context, body))
    from .upstream import Client
    from . import drafts, courseware, operations
    client = Client(context)
    match = re.fullmatch(r'teachers/([1-9][0-9]{0,17})/favorite', path)
    if match and method == 'PUT': return success(operations.favorite(client, match[1], body))
    if path == 'drafts' and method == 'POST': return success(drafts.create(client, body))
    match = re.fullmatch(r'drafts/([a-f0-9-]{36})(/slots)?', path)
    if match:
        if match[2] and method == 'PUT': return success(drafts.update_slots(client, match[1], body))
        if not match[2] and method == 'GET': return success(drafts.public(drafts.get_record(client, match[1])['payload']))
    if path == 'courseware/categories' and method == 'GET': return success(courseware.categories(client))
    if path == 'courseware' and method == 'GET':
        return success(courseware.query(client, body, drafts.get_record(client, body.get('draftId'))['payload']))
    match = re.fullmatch(r'drafts/([a-f0-9-]{36})/lessons/([0-9]{2}(?::|%3A)[0-9]{2})/courseware', path, re.I)
    if match and method == 'PUT':
        return success(operations.change(client, match[1], re.sub('%3a', ':', match[2], flags=re.I), body))
    match = re.fullmatch(r'courseware/([1-9][0-9]{0,17})/preview', path)
    if match and method == 'POST': return success(operations.preview(client, match[1], body))
    if path == 'bookings' and method == 'POST': return success(operations.book(client, body))
    match = re.fullmatch(r'operations/([a-f0-9-]{36})/acknowledge', path)
    if match and method == 'POST': return success(operations.acknowledge(client, match[1], body))
    match = re.fullmatch(r'operations/([a-f0-9-]{36})', path)
    if match and method == 'GET': return success(operations.get(client, match[1]))
    match = re.fullmatch(r'bookings/([a-f0-9]{64})/(cancel|resources|actions/(classroom|replay|prestudy|homework))', path)
    if match:
        if match[2] == 'cancel' and method == 'POST': return success(operations.cancel(client, match[1], body))
        if match[2] == 'resources' and method == 'GET': return success(operations.resources(client, match[1]))
        if match[3] and method == 'POST': return success(operations.learning(client, match[1], match[3], body))
    if method == 'GET':
        from . import read_api, images
        from .auth import AuthError
        from .upstream import Client
        if path == 'teacher-filters':
            return success(read_api.filters(client))
        if path == 'teachers':
            return success(read_api.teacher_query(client, body))
        if path == 'bookings':
            return success(read_api.bookings(client, body))
        match = re.fullmatch(r'teachers/([1-9][0-9]{0,17})(/schedule)?', path)
        if match:
            return success(read_api.schedule(client, match[1], body) if match[2] else read_api.profile(client, match[1]))
        match = re.fullmatch(r'resources/images/([a-f0-9]{64})', path)
        if match:
            if set(body) - {'chunk'}: raise AuthError('VALIDATION_ERROR', '头像参数不正确。')
            return success(images.load(client, match[1], body.get('chunk', '0')))
    raise PluginError("ACTION_UNAVAILABLE", "此能力尚未完成上游核验，暂不可用。", "none")


def success(data):
    return {"ok": True, "data": data, "requestId": "local", "serverTime": _now()}


def _now():
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")


def _bootstrap(context):
    from .auth import session, public_connection
    connection = public_connection(session(context))
    count, read_error = None, None
    if connection['status'] == 'connected':
        from .read_api import bootstrap_details
        from .auth import AuthError
        try:
            connection['contract'], count = bootstrap_details(context)
        except AuthError as error:
            if error.code == 'RECONNECT_REQUIRED':
                connection = public_connection(session(context))
            else:
                read_error = str(error)
    now = datetime.now(timezone(timedelta(hours=8)))
    unresolved = []
    if connection['status'] == 'connected' and 'plugin.external-operations' in context.get('capabilities', []):
        from .auth import bridge
        unresolved = bridge(context, 'operation.list', {})['operations']
    return {
        "connection": connection,
        "timezone": "Asia/Shanghai",
        "serverDate": now.date().isoformat(),
        "upcomingCount": count,
        "readError": read_error,
        "bookingLimits": {"maxContiguousLessons": 38},
        "features": {key: {"mode": "native" if key in ("book", "multiLesson", "preview", "changeCourseware") else "unavailable", "reason": None if key in ("book", "multiLesson", "preview", "changeCourseware") else "请在美森App继续。"}
                     for key in ("book", "multiLesson", "preview", "changeCourseware", "adjustOrder",
                                 "classroom", "replay", "prestudy", "homework")},
        "unresolvedOperations": [{"operationId": item['operationId'], "kind": item['kind'], "state": item['state'],
                                  "stageVersion": item['stageVersion'], "message": "上次操作待核对，请勿重复提交。", "result": None}
                                 for item in unresolved],
    }

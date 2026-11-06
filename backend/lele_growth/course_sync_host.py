"""Persist Mison course sync inside the plugin bridge transaction.

The bridge already holds the child row lock. Do not take the child advisory
lock here; doing so after that row lock can deadlock a normal task save.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import json
import re
import uuid
from datetime import datetime, timezone

from lele_growth.child_service import ApiError, require
from lele_growth.course_sync import SHANGHAI, CourseSyncConflict, clock, purge_incomplete, reconcile_current, validate_settings
from lele_growth.business_operations import uid
from lele_growth.plugins import private_store
from lele_growth.plugins.policy import row_dict

COLLECTION = "course-sync"
RECORD = "settings"
RECEIPTS = "course-sync-receipts"
PLUGIN_ID = "mison-booking"
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}\Z")
REASONS = {
    "archived": "孩子已归档，已暂停同步。",
    "incomplete": "课程名单不完整，没有开启同步，也没有发放积分。",
    "multiple": "当前账号有多个有效一对一课程，已暂停同步。",
    "missing-contract": "当前美森账号没有可用的一对一课程，已暂停同步。",
    "reconnect": "美森账号未连接，已暂停同步。",
}


def _reason_message(reason):
    return REASONS.get(reason, "课程暂时无法同步，已有课程保持不变。")


def _settings(cur, scope):
    record = private_store.get(cur, scope, COLLECTION, RECORD)
    payload = dict(record["payload"]) if record else {}
    return payload, record["revision"] if record else 0


def _public(payload, revision, *, owner):
    points = payload.get("points")
    start = payload.get("startDate")
    return {"enabled": payload.get("enabled") is True,
            "points": points if type(points) is int else None,
            "startDate": start if isinstance(start, str) else None,
            "revision": revision, "canManage": owner,
            "serverDate": datetime.now(SHANGHAI).date().isoformat()}


def _identity(payload, key):
    value = payload.get(key)
    require(isinstance(value, str) and SAFE_ID.fullmatch(value), 400, "美森课程身份不正确。", "VALIDATION_ERROR")
    return value


def _courses(payload):
    courses = payload.get("courses")
    require(isinstance(courses, list) and len(courses) <= 5000, 400, "课程名单不正确。", "VALIDATION_ERROR")
    return courses


def _binding(cur, scope, expected_revision, snapshot=None, *, connected=True):
    record = private_store.get(cur, scope, 'login-session', 'current')
    saved = record['payload'] if record else {}
    require(type(expected_revision) is int and expected_revision == saved.get('bindingRevision', 0),
            409, '美森账号已改变，请重新打开账号设置。', 'BINDING_CHANGED')
    if not connected:
        return
    require(isinstance(saved.get('credentialId'), str), 409, '请先登录美森账号。', 'RECONNECT_REQUIRED')
    cur.execute("SELECT revision,state,expires_at,provider FROM lele.plugin_credentials WHERE id=%s AND child_id=%s AND plugin_id=%s",
                (saved['credentialId'], scope['child_id'], scope['plugin_id']))
    credential = row_dict(cur)
    require(credential and credential['provider'] == 'mison' and credential['state'] == 'active'
            and credential['expires_at'] and credential['expires_at'] > datetime.now(timezone.utc),
            409, '美森登录已失效，请重新登录。', 'RECONNECT_REQUIRED')
    if snapshot is not None:
        require(snapshot.get('bindingRevision') == expected_revision
                and snapshot.get('credentialId') == saved['credentialId']
                and type(snapshot.get('credentialRevision')) is int
                and snapshot['credentialRevision'] == credential['revision']
                and snapshot.get('accountId') == saved.get('userid'),
                409, '美森账号已改变，本次课程没有同步。', 'BINDING_CHANGED')


def _save_request(cur, scope, actor_id, payload, revision):
    request = payload.get('request')
    fields = {'operationId', 'expectedRevision', 'bindingRevision', 'enabled', 'points', 'startDate'}
    require(isinstance(request, dict) and set(request) == fields, 400, '同步设置不正确。', 'VALIDATION_ERROR')
    try:
        operation_id = str(uuid.UUID(request['operationId']))
    except (ValueError, TypeError, AttributeError):
        require(False, 400, '同步操作标识不正确。', 'VALIDATION_ERROR')
    require(type(request['expectedRevision']) is int and request['expectedRevision'] >= 0
            and type(request['bindingRevision']) is int and request['bindingRevision'] >= 0
            and type(request['enabled']) is bool, 400, '同步设置不正确。', 'VALIDATION_ERROR')
    try:
        encoded = json.dumps(request, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    except (ValueError, TypeError):
        raise ApiError(400, '同步设置不正确。', 'VALIDATION_ERROR') from None
    digest = hashlib.sha256(encoded).hexdigest()
    receipt = private_store.get(cur, scope, RECEIPTS, operation_id)
    if receipt:
        saved = receipt['payload']
        require(saved['actorId'] == actor_id and hmac.compare_digest(saved['requestHash'], digest),
                409, '操作编号已用于其他同步请求。', 'OPERATION_CONFLICT')
        return request, operation_id, digest, copy.deepcopy(saved['result'])
    require(request['expectedRevision'] == revision, 409, '同步设置已改变，请重新核对后保存。', 'REVISION_CONFLICT')
    if request['enabled']:
        try:
            validate_settings(request['points'], request['startDate'])
        except CourseSyncConflict as error:
            raise ApiError(400, str(error), error.code) from None
    _binding(cur, scope, request['bindingRevision'], connected=request['enabled'])
    return request, operation_id, digest, None


def _commit(service, cur, child_id, current, data, actor_id, action):
    if data == current["data"]:
        return current
    data = copy.deepcopy(data)
    stamp, _ = clock(datetime.now(SHANGHAI))
    data["operationLog"] = (list(data.get("operationLog") or []) + [{
        "id": uid(), "at": stamp, "action": action, "revision": current["revision"] + 1,
        "actorUserId": str(actor_id or PLUGIN_ID),
    }])[-500:]
    return service.save(cur, child_id, current, data)


def _store_settings(cur, scope, payload, revision):
    private_store.put(cur, scope, COLLECTION, RECORD, payload, expected_revision=revision)


def purge_saved(service, cur, child_id, actor_id, account_id=None):
    current = service.store.read(cur, child_id, locked=True)
    updated, removed = purge_incomplete(current["data"], account_id=account_id)
    if removed:
        _commit(service, cur, child_id, current, updated, actor_id, "course.sync.purge")
    return removed


def handle(service, cur, scope, request_context, action, payload):
    require(scope.get("plugin_id") == PLUGIN_ID, 403, "此插件不能同步课程。", "plugin_capability_denied")
    actor_id = request_context.get("actorId")
    owner = bool(actor_id) and actor_id == scope.get("owner_id")
    archived = bool(scope.get("archived") or scope.get("deleted_at") is not None)
    child_id = scope["child_id"]
    if action == "courseSync.get":
        stored, revision = _settings(cur, scope)
        return {"ok": True, "data": _public(stored, revision, owner=owner)}
    if action == "courseSync.purge":
        require(owner or request_context.get("jobId"), 403, "只有儿童负责人可以设置课程同步。", "OWNER_REQUIRED")
        removed = purge_saved(service, cur, child_id, actor_id, payload.get("accountId"))
        return {"ok": True, "data": {"state": "purged", "removed": removed}}
    require(action in ("courseSync.check", "courseSync.preview", "courseSync.save", "courseSync.run"), 400, "课程同步动作不存在。", "plugin_bridge_action_unavailable")
    if action != "courseSync.run":
        require(owner, 403, "只有儿童负责人可以设置课程同步。", "OWNER_REQUIRED")
        require(not archived, 409, _reason_message("archived"), "archived")
    stored, revision = _settings(cur, scope)
    request = None
    if action in ('courseSync.check', 'courseSync.save'):
        request, operation_id, request_hash, replay = _save_request(cur, scope, actor_id, payload, revision)
        if action == 'courseSync.check':
            return {'ok': True, 'data': {'replay': replay is not None, 'result': replay}}
        if replay is not None:
            return {'ok': True, 'data': replay}
    if action == "courseSync.save" and request['enabled'] is False:
        updated = {**stored, "enabled": False}
        current = service.store.read(cur, child_id, locked=True)
        purged, removed = purge_incomplete(current["data"])
        _commit(service, cur, child_id, current, purged, actor_id, "course.sync.disable")
        _store_settings(cur, scope, updated, revision)
        summary = {"state": "disabled", "removed": removed, "revision": revision + 1}
        private_store.put(cur, scope, RECEIPTS, operation_id,
                          {'actorId': actor_id, 'requestHash': request_hash, 'result': summary}, expected_revision=0)
        return {"ok": True, "data": summary}
    if action == 'courseSync.run':
        if not stored.get('enabled'):
            return {'ok': True, 'data': {'state': 'disabled'}}
        if type(payload.get('settingsRevision')) is not int or payload['settingsRevision'] != revision:
            return {'ok': True, 'data': {'state': 'paused', 'reason': 'settings-changed'}}
    expected_binding = request['bindingRevision'] if request else payload.get('bindingRevision')
    _binding(cur, scope, expected_binding, payload)
    account_id = _identity(payload, "accountId")
    contract_id = _identity(payload, "contractId")
    parameters = stored if action == 'courseSync.run' else request if request is not None else payload
    points = parameters.get('points')
    start_date = parameters.get('startDate')
    courses = _courses(payload)
    list_complete = payload.get("listComplete") is True
    contract_error = payload.get("contractError")
    require(contract_error is None or isinstance(contract_error, str), 400, "课程同步状态不正确。", "VALIDATION_ERROR")
    if action == "courseSync.run" and (not stored.get("enabled") or archived or not list_complete or contract_error):
        reason = "disabled" if not stored.get("enabled") else refusal_reason(archived, list_complete, contract_error)
        return {"ok": True, "data": {"state": "paused" if reason != "disabled" else "disabled", "reason": reason}}
    if action != "courseSync.run":
        require(list_complete and not contract_error, 409, _reason_message(contract_error or "incomplete"), contract_error or "incomplete")
    current = service.store.read(cur, child_id, locked=True)
    try:
        updated, summary = reconcile_current(
            current["data"], courses, account_id=account_id, contract_id=contract_id, points=points,
            start_date=start_date, now=datetime.now(SHANGHAI), list_complete=list_complete,
            archived=archived, contract_error=contract_error)
    except CourseSyncConflict as error:
        if action == "courseSync.run":
            return {"ok": True, "data": {"state": "paused", "reason": error.code}}
        raise ApiError(409, str(error), error.code) from None
    if summary.get("state") == "paused":
        if action == "courseSync.run":
            return {"ok": True, "data": summary}
        raise ApiError(409, _reason_message(summary.get("reason")), summary.get("reason"))
    if action == "courseSync.preview":
        return {"ok": True, "data": summary}
    _commit(service, cur, child_id, current, updated, actor_id, "course.sync")
    if action == "courseSync.save" or stored.get("accountId") != account_id or stored.get("contractId") != contract_id:
        _store_settings(cur, scope, {"enabled": True, "points": points, "startDate": start_date,
                                      "accountId": account_id, "contractId": contract_id}, revision)
        summary["revision"] = revision + 1
    if action == 'courseSync.save':
        private_store.put(cur, scope, RECEIPTS, operation_id,
                          {'actorId': actor_id, 'requestHash': request_hash, 'result': summary}, expected_revision=0)
    return {"ok": True, "data": summary}


def refusal_reason(archived, list_complete, contract_error):
    if archived:
        return "archived"
    if contract_error:
        return contract_error
    if not list_complete:
        return "incomplete"
    return None

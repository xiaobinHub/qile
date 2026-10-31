"""Page Demo worker: scoped JSON responses and declarative activity effects only."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import math
import re
import time


DEFAULT_CONFIG = {
    "title": "页面能力 Demo", "pageSize": 5, "multiplier": 1.5,
    "autoRefresh": True, "tone": "默认", "categories": ["日常", "学习"],
    "targetDate": "2030-01-01", "checkpoint": "2030-01-01T12:00:00+08:00",
    "contactEmail": "demo@example.invalid", "referenceURL": "https://example.com",
    "recordBackground": True, "captureEvents": True,
}
FEATURES = ("records", "info", "probe", "slow", "controlled-failure",
            "heartbeat", "task.completed")


def health():
    return {"ok": True}


def _config(context):
    return {**deepcopy(DEFAULT_CONFIG), **deepcopy(context.get("config", {}))}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _info(context):
    # An explicit allowlist is essential: context contains a signed scopeToken.
    return {"ok": True, "pluginId": context["pluginId"], "childId": context["childId"],
            "version": context["version"], "releaseId": context["releaseId"],
            "configRevision": context["configRevision"], "config": _config(context),
            "serverTime": _now(), "features": list(FEATURES)}


def _record_id(prefix, key):
    if not isinstance(key, str) or not 1 <= len(key) <= 240:
        raise ValueError("Demo occurrenceKey 必须为 1–240 字符。")
    if re.fullmatch(r"[A-Za-z0-9_.:@+\-]+", key) is None:
        key = "sha256:" + hashlib.sha256(key.encode()).hexdigest()
    else:
        key = "raw:" + key
    return prefix + ":" + key


def _finite_number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _probe_body(body):
    if not isinstance(body, dict) or set(body) != {"operationId", "message", "value"}:
        raise ValueError("Demo probe 需要 operationId、message 和 value。")
    operation_id, message, value = (body[key] for key in ("operationId", "message", "value"))
    if not isinstance(operation_id, str) or not 8 <= len(operation_id) <= 128:
        raise ValueError("Demo operationId 长度必须为 8–128。")
    if not isinstance(message, str) or not 1 <= len(message) <= 200:
        raise ValueError("Demo message 长度必须为 1–200。")
    if not _finite_number(value):
        raise ValueError("Demo value 必须为有限数值。")
    return operation_id, message, value


def handle_request(context, path, method, body):
    if method == "GET" and path in ("info", "slow"):
        if path == "slow":
            time.sleep(2)
        return _info(context)
    if method == "POST" and path == "fail":
        raise ValueError("Demo 按钮触发的受控错误。")
    if method == "POST" and path == "probe":
        operation_id, message, value = _probe_body(body)
        config = _config(context)
        weighted = value * config["multiplier"]
        if not _finite_number(weighted):
            raise ValueError("Demo 加权结果超出有限数值范围。")
        return {"ok": True, "message": message, "value": value,
                "weightedValue": weighted, "operationId": operation_id,
                "effects": [{"collection": "activity", "id": _record_id("manual", operation_id),
                             "payload": {"kind": "manual", "createdAt": _now(),
                                         "message": message, "value": value, "weightedValue": weighted,
                                         "operationId": operation_id,
                                         "configRevision": context["configRevision"],
                                         "version": context["version"]}}]}
    raise ValueError("Demo 不支持此接口或请求方法。")


def handle_job(context, task, payload):
    config = _config(context)
    if task == "heartbeat":
        if not config["recordBackground"]:
            return {"effects": []}
        kind, message = "heartbeat", "每 60 秒后台心跳，仅记录站内活动。"
    elif task == "event:task.completed":
        if not config["captureEvents"] or payload.get("eventType") != "task.completed":
            return {"effects": []}
        kind, message = "task.completed", "收到任务完成事件，仅记录站内活动。"
    else:
        raise ValueError("Demo 不支持此后台任务。")
    key = payload.get("occurrenceKey")
    record = {"kind": kind, "createdAt": _now(), "message": message,
              "configRevision": context["configRevision"], "version": context["version"],
              "occurrenceKey": key}
    return {"effects": [{"collection": "activity", "id": _record_id(kind, key), "payload": record}]}


def cancel_job(context, job_id):
    return {"cancelled": True, "effects": []}


def shutdown():
    # No resources, threads or permanent timers are owned by this module.
    return None

"""Service Demo worker. Channels are labels; no external notifications are sent."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import math
import re
import time
from zoneinfo import ZoneInfo


WEEKDAYS = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")
DEFAULT_CONFIG = {
    "message": "后台能力 Demo：只记录执行结果，不发送外部消息。", "channel": "站内记录",
    "time": "20:00", "timezone": "Asia/Shanghai", "weekdays": list(WEEKDAYS),
    "batchSize": 1, "multiplier": 1, "recordHeartbeat": True,
    "captureEvents": True, "simulateFailure": False,
}
FEATURES = ("records", "info", "probe", "slow", "controlled-failure",
            "heartbeat", "daily-reminder", "task.completed")


def health():
    return {"ok": True}


def _config(context):
    return {**deepcopy(DEFAULT_CONFIG), **deepcopy(context.get("config", {}))}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _info(context):
    return {"ok": True, "pluginId": context["pluginId"], "childId": context["childId"],
            "version": context["version"], "releaseId": context["releaseId"],
            "configRevision": context["configRevision"], "config": _config(context),
            "serverTime": _now(), "features": list(FEATURES)}


def _record_id(task, key, index=None):
    if not isinstance(key, str) or not 1 <= len(key) <= 240:
        raise ValueError("Demo occurrenceKey 必须为 1–240 字符。")
    if re.fullmatch(r"[A-Za-z0-9_.:@+\-]+", key) is None:
        key = "sha256:" + hashlib.sha256(key.encode()).hexdigest()
    else:
        key = "raw:" + key
    return f"{task}:{key}" + (f":{index}" if index is not None else "")


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
                "effects": [{"collection": "executions", "id": _record_id("manual", operation_id),
                             "payload": {"kind": "manual", "createdAt": _now(),
                                         "message": message, "value": value, "weightedValue": weighted,
                                         "points": value, "weightedPoints": weighted, "batchIndex": 1,
                                         "channel": config["channel"], "operationId": operation_id,
                                         "configRevision": context["configRevision"],
                                         "version": context["version"]}}]}
    raise ValueError("Demo 不支持此接口或请求方法。")


def _event_reference(payload):
    event = payload.get("event")
    if not isinstance(event, dict):
        raise ValueError("Demo task.completed 缺少事件引用。")
    # Keep references and actual numeric points, never the entire event/context.
    reference = {}
    for key in ("occurrenceKey", "taskId", "seriesId", "date"):
        value = event.get(key)
        if isinstance(value, str) and len(value) <= 240:
            reference[key] = value
    points = event.get("points", 0)
    if not _finite_number(points):
        raise ValueError("Demo event points 必须为有限数值。")
    reference["points"] = points
    return reference


def handle_job(context, task, payload):
    config = _config(context)
    if task == "heartbeat":
        if not config["recordHeartbeat"]:
            return {"effects": []}
        kind, event, points = "heartbeat", None, 1
    elif task == "daily-reminder":
        # Delivery/retry time can be days later. Always use scheduled occurrence.
        key = payload.get("occurrenceKey")
        if not isinstance(key, str):
            raise ValueError("Demo 每日任务缺少 occurrence 时间。")
        occurred = datetime.fromisoformat(key.replace("Z", "+00:00"))
        if occurred.tzinfo is None:
            raise ValueError("Demo occurrence 时间必须包含时区。")
        local = occurred.astimezone(ZoneInfo(config["timezone"]))
        if WEEKDAYS[local.weekday()] not in config["weekdays"]:
            return {"effects": []}
        kind, event, points = "daily-reminder", None, 1
    elif task == "event:task.completed":
        if not config["captureEvents"] or payload.get("eventType") != "task.completed":
            return {"effects": []}
        kind = "task.completed"
        event = _event_reference(payload)
        points = event["points"]
    else:
        raise ValueError("Demo 不支持此后台任务。")
    if config["simulateFailure"]:
        raise ValueError("Demo 配置触发的后台失败模拟，由平台重试。")
    weighted = points * config["multiplier"]
    if not _finite_number(weighted):
        raise ValueError("Demo 加权积分超出有限数值范围。")
    key = payload.get("occurrenceKey")
    created_at = _now()
    effects = []
    for index in range(1, config["batchSize"] + 1):
        record = {"kind": kind, "message": config["message"], "channel": config["channel"],
                  "createdAt": created_at, "time": config["time"], "timezone": config["timezone"],
                  "points": points, "weightedPoints": weighted,
                  "batchIndex": index, "occurrenceKey": key,
                  "configRevision": context["configRevision"], "version": context["version"]}
        if event is not None:
            record["event"] = deepcopy(event)
        effects.append({"collection": "executions", "id": _record_id(task, key, index), "payload": record})
    return {"effects": effects}


def cancel_job(context, job_id):
    return {"cancelled": True, "effects": []}


def shutdown():
    return None

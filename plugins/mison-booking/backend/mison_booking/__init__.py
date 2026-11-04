"""Mison booking plugin worker."""

import json


def health():
    return {"ok": True}


def handle_request(context, path, method, body):
    from . import routes
    from .auth import AuthError
    try:
        return routes.handle(context, path, method, body)
    except AuthError as error:
        return routes.PluginError(error.code, str(error), operation_id=error.operation_id).result()
    except routes.PluginError as error:
        return error.result()
    except Exception:
        return {"ok": False, "error": {"code": "UPSTREAM_UNAVAILABLE", "message": "美森服务暂时不可用。", "retry": "read"}}


def _result(data):
    return {"ok": True, "data": data, "requestId": "local", "serverTime": _now()}


def _now():
    from datetime import datetime, timezone, timedelta
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")

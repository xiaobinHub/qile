"""Demonstration only: records an execution; never sends an external message."""
from datetime import datetime, timezone


def health():
    return {"ok": True}


def handle_job(context, task, payload):
    return {"effects": [{"collection": "executions", "id": payload["occurrenceKey"],
                         "payload": {"message": context["config"]["message"],
                                     "executedAt": datetime.now(timezone.utc).isoformat()}}]}


def handle_request(context, path, method, body):
    return {"ok": True}

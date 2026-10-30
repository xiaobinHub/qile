"""Protocol 1.0. Plugin handlers return JSON, optionally declarative record effects.

health() -> dict
handle_request(context, path, method, body) -> dict
handle_job(context, task, payload) -> {"effects": [{"collection": ..., "id": ..., "payload": ...}]}
cancel_job(context, job_id) -> dict  # optional; cancellation is cooperative
shutdown() -> None                 # optional

context is a scoped, server-issued dict. It contains no database credentials.
The platform rechecks all fences before accepting any returned effects.
"""
PROTOCOL_VERSION = "1.0"


def record_effect(collection, record_id, payload):
    return {"collection": collection, "id": record_id, "payload": payload}

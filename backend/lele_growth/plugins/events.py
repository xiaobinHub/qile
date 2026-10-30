"""Transactional core outbox; delivery is deferred until after business commit."""
from __future__ import annotations

import hashlib
import json
from psycopg.types.json import Jsonb
from lele_growth.child_service import ApiError, require
from .policy import active_context, rows_dict


def emit_task_completed(cur, child_id, revision, payload, operation_id):
    """Call only inside the original successful task.completed transaction.

    Event identity follows the business operation, so an idempotent replay cannot
    publish twice. The payload is a minimal task reference, not a child snapshot.
    """
    require(isinstance(payload, dict) and isinstance(operation_id, str) and 1 <= len(operation_id) <= 128, 400)
    require(type(revision) is int and revision >= 0, 400)
    data = {key: payload[key] for key in ('occurrenceKey', 'taskId', 'seriesId', 'date', 'title', 'points') if key in payload}
    require(len(json.dumps(data, allow_nan=False).encode()) <= 8192, 400)
    event_id = hashlib.sha256(('task.completed:' + child_id + ':' + operation_id).encode()).hexdigest()
    cur.execute("INSERT INTO lele.plugin_event_outbox(event_id,child_id,event_type,payload,source_revision) VALUES(%s,%s,'task.completed',%s,%s) ON CONFLICT(event_id) DO NOTHING", (event_id, child_id, Jsonb(data), revision))
    return event_id


class EventDispatcher:
    def __init__(self, service, scheduler):
        self.service, self.scheduler = service, scheduler

    def dispatch(self, *, limit=100):
        require(type(limit) is int and 1 <= limit <= 1000, 400)
        # Explicit per-plugin delivery identities, no shared cursor which could
        # allow a failing plugin to block another plugin's consumption.
        events = self.service.transaction(lambda cur: rows_dict(cur.execute("SELECT o.*,p.id AS plugin_id FROM lele.plugin_event_outbox o JOIN lele.plugin_catalog p ON p.publication_status='published' AND p.operation_state='ready' JOIN lele.plugin_releases r ON r.release_id=p.active_release_id WHERE r.manifest->'events' ? o.event_type AND NOT EXISTS(SELECT 1 FROM lele.plugin_event_deliveries d WHERE d.event_id=o.event_id AND d.plugin_id=p.id) ORDER BY o.created_at,o.event_id,p.id LIMIT %s", (limit,))))
        delivered = 0
        for event in events:
            def work(cur):
                context = active_context(cur, event['plugin_id'], event['child_id'])
                require(event['event_type'] in context['manifest'].get('events', []), 409)
                cur.execute("INSERT INTO lele.plugin_event_deliveries(event_id,plugin_id,generation,config_revision,release_epoch,release_id) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(event_id,plugin_id) DO NOTHING RETURNING event_id", (event['event_id'], event['plugin_id'], context['generation'], context['configRevision'], context['releaseEpoch'], context['releaseId']))
                if cur.fetchone() is None:
                    return 0
                self.scheduler.enqueue_in_transaction(cur, context, 'event:' + event['event_type'], event['event_id'], event['created_at'], {'eventId': event['event_id'], 'eventType': event['event_type'], 'event': event['payload'], 'sourceRevision': event['source_revision'], 'occurrenceKey': event['event_id']})
                return 1
            try:
                delivered += self.service.transaction(work)
            except ApiError as error:
                if error.status >= 500:
                    continue  # Deployment/transient failures pause; never drop events.
                # Ineligible deliveries are durably skipped. They must not
                # replay historical events when a child enables much later.
                def skip(cur):
                    cur.execute("INSERT INTO lele.plugin_event_deliveries(event_id,plugin_id,status) VALUES(%s,%s,'skipped') ON CONFLICT(event_id,plugin_id) DO NOTHING", (event['event_id'], event['plugin_id']))
                self.service.transaction(skip)
        return delivered

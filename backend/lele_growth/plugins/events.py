"""Transactional core outbox; delivery is deferred until after business commit."""
from __future__ import annotations

import hashlib
import json
from psycopg.types.json import Jsonb
from lele_growth.child_service import ApiError, require
from lele_growth.maintenance import PLUGIN_SCHEMA_VERSION
from .policy import load_context, rows_dict


def emit_task_completed(cur, child_id, revision, payload, operation_id):
    """Call only inside the original successful task.completed transaction.

    Event identity follows the business operation, so an idempotent replay cannot
    publish twice. The payload is a minimal task reference, not a child snapshot.
    """
    require(isinstance(payload, dict) and isinstance(operation_id, str) and 1 <= len(operation_id) <= 128, 400)
    require(type(revision) is int and revision >= 0, 400)
    data = {key: payload[key] for key in ('occurrenceKey', 'taskId', 'seriesId', 'date', 'title', 'points') if key in payload}
    require(len(json.dumps(data, allow_nan=False).encode()) <= 8192, 400)
    cur.execute('SELECT max(version) FROM lele.plugin_platform_versions')
    if cur.fetchone()[0] != PLUGIN_SCHEMA_VERSION:
        # Core saves remain available while explicit plugin maintenance is pending.
        return None
    cur.execute('SELECT id FROM lele.children WHERE id=%s FOR UPDATE', (child_id,))
    require(cur.fetchone() is not None, 404, '孩子不存在。')
    # The caller already owns the child transaction. Only read catalog rows:
    # inserting deliveries here would acquire a catalog FK lock in reverse order.
    cur.execute("""SELECT p.id AS plugin_id,cp.generation
        FROM lele.child_plugins cp
        JOIN lele.plugin_catalog p ON p.id=cp.plugin_id
        JOIN lele.plugin_releases r ON r.release_id=p.active_release_id
        JOIN lele.children c ON c.id=cp.child_id
        WHERE cp.child_id=%s AND cp.installed AND cp.enabled AND NOT cp.requires_reenable
          AND p.publication_status='published' AND NOT c.archived AND c.deleted_at IS NULL
          AND (p.scope_mode='all' OR EXISTS(SELECT 1 FROM lele.plugin_scope_children s
               WHERE s.plugin_id=p.id AND s.child_id=cp.child_id))
          AND r.manifest->'events' ? 'task.completed'
        ORDER BY p.id""", (child_id,))
    recipients = [{'pluginId': row['plugin_id'], 'generation': row['generation']}
                  for row in rows_dict(cur)]
    event_id = hashlib.sha256(('task.completed:' + child_id + ':' + operation_id).encode()).hexdigest()
    cur.execute("INSERT INTO lele.plugin_event_outbox(event_id,child_id,event_type,payload,source_revision,recipients) VALUES(%s,%s,'task.completed',%s,%s,%s) ON CONFLICT(event_id) DO NOTHING", (event_id, child_id, Jsonb(data), revision, Jsonb(recipients)))
    return event_id


class EventDispatcher:
    def __init__(self, service, scheduler):
        self.service, self.scheduler = service, scheduler

    def dispatch(self, *, limit=100):
        require(type(limit) is int and 1 <= limit <= 1000, 400)
        # Recipient identities were fixed at emission. Temporarily unavailable
        # releases pause without holding up a different plugin's deliveries.
        events = self.service.transaction(lambda cur: rows_dict(cur.execute("""
            SELECT o.*,p.id AS plugin_id,(recipient->>'generation')::bigint AS recipient_generation
            FROM lele.plugin_event_outbox o
            CROSS JOIN LATERAL jsonb_array_elements(o.recipients) AS recipient
            JOIN lele.plugin_catalog p ON p.id=recipient->>'pluginId'
            WHERE (p.operation_state='ready' OR p.publication_status<>'published')
              AND NOT EXISTS(SELECT 1 FROM lele.plugin_event_deliveries d
                  WHERE d.event_id=o.event_id AND d.plugin_id=p.id)
            ORDER BY o.created_at,o.event_id,p.id LIMIT %s""", (limit,))))
        delivered = 0
        for event in events:
            def work(cur):
                context = load_context(cur, event['plugin_id'], event['child_id'])
                if event['recipient_generation'] != context['generation']:
                    status = 'cancelled'
                elif context['reason'] in ('plugin_updating', 'plugin_failed'):
                    return 0
                elif not context['effective_enabled'] or event['event_type'] not in context['manifest'].get('events', []):
                    status = 'skipped'
                else:
                    status = 'pending'
                cur.execute("INSERT INTO lele.plugin_event_deliveries(event_id,plugin_id,status,generation,config_revision,release_epoch,release_id,cancel_requested) VALUES(%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(event_id,plugin_id) DO NOTHING RETURNING event_id", (event['event_id'], event['plugin_id'], status, event['recipient_generation'], context['configRevision'], context['releaseEpoch'], context['releaseId'], status == 'cancelled'))
                if cur.fetchone() is None:
                    return 0
                if status != 'pending':
                    return 0
                self.scheduler.enqueue_in_transaction(cur, context, 'event:' + event['event_type'], event['event_id'], event['created_at'], {'eventId': event['event_id'], 'eventType': event['event_type'], 'event': event['payload'], 'sourceRevision': event['source_revision'], 'occurrenceKey': event['event_id']})
                return 1
            try:
                delivered += self.service.transaction(work)
            except ApiError as error:
                if error.status >= 500:
                    continue  # Deployment/transient failures pause; never drop events.
                raise
        return delivered

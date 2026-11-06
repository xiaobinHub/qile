"""PostgreSQL leases, bounded retries and fenced declarative effects.

All RPC happens after claim commits. Occurrence keys never include code version.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
import logging
import time
import uuid
import threading
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb
from lele_growth.child_service import ApiError, require
from .policy import active_context, rows_dict, row_dict

RETRY_DELAYS = (10, 30, 120)
UTC = timezone.utc


def utcnow():
    return datetime.now(UTC)


def occurrence(task, config, now):
    """Latest UTC interval or local daily occurrence; no backlog expansion."""
    if 'intervalSeconds' in task:
        seconds = task['intervalSeconds']
        stamp = int(now.timestamp()) // seconds * seconds
        due = datetime.fromtimestamp(stamp, UTC)
        return due.isoformat(), due
    schedule = task.get('schedule', {})
    if isinstance(schedule, str):
        schedule = {'time': schedule}
    require(isinstance(schedule, dict), 400, '不支持的任务计划。')
    clock = config.get(schedule.get('configTime', ''), schedule.get('time', task.get('time', '09:00')))
    tz = config.get(schedule.get('configTimezone', ''), schedule.get('timezone', task.get('timezone', 'Asia/Shanghai')))
    require(isinstance(clock, str) and re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?', clock), 400, '任务时间不正确。')
    zone = ZoneInfo(tz)
    local = now.astimezone(zone)
    parts = list(map(int, clock.split(':')))
    hour, minute = parts[:2]
    second = parts[2] if len(parts) == 3 else 0
    due = local.replace(hour=hour, minute=minute, second=second, microsecond=0)
    if due > local:
        due -= timedelta(days=1)
    return due.isoformat(), due.astimezone(UTC)


class PluginScheduler:
    def __init__(self, service, gateway, *, owner=None, lease_seconds=45, clock=utcnow,
                 schedule_batch_size=100, schedule_budget_seconds=0.5):
        require(type(schedule_batch_size) is int and 1 <= schedule_batch_size <= 1000, 400)
        require(type(schedule_budget_seconds) in (int, float) and 0 < schedule_budget_seconds <= 60, 400)
        self.service, self.gateway = service, gateway
        self.owner = owner or str(uuid.uuid4())
        self.lease_seconds, self.clock = lease_seconds, clock
        self.schedule_errors = {}
        self.schedule_batch_size = schedule_batch_size
        self.schedule_budget_seconds = schedule_budget_seconds
        self.schedule_cursor = None

    def enqueue_in_transaction(self, cur, context, task_id, occurrence_key, due_at, payload=None):
        require(isinstance(task_id, str) and 1 <= len(task_id) <= 128, 400)
        require(isinstance(occurrence_key, str) and 1 <= len(occurrence_key) <= 240, 400)
        require(due_at.tzinfo is not None, 400)
        job_id = str(uuid.uuid4())
        cur.execute('INSERT INTO lele.plugin_jobs(id,plugin_id,child_id,task_id,occurrence_key,due_at,payload,generation,config_revision,release_epoch,release_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(plugin_id,child_id,task_id,occurrence_key) DO NOTHING RETURNING id',
                    (job_id, context['pluginId'], context['childId'], task_id, occurrence_key, due_at, Jsonb(payload or {}), context['generation'], context['configRevision'], context['releaseEpoch'], context['releaseId']))
        created = cur.fetchone()
        if created:
            return created[0]
        cur.execute('SELECT id FROM lele.plugin_jobs WHERE plugin_id=%s AND child_id=%s AND task_id=%s AND occurrence_key=%s',
                    (context['pluginId'], context['childId'], task_id, occurrence_key))
        return cur.fetchone()[0]

    def enqueue(self, plugin_id, child_id, task_id, occurrence_key, due_at, payload=None):
        def work(cur):
            context = active_context(cur, plugin_id, child_id)
            require(any(t['id'] == task_id for t in context['manifest'].get('tasks', [])), 400, '任务未在清单登记。')
            return self.enqueue_in_transaction(cur, context, task_id, occurrence_key, due_at, payload)
        return self.service.transaction(work)

    def schedule_due(self):
        now = self.clock()
        deadline = time.monotonic() + self.schedule_budget_seconds
        cursor = self.schedule_cursor
        query = """SELECT cp.plugin_id,cp.child_id FROM lele.child_plugins cp
            JOIN lele.plugin_catalog p ON p.id=cp.plugin_id
            WHERE cp.installed AND cp.enabled AND NOT cp.requires_reenable
              AND p.publication_status='published' AND p.operation_state='ready'"""
        args = []
        if cursor is not None:
            query += ' AND (cp.plugin_id,cp.child_id)>(%s,%s)'
            args.extend(cursor)
        query += ' ORDER BY cp.plugin_id,cp.child_id LIMIT %s'
        args.append(self.schedule_batch_size)
        pairs = self.service.transaction(lambda cur: rows_dict(cur.execute(query, args)))
        if not pairs:
            self.schedule_cursor = None
            return 0
        count = 0
        for index, pair in enumerate(pairs):
            if index and time.monotonic() >= deadline:
                break
            def work(cur):
                context = active_context(cur, pair['plugin_id'], pair['child_id'])
                created = 0
                for task in context['manifest'].get('tasks', []):
                    key, due = occurrence(task, context['config'], now)
                    self.enqueue_in_transaction(cur, context, task['id'], key, due, {'occurrenceKey': key})
                    created += 1
                return created
            try:
                count += self.service.transaction(work)
            except ApiError:
                pass
            except Exception:
                key = pair['plugin_id']
                moment = time.monotonic()
                if moment - self.schedule_errors.get(key, -60) >= 60:
                    logging.getLogger(__name__).warning('Plugin schedule rejected: %s', key)
                    self.schedule_errors[key] = moment
            finally:
                # Even an invalid instance must not pin later children behind it.
                self.schedule_cursor = (pair['plugin_id'], pair['child_id'])
        else:
            if len(pairs) < self.schedule_batch_size:
                self.schedule_cursor = None
        return count

    def _terminal(self, cur, job_id, status):
        cur.execute("UPDATE lele.plugin_jobs SET status=%s,cancel_requested=cancel_requested OR %s,updated_at=now() WHERE id=%s AND status IN ('pending','retry') RETURNING *",
                    (status, status == 'cancelled', job_id))
        job = row_dict(cur)
        if job:
            self._sync_event(cur, job, status)

    def claim(self, plugin_id=None):
        now = self.clock()
        candidates = self.service.transaction(lambda cur: rows_dict(cur.execute("SELECT id,plugin_id,child_id FROM lele.plugin_jobs WHERE status IN ('pending','retry') AND due_at<=%s AND (%s::text IS NULL OR plugin_id=%s) ORDER BY due_at,id LIMIT 100", (now, plugin_id, plugin_id))))
        for candidate in candidates:
            def work(cur):
                # Policy before job lock; lifecycle cancellation takes the same order.
                try:
                    context = active_context(cur, candidate['plugin_id'], candidate['child_id'])
                except ApiError as error:
                    if error.kind == 'plugin_updating':
                        return None
                    self._terminal(cur, candidate['id'], 'cancelled')
                    return None
                cur.execute("SELECT * FROM lele.plugin_jobs WHERE id=%s AND status IN ('pending','retry') AND due_at<=%s FOR UPDATE SKIP LOCKED", (candidate['id'], now))
                job = row_dict(cur)
                if job is None:
                    return None
                if job['cancel_requested'] or job['generation'] != context['generation'] or job['config_revision'] != context['configRevision']:
                    self._terminal(cur, job['id'], 'cancelled')
                    return None
                task = next((t for t in context['manifest'].get('tasks', []) if t['id'] == job['task_id']), None)
                event = job['task_id'].startswith('event:') and job['payload'].get('eventType') in context['manifest'].get('events', [])
                if task is None and not event:
                    self._terminal(cur, job['id'], 'cancelled')
                    return None
                task = task or {}
                if not event and job['attempt'] == 0 and task.get('misfirePolicy', 'skip') == 'skip' and now - job['due_at'] > timedelta(minutes=5):
                    self._terminal(cur, job['id'], 'skipped')
                    return None
                if not event and task.get('misfirePolicy') == 'latest':
                    cur.execute("SELECT EXISTS(SELECT 1 FROM lele.plugin_jobs WHERE plugin_id=%s AND child_id=%s AND task_id=%s AND due_at>%s AND due_at<=%s AND status IN ('pending','retry','running','succeeded'))", (job['plugin_id'], job['child_id'], job['task_id'], job['due_at'], now))
                    if cur.fetchone()[0]:
                        self._terminal(cur, job['id'], 'skipped')
                        return None
                lease = now + timedelta(seconds=max(self.lease_seconds, task.get('timeoutSeconds', 10) + 5))
                cur.execute("UPDATE lele.plugin_jobs SET status='running',lease_owner=%s,lease_until=%s,attempt=attempt+1,release_id=%s,release_epoch=%s,updated_at=now() WHERE id=%s RETURNING *", (self.owner, lease, context['releaseId'], context['releaseEpoch'], job['id']))
                job = row_dict(cur)
                job['context'] = self.gateway.issue_job_context(context, job['id'], attempt=job['attempt'])
                job['timeoutSeconds'] = task.get('timeoutSeconds', 10)
                self._sync_event(cur, job, 'running', lease=lease)
                return job
            job = self.service.transaction(work)
            if job:
                return job
        return None

    def _sync_event(self, cur, job, status, *, lease=None, result=None):
        event_id = job.get('payload', {}).get('eventId') if job['task_id'].startswith('event:') else None
        if event_id:
            cur.execute('UPDATE lele.plugin_event_deliveries SET status=%s,lease_owner=%s,lease_until=%s,attempt=%s,generation=%s,config_revision=%s,release_epoch=%s,release_id=%s,result=%s,updated_at=now() WHERE event_id=%s AND plugin_id=%s',
                        (status, self.owner if status == 'running' else None, lease, job.get('attempt', 0), job['generation'], job['config_revision'], job['release_epoch'], job['release_id'], Jsonb(result) if result is not None else None, event_id, job['plugin_id']))

    def heartbeat(self, job_id):
        now = self.clock()
        return self.service.transaction(lambda cur: cur.execute("UPDATE lele.plugin_jobs SET lease_until=%s,updated_at=now() WHERE id=%s AND status='running' AND lease_owner=%s AND lease_until>%s AND NOT cancel_requested RETURNING id", (now + timedelta(seconds=self.lease_seconds), job_id, self.owner, now)).fetchone() is not None)

    def complete(self, job, result):
        require(isinstance(result, dict), 502, '应用结果格式不正确。')
        def work(cur):
            current = self.gateway.final_context(cur, job['context'])
            cur.execute("SELECT * FROM lele.plugin_jobs WHERE id=%s FOR UPDATE", (job['id'],))
            row = row_dict(cur)
            require(row and row['status'] == 'running' and row['lease_owner'] == self.owner and row['lease_until'] > self.clock() and not row['cancel_requested'], 409, '任务租约或运行资格已失效。', 'plugin_job_revoked')
            require(row['attempt'] == job['attempt'], 409, '任务已被其他执行接管。', 'plugin_job_revoked')
            effect_key = 'job:' + row['task_id'] + ':' + row['occurrence_key']
            self.gateway.apply_effects(cur, job['context'], result, effect_key=effect_key)
            cur.execute("UPDATE lele.plugin_jobs SET status='succeeded',result=%s,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=%s", (Jsonb(result), row['id']))
            self._sync_event(cur, row, 'succeeded', result=result)
            return {'ok': True, 'jobId': row['id'], 'releaseId': current['releaseId']}
        return self.service.transaction(work)

    def fail(self, job, *, code='plugin_worker_failed', uncertain=False):
        now = self.clock()
        def work(cur):
            cur.execute("SELECT * FROM lele.plugin_jobs WHERE id=%s AND status='running' AND lease_owner=%s AND attempt=%s FOR UPDATE", (job['id'], self.owner, job['attempt']))
            row = row_dict(cur)
            if row is None:
                return False
            status = 'cancelled' if row['cancel_requested'] or code in ('plugin_context_revoked', 'plugin_disabled', 'plugin_requires_reenable', 'plugin_unpublished', 'plugin_out_of_scope', 'child_unavailable', 'plugin_job_revoked') else 'uncertain' if uncertain else 'retry' if row['attempt'] <= len(RETRY_DELAYS) else 'failed'
            delay = RETRY_DELAYS[min(row['attempt'] - 1, len(RETRY_DELAYS) - 1)]
            cur.execute('UPDATE lele.plugin_jobs SET status=%s,due_at=%s,lease_owner=NULL,lease_until=NULL,last_error_code=%s,updated_at=now() WHERE id=%s', (status, now + timedelta(seconds=delay), code, row['id']))
            self._sync_event(cur, row, status)
            return True
        return self.service.transaction(work)

    def reap(self):
        now = self.clock()
        def work(cur):
            cur.execute("SELECT * FROM lele.plugin_jobs WHERE status='running' AND lease_until<=%s ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100", (now,))
            jobs = rows_dict(cur)
            for job in jobs:
                status = 'cancelled' if job['cancel_requested'] else 'uncertain' if job['payload'].get('externalNonIdempotent') else 'retry' if job['attempt'] <= 3 else 'failed'
                delay = RETRY_DELAYS[min(max(job['attempt'] - 1, 0), 2)]
                cur.execute("UPDATE lele.plugin_jobs SET status=%s,due_at=%s,lease_owner=NULL,lease_until=NULL,last_error_code='lease_expired',updated_at=now() WHERE id=%s", (status, now + timedelta(seconds=delay), job['id']))
                self._sync_event(cur, job, status)
            return len(jobs)
        return self.service.transaction(work)

    def run_one(self, plugin_id=None):
        job = self.claim(plugin_id)
        if not job:
            return False
        payload = {**job['payload'], 'occurrenceKey': job['occurrence_key']}
        stopped = threading.Event()
        def renew():
            while not stopped.wait(max(0.1, min(10, self.lease_seconds / 3))):
                try:
                    if not self.heartbeat(job['id']):
                        self.gateway.runtime.call(job['context'], 'cancel_job', {'jobId': job['id']})
                        return
                except ApiError:
                    # The final transaction still rejects any expired lease.
                    return
        heartbeat = threading.Thread(target=renew, daemon=True)
        heartbeat.start()
        try:
            result = self.gateway.runtime.call(job['context'], 'handle_job', {'task': job['task_id'], 'payload': payload}, timeout=job['timeoutSeconds'])
            if result.get('uncertain') is True:
                self.fail(job, code='external_result_uncertain', uncertain=True)
            else:
                self.complete(job, result)
        except ApiError as error:
            self.fail(job, code=error.kind or 'plugin_execution_failed', uncertain=bool(job['payload'].get('externalNonIdempotent')))
        except Exception:
            self.fail(job, code='plugin_execution_failed', uncertain=bool(job['payload'].get('externalNonIdempotent')))
        finally:
            stopped.set()
            heartbeat.join(timeout=0.2)
        return True

    def tick(self):
        self.reap()
        self.schedule_due()
        return self.run_one()

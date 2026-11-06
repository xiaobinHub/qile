"""Preview/apply one verified incomplete cancellation in local lele_dev only.

Always uses the normal host resolver/transaction. Refuses any other business
change, including points, task updates or additions. No upstream mutations,
credential invalidation, login, production config or blanket SQL deletion.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'backend'), str(ROOT/'plugins/mison-booking/backend'), str(ROOT/'packages/plugin-sdk-python/src')]

from lele_growth.child_service import ApiError, ChildService, require
from lele_growth.course_sync import SHANGHAI, is_mison
from lele_growth.course_sync_host import handle
from lele_growth.course_sync_identity import reconcile_identified
from lele_growth import course_sync_identity_store as identity_store
from lele_growth.plugins.credential_vault import CredentialVault
from lele_growth.plugins.gateway import ContextSigner
from lele_growth.plugins.policy import active_context, assert_fences
from lele_growth.plugins.private_bridge import PluginBridge
from mison_booking.auth import AuthError
from mison_booking.course_sync import collect_lessons
from mison_booking.upstream import Client

PLUGIN = 'mison-booking'


class ReadOnlyClient(Client):
    def mutate(self, *args, **kwargs):
        raise RuntimeError('Repair tool rejects all upstream writes')

    def expired(self):
        raise AuthError('RECONNECT_REQUIRED', '保存的登录已过期；本工具不会重新登录或修改凭据。')


def check_delta(before, after, task_id):
    """Accept exactly one task deletion, or an already-repaired no-op."""
    target = next((row for row in before['series'] if row['id'] == task_id), None)
    expected = copy.deepcopy(before)
    expected['series'] = [row for row in expected['series'] if row['id'] != task_id]
    require(after == expected, 409, '预览包含目标之外的任务、积分或历史变更，拒绝执行。', 'REPAIR_SCOPE_CHANGED')
    return target is not None


def repair(child_id, cid, day, *, apply=False, expected_revision=None):
    service = ChildService(ROOT/'data/development/config.json')
    config = service.config
    require(config['environment'] == 'development' and config['_connect']['dbname'] == 'lele_dev'
            and config['_connect']['host'] in ('127.0.0.1', 'localhost', '::1'),
            400, '修复仅允许本机 development / lele_dev。', 'REPAIR_ENVIRONMENT')
    require(not apply or type(expected_revision) is int, 400, '执行修复必须提供预览的业务修订号。', 'REPAIR_REVISION_REQUIRED')
    scope = service.transaction(lambda cur: active_context(cur, PLUGIN, child_id))
    context = ContextSigner().issue(scope, actor=scope['owner_id'])
    bridge = PluginBridge(service, CredentialVault(ROOT/'data/development/plugin-vault.txt'))
    settings = bridge.handle(context, 'courseSync.get', {})['data']
    require(settings['enabled'], 409, '当前没有启用课程同步，拒绝修改。', 'REPAIR_SYNC_DISABLED')
    session = bridge.handle(context, 'session.get', {})['data']
    require(session['status'] == 'connected', 409, '保存的登录不可用；未重新登录。', 'RECONNECT_REQUIRED')
    client = object.__new__(ReadOnlyClient)
    client.context, client.session = context, session
    client.userid = int(session['userid'])
    client.scope = (child_id, session['bindingRevision'], session['credentialId'])
    client.deadline = time.monotonic() + 45
    lessons, contract = collect_lessons(client)
    payload = {'courses': lessons, 'accountId': str(session['userid']), 'contractId': contract['id'],
        'bindingRevision': session['bindingRevision'], 'credentialId': session['credentialId'],
        'credentialRevision': session['credentialRevision'], 'listComplete': True,
        'snapshotRevision': settings['snapshotRevision'], 'settingsRevision': settings['revision'],
        'points': settings['points'], 'startDate': settings['startDate']}

    def work(cur):
        current_scope = active_context(cur, PLUGIN, child_id)
        assert_fences(current_scope, context)
        require(current_scope['owner_id'] == context['actorId'],
                409, '儿童负责人已改变，必须重新预览。', 'REPAIR_OWNER_CHANGED')
        cur.execute("""SELECT 1 FROM lele.memberships m JOIN lele.users u ON u.id=m.user_id
WHERE m.child_id=%s AND m.user_id=%s AND u.status='active'""", (child_id, context['actorId']))
        require(cur.fetchone() is not None, 403, '负责人账号或成员资格已改变。', 'OWNER_REQUIRED')
        current = service.store.read(cur, child_id, locked=True)
        require(expected_revision is None or current['revision'] == expected_revision,
                409, '业务数据已改变，必须重新预览。', 'REPAIR_REVISION_CHANGED')
        # The stable task ID is still CID-based; never replace this identity.
        from lele_growth.course_sync import series_id
        task_id = series_id(payload['accountId'], payload['contractId'], cid)
        target = next((row for row in current['data']['series'] if row['id'] == task_id), None)
        require(target is None or is_mison(target) and target['startDate'] == day,
                409, '目标课程身份或日期已改变。', 'REPAIR_TARGET_CHANGED')
        before_identities = identity_store.load(cur, current_scope, payload['accountId'], payload['contractId'])
        updated, _, records = reconcile_identified(current['data'], lessons,
            associations={key: record['payload'] for key, record in before_identities.items()},
            account_id=payload['accountId'], contract_id=payload['contractId'], points=settings['points'],
            start_date=settings['startDate'], now=datetime.now(SHANGHAI))
        pending = check_delta(current['data'], updated, task_id)
        require(not pending or records.get(cid, {}).get('cancelReason') == 'cancelled',
                409, '未能唯一确认目标课程已经取消。', 'REPAIR_CANCEL_UNCONFIRMED')
        preview = handle(service, cur, current_scope, context, 'courseSync.preview', payload)['data']
        output = {'environment': 'development', 'database': 'lele_dev', 'applied': False,
                  'revision': current['revision'], 'targetCid': cid, 'targetDate': day,
                  'targetPresent': pending, 'summary': preview}
        if not apply or not pending:
            return output
        folder = ROOT/'data/development/repairs'
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = folder/f'mison-{cid}-revision-{current["revision"]}-{time.time_ns()}.json'
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as backup:
            json.dump({'childId': child_id, 'revision': current['revision'], 'data': current['data'],
                       'identities': before_identities}, backup, ensure_ascii=False, indent=2)
        result = handle(service, cur, current_scope, context, 'courseSync.run', payload)['data']
        require(result['state'] == 'synced' and result['removed'] == 1 and result['clawback'] == 0
                and result['points'] == 0, 409, '修复结果超出预览，事务已回滚。', 'REPAIR_RESULT_CHANGED')
        saved = service.store.read(cur, child_id, locked=True)
        business = copy.deepcopy(saved['data'])
        business['operationLog'] = current['data'].get('operationLog', [])
        check_delta(current['data'], business, task_id)
        # Idempotency also goes through the normal host path and the saved tombstone.
        _, next_revision = identity_store.snapshot(cur, current_scope)
        repeated = handle(service, cur, current_scope, context, 'courseSync.run',
                          {**payload, 'snapshotRevision': next_revision})['data']
        require(repeated['state'] == 'synced' and service.store.read(cur, child_id)['data'] == saved['data'],
                409, '重复同步改变了修复结果，事务已回滚。', 'REPAIR_NOT_IDEMPOTENT')
        service.audit(cur, context['actorId'], 'course.sync.repair', child_id,
                      {'cid': cid, 'date': day, 'beforeRevision': current['revision'], 'removed': 1})
        output.update(applied=True, revision=saved['revision'], backup=str(path), repeatedSummary=repeated)
        return output

    return service.transaction(work)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--child-id', required=True)
    parser.add_argument('--cid', required=True)
    parser.add_argument('--date', required=True)
    parser.add_argument('--expected-revision', type=int)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        result = repair(args.child_id, args.cid, args.date, apply=args.apply, expected_revision=args.expected_revision)
    except (ApiError, AuthError) as error:
        print(json.dumps({'error': getattr(error, 'kind', None) or getattr(error, 'code', None),
                          'message': getattr(error, 'error', None) or str(error)}, ensure_ascii=False))
        raise SystemExit(1) from None
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()

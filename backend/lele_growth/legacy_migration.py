"""One-time, offline v1 business migration into an empty production v4 database.

No old snapshots/request logs are imported; the immutable source record is kept
outside the database. Upload keys are deterministic so an interrupted run can be
retried without overwriting existing business data or creating duplicate images.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import stat
import uuid

from psycopg.types.json import Jsonb

from lele_growth.child_service import require
from lele_growth.media_types import transform_images, referenced_assets
from lele_growth.postgres_store import canonical_bytes, canonical_sha256, validate_record, PostgresStore
from lele_growth.production_maintenance import production_service, target_details


def read_source(path, expected_sha256):
    path = Path(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077 and info.st_uid == os.geteuid(),
            403, '迁移来源必须为当前用户拥有的私有普通文件（0600）。')
    record = json.loads(path.read_text())
    validate_record(record)
    require(canonical_sha256(record) == expected_sha256, 409, '来源摘要不匹配，迁移停止。')
    require(not list(referenced_assets(record)), 409, '旧版来源应为自包含图片，不能引用其他环境的文件。')
    return record


def migrate_record(service, record, owner_id, *, expected_sha256, apply=False, confirm=None):
    require(service.config['environment'] == 'production', 403, '该入口仅用于明确的生产迁移。')
    target = target_details(service)
    require(not apply or confirm == target['targetId'], 403, '执行前必须确认预览的目标 targetId。')
    validate_record(record)
    require(canonical_sha256(record) == expected_sha256, 409, '来源摘要不匹配。')
    require(not list(referenced_assets(record)), 409, '来源不能包含其他环境的图片引用。')
    namespace = 'lele-production-migration:' + target['targetId'] + ':' + expected_sha256
    child_id = str(uuid.uuid5(uuid.NAMESPACE_URL, namespace))
    images = {}
    def store(image):
        asset = str(uuid.uuid5(uuid.NAMESPACE_URL, namespace + ':' + image.sha256))
        images[asset] = image
        return asset
    prepared = transform_images(record, store)
    require(not images or (service.config['_object_storage'] or {}).get('provider') == 'oss', 409, '迁移图片需要私有生产 OSS 配置。')
    def preflight(cur):
        cur.execute("SELECT id FROM lele.users WHERE id=%s AND role='parent' AND status='active'", (owner_id,))
        require(cur.fetchone() is not None, 409, '需要有效的生产家长账号作为孩子管理员。')
        cur.execute('SELECT child_id FROM lele.migration_runs WHERE source_sha256=%s', (expected_sha256,))
        previous = cur.fetchone()
        if previous:
            require(previous[0] == child_id, 409, '来源已被另一迁移使用，停止。')
            rebuilt = service.store.read(cur, child_id)
            require(canonical_bytes(rebuilt) == canonical_bytes(prepared), 409, '目标已发生变化，不允许重复导入覆盖。')
            return True
        cur.execute('SELECT EXISTS(SELECT 1 FROM lele.children)')
        require(not cur.fetchone()[0], 409, '生产迁移只允许无孩子数据的独立目标库。')
        return False
    previous = service.transaction(preflight, exclusive=True)
    summary = {'target': target, 'sourceSha256': expected_sha256, 'revision': record['revision'],
               'counts': PostgresStore._counts(record['data']), 'images': len(images), 'childId': child_id,
               'balance': sum(row['amount'] for row in record['data']['ledger']),
               'normalizedSha256': canonical_sha256(prepared)}
    if not apply:
        return {'dryRun': True, 'alreadyImported': previous, **summary}
    if not previous:
        for image in images.values():
            service.media.objects.put(service.media.objects.key(child_id, image), image)
        def commit(cur):
            if preflight(cur):
                return False
            service.create_child(cur, owner_id, record['data']['settings']['childName'], copy.deepcopy(prepared),
                                 child_id=child_id, media_images=images)
            rebuilt = service.store.read(cur, child_id)
            require(canonical_bytes(rebuilt) == canonical_bytes(prepared), 409, '迁移后业务内容不一致，已回滚。')
            cur.execute('INSERT INTO lele.migration_runs(child_id,source_sha256,source_revision,source_updated_at_raw,target_revision,migrated_at,entity_counts,business_sha256,db_schema_version) VALUES(%s,%s,%s,%s,%s,now(),%s,%s,4)',
                        (child_id, expected_sha256, record['revision'], record['updatedAt'], record['revision'],
                         Jsonb(summary['counts']), canonical_sha256(record['data'])))
            service.audit(cur, owner_id, 'migration.production.legacy', child_id,
                          {'sourceSha256': expected_sha256, 'sourceRevision': record['revision'],
                           'normalizedSha256': summary['normalizedSha256'], 'images': len(images), 'targetId': target['targetId']})
            return True
        created = service.transaction(commit, exclusive=True)
    else:
        created = False
    # Read every uploaded image again; a committed record is never reported as
    # verified merely because a PUT returned success.
    for image in images.values():
        require(service.media.objects.get(service.media.objects.key(child_id, image), image.sha256) == image.content,
                503, '迁移图片读回核验失败；业务数据已保留，请检查存储。')
    return {'dryRun': False, 'imported': created, 'verified': True, **summary}


def main(argv=None):
    import argparse
    import psycopg
    from lele_growth.child_service import ApiError
    from lele_growth.storage import StoreError
    parser = argparse.ArgumentParser(description='旧生产 v1 数据迁入独立新版库；默认只预览，不覆盖。')
    parser.add_argument('--config', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--source-sha256', required=True)
    parser.add_argument('--owner-id', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--confirm')
    args = parser.parse_args(argv)
    try:
        record = read_source(args.source, args.source_sha256)
        result = migrate_record(production_service(args.config), record, args.owner_id,
                                expected_sha256=args.source_sha256, apply=args.apply, confirm=args.confirm)
        print(json.dumps(result, ensure_ascii=False))
    except (ApiError, StoreError) as error:
        parser.exit(1, str(error) + '\n')
    except (OSError, ValueError, psycopg.Error):
        parser.exit(1, '迁移失败；请检查私有文件、目标配置及连接，保留来源后重新预览核验。\n')

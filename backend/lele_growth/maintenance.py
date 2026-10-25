"""Internal maintenance primitives. Public callers must authorize their environment."""
from __future__ import annotations

import hashlib
from pathlib import Path

import psycopg

from lele_growth.child_service import (
    PASSWORDS, USER_COLUMNS, identity, login_value, password_value,
    public_user, require, text_value,
)
from lele_growth.postgres_store import PostgresStore


def schema_sources(*, include_ledger_date=True):
    directory = Path(__file__).with_name('db')
    source = (directory / 'schema_v2.sql').read_text()
    migration = (directory / 'migrate_v2_to_v3.sql').read_text()
    media = (directory / 'migrate_v3_to_v4.sql').read_text()
    avatars = (directory / 'migrate_v4_to_v5.sql').read_text()
    texts = {2: source, 3: source + '\n' + migration, 4: source + '\n' + migration + '\n' + media}
    texts[5] = texts[4] + '\n' + avatars
    texts[6] = texts[5] + '\n' + (directory / 'migrate_v5_to_v6.sql').read_text()
    if include_ledger_date:
        texts[6] += '\n' + (directory / 'add_points_ledger_task_date.sql').read_text()
    return source, migration, media, {version: hashlib.sha256(text.encode()).hexdigest() for version, text in texts.items()}


def schema_version(cur):
    """Refuse even known version numbers if SQL/catalog fingerprints differ."""
    cur.execute("SELECT obj_description(oid,'pg_namespace') FROM pg_namespace WHERE nspname='lele'")
    namespace = cur.fetchone()
    if namespace is None:
        return None
    hashes = schema_sources()[3]
    catalog = PostgresStore._catalog(cur)
    matches = [v for v, h in hashes.items() if namespace[0] == f'lele-schema-v{v}:{h}:{catalog}']
    # Accept the known development v6 schema so the table-only addition can be applied.
    legacy_v6 = schema_sources(include_ledger_date=False)[3][6]
    if namespace[0] == f'lele-schema-v6:{legacy_v6}:{catalog}':
        matches.append(6)
    require(len(matches) == 1, 409, '检测到未知数据库结构，升级停止。')
    version = matches[0]
    cur.execute('SELECT version FROM lele.schema_versions')
    require(cur.fetchall() == [(version,)], 409, '数据库版本与结构标记不一致，升级停止。')
    return version


def inspect_schema(service):
    def run(cur):
        version = schema_version(cur)
        users = 0
        if version is not None:
            cur.execute('SELECT count(*) FROM lele.users')
            users = cur.fetchone()[0]
        pending = []
        if version == 6:
            cur.execute("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='lele' AND table_name='points_ledger' AND column_name='task_date')")
            if not cur.fetchone()[0]:
                pending.append('points_ledger.task_date')
        return {'version': version, 'users': users, 'pendingTableChanges': pending}
    return service.transaction(run, exclusive=True, schema_check=False)


def initialize_service(service, *, upgrade_only=False, audit_detail=None):
    source, migration, media, hashes = schema_sources()
    def run(cur):
        previous = schema_version(cur)
        if previous == 6:
            cur.execute("SELECT obj_description(oid,'pg_namespace') FROM pg_namespace WHERE nspname='lele'")
            if cur.fetchone()[0].startswith(f'lele-schema-v6:{hashes[6]}:'):
                return {'initialized': False, 'upgraded': False, 'version': 6}
        if previous is None:
            require(not upgrade_only, 409, '数据库尚未初始化，请先执行 initialize。')
            cur.execute(source)
        if previous in (None, 2):
            cur.execute(migration)
        if previous in (None, 2, 3):
            cur.execute(media)
        if previous in (None, 2, 3, 4):
            cur.execute((Path(__file__).with_name('db') / 'migrate_v4_to_v5.sql').read_text())
        if previous in (None, 2, 3, 4, 5):
            cur.execute((Path(__file__).with_name('db') / 'migrate_v5_to_v6.sql').read_text())
        cur.execute((Path(__file__).with_name('db') / 'add_points_ledger_task_date.sql').read_text())
        marker = f'lele-schema-v6:{hashes[6]}:{PostgresStore._catalog(cur)}'
        cur.execute(psycopg.sql.SQL('COMMENT ON SCHEMA lele IS {}').format(psycopg.sql.Literal(marker)))
        result = {'initialized': previous is None, 'upgraded': previous is not None, 'version': 6}
        if audit_detail is not None:
            service.audit(cur, None, 'maintenance.schema.initialize' if previous is None else 'maintenance.schema.upgrade',
                          detail={**audit_detail, 'fromVersion': previous, 'toVersion': 6})
        return result
    return service.transaction(run, exclusive=True, schema_check=False)


def bootstrap_service(service, login_name, nickname, password, *, audit_detail=None):
    # Hash/validate before locking; the empty-user precondition is rechecked under
    # the same account gate used by all account creation requests.
    login, name = login_value(login_name), text_value(nickname)
    encoded = PASSWORDS.hash(password_value(password))
    def run(cur):
        require(schema_version(cur) == 6, 409, '请先初始化或升级数据库。')
        cur.execute('SELECT EXISTS(SELECT 1 FROM lele.users)')
        require(not cur.fetchone()[0], 409, '已有账号，不能重复引导管理员。')
        uid = identity()
        cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES(%s,%s,%s,%s,'admin','active') RETURNING " + USER_COLUMNS,
                    (uid, login, name, encoded))
        result = public_user(cur.fetchone())
        service.audit(cur, uid, 'bootstrap.admin', detail=audit_detail)
        return result
    return service.transaction(run, exclusive=True)

"""Explicit offline production operations, never invoked by the web application."""
from __future__ import annotations

import getpass
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

from lele_growth.child_service import ChildService, require
from lele_growth.maintenance import bootstrap_service, initialize_service, inspect_schema
from lele_growth.media_migration import cleanup_service

ACTIONS = ('initialize', 'upgrade', 'bootstrap-admin', 'cleanup-staged')


def production_service(config_path):
    path = Path(config_path).expanduser()
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077
            and info.st_uid == os.geteuid(), 403, '维护配置必须为当前用户拥有的私有普通文件（0600），不允许符号链接。')
    service = ChildService(path)
    require(service.config['environment'] == 'production', 403, '生产维护入口只接受 production 配置；本地开发请使用开发工具。')
    return service


def target_details(service):
    cfg = service.config
    db = cfg['_connect']
    storage = cfg['_object_storage'] or {}
    details = {
        'database': {key: db[key] for key in ('host', 'port', 'dbname', 'user', 'sslmode')},
        'parentOrigin': cfg['parent_origin'], 'adminOrigin': cfg['admin_origin'],
        'objects': {key: storage[key] for key in ('provider', 'endpoint', 'bucket', 'prefix') if key in storage},
    }
    fingerprint = hashlib.sha256(json.dumps(details, sort_keys=True).encode()).hexdigest()[:24]
    return {'targetId': fingerprint, **details}


def execute(service, action, *, apply=False, confirm=None, login_name=None, nickname=None, password=None):
    require(service.config['environment'] == 'production', 403, '需要 production 配置。')
    require(action in ACTIONS, 400, '维护操作不正确。')
    target = target_details(service)
    if apply:
        require(confirm == target['targetId'], 403, '执行前必须使用预览中的 targetId 明确确认当前目标。')
    if action == 'cleanup-staged':
        require((service.config['_object_storage'] or {}).get('provider') == 'oss', 409, '生产暂存清理需要有效的私有 OSS 配置。')
    status = inspect_schema(service)
    if action in ('bootstrap-admin', 'cleanup-staged'):
        require(status['version'] == 6, 409, '请先初始化或升级数据库至 v6。')
    if action == 'upgrade':
        require(status['version'] is not None, 409, '数据库尚未初始化，请先执行 initialize。')
    if action == 'bootstrap-admin':
        require(status['users'] == 0, 409, '已有账号，不能重复引导管理员。')
    if not apply:
        result = {'schema': status}
        if action == 'cleanup-staged':
            result.update(cleanup_service(service, apply=False))
        return {'dryRun': True, 'action': action, 'target': target, **result}
    detail = {'targetId': target['targetId'], 'operator': getpass.getuser(), 'pid': os.getpid()}
    if action in ('initialize', 'upgrade'):
        result = initialize_service(service, upgrade_only=action == 'upgrade', audit_detail=detail)
    elif action == 'bootstrap-admin':
        result = {'user': bootstrap_service(service, login_name, nickname, password, audit_detail=detail)}
    else:
        result = cleanup_service(service, apply=True, audit_detail=detail)
    return {'dryRun': False, 'action': action, 'target': target, **result}


def main(argv=None):
    import argparse
    import psycopg
    from lele_growth.child_service import ApiError
    from lele_growth.storage import StoreError
    parser = argparse.ArgumentParser(description='离线生产维护；默认仅预览。执行需 --apply --confirm TARGET_ID。')
    parser.add_argument('action', choices=ACTIONS)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--confirm')
    parser.add_argument('--login-name')
    parser.add_argument('--nickname')
    args = parser.parse_args(argv)
    try:
        service = production_service(args.config)
        password = None
        if args.action == 'bootstrap-admin' and args.apply:
            # Target and empty-database checks happen before asking for a secret.
            require(args.confirm == target_details(service)['targetId'], 403, '请先预览并确认目标 targetId。')
            execute(service, args.action)
            require(args.login_name and args.nickname, 400, '需要 --login-name 和 --nickname。')
            require(sys.stdin.isatty(), 400, '管理员密码只能在交互终端中输入，禁止参数、管道或日志传递。')
            password = getpass.getpass('管理员初始密码：')
            require(password == getpass.getpass('再次输入初始密码：'), 400, '两次输入的密码不一致。')
        result = execute(service, args.action, apply=args.apply, confirm=args.confirm,
                         login_name=args.login_name, nickname=args.nickname, password=password)
        print(json.dumps(result, ensure_ascii=False))
    except (ApiError, StoreError) as error:
        parser.exit(1, str(error) + '\n')
    except (OSError, ValueError, psycopg.Error):
        # Connection exceptions and filenames may contain secrets; never print them.
        parser.exit(1, '维护失败：请检查私有配置、数据库连接和执行权限；操作结果不明确时先预览核验。\n')

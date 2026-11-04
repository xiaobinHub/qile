#!/usr/bin/env python3
"""Control an existing local plugin runtime; never deploy or print credentials."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('register', 'reload', 'stop', 'status'):
        sub = commands.add_parser(command)
        sub.add_argument('plugin_id')
        if command in ('reload', 'stop'):
            sub.add_argument('--session')
        if command == 'register':
            sub.add_argument('--port', type=int, required=True)
            sub.add_argument('--session', required=True)
            sub.add_argument('--pid', type=int, required=True)
            sub.add_argument('--with-backend', action='store_true')
    args = parser.parse_args(argv)
    from lele_growth.child_service import ApiError, load_config
    from lele_growth.plugins.dev_mode import DevRegistry
    from lele_growth.plugins.supervisor import RuntimeClient
    try:
        config = load_config(ROOT / 'data/development/config.json')
        registry = DevRegistry(config)
        registry.guard()
        registry.path(args.plugin_id)
        # Match scripts/dev.py exactly. Do not rebuild its config or replace
        # process environment: vault keys and bridge credentials stay intact.
        runtime_root = ROOT / 'data/development/plugin-runtime'
        client = RuntimeClient(runtime_root)
        client.sockets = ROOT / 'data/development/plugin-sockets'
        body = {'pluginId': args.plugin_id}
        if args.command in ('reload', 'stop') and args.session is not None:
            body['sessionId'] = args.session
        if args.command == 'register':
            body.update(port=args.port, sessionId=args.session, pid=args.pid, backend=args.with_backend)
        result = client._request('/dev-' + args.command, body, timeout=370)
        data = result.get('development')
        public = None if data is None else {key: data[key] for key in
                  ('pluginId', 'sessionId', 'revision', 'port', 'backend', 'state', 'errorKind') if key in data}
        print(json.dumps({'ok': True, 'development': public}, ensure_ascii=False))
        return 0
    except ApiError as error:
        # Remote exceptions are sanitized by the private transport.
        print(json.dumps({'ok': False, 'kind': error.kind or 'plugin_dev_failed', 'error': error.error,
                          'logHint': '开发后台日志仅保存在本机私有目录 data/development/plugin-dev/environments/<插件ID>/<会话ID>/worker.log'}, ensure_ascii=False), file=sys.stderr)
    except Exception:
        print(json.dumps({'ok': False, 'kind': 'plugin_dev_unavailable',
                          'error': '本机开发运行服务不可用，请先运行 .venv/bin/python scripts/dev.py start。'}, ensure_ascii=False), file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())

"""Offline single-plugin deployment operator; preview by default."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))


def main(argv=None):
    import argparse
    import getpass
    import json
    import psycopg
    from lele_growth.child_service import ApiError, ChildService
    from lele_growth.plugins.deployment import PluginDeployment
    from lele_growth.production_maintenance import production_service
    from lele_growth.storage import StoreError
    parser = argparse.ArgumentParser(description='独立插件运维；默认预览，执行需 --apply --confirm TARGET_ID。')
    parser.add_argument('action', choices=('inspect', 'deploy', 'rollback', 'recover'))
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--package', type=Path)
    parser.add_argument('--plugin')
    parser.add_argument('--version')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--confirm')
    args = parser.parse_args(argv)
    try:
        service = ChildService(args.config)
        if service.config['environment'] == 'production':
            service = production_service(args.config)
        manager = PluginDeployment(service, actor=getpass.getuser())
        result = manager.execute(args.action, package=args.package, plugin_id=args.plugin, version=args.version,
                                 apply=args.apply, confirm=args.confirm)
        print(json.dumps(result, ensure_ascii=False))
    except (ApiError, StoreError) as error:
        parser.exit(1, str(error) + '\n')
    except (OSError, ValueError, psycopg.Error):
        parser.exit(1, '插件运维失败；请检查配置和目标，结果不明确时先预览核验。\n')


if __name__ == '__main__':
    main()

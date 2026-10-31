"""Read-only local operator view of a single child's Demo records, even after uninstall."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def main():
    from lele_growth.child_service import ChildService, load_config

    parser = argparse.ArgumentParser(description="只读查看本机 Demo 执行结果，不安装、启用或触发任务。")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--plugin", choices=("demo-page", "demo-service"), required=True)
    parser.add_argument("--child", required=True)
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error("limit 必须为 1–100。")
    config = load_config(args.config)
    database = config["database"]
    if (config["environment"] != "development"
            or database.get("host") not in ("localhost", "127.0.0.1", "::1")
            or not (database.get("dbname") == "lele_dev"
                    or database.get("dbname", "").startswith("lele_test"))):
        parser.error("此工具仅允许本机 lele_dev / lele_test* 开发与测试库。")
    service = ChildService(args.config)
    if service.config["database"] != database or service.config["environment"] != "development":
        parser.error("配置在读取期间发生变化，请重新核对目标。")

    def read(cur):
        cur.execute("SELECT current_database()")
        if cur.fetchone()[0] != database["dbname"]:
            raise RuntimeError("数据库目标不一致。")
        cur.execute("SELECT id,name,publication_status,operation_state FROM lele.plugin_catalog WHERE id=%s",
                    (args.plugin,))
        plugin = cur.fetchone()
        if not plugin:
            return {"pluginId": args.plugin, "childId": args.child, "registered": False, "records": []}
        cur.execute("SELECT installed,enabled,requires_reenable FROM lele.child_plugins WHERE plugin_id=%s AND child_id=%s",
                    (args.plugin, args.child))
        installation = cur.fetchone()
        cur.execute("SELECT collection,record_id,payload,revision,updated_at FROM lele.child_plugin_records "
                    "WHERE plugin_id=%s AND child_id=%s ORDER BY updated_at DESC,record_id LIMIT %s",
                    (args.plugin, args.child, args.limit))
        records = [dict(collection=row[0], id=row[1], payload=row[2], revision=row[3], updatedAt=row[4].isoformat())
                   for row in cur.fetchall()]
        return {"pluginId": plugin[0], "name": plugin[1], "publicationStatus": plugin[2],
                "operationState": plugin[3], "childId": args.child,
                "installation": dict(zip(("installed", "enabled", "requiresReenable"), installation)) if installation else None,
                "records": records}

    print(json.dumps(service.transaction(read), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

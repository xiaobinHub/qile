"""Recreate only the two full Demo fixtures; passwords arrive on stdin, never stdout.

Called by tests/browser/demo_plugins_acceptance.cjs after it reserves both ports.
This is intentionally independent of the minimal-example browser fixtures.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import uuid

import psycopg
from psycopg import sql

from lele_growth.child_service import ChildService, bootstrap, initialize, load_config
from lele_growth.maintenance import initialize_plugin_platform
from lele_growth.plugins.catalog import register_release
from lele_growth.plugins.deployment import inspect_package, prepare_release

ROOT = Path(__file__).resolve().parents[3]
DATABASE = "lele_test_demo_plugins"
FOLDER = ROOT / "data/testing/demo-plugins"
IDS = ("demo-page", "demo-service")


def main():
    passwords = json.load(sys.stdin)
    assert set(passwords) == {"initial", "admin", "dad", "mom"}
    assert all(isinstance(value, str) and len(value) >= 16 for value in passwords.values())
    # Refuse symlinks at every level, before writing config or removing runtime.
    assert all(not part.is_symlink() for part in [FOLDER, *FOLDER.parents])
    FOLDER.mkdir(parents=True, exist_ok=True, mode=0o700)
    FOLDER.chmod(0o700)
    base = load_config(ROOT / "data/development/config.json")
    assert base["environment"] == "development"
    connect = {**base["_connect"], "dbname": DATABASE}
    assert DATABASE == "lele_test_demo_plugins"
    with psycopg.connect(**{**connect, "dbname": "postgres"}, autocommit=True) as conn:
        if not conn.execute("SELECT 1 FROM pg_database WHERE datname=%s", (DATABASE,)).fetchone():
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(DATABASE)))
    config = {key: value for key, value in base.items() if not key.startswith("_")}
    config.update(
        database={**base["database"], "dbname": DATABASE},
        parent_origin="http://127.0.0.1:19087",
        admin_origin="http://127.0.0.1:19088",
        object_storage={"provider": "test-filesystem", "root": str(FOLDER / "objects")},
    )
    config_path = FOLDER / "config.json"
    assert not config_path.is_symlink()
    config_path.write_text(json.dumps(config))
    config_path.chmod(0o600)
    with psycopg.connect(**connect) as conn:
        assert conn.execute("SELECT current_database()").fetchone()[0] == DATABASE
        conn.execute("DROP SCHEMA IF EXISTS lele CASCADE")
    initialize(config_path)
    bootstrap(config_path, "demoadmin", "Demo 验收管理员", passwords["initial"])
    service = ChildService(config_path)
    assert service.config["_connect"]["dbname"] == DATABASE
    initialize_plugin_platform(service)

    def login(name, password, surface):
        return service.request("POST", "auth/login", {"loginName": name, "password": password},
                               None, None, config[surface + "_origin"], surface, "127.0.0.1")

    def call(session, surface, method, route, body=None):
        return service.request(method, route, body or {}, session["_cookie"], session["csrfToken"],
                               config[surface + "_origin"], surface, "127.0.0.1")

    admin = login("demoadmin", passwords["initial"], "admin")
    call(admin, "admin", "POST", "account/password", {
        "currentPassword": passwords["initial"], "newPassword": passwords["admin"],
    })
    admin = login("demoadmin", passwords["admin"], "admin")
    parents = {}
    for name in ("dad", "mom"):
        user = call(admin, "admin", "POST", "admin/users", {
            "loginName": "demo" + name, "nickname": "Demo 家长 " + name,
            "password": passwords["initial"],
        })["user"]
        call(admin, "admin", "PATCH", "admin/users/" + user["id"] + "/status", {"status": "active"})
        parent = login("demo" + name, passwords["initial"], "parent")
        call(parent, "parent", "POST", "account/password", {
            "currentPassword": passwords["initial"], "newPassword": passwords[name],
        })
        parents[name] = login("demo" + name, passwords[name], "parent")
    children = []
    for name in ("测试甲", "测试乙"):
        children.append(call(parents["dad"], "parent", "POST", "children", {
            "name": name, "gender": "boy", "requestId": str(uuid.uuid4()),
        })["child"])
    invitation = call(parents["dad"], "parent", "POST", f'children/{children[0]["id"]}/invitations', {
        "loginName": "demomom",
    })["invitation"]
    call(parents["mom"], "parent", "POST", f'invitations/{invitation["id"]}/accept')

    asset_root = FOLDER / "runtime"
    assert asset_root.parent == FOLDER and not asset_root.is_symlink()
    if asset_root.exists():
        shutil.rmtree(asset_root)
    sys.path.insert(0, str(ROOT))
    from scripts.package_plugin import package_plugin
    manifests, schemas = {}, {}
    for plugin_id in IDS:
        package = package_plugin(ROOT, plugin_id, allow_dirty=True)
        prepare_release(inspect_package(package), asset_root)
        release = asset_root / plugin_id / "releases/1.0.0"
        manifest = json.loads((release / "plugin.json").read_text())
        schema = json.loads((release / manifest["configSchema"]).read_text())
        assert manifest["id"] == plugin_id and manifest["version"] == "1.0.0"
        assert manifest["name"] and manifest["description"] and manifest["instructions"]
        assert manifest["icons"] and all((release / icon).is_file() for icon in manifest["icons"])
        assert any(task.get("intervalSeconds") == 60 for task in manifest["tasks"])
        assert "task.completed" in manifest["events"]
        service.transaction(lambda cur: register_release(
            cur, manifest, artifact_sha256=hashlib.sha256(package.read_bytes()).hexdigest(),
            source_commit="demo-browser-fixture", config_schema=schema, activate=True,
        ))
        manifests[plugin_id], schemas[plugin_id] = manifest, schema
    state = {"database": DATABASE, "childId": children[0]["id"],
             "childName": children[0]["name"], "otherChildId": children[1]["id"],
             "otherChildName": children[1]["name"], "manifests": manifests, "schemas": schemas}
    (FOLDER / "state.json").write_text(json.dumps(state, ensure_ascii=False))
    print(json.dumps(state, ensure_ascii=False))


if __name__ == "__main__":
    main()

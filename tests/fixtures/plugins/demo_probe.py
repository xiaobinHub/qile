"""Bounded Demo QA probes; no fixture worker handlers or minimal examples imported.

snapshot: read durable evidence. enqueue: schedule a deterministic, due occurrence.
update/rollback: real deployment of the same code/data schema at 1.0.1/1.0.0.
All mutation is fenced to the exact dedicated database and runtime directory.
"""
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile

from lele_growth.child_service import ChildService
from lele_growth.plugins.deployment import PluginDeployment
from lele_growth.plugins.gateway import PluginGateway
from lele_growth.plugins.scheduler import PluginScheduler
from lele_growth.plugins.supervisor import RuntimeClient
from lele_growth.production_maintenance import target_details

ROOT = Path(__file__).resolve().parents[3]
FOLDER = ROOT / "data/testing/demo-plugins"
IDS = ("demo-page", "demo-service")


def snapshot(service, state):
    def read(cur):
        cur.execute("SELECT current_database()")
        assert cur.fetchone()[0] == "lele_test_demo_plugins"
        cur.execute("SELECT plugin_id,child_id,collection,record_id,payload,revision,data_schema_version "
                    "FROM lele.child_plugin_records ORDER BY plugin_id,child_id,collection,record_id")
        records = [dict(zip(("pluginId", "childId", "collection", "id", "payload", "revision", "dataSchemaVersion"), row))
                   for row in cur.fetchall()]
        cur.execute("SELECT id,plugin_id,child_id,task_id,occurrence_key,status,attempt,last_error_code,"
                    "release_id,config_revision FROM lele.plugin_jobs ORDER BY created_at,id")
        jobs = [dict(zip(("id", "pluginId", "childId", "taskId", "occurrenceKey", "status", "attempt", "error", "releaseId", "configRevision"), row))
                for row in cur.fetchall()]
        cur.execute("SELECT event_id,child_id,event_type,payload,source_revision FROM lele.plugin_event_outbox ORDER BY created_at,event_id")
        events = [dict(zip(("id", "childId", "type", "payload", "sourceRevision"), row)) for row in cur.fetchall()]
        cur.execute("SELECT event_id,plugin_id,status,attempt FROM lele.plugin_event_deliveries ORDER BY event_id,plugin_id")
        deliveries = [dict(zip(("eventId", "pluginId", "status", "attempt"), row)) for row in cur.fetchall()]
        cur.execute("SELECT plugin_id,child_id,effect_key,status FROM lele.plugin_effects ORDER BY plugin_id,child_id,effect_key")
        effects = [dict(zip(("pluginId", "childId", "key", "status"), row)) for row in cur.fetchall()]
        assert all(record["pluginId"] in IDS for record in records)
        return {"database": "lele_test_demo_plugins", "records": records, "jobs": jobs,
                "events": events, "deliveries": deliveries, "effects": effects}
    return service.transaction(read)


def next_package(plugin_id):
    sys.path.insert(0, str(ROOT))
    from scripts.package_plugin import pure_wheel
    release = FOLDER / "runtime" / plugin_id / "releases/1.0.0"
    descriptor = json.loads((release / "artifact.json").read_text())
    files = {name: (release / name).read_bytes() for name in descriptor["files"]}
    manifest = json.loads(files["plugin.json"])
    original_schema = files[manifest["configSchema"]]
    original_data_version = manifest["dataSchemaVersion"]
    manifest["version"] = "1.0.1"
    files["plugin.json"] = json.dumps(manifest, ensure_ascii=False).encode()
    normalized = plugin_id.replace("-", "_")
    for name in list(files):
        if name.startswith("wheels/" + normalized + "-"):
            del files[name]
    modules = {name.removeprefix("backend/"): data for name, data in files.items()
               if name.startswith("backend/") and name.endswith(".py")}
    wheel_name, wheel = pure_wheel(plugin_id, "1.0.1", modules)
    files["wheels/" + wheel_name] = wheel
    assert manifest["dataSchemaVersion"] == original_data_version
    assert files[manifest["configSchema"]] == original_schema
    descriptor.update(version="1.0.1", files={name: hashlib.sha256(data).hexdigest() for name, data in files.items()})
    files["artifact.json"] = json.dumps(descriptor).encode()
    package = FOLDER / (plugin_id + "-1.0.1.tar.gz")
    assert not package.is_symlink()
    with tarfile.open(package, "w:gz") as archive:
        for name, data in sorted(files.items()):
            member = tarfile.TarInfo(name)
            member.size, member.mode = len(data), 0o644
            archive.addfile(member, io.BytesIO(data))
    return package


def main():
    assert all(not part.is_symlink() for part in [FOLDER, *FOLDER.parents])
    assert Path(os.environ["LELE_PLUGIN_ROOT"]).resolve() == FOLDER / "runtime"
    assert Path(os.environ["LELE_ACCOUNTS_CONFIG"]).resolve() == FOLDER / "config.json"
    service = ChildService(FOLDER / "config.json")
    assert service.config["environment"] == "development"
    assert service.config["_connect"]["dbname"] == "lele_test_demo_plugins"
    state = json.loads((FOLDER / "state.json").read_text())
    mode = sys.argv[1]
    if mode == "snapshot":
        result = snapshot(service, state)
    else:
        plugin_id = sys.argv[2]
        assert plugin_id in IDS
        if mode == "health":
            version = sys.argv[3]
            assert version in ("1.0.0", "1.0.1")
            result = RuntimeClient().health(plugin_id, version)
        elif mode == "enqueue":
            task, key = sys.argv[3:5]
            assert task in ("heartbeat", "daily-reminder")
            # Caller supplies an ISO occurrence for daily-reminder; arbitrary keys
            # are allowed only for heartbeat. Runtime still executes handle_job.
            due = datetime.fromisoformat(key) if task == "daily-reminder" else datetime.now(timezone.utc)
            assert due.tzinfo is not None and due <= datetime.now(timezone.utc)
            scheduler = PluginScheduler(service, PluginGateway(service))
            result = {"jobId": scheduler.enqueue(plugin_id, state["childId"], task, key, due)}
        elif mode in ("update", "rollback"):
            manager = PluginDeployment(service)
            confirm = target_details(service)["targetId"]
            if mode == "update":
                result = manager.execute("deploy", package=next_package(plugin_id), apply=True, confirm=confirm)
            else:
                result = manager.execute("rollback", plugin_id=plugin_id, version="1.0.0", apply=True, confirm=confirm)
        else:
            raise ValueError("Unsupported Demo probe")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

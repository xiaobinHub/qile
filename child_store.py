"""Child-scoped, lossless relational mapping. No connection or implicit initialization."""
from postgres_store import ARRAY_TABLES, BUSINESS_TABLES, KNOWN_DATA_KEYS, KNOWN_STORE_KEYS, validate_record, validate_data, canonical_sha256, canonical_bytes, UNAVAILABLE
from storage import StoreError, BACKUP_LIMIT
from http import HTTPStatus
from psycopg.types.json import Jsonb
DB_SCHEMA_VERSION = 4

class ChildStore:
    @staticmethod
    def _json(value):
        return Jsonb(value, dumps=lambda item: canonical_bytes(item).decode('utf-8'))

    def read(self, cursor, child_id, *, locked: bool = False) -> dict:
        cursor.execute("SELECT store_format,store_version,app_schema_version,db_schema_version,revision,updated_at_raw,data_keys,data_extra,store_extra FROM lele.app_metadata WHERE child_id=%s AND id=1" + (" FOR UPDATE" if locked else ""), (child_id,))
        row = cursor.fetchone()
        if row is None or row[3] != DB_SCHEMA_VERSION:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, "数据库尚未完成数据迁移，请先完成初始化和核验。")
        store_format, version, schema_version, _, revision, updated, data_keys, data_extra, store_extra = row
        data = dict(data_extra)
        data["schemaVersion"] = schema_version
        cursor.execute("SELECT record_json FROM lele.app_settings WHERE child_id=%s AND id=1", (child_id,))
        settings = cursor.fetchone()
        if settings is None:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, UNAVAILABLE)
        data["settings"] = settings[0]
        for key, table in ARRAY_TABLES.items():
            cursor.execute(f"SELECT record_json FROM lele.{table} WHERE child_id=%s ORDER BY sort_order", (child_id,))
            data[key] = [item[0] for item in cursor.fetchall()]
        cursor.execute("SELECT series_id,record_json FROM lele.task_revisions WHERE child_id=%s ORDER BY series_id,sort_order", (child_id,))
        revisions: dict[str, list] = {}
        for series_id, revision_json in cursor.fetchall():
            revisions.setdefault(series_id, []).append(revision_json)
        cursor.execute("SELECT id,revisions_state FROM lele.task_series WHERE child_id=%s ORDER BY sort_order", (child_id,))
        states = dict(cursor.fetchall())
        for task in data["series"]:
            state = states[task["id"]]
            if state == "array":
                task["revisions"] = revisions.get(task["id"], [])
            elif state == "null":
                task["revisions"] = None
        data = {key: data[key] for key in data_keys}
        record = dict(store_extra)
        record.update(format=store_format, version=version, revision=revision, updatedAt=updated, data=data)
        try:
            validate_record(record)
        except StoreError:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, "数据库数据核验失败，请检查迁移或恢复记录。") from None
        return record

    def replace(self, cursor, child_id, data: dict) -> None:
        from media_service import MediaService
        MediaService.require_external(data)
        for table in BUSINESS_TABLES:
            cursor.execute(f"DELETE FROM lele.{table} WHERE child_id=%s", (child_id,))
        cursor.execute("INSERT INTO lele.app_settings(child_id,id,record_json) VALUES (%s,1,%s)", (child_id,self._json(data["settings"]),))
        native = {
            "task_series": (("start_date", "startDate"), ("start_time", "startTime"), ("end_time", "endTime"), ("created_at", "createdAt"), ("updated_at", "updatedAt")),
            "task_exceptions": (("original_date", "originalDate"),),
            "points_ledger": (("business_date", "date"), ("created_at", "createdAt")),
            "gifts": (("created_at", "createdAt"), ("updated_at", "updatedAt"), ("redeemed_at", "redeemedAt")),
            "task_presets": (("start_time", "startTime"), ("end_time", "endTime")),
            "business_operations": (("operated_at", "at"), ("effective_from", "effectiveFrom")),
        }
        for key, table in ARRAY_TABLES.items():
            columns = ["child_id", "record_json", "sort_order", *[column for column, _ in native.get(table, ())]]
            if key == "series":
                columns.append("revisions_state")
            if key == "exceptions":
                columns.append("override_date")
            if key == "completions":
                columns.extend(("task_date", "original_date", "start_time", "end_time", "updated_at"))
            rows = []
            for order, item in enumerate(data.get(key, [])):
                record_json = dict(item)
                values = []
                if key == "series":
                    revisions = record_json.pop("revisions", None)
                    values = ["absent" if "revisions" not in item else "null" if revisions is None else "array"]
                elif key == "exceptions":
                    values = [(item.get("data") or {}).get("date")]
                elif key == "completions":
                    snapshot = item["snapshot"]
                    values = [snapshot.get("date"), snapshot.get("originalDate"), snapshot.get("startTime"), snapshot.get("endTime"), item.get("updatedAt")]
                rows.append((child_id,self._json(record_json), order, *[item.get(field) for _, field in native.get(table, ())], *values))
            if rows:
                cursor.executemany(f"INSERT INTO lele.{table} ({','.join(columns)}) VALUES ({','.join(['%s'] * len(columns))})", rows)
        revision_rows = []
        for task in data["series"]:
            for order, revision in enumerate(task.get("revisions") or []):
                effective = {**{k: v for k, v in task.items() if k != "revisions"}, **revision}
                revision_rows.append((child_id,self._json(revision), self._json(effective), order, task["id"], revision["effectiveFrom"], effective["startTime"], effective["endTime"]))
        if revision_rows:
            cursor.executemany("INSERT INTO lele.task_revisions(child_id,record_json,effective_json,sort_order,series_id,effective_from,start_time,end_time) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)", revision_rows)

    def metadata(self, cursor, child_id, record: dict, *, insert: bool = False) -> None:
        data = record["data"]
        values = (record["format"], record["version"], data["schemaVersion"], DB_SCHEMA_VERSION, record["revision"], record["updatedAt"], record["updatedAt"], list(data), self._json({k: v for k, v in data.items() if k not in KNOWN_DATA_KEYS}), self._json({k: v for k, v in record.items() if k not in KNOWN_STORE_KEYS}))
        columns = "store_format,store_version,app_schema_version,db_schema_version,revision,updated_at,updated_at_raw,data_keys,data_extra,store_extra".split(",")
        if insert:
            cursor.execute(f"INSERT INTO lele.app_metadata(child_id,id,{','.join(columns)}) VALUES(%s,1,{','.join(['%s'] * len(columns))})", (child_id,*values))
        else:
            cursor.execute(f"UPDATE lele.app_metadata SET {','.join(column+'=%s' for column in columns)} WHERE child_id=%s AND id=1", (*values,child_id))


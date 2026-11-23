"""Child-scoped, lossless relational mapping. No connection or implicit initialization."""
from lele_growth.postgres_store import ARRAY_TABLES, BUSINESS_TABLES, KNOWN_DATA_KEYS, KNOWN_STORE_KEYS, validate_record, canonical_bytes, UNAVAILABLE
from lele_growth.storage import StoreError
from http import HTTPStatus
from psycopg.types.json import Jsonb
DB_SCHEMA_VERSION = 4


class StoredException(dict):
    """Physical identity survives deepcopy but is not part of the business JSON."""
    def __init__(self, value, row_id):
        super().__init__(value)
        self.row_id = row_id


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
            if key == "exceptions":
                cursor.execute("SELECT record_json,row_id FROM lele.task_exceptions WHERE child_id=%s ORDER BY sort_order", (child_id,))
                data[key] = [StoredException(*row) for row in cursor.fetchall()]
                continue
            if key == "ledger":
                cursor.execute("SELECT record_json,task_date FROM lele.points_ledger WHERE child_id=%s ORDER BY sort_order", (child_id,))
                data[key] = [self._ledger_record(*row) for row in cursor.fetchall()]
                continue
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

    NATIVE = {
        "task_series": (("start_date", "startDate"), ("start_time", "startTime"), ("end_time", "endTime"), ("created_at", "createdAt"), ("updated_at", "updatedAt")),
        "task_exceptions": (("original_date", "originalDate"),),
        "points_ledger": (("business_date", "date"), ("created_at", "createdAt"), ("task_date", "taskDate")),
        "gifts": (("created_at", "createdAt"), ("updated_at", "updatedAt"), ("redeemed_at", "redeemedAt")),
        "task_presets": (("start_time", "startTime"), ("end_time", "endTime")),
        "business_operations": (("operated_at", "at"), ("effective_from", "effectiveFrom")),
    }

    @classmethod
    def _row(cls, child_id, key, table, order, item):
        record_json = dict(item)
        if key == "ledger":
            # The authoritative task date is the native column, not a JSON fallback.
            record_json.pop("taskDate", None)
        extra = []
        if key == "series":
            revisions = record_json.pop("revisions", None)
            extra = ["absent" if "revisions" not in item else "null" if revisions is None else "array"]
        elif key == "exceptions":
            extra = [(item.get("data") or {}).get("date")]
        elif key == "completions":
            snapshot = item["snapshot"]
            extra = [snapshot.get("date"), snapshot.get("originalDate"), snapshot.get("startTime"), snapshot.get("endTime"), item.get("updatedAt")]
        return (child_id, cls._json(record_json), order, *[item.get(field) for _, field in cls.NATIVE.get(table, ())], *extra)

    @classmethod
    def _columns(cls, key, table):
        columns = ["child_id", "record_json", "sort_order", *[column for column, _ in cls.NATIVE.get(table, ())]]
        if key == "series":
            columns.append("revisions_state")
        if key == "exceptions":
            columns.append("override_date")
        if key == "completions":
            columns.extend(("task_date", "original_date", "start_time", "end_time", "updated_at"))
        return columns

    @staticmethod
    def _ledger_record(stored, task_date):
        item = dict(stored)
        item.pop("taskDate", None)
        if task_date is not None:
            item["taskDate"] = task_date.isoformat()
        return item

    @classmethod
    def _revision_row(cls, child_id, task, order, revision):
        effective = {**{k: v for k, v in task.items() if k != "revisions"}, **revision}
        return (child_id, cls._json(revision), cls._json(effective), order, task["id"], revision["effectiveFrom"], effective["startTime"], effective["endTime"])

    def _insert_rows(self, cursor, table, columns, rows):
        if rows:
            cursor.executemany(f"INSERT INTO lele.{table} ({','.join(columns)}) VALUES ({','.join(['%s'] * len(columns))})", rows)

    VALUE_TYPES = {
        "record_json": "jsonb", "sort_order": "integer", "start_date": "date", "original_date": "date",
        "override_date": "date", "task_date": "date", "business_date": "date", "effective_from": "date",
        "start_time": "time", "end_time": "time", "created_at": "timestamptz", "updated_at": "timestamptz",
        "redeemed_at": "timestamptz", "operated_at": "timestamptz",
    }

    @classmethod
    def _typed_values(cls, columns):
        return ",".join(f"%s::{cls.VALUE_TYPES.get(column, 'text')}" for column in columns)

    def _delete_rows(self, cursor, child_id, table, column, values):
        if values:
            cursor.execute(f"DELETE FROM lele.{table} WHERE child_id=%s AND {column}=ANY(%s)", (child_id, list(values)))

    def _append(self, cursor, child_id, key, item, returning=""):
        table = ARRAY_TABLES[key]
        columns = self._columns(key, table)
        values = ["%s"] * len(columns)
        values[2] = f"(SELECT COALESCE(MAX(sort_order),-1)+1 FROM lele.{table} WHERE child_id=%s)"
        row = list(self._row(child_id, key, table, None, item))
        row[columns.index("sort_order")] = child_id
        cursor.execute(f"INSERT INTO lele.{table} ({','.join(columns)}) VALUES ({','.join(values)}) {returning}", row)

    def append_event(self, cursor, child_id, event):
        self._append(cursor, child_id, "operationLog", event)
        cursor.execute("""DELETE FROM lele.business_operations WHERE child_id=%s AND sort_order <= (
            SELECT sort_order FROM lele.business_operations WHERE child_id=%s ORDER BY sort_order DESC OFFSET 500 LIMIT 1)""", (child_id, child_id))

    def completion_header(self, cursor, child_id):
        cursor.execute("""SELECT store_format,store_version,revision,updated_at_raw,db_schema_version
            FROM lele.app_metadata WHERE child_id=%s AND id=1 FOR UPDATE""", (child_id,))
        row = cursor.fetchone()
        if row is None or row[4] != DB_SCHEMA_VERSION:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, "数据库尚未完成数据迁移，请先完成初始化和核验。")
        return dict(format=row[0], version=row[1], revision=row[2], updatedAt=row[3])

    def change_completion(self, cursor, child_id, payload, stamp, today):
        from lele_growth.business_operations import completion_change, completion_key, occurrence_parts, resolve_occurrence, revision
        key = completion_key(payload)
        series_id = key.rpartition("@")[0]
        cursor.execute("SELECT record_json,revisions_state FROM lele.task_series WHERE child_id=%s AND id=%s", (child_id, series_id))
        stored_series = cursor.fetchone()
        series = stored_series[0] if stored_series else None
        cursor.execute("SELECT record_json FROM lele.task_completions WHERE child_id=%s AND occurrence_key=%s", (child_id, key))
        row = cursor.fetchone()
        existing = row[0] if row else None

        def resolve():
            _, original = occurrence_parts(key)
            if series is None:
                raise StoreError(HTTPStatus.CONFLICT, "记录已不存在，请刷新后重试。")
            cursor.execute("""SELECT record_json FROM lele.task_exceptions WHERE child_id=%s AND series_id=%s AND original_date=%s
                ORDER BY sort_order LIMIT 1""", (child_id, series_id, original))
            exception = cursor.fetchone()
            effective, multiple = None, False
            if not exception:
                if stored_series[1] == "array":
                    cursor.execute("""SELECT record_json, EXISTS(SELECT 1 FROM lele.task_revisions
                        WHERE child_id=%s AND series_id=%s AND sort_order>0) FROM lele.task_revisions
                        WHERE child_id=%s AND series_id=%s AND effective_from<=%s ORDER BY effective_from DESC LIMIT 1""",
                        (child_id, series_id, child_id, series_id, original))
                    effective, multiple = cursor.fetchone() or (None, False)
                else:
                    effective = revision(series, series["startDate"], series_id + ":v1")
            return resolve_occurrence(series, original, exception[0] if exception else None, effective, multiple)

        completion, entry = completion_change(key, payload["completed"], existing, series, resolve, stamp, today)
        if entry is None:
            return completion, []
        if existing is None:
            self._append(cursor, child_id, "completions", completion)
        else:
            snapshot = completion["snapshot"]
            cursor.execute("""UPDATE lele.task_completions SET record_json=%s,task_date=%s,original_date=%s,start_time=%s,end_time=%s,updated_at=%s
                WHERE child_id=%s AND occurrence_key=%s""", (self._json(completion), snapshot["date"], snapshot.get("originalDate"),
                snapshot["startTime"], snapshot["endTime"], stamp, child_id, key))
        self._append(cursor, child_id, "ledger", entry, "RETURNING record_json,task_date")
        return completion, [self._ledger_record(*cursor.fetchone())]

    def replace(self, cursor, child_id, data: dict) -> None:
        from lele_growth.media_service import MediaService
        MediaService.require_external(data)
        for table in BUSINESS_TABLES:
            cursor.execute(f"DELETE FROM lele.{table} WHERE child_id=%s", (child_id,))
        cursor.execute("INSERT INTO lele.app_settings(child_id,id,record_json) VALUES (%s,1,%s)", (child_id,self._json(data["settings"]),))
        for key, table in ARRAY_TABLES.items():
            columns = self._columns(key, table)
            rows = []
            for order, item in enumerate(data.get(key, [])):
                rows.append(self._row(child_id, key, table, order, item))
            self._insert_rows(cursor, table, columns, rows)
        revision_rows = []
        for task in data["series"]:
            for order, revision in enumerate(task.get("revisions") or []):
                revision_rows.append(self._revision_row(child_id, task, order, revision))
        self._insert_rows(cursor, "task_revisions", ("child_id", "record_json", "effective_json", "sort_order", "series_id", "effective_from", "start_time", "end_time"), revision_rows)

    def apply_changes(self, cursor, child_id, previous: dict, data: dict) -> None:
        """Persist only changed business rows while preserving canonical JSON."""
        from lele_growth.media_service import MediaService
        MediaService.require_external(data)
        if previous.get("settings") != data.get("settings"):
            cursor.execute("UPDATE lele.app_settings SET record_json=%s WHERE child_id=%s AND id=1", (self._json(data["settings"]), child_id))

        old_log, new_log = previous["operationLog"], data["operationLog"]
        if new_log != old_log:
            if not new_log or new_log != (old_log + [new_log[-1]])[-500:]:
                raise ValueError("Business commands must append one operation log entry")
            self.append_event(cursor, child_id, new_log[-1])

        # Delete dependents before their referenced rows. Deferred foreign keys
        # permit this, but stable ordering also keeps temporary unique conflicts out.
        ordered = (
            ("exceptions", "task_exceptions"), ("completions", "task_completions"),
            ("ledger", "points_ledger"), ("gifts", "gifts"),
            ("taskPresets", "task_presets"), ("series", "task_series"), ("categories", "task_categories"),
        )
        prepared = {}
        for key, table in ordered:
            columns = self._columns(key, table)
            old_items = previous.get(key, [])
            new_items = data.get(key, [])
            if key == "exceptions":
                identity_column, identity_type = "row_id", "bigint"
                old_by_identity = {item.row_id: (order, item) for order, item in enumerate(old_items)}
                by_public_id = {item["id"]: item.row_id for item in old_items if item.get("id")}
                identities = [getattr(item, "row_id", by_public_id.get(item.get("id"))) for item in new_items]
            else:
                identity_column = "occurrence_key" if key == "completions" else "id"
                identity_type = "text"
                field = "occurrenceKey" if key == "completions" else "id"
                old_by_identity = {item[field]: (order, item) for order, item in enumerate(old_items)}
                identities = [item[field] for item in new_items]
            removed = old_by_identity.keys() - set(identities)
            inserts, updates = [], []
            moved = []
            for order, (identity, item) in enumerate(zip(identities, new_items)):
                previous_item = old_by_identity.get(identity)
                if previous_item is None:
                    inserts.append(self._row(child_id, key, table, order, item))
                elif previous_item != (order, item):
                    updates.append((identity, self._row(child_id, key, table, order, item)))
                    if previous_item[0] != order:
                        moved.append(identity)
            self._delete_rows(cursor, child_id, table, identity_column, removed)
            if key == "series":
                self._delete_rows(cursor, child_id, "task_revisions", "series_id", removed)
            if moved:
                cursor.execute(f"""UPDATE lele.{table} SET sort_order=(SELECT GREATEST(MAX(sort_order),%s) FROM lele.{table} WHERE child_id=%s)+ordinality
                    FROM unnest(%s::{identity_type}[]) WITH ORDINALITY AS moving(identity,ordinality)
                    WHERE child_id=%s AND {identity_column}=moving.identity""", (len(new_items), child_id, moved, child_id))
            assignments = ",".join(f"{column}=source.{column}" for column in columns if column != "child_id")
            for identity, row in updates:
                cursor.execute(f"UPDATE lele.{table} AS target SET {assignments} FROM (SELECT {self._typed_values(columns)}) AS source({','.join(columns)}) WHERE target.child_id=source.child_id AND target.{identity_column}=%s::{identity_type}",
                               (*row, identity))
            prepared[table] = columns, inserts
        for _, table in reversed(ordered):
            columns, inserts = prepared[table]
            self._insert_rows(cursor, table, columns, inserts)

        old_series = {task["id"]: task for task in previous.get("series", [])}
        revision_inserts = []
        for task in data.get("series", []):
            revisions = list(task.get("revisions") or [])
            old_revisions = list((old_series.get(task["id"]) or {}).get("revisions") or [])
            if revisions == old_revisions and task.get("id") in old_series and {k: v for k, v in task.items() if k != "revisions"} == {k: v for k, v in old_series[task["id"]].items() if k != "revisions"}:
                continue
            cursor.execute("DELETE FROM lele.task_revisions WHERE child_id=%s AND series_id=%s", (child_id, task["id"]))
            revision_inserts.extend(self._revision_row(child_id, task, order, revision) for order, revision in enumerate(revisions))
        self._insert_rows(cursor, "task_revisions", ("child_id", "record_json", "effective_json", "sort_order", "series_id", "effective_from", "start_time", "end_time"), revision_inserts)

    def metadata(self, cursor, child_id, record: dict, *, insert: bool = False) -> None:
        data = record["data"]
        values = (record["format"], record["version"], data["schemaVersion"], DB_SCHEMA_VERSION, record["revision"], record["updatedAt"], record["updatedAt"], list(data), self._json({k: v for k, v in data.items() if k not in KNOWN_DATA_KEYS}), self._json({k: v for k, v in record.items() if k not in KNOWN_STORE_KEYS}))
        columns = "store_format,store_version,app_schema_version,db_schema_version,revision,updated_at,updated_at_raw,data_keys,data_extra,store_extra".split(",")
        if insert:
            cursor.execute(f"INSERT INTO lele.app_metadata(child_id,id,{','.join(columns)}) VALUES(%s,1,{','.join(['%s'] * len(columns))})", (child_id,*values))
        else:
            cursor.execute(f"UPDATE lele.app_metadata SET {','.join(column+'=%s' for column in columns)} WHERE child_id=%s AND id=1", (*values,child_id))


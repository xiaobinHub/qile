"""Explicitly initialized PostgreSQL store; JSON records remain authoritative."""
from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import re
from datetime import date, datetime
from http import HTTPStatus
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from storage import BACKUP_LIMIT, STORE_FORMAT, STORE_VERSION, JsonStore, StoreError

DB_SCHEMA_VERSION = 1
ARRAY_TABLES = {
    "categories": "task_categories", "series": "task_series",
    "exceptions": "task_exceptions", "completions": "task_completions",
    "ledger": "points_ledger", "gifts": "gifts", "taskPresets": "task_presets",
    "operationLog": "business_operations",
}
BUSINESS_TABLES = ("app_settings", *ARRAY_TABLES.values(), "task_revisions")
TABLES = frozenset((*BUSINESS_TABLES, "app_metadata", "data_snapshots", "request_logs", "migration_runs"))
KNOWN_DATA_KEYS = frozenset(("schemaVersion", "settings", *ARRAY_TABLES))
KNOWN_STORE_KEYS = frozenset(("format", "version", "revision", "updatedAt", "data"))
ID_RE = re.compile(r"[A-Za-z0-9._:-]{1,100}\Z")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
TIME_RE = re.compile(r"(?:[01]\d|2[0-3]):[0-5]\d\Z")
CONFIG_ERROR = "数据库配置不完整或不受支持，请检查本机配置。"
UNAVAILABLE = "数据库暂时无法访问，未作任何修改。"
INVALID = "提交的数据字段或关联不正确，未作任何修改。"


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def load_config(path: Path) -> dict[str, Any]:
    """Return only vetted libpq options. Never interpolate or log credentials."""
    try:
        config = json.loads(Path(path).read_text(encoding="utf-8"))
        allowed = {"host", "port", "dbname", "user", "password", "sslmode", "sslrootcert", "allow_unencrypted", "connect_timeout"}
        if not isinstance(config, dict) or set(config) - allowed:
            raise ValueError
        for key in ("host", "dbname", "user"):
            if not isinstance(config.get(key), str) or not config[key] or "\x00" in config[key]:
                raise ValueError
        if type(config.get("port", 5432)) is not int or not 1 <= config.get("port", 5432) <= 65535:
            raise ValueError
        mode = config.get("sslmode", "verify-full")
        if mode not in {"require", "verify-ca", "verify-full", "disable"}:
            raise ValueError
        if mode == "disable" and config.get("allow_unencrypted") is not True:
            raise ValueError
        if "allow_unencrypted" in config and type(config["allow_unencrypted"]) is not bool:
            raise ValueError
        if "password" in config and (not isinstance(config["password"], str) or "\x00" in config["password"]):
            raise ValueError
        if "connect_timeout" in config and (type(config["connect_timeout"]) is not int or not 1 <= config["connect_timeout"] <= 8):
            raise ValueError
        result = {key: config[key] for key in ("host", "dbname", "user", "password") if key in config}
        result.update(port=config.get("port", 5432), sslmode=mode,
                      connect_timeout=8, options="-c statement_timeout=10000 -c lock_timeout=5000")
        cert = config.get("sslrootcert")
        if cert is not None:
            if not isinstance(cert, str) or not cert or "\x00" in cert:
                raise ValueError
            cert_path = Path(cert).expanduser()
            if not cert_path.is_absolute():
                cert_path = Path(path).parent / cert_path
            if not cert_path.is_file():
                raise ValueError
            result["sslrootcert"] = str(cert_path.resolve())
        if mode in {"verify-ca", "verify-full"} and "sslrootcert" not in result:
            raise ValueError
        return result
    except (OSError, ValueError, TypeError):
        raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, CONFIG_ERROR) from None


def _bad() -> None:
    raise StoreError(HTTPStatus.BAD_REQUEST, INVALID)


def _integer(value: Any, minimum: int | None = None, maximum: int | None = None) -> bool:
    return type(value) is int and -(2**63) <= value < 2**63 and (minimum is None or value >= minimum) and (maximum is None or value <= maximum)


def _id(value: Any) -> bool:
    return isinstance(value, str) and bool(ID_RE.fullmatch(value))


def _date(value: Any) -> bool:
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def _timestamp(value: Any, nullable: bool = True) -> bool:
    if value is None:
        return nullable
    if not isinstance(value, str):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.tzinfo is not None
    except ValueError:
        return False


def _text(value: Any, max_length: int | None = None) -> bool:
    return isinstance(value, str) and bool(value.strip()) and (max_length is None or len(value.strip()) <= max_length)


def _times(record: dict) -> None:
    start, end = record.get("startTime"), record.get("endTime")
    if not isinstance(start, str) or not TIME_RE.fullmatch(start) or not isinstance(end, str) or not TIME_RE.fullmatch(end) or start >= end:
        _bad()


def _recurrence(rule: Any, starts_on: str) -> None:
    if rule is None:
        return
    if not isinstance(rule, dict) or rule.get("freq") not in {"daily", "weekly", "monthly"} or rule.get("endType") not in {"never", "until", "count"} or not _integer(rule.get("interval"), 1, 99):
        _bad()
    if rule["freq"] == "weekly" and (not isinstance(rule.get("weekdays"), list) or not rule["weekdays"] or any(not _integer(v, 0, 6) for v in rule["weekdays"])):
        _bad()
    if rule["freq"] == "monthly" and not _integer(rule.get("monthDay"), 1, 31):
        _bad()
    if rule["endType"] == "until" and (not _date(rule.get("until")) or rule["until"] < starts_on):
        _bad()
    if rule["endType"] == "count" and not _integer(rule.get("count"), 1, 10000):
        _bad()


def _validate_data(data: Any) -> dict:
    JsonStore._validate_app_data(data)
    if not isinstance(data["settings"], dict):
        _bad()
    settings = data["settings"]
    if "weekStartsOn" in settings and settings["weekStartsOn"] is not None and not _integer(settings["weekStartsOn"], 0, 6):
        _bad()
    if "legacySplitRepairV1" in settings and settings["legacySplitRepairV1"] is not None and type(settings["legacySplitRepairV1"]) is not bool:
        _bad()
    for key in ARRAY_TABLES:
        rows = data.get(key, [])
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            _bad()
        identity = "occurrenceKey" if key == "completions" else "id"
        identifiers = [row.get(identity) for row in rows if key != "exceptions" or row.get(identity) is not None]
        if any(not isinstance(value, str) or (identity != "occurrenceKey" and not _id(value)) for value in identifiers) or len(identifiers) != len(set(identifiers)):
            _bad()
    categories = {row["id"] for row in data["categories"]}
    series_ids = {row["id"] for row in data["series"]}
    for row in data["categories"]:
        if not _text(row.get("name")) or not isinstance(row.get("color"), str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", row["color"]) or type(row.get("active")) is not bool:
            _bad()
    def task_fields(row: dict, start_key: str) -> None:
        if not _text(row.get("title")) or row.get("categoryId") not in categories or not _integer(row.get("points"), 0) or not _date(row.get(start_key)):
            _bad()
        _times(row)
        _recurrence(row.get("recurrence"), row[start_key])
    for row in data["series"]:
        task_fields(row, "startDate")
        if not _timestamp(row.get("createdAt")) or not _timestamp(row.get("updatedAt")):
            _bad()
        revisions = row.get("revisions")
        if revisions is not None:
            if not isinstance(revisions, list) or not revisions:
                _bad()
            last = ""
            for revision in revisions:
                if not isinstance(revision, dict) or not _id(revision.get("id")):
                    _bad()
                task_fields({**row, **revision}, "effectiveFrom")
                if revision["effectiveFrom"] <= last:
                    _bad()
                last = revision["effectiveFrom"]
    for row in data["exceptions"]:
        if row.get("seriesId") not in series_ids or not _date(row.get("originalDate")) or row.get("action") not in {"cancel", "override"}:
            _bad()
        if row["action"] == "override":
            override = row.get("data")
            if not isinstance(override, dict) or not _id(override.get("id") or override.get("seriesId")):
                _bad()
            task_fields(override, "date")
    for row in data["completions"]:
        snapshot = row.get("snapshot")
        if type(row.get("completed")) is not bool or not isinstance(snapshot, dict) or not _text(snapshot.get("title")) or not _id(snapshot.get("id") or snapshot.get("seriesId")) or snapshot.get("categoryId") not in categories or not _integer(snapshot.get("points"), 0) or not _date(snapshot.get("date")) or not _timestamp(row.get("updatedAt")):
            _bad()
        _times(snapshot)
        if snapshot.get("originalDate") is not None and not _date(snapshot["originalDate"]):
            _bad()
        if snapshot.get("recurring") is not None and type(snapshot["recurring"]) is not bool:
            _bad()
    ledger = {row["id"]: row for row in data["ledger"]}
    for row in ledger.values():
        amount, kind = row.get("amount"), row.get("kind")
        if not _integer(amount) or not _date(row.get("date")) or not _timestamp(row.get("createdAt"), False):
            _bad()
        if not ((kind == "task-complete" and amount >= 0) or (kind == "task-reversal" and amount <= 0) or (kind == "manual" and amount != 0) or (kind == "gift-redeem" and amount < 0) or (kind == "gift-reversal" and amount > 0)):
            _bad()
        if kind == "manual" and (not isinstance(row.get("reason"), str) or not row["reason"]):
            _bad()
        if kind == "gift-redeem":
            snapshot = row.get("giftSnapshot")
            if not isinstance(snapshot, dict) or not _text(snapshot.get("name")) or not _integer(snapshot.get("points"), 1) or snapshot["points"] != -amount:
                _bad()
        related_id = row.get("relatedLedgerId")
        if related_id is not None and related_id not in ledger:
            _bad()
        if kind == "gift-reversal":
            original = ledger.get(related_id)
            expected_kind = "gift-redeem"
            if original is None or original.get("kind") != expected_kind or original.get("amount") != -amount:
                _bad()
            relation_key = "giftId"
            if not row.get(relation_key) or original.get(relation_key) != row[relation_key]:
                _bad()
        if kind.startswith("gift-") and not _id(row.get("giftId")):
            _bad()
    for row in data["gifts"]:
        if not _text(row.get("name"), 40) or not _integer(row.get("points"), 1, 99999) or row.get("status") not in {"available", "redeemed"} or not _timestamp(row.get("createdAt"), False) or not _timestamp(row.get("updatedAt"), False) or not _timestamp(row.get("redeemedAt")):
            _bad()
        image = row.get("imageData")
        if image is not None and image != "" and (not isinstance(image, str) or len(image) > 260000 or not re.match(r"^data:image/(webp|jpeg|png);base64,", image, re.I)):
            _bad()
        if row.get("imageAssetId") is not None:
            from media_types import ASSET_ID
            if not isinstance(row["imageAssetId"], str) or not ASSET_ID.fullmatch(row["imageAssetId"]):
                _bad()
        link = row.get("redemptionLedgerId")
        if link is not None and link not in ledger:
            _bad()
        if row["status"] == "redeemed":
            redemption = ledger.get(link)
            if not _timestamp(row.get("redeemedAt"), False) or redemption is None or redemption.get("kind") != "gift-redeem" or redemption.get("giftId") != row["id"] or redemption.get("amount") != -row["points"]:
                _bad()
    for row in data["operationLog"]:
        if not _text(row.get("action")) or not _integer(row.get("revision"), 0) or not _timestamp(row.get("at"), False) or (row.get("amount") is not None and not _integer(row["amount"])) or (row.get("effectiveFrom") is not None and not _date(row["effectiveFrom"])):
            _bad()
    canonical_bytes(data)
    return data


def _validate_record(record: Any) -> dict:
    if not isinstance(record, dict) or not KNOWN_STORE_KEYS.issubset(record) or record["format"] != STORE_FORMAT or record["version"] != STORE_VERSION or not _integer(record["revision"], 0) or not _timestamp(record["updatedAt"]):
        _bad()
    validate_data(record["data"])
    canonical_bytes(record)
    return record


def validate_data(data: Any) -> dict:
    try:
        return _validate_data(data)
    except StoreError:
        raise
    except (TypeError, ValueError, KeyError, OverflowError):
        _bad()


def validate_record(record: Any) -> dict:
    try:
        return _validate_record(record)
    except StoreError:
        raise
    except (TypeError, ValueError, KeyError, OverflowError):
        _bad()


class PostgresStore:
    def __init__(self, project_root: Path, config_path: Path | None = None):
        self.project_root = Path(project_root)
        self.config_path = Path(config_path) if config_path is not None else self.project_root / "data" / "rds-config.json"

    def _connect(self):
        try:
            import psycopg
            return psycopg.connect(**load_config(self.config_path))
        except StoreError:
            raise
        except Exception:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, UNAVAILABLE) from None

    @staticmethod
    def _json(value: Any):
        from psycopg.types.json import Jsonb
        return Jsonb(value, dumps=lambda item: canonical_bytes(item).decode("utf-8"))

    @staticmethod
    def _mapped_error(error: Exception, committing: bool = False) -> StoreError:
        if isinstance(error, StoreError):
            return error
        code = getattr(error, "sqlstate", None)
        if code and (code.startswith("22") or code.startswith("23")):
            return StoreError(HTTPStatus.BAD_REQUEST, INVALID)
        if committing and (code is None or code.startswith("08") or code in {"57P01", "57P02", "57P03"}):
            return StoreError(HTTPStatus.SERVICE_UNAVAILABLE, "保存结果暂未确认，请刷新检查。")
        return StoreError(HTTPStatus.SERVICE_UNAVAILABLE, UNAVAILABLE)

    def _transaction(self, work: Callable, *, readonly: bool = False):
        connection = self._connect()
        committing = False
        try:
            with connection.cursor() as cursor:
                if readonly:
                    cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                result = work(cursor)
            committing = True
            connection.commit()
            return result
        except Exception as error:
            try:
                connection.rollback()
            except Exception:
                pass
            raise self._mapped_error(error, committing and not readonly) from None
        finally:
            try:
                connection.close()
            except Exception:
                pass

    @staticmethod
    def _read(cursor, *, locked: bool = False) -> dict:
        cursor.execute("SELECT store_format,store_version,app_schema_version,db_schema_version,revision,updated_at_raw,data_keys,data_extra,store_extra FROM lele.app_metadata WHERE id=1" + (" FOR UPDATE" if locked else ""))
        row = cursor.fetchone()
        if row is None or row[3] != DB_SCHEMA_VERSION:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, "数据库尚未完成数据迁移，请先完成初始化和核验。")
        store_format, version, schema_version, _, revision, updated, data_keys, data_extra, store_extra = row
        data = dict(data_extra)
        data["schemaVersion"] = schema_version
        cursor.execute("SELECT record_json FROM lele.app_settings WHERE id=1")
        settings = cursor.fetchone()
        if settings is None:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, UNAVAILABLE)
        data["settings"] = settings[0]
        for key, table in ARRAY_TABLES.items():
            cursor.execute(f"SELECT record_json FROM lele.{table} ORDER BY sort_order")
            data[key] = [item[0] for item in cursor.fetchall()]
        cursor.execute("SELECT series_id,record_json FROM lele.task_revisions ORDER BY series_id,sort_order")
        revisions: dict[str, list] = {}
        for series_id, revision_json in cursor.fetchall():
            revisions.setdefault(series_id, []).append(revision_json)
        cursor.execute("SELECT id,revisions_state FROM lele.task_series ORDER BY sort_order")
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

    def read(self) -> dict:
        return self._transaction(lambda cursor: self._read(cursor), readonly=True)

    def raw(self) -> bytes:
        return json.dumps(self.read(), ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8") + b"\n"

    def health(self) -> bool:
        try:
            self.read()
            return True
        except StoreError:
            return False

    def _replace_business(self, cursor, data: dict) -> None:
        for table in BUSINESS_TABLES:
            cursor.execute(f"DELETE FROM lele.{table}")
        cursor.execute("INSERT INTO lele.app_settings(id,record_json) VALUES (1,%s)", (self._json(data["settings"]),))
        native = {
            "task_series": (("start_date", "startDate"), ("start_time", "startTime"), ("end_time", "endTime"), ("created_at", "createdAt"), ("updated_at", "updatedAt")),
            "task_exceptions": (("original_date", "originalDate"),),
            "points_ledger": (("business_date", "date"), ("created_at", "createdAt")),
            "gifts": (("created_at", "createdAt"), ("updated_at", "updatedAt"), ("redeemed_at", "redeemedAt")),
            "task_presets": (("start_time", "startTime"), ("end_time", "endTime")),
            "business_operations": (("operated_at", "at"), ("effective_from", "effectiveFrom")),
        }
        for key, table in ARRAY_TABLES.items():
            columns = ["record_json", "sort_order", *[column for column, _ in native.get(table, ())]]
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
                rows.append((self._json(record_json), order, *[item.get(field) for _, field in native.get(table, ())], *values))
            if rows:
                cursor.executemany(f"INSERT INTO lele.{table} ({','.join(columns)}) VALUES ({','.join(['%s'] * len(columns))})", rows)
        revision_rows = []
        for task in data["series"]:
            for order, revision in enumerate(task.get("revisions") or []):
                effective = {**{k: v for k, v in task.items() if k != "revisions"}, **revision}
                revision_rows.append((self._json(revision), self._json(effective), order, task["id"], revision["effectiveFrom"], effective["startTime"], effective["endTime"]))
        if revision_rows:
            cursor.executemany("INSERT INTO lele.task_revisions(record_json,effective_json,sort_order,series_id,effective_from,start_time,end_time) VALUES(%s,%s,%s,%s,%s,%s,%s)", revision_rows)

    def _metadata(self, cursor, record: dict, *, insert: bool = False) -> None:
        data = record["data"]
        values = (record["format"], record["version"], data["schemaVersion"], DB_SCHEMA_VERSION, record["revision"], record["updatedAt"], record["updatedAt"], list(data), self._json({k: v for k, v in data.items() if k not in KNOWN_DATA_KEYS}), self._json({k: v for k, v in record.items() if k not in KNOWN_STORE_KEYS}))
        columns = "store_format,store_version,app_schema_version,db_schema_version,revision,updated_at,updated_at_raw,data_keys,data_extra,store_extra".split(",")
        if insert:
            cursor.execute(f"INSERT INTO lele.app_metadata(id,{','.join(columns)}) VALUES(1,{','.join(['%s'] * len(columns))})", values)
        else:
            cursor.execute(f"UPDATE lele.app_metadata SET {','.join(column+'=%s' for column in columns)} WHERE id=1", values)

    def write(self, expected_revision: int | None, data: Any, repair: bool = False) -> dict:
        validate_data(data)
        def save(cursor):
            current = self._read(cursor, locked=True)
            if type(expected_revision) is not int or current["revision"] != expected_revision:
                raise StoreError(HTTPStatus.CONFLICT, "数据已在其他浏览器更新，请刷新后再保存。")
            now = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")
            next_record = {**current, "revision": current["revision"] + 1, "updatedAt": now, "data": data}
            cursor.execute("INSERT INTO lele.data_snapshots(revision,captured_at,snapshot_json,content_sha256) VALUES(%s,%s,%s,%s)", (current["revision"], now, self._json(current), canonical_sha256(current)))
            self._replace_business(cursor, data)
            self._metadata(cursor, next_record)
            cursor.execute("DELETE FROM lele.data_snapshots WHERE id NOT IN (SELECT id FROM lele.data_snapshots ORDER BY captured_at DESC,id DESC LIMIT %s)", (BACKUP_LIMIT,))
            return next_record
        return self._transaction(save)

    @staticmethod
    def _counts(data: dict) -> dict:
        return {"settings": 1, **{key: len(data.get(key, [])) for key in ARRAY_TABLES}, "revisions": sum(len(task.get("revisions") or []) for task in data["series"])}

    def import_record(self, record: dict, source_sha256: str) -> dict:
        if not isinstance(source_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", source_sha256):
            _bad()
        validate_record(record)
        def migrate(cursor):
            cursor.execute("SELECT pg_advisory_xact_lock(1818586213,1)")
            cursor.execute("SELECT source_revision,entity_counts,business_sha256,db_schema_version FROM lele.migration_runs WHERE source_sha256=%s", (source_sha256,))
            existing = cursor.fetchone()
            if existing:
                target = self._read(cursor)
                return {"source_sha256": source_sha256, "source_revision": existing[0], "target_revision": target["revision"], "entity_counts": existing[1], "points": sum(item["amount"] for item in target["data"]["ledger"]), "business_sha256": existing[2], "source_points": sum(item["amount"] for item in record["data"]["ledger"]), "target_points": sum(item["amount"] for item in target["data"]["ledger"]), "already_migrated": True, "db_schema_version": existing[3]}
            for table in sorted(TABLES):
                cursor.execute(f"SELECT EXISTS(SELECT 1 FROM lele.{table})")
                if cursor.fetchone()[0]:
                    raise StoreError(HTTPStatus.CONFLICT, "目标数据库已有数据，迁移已停止，未作任何修改。")
            self._replace_business(cursor, record["data"])
            self._metadata(cursor, record, insert=True)
            rebuilt = self._read(cursor)
            if canonical_bytes(rebuilt) != canonical_bytes(record):
                raise StoreError(HTTPStatus.BAD_REQUEST, "迁移后的数据核验失败，未作任何修改。")
            report = {"source_sha256": source_sha256, "source_revision": record["revision"], "target_revision": rebuilt["revision"], "entity_counts": self._counts(record["data"]), "points": sum(item["amount"] for item in record["data"]["ledger"]), "business_sha256": canonical_sha256(record["data"]), "source_points": sum(item["amount"] for item in record["data"]["ledger"]), "target_points": sum(item["amount"] for item in rebuilt["data"]["ledger"]), "already_migrated": False, "db_schema_version": DB_SCHEMA_VERSION}
            cursor.execute("INSERT INTO lele.migration_runs(source_sha256,source_revision,source_updated_at_raw,target_revision,migrated_at,entity_counts,business_sha256,db_schema_version) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)", (source_sha256, record["revision"], record["updatedAt"], record["revision"], datetime.now(ZoneInfo("Asia/Shanghai")), self._json(report["entity_counts"]), report["business_sha256"], DB_SCHEMA_VERSION))
            return report
        return self._transaction(migrate)

    @staticmethod
    def _catalog(cursor) -> str:
        cursor.execute("SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='lele' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum")
        columns = cursor.fetchall()
        cursor.execute("SELECT c.relname,con.conname,pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lele' ORDER BY c.relname,con.conname")
        constraints = cursor.fetchall()
        cursor.execute("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='lele' ORDER BY indexname")
        indexes = cursor.fetchall()
        cursor.execute("SELECT p.proname,pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='lele' ORDER BY p.proname")
        return canonical_sha256([columns, constraints, indexes, cursor.fetchall()])

    def initialize_schema(self) -> None:
        try:
            sql = (self.project_root / "db" / "schema.sql").read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, "数据库结构文件不可用，未作任何修改。") from None
        source_hash = hashlib.sha256(sql.encode("utf-8")).hexdigest()
        def initialize(cursor):
            cursor.execute("SELECT pg_advisory_xact_lock(1818586213,1)")
            cursor.execute("SELECT obj_description(oid,'pg_namespace') FROM pg_namespace WHERE nspname='lele'")
            namespace = cursor.fetchone()
            if namespace is not None:
                cursor.execute("SELECT tablename FROM pg_tables WHERE schemaname='lele'")
                names = {row[0] for row in cursor.fetchall()}
                marker = namespace[0]
                if names != TABLES or not isinstance(marker, str) or marker != f"lele-schema-v1:{source_hash}:{self._catalog(cursor)}":
                    raise StoreError(HTTPStatus.CONFLICT, "检测到不熟悉的数据库结构，初始化已停止，未作任何修改。")
                cursor.execute("SELECT db_schema_version FROM lele.app_metadata")
                if any(row[0] != DB_SCHEMA_VERSION for row in cursor.fetchall()):
                    raise StoreError(HTTPStatus.CONFLICT, "数据库结构版本不受支持。")
                return
            cursor.execute(sql)
            marker = f"lele-schema-v1:{source_hash}:{self._catalog(cursor)}"
            from psycopg import sql as sql_module
            cursor.execute(sql_module.SQL("COMMENT ON SCHEMA lele IS {}").format(sql_module.Literal(marker)))
        self._transaction(initialize)

    def append_operation_log(self, record: dict) -> None:
        try:
            address = str(ipaddress.ip_address(record["client"]))
            http_status = record.get("httpStatus", 200 if record.get("result") == "saved" else 409 if record.get("result") == "conflict" else 400)
            def append(cursor):
                cursor.execute("INSERT INTO lele.request_logs(request_id,requested_at,client_address,expected_revision,current_revision,http_status,result,error_message) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)", (record["requestId"], record["at"], address, record.get("expectedRevision"), record.get("currentRevision"), http_status, record["result"], record.get("error")))
            self._transaction(append)
        except Exception:
            logging.getLogger("lele-task-manager").info("数据库保存请求日志暂时不可用。")

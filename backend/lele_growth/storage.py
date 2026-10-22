"""Shared storage contract and unchanged local JSON implementation."""
from __future__ import annotations
import json
import os
import re
import tempfile
import threading
from datetime import datetime
from http import HTTPStatus
from pathlib import Path
from typing import Any, Protocol

STORE_FORMAT = "lele-task-manager-store"
STORE_VERSION = 1
BACKUP_LIMIT = 30

class StoreError(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def resolve_storage_mode(project_root: Path, explicit: str | None = None) -> str:
    if explicit is not None:
        if explicit in {"json", "postgres"}:
            return explicit
        raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, "存储方式配置无效。")
    directory = project_root / "data"
    mode_file = directory / "storage-mode.json"
    if not mode_file.exists():
        if (directory / "rds-config.json").exists() or (directory / "rds-cutover.json").exists():
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, "存储方式配置缺失，已停止启动以保护当前数据。")
        return "json"
    try:
        mode = json.loads(mode_file.read_text(encoding="utf-8"))["storage"]
        if mode not in {"json", "postgres"}:
            raise ValueError
        return mode
    except (OSError, ValueError, TypeError, KeyError):
        raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, "存储方式配置无效。") from None


class JsonStore:
    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.data_dir = project_root / "data"
        self.data_file = self.data_dir / "lele-task-manager.json"
        self.backup_dir = self.data_dir / "backups"
        self.operation_log_file = self.data_dir / "lele-operation-log.jsonl"
        self._lock = threading.RLock()

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {
            "format": STORE_FORMAT,
            "version": STORE_VERSION,
            "revision": 0,
            "updatedAt": None,
            "data": None,
        }

    @staticmethod
    def _decode(raw: bytes) -> dict[str, Any]:
        try:
            record = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise StoreError(HTTPStatus.UNPROCESSABLE_ENTITY, "本机数据文件无法解析，未作任何修改。") from error
        if not isinstance(record, dict):
            raise StoreError(HTTPStatus.UNPROCESSABLE_ENTITY, "本机数据文件格式不正确，未作任何修改。")
        if record.get("format") != STORE_FORMAT or record.get("version") != STORE_VERSION:
            raise StoreError(HTTPStatus.UNPROCESSABLE_ENTITY, "本机数据文件版本不受支持，未作任何修改。")
        if not isinstance(record.get("revision"), int) or record["revision"] < 0:
            raise StoreError(HTTPStatus.UNPROCESSABLE_ENTITY, "本机数据文件缺少有效版本号，未作任何修改。")
        if not isinstance(record.get("data"), dict):
            raise StoreError(HTTPStatus.UNPROCESSABLE_ENTITY, "本机数据文件缺少任务数据，未作任何修改。")
        return record

    @staticmethod
    def _validate_app_data(data: Any) -> dict[str, Any]:
        if not isinstance(data, dict) or data.get("schemaVersion") != 2:
            raise StoreError(HTTPStatus.BAD_REQUEST, "提交的数据格式不正确。")
        required = ("settings", "categories", "series", "exceptions", "completions", "ledger", "gifts", "operationLog")
        if any(key not in data for key in required) or any(not isinstance(data[key], list) for key in required if key != "settings"):
            raise StoreError(HTTPStatus.BAD_REQUEST, "提交的数据结构不完整。")
        presets = data.get("taskPresets", [])
        if not isinstance(presets, list):
            raise StoreError(HTTPStatus.BAD_REQUEST, "常用任务配置必须为列表。")
        preset_ids = set()
        category_ids = {category.get("id") for category in data["categories"]
                        if isinstance(category, dict) and isinstance(category.get("id"), str)}
        for preset in presets:
            if not isinstance(preset, dict):
                raise StoreError(HTTPStatus.BAD_REQUEST, "常用任务配置格式不正确。")
            preset_id, title = preset.get("id"), preset.get("title")
            start, end, points = preset.get("startTime"), preset.get("endTime"), preset.get("points")
            category_id = preset.get("categoryId", "")
            valid_time = lambda value: isinstance(value, str) and re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value)
            if (not isinstance(preset_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,100}", preset_id)
                    or preset_id in preset_ids or not isinstance(title, str) or not title.strip() or len(title) > 80
                    or not valid_time(start) or not valid_time(end) or end <= start
                    or type(points) is not int or not 0 <= points <= 9999
                    or not isinstance(category_id, str) or (category_id and category_id not in category_ids)):
                raise StoreError(HTTPStatus.BAD_REQUEST, "常用任务配置的名称、类型、时间、积分或标识不正确。")
            preset_ids.add(preset_id)
        # 前端会做完整校验；服务端额外拦截已知会导致客户端无法加载的
        # 重复任务日期边界，避免错误数据再次落盘。
        for task in data.get("series", []):
            if not isinstance(task, dict):
                continue
            if not isinstance(task.get("id"), str) or not isinstance(task.get("startDate"), str):
                raise StoreError(HTTPStatus.BAD_REQUEST, "任务系列缺少有效标识或开始日期。")
            rule = task.get("recurrence")
            if not isinstance(rule, dict) or rule.get("endType") != "until":
                continue
            start_date, until_date = task.get("startDate"), rule.get("until")
            if isinstance(start_date, str) and isinstance(until_date, str) and until_date < start_date:
                raise StoreError(HTTPStatus.BAD_REQUEST, "重复任务的截止日期不能早于开始日期。")
            revisions = task.get("revisions")
            if revisions is not None:
                if not isinstance(revisions, list) or not revisions:
                    raise StoreError(HTTPStatus.BAD_REQUEST, "任务规则版本不能为空。")
                last = ""
                for revision in revisions:
                    if not isinstance(revision, dict) or not isinstance(revision.get("effectiveFrom"), str):
                        raise StoreError(HTTPStatus.BAD_REQUEST, "任务规则版本格式不正确。")
                    if last and revision["effectiveFrom"] <= last:
                        raise StoreError(HTTPStatus.BAD_REQUEST, "任务规则版本日期必须递增。")
                    last = revision["effectiveFrom"]
        try:
            json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        except (TypeError, ValueError) as error:
            raise StoreError(HTTPStatus.BAD_REQUEST, "提交的数据无法保存为 JSON。") from error
        return data

    def read(self) -> dict[str, Any]:
        with self._lock:
            if not self.data_file.exists():
                return self._empty()
            return self._decode(self.data_file.read_bytes())

    def raw(self) -> bytes:
        with self._lock:
            if not self.data_file.exists():
                raise StoreError(HTTPStatus.NOT_FOUND, "尚未创建本机数据文件。")
            return self.data_file.read_bytes()

    def _ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.backup_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _fsync_directory(directory: Path) -> None:
        if os.name == "posix":
            descriptor = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    def _atomic_write(self, destination: Path, payload: bytes) -> None:
        self._ensure_dirs()
        descriptor, temporary_name = tempfile.mkstemp(prefix=".write-", dir=destination.parent)
        try:
            with os.fdopen(descriptor, "wb") as temporary:
                temporary.write(payload)
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_name, destination)
            self._fsync_directory(destination.parent)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)

    def _backup_current(self, revision: int, raw: bytes, corrupt: bool = False) -> None:
        self._ensure_dirs()
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
        label = "corrupt" if corrupt else f"r{revision}"
        self._atomic_write(self.backup_dir / f"{timestamp}-{label}.json", raw)

    def _prune_backups(self) -> None:
        backups = sorted(self.backup_dir.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
        for backup in backups[BACKUP_LIMIT:]:
            backup.unlink(missing_ok=True)

    def append_operation_log(self, record: dict[str, Any]) -> None:
        """记录保存请求的结果；日志不包含完整任务数据。"""
        self._ensure_dirs()
        payload = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        with self._lock:
            with self.operation_log_file.open("ab") as log:
                log.write(payload)
                log.flush()
                os.fsync(log.fileno())

    def write(self, expected_revision: int | None, data: Any, repair: bool = False) -> dict[str, Any]:
        data = self._validate_app_data(data)
        with self._lock:
            current_raw = self.data_file.read_bytes() if self.data_file.exists() else None
            try:
                current = self._decode(current_raw) if current_raw is not None else self._empty()
            except StoreError:
                if not repair:
                    raise
                self._backup_current(0, current_raw or b"", corrupt=True)
                current = self._empty()
            if expected_revision is None or expected_revision != current["revision"]:
                raise StoreError(HTTPStatus.CONFLICT, "本机数据已在其他浏览器更新，请刷新后再保存。")
            if current_raw is not None:
                self._backup_current(current["revision"], current_raw)
            next_record = {
                "format": STORE_FORMAT,
                "version": STORE_VERSION,
                "revision": current["revision"] + 1,
                "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
                "data": data,
            }
            payload = json.dumps(next_record, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8") + b"\n"
            self._atomic_write(self.data_file, payload)
            self._prune_backups()
            return next_record


class DataStore(Protocol):
    def read(self) -> dict[str, Any]: ...
    def raw(self) -> bytes: ...
    def write(self, expected_revision: int | None, data: Any, repair: bool = False) -> dict[str, Any]: ...
    def append_operation_log(self, record: dict[str, Any]) -> None: ...

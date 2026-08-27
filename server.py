#!/usr/bin/env python3
"""仅供本机使用的乐乐成长计划数据服务。"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


HOST = "127.0.0.1"
PORT = 8787
STORE_FORMAT = "lele-task-manager-store"
STORE_VERSION = 1
MAX_BODY_BYTES = 2 * 1024 * 1024
BACKUP_LIMIT = 30


class StoreError(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class JsonStore:
    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.data_dir = project_root / "data"
        self.data_file = self.data_dir / "lele-task-manager.json"
        self.backup_dir = self.data_dir / "backups"
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
        if not isinstance(data, dict) or data.get("schemaVersion") != 1:
            raise StoreError(HTTPStatus.BAD_REQUEST, "提交的数据格式不正确。")
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


class AppHandler(BaseHTTPRequestHandler):
    server_version = "LeleTaskManager/1"
    store: JsonStore
    index_file: Path

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def _json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, error: StoreError) -> None:
        self._json(error.status, {"error": error.message})

    def _read_request_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError as error:
            raise StoreError(HTTPStatus.BAD_REQUEST, "请求长度不正确。") from error
        if length < 1 or length > MAX_BODY_BYTES:
            raise StoreError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "请求数据过大或为空。")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise StoreError(HTTPStatus.BAD_REQUEST, "请求不是有效 JSON。") from error
        if not isinstance(payload, dict):
            raise StoreError(HTTPStatus.BAD_REQUEST, "请求格式不正确。")
        return payload

    def _serve_index(self) -> None:
        body = self.index_file.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path in ("/", "/index.html"):
                self._serve_index()
            elif path == "/api/health":
                self._json(HTTPStatus.OK, {"service": "lele-task-manager", "version": STORE_VERSION})
            elif path == "/api/data":
                self._json(HTTPStatus.OK, self.store.read())
            elif path == "/api/data/raw":
                body = self.store.raw()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Disposition", 'attachment; filename="lele-task-manager-raw.json"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self._json(HTTPStatus.NOT_FOUND, {"error": "未找到请求的资源。"})
        except StoreError as error:
            self._error(error)
        except OSError:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "读取本机数据失败。"})

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/data":
            self._json(HTTPStatus.NOT_FOUND, {"error": "未找到请求的资源。"})
            return
        try:
            payload = self._read_request_json()
            expected = payload.get("expectedRevision")
            if not isinstance(expected, int) or expected < 0:
                raise StoreError(HTTPStatus.BAD_REQUEST, "缺少有效的数据版本号。")
            repair = parse_qs(parsed.query).get("repair") == ["1"]
            record = self.store.write(expected, payload.get("data"), repair=repair)
            self._json(HTTPStatus.OK, record)
        except StoreError as error:
            self._error(error)
        except OSError:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "写入本机数据失败，原数据未被替换。"})


def has_running_instance() -> bool:
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/api/health", timeout=1) as response:
            return json.loads(response.read().decode("utf-8")).get("service") == "lele-task-manager"
    except (urllib.error.URLError, ValueError, TimeoutError):
        return False


def create_server(project_root: Path, port: int = PORT) -> ThreadingHTTPServer:
    handler = type("LeleHandler", (AppHandler,), {"store": JsonStore(project_root), "index_file": project_root / "index.html"})
    return ThreadingHTTPServer((HOST, port), handler)


def main() -> int:
    parser = argparse.ArgumentParser(description="乐乐成长计划本机数据服务")
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    try:
        server = create_server(root, args.port)
    except OSError as error:
        if args.port == PORT and has_running_instance():
            print("乐乐成长计划已经在运行，正在打开浏览器。")
            webbrowser.open(f"http://{HOST}:{PORT}/")
            return 0
        print(f"无法启动本机服务：端口 {args.port} 已被其他程序占用。")
        return 1
    url = f"http://{HOST}:{args.port}/"
    print(f"乐乐成长计划正在运行：{url}")
    print("请保持此窗口打开；关闭窗口不会删除项目目录中的数据。")
    threading.Timer(0.35, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n本机服务已停止，数据已保留。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

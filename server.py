#!/usr/bin/env python3
"""乐乐成长计划本机数据服务，默认允许受口令保护的局域网访问。"""

from __future__ import annotations

import argparse
import json
import logging
import os
import secrets
import shutil
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime
from http.cookies import SimpleCookie
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


LOOPBACK_HOST = "127.0.0.1"
BIND_HOST = "0.0.0.0"
PORT = 8787
STORE_FORMAT = "lele-task-manager-store"
STORE_VERSION = 1
MAX_BODY_BYTES = 16 * 1024 * 1024
BACKUP_LIMIT = 30
ACCESS_CODE_LENGTH = 10
SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
ACCESS_COOKIE_NAME = "lele_access_session"
ACCESS_CONFIG_NAME = "lele-lan-access.json"
SERVICE_LOGGER = logging.getLogger("lele-task-manager")


def configure_service_logging(log_dir: str | None) -> None:
    """Configure bounded service logs for background launchd runs."""
    SERVICE_LOGGER.handlers.clear()
    SERVICE_LOGGER.setLevel(logging.INFO)
    SERVICE_LOGGER.propagate = False
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    if log_dir:
        directory = Path(log_dir)
        directory.mkdir(parents=True, exist_ok=True)
        handler: logging.Handler = RotatingFileHandler(
            directory / "server.log", maxBytes=1_024 * 1_024, backupCount=3, encoding="utf-8"
        )
    else:
        handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    SERVICE_LOGGER.addHandler(handler)


def service_log(message: str) -> None:
    SERVICE_LOGGER.info(message)


class StoreError(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def is_loopback(address: str) -> bool:
    return address in {"127.0.0.1", "::1"}


def local_network_addresses() -> list[str]:
    addresses: set[str] = set()
    try:
        candidates = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except socket.gaierror:
        candidates = []
    for candidate in candidates:
        address = candidate[4][0]
        if not is_loopback(address) and not address.startswith("169.254."):
            addresses.add(address)
    # getaddrinfo 在部分 Mac 网络配置下只会返回回环地址；此探测不会发出网络请求，
    # 仅借助系统路由表取得当前默认网络接口的本机地址。
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 80))
            address = probe.getsockname()[0]
            if not is_loopback(address) and not address.startswith("169.254."):
                addresses.add(address)
    except OSError:
        pass
    return sorted(addresses)


def new_access_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    raw = "".join(secrets.choice(alphabet) for _ in range(ACCESS_CODE_LENGTH))
    return f"{raw[:5]}-{raw[5:]}"


class AccessControl:
    """Persistent LAN passcode plus in-memory browser sessions."""

    def __init__(self, project_root: Path):
        self.config_file = project_root / "data" / ACCESS_CONFIG_NAME
        self._lock = threading.RLock()
        self._sessions: dict[str, float] = {}
        self._code = self._load_or_create_code()

    def _load_or_create_code(self) -> str:
        try:
            record = json.loads(self.config_file.read_text(encoding="utf-8"))
            code = record.get("code") if isinstance(record, dict) else None
            if isinstance(code, str) and len(code) == ACCESS_CODE_LENGTH + 1:
                return code
        except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
            pass
        code = new_access_code()
        self._write_code(code)
        return code

    def _write_code(self, code: str) -> None:
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix=".access-", dir=self.config_file.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as temporary:
                json.dump({"code": code, "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds")}, temporary, ensure_ascii=False)
                temporary.write("\n")
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_name, self.config_file)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)

    def code(self) -> str:
        with self._lock:
            return self._code

    def rotate(self) -> str:
        with self._lock:
            self._code = new_access_code()
            self._write_code(self._code)
            self._sessions.clear()
            return self._code

    def _clean_sessions(self) -> None:
        now = time.time()
        self._sessions = {token: expires for token, expires in self._sessions.items() if expires > now}

    def create_session(self) -> str:
        with self._lock:
            self._clean_sessions()
            token = secrets.token_urlsafe(32)
            self._sessions[token] = time.time() + SESSION_MAX_AGE_SECONDS
            return token

    def verify_code(self, code: Any) -> bool:
        if not isinstance(code, str):
            return False
        with self._lock:
            return secrets.compare_digest(code.strip().upper(), self._code)

    def session_is_valid(self, token: str | None) -> bool:
        if not token:
            return False
        with self._lock:
            self._clean_sessions()
            return token in self._sessions


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


class AppHandler(BaseHTTPRequestHandler):
    server_version = "LeleTaskManager/1"
    store: JsonStore
    access: AccessControl
    index_file: Path

    def log_message(self, format: str, *args: Any) -> None:
        service_log(f"{self.client_address[0]} {format % args}")

    def _json(self, status: HTTPStatus, payload: dict[str, Any], headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
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

    def _session_token(self) -> str | None:
        try:
            cookies = SimpleCookie(self.headers.get("Cookie", ""))
            morsel = cookies.get(ACCESS_COOKIE_NAME)
            return morsel.value if morsel else None
        except (KeyError, ValueError):
            return None

    def _is_local_request(self) -> bool:
        return is_loopback(self.client_address[0])

    def _require_access(self) -> None:
        if self._is_local_request() or self.access.session_is_valid(self._session_token()):
            return
        raise StoreError(HTTPStatus.UNAUTHORIZED, "请输入局域网访问口令。")

    def _access_status(self) -> dict[str, Any]:
        urls = [f"http://{address}:{self.server.server_port}/" for address in local_network_addresses()]
        return {
            "lanUrls": urls,
            "canRefresh": self._is_local_request(),
            "code": self.access.code() if self._is_local_request() else None,
        }

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
            elif path == "/api/access/status":
                self._require_access()
                self._json(HTTPStatus.OK, self._access_status())
            elif path == "/api/data":
                self._require_access()
                self._json(HTTPStatus.OK, self.store.read())
            elif path == "/api/data/raw":
                self._require_access()
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
        request_id = secrets.token_hex(8)
        expected = None
        result = "error"
        try:
            self._require_access()
            payload = self._read_request_json()
            expected = payload.get("expectedRevision")
            if not isinstance(expected, int) or expected < 0:
                raise StoreError(HTTPStatus.BAD_REQUEST, "缺少有效的数据版本号。")
            repair = parse_qs(parsed.query).get("repair") == ["1"]
            record = self.store.write(expected, payload.get("data"), repair=repair)
            self._json(HTTPStatus.OK, record)
            result = "saved"
        except StoreError as error:
            self._error(error)
            result = f"error:{error.status.value}"
            error_message = error.message
        except OSError:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "写入本机数据失败，原数据未被替换。"})
            result = "error:500"
            error_message = "写入本机数据失败"
        finally:
            try:
                self.store.append_operation_log({
                    "requestId": request_id,
                    "at": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "client": self.client_address[0],
                    "expectedRevision": expected,
                    "currentRevision": self.store.read().get("revision"),
                    "result": result,
                    "error": locals().get("error_message"),
                })
            except (OSError, StoreError):
                pass

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path == "/api/access/login":
                payload = self._read_request_json()
                if not self.access.verify_code(payload.get("code")):
                    raise StoreError(HTTPStatus.UNAUTHORIZED, "访问口令不正确。")
                token = self.access.create_session()
                cookie = f"{ACCESS_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_MAX_AGE_SECONDS}"
                self._json(HTTPStatus.OK, {"ok": True}, {"Set-Cookie": cookie})
                return
            if path == "/api/access/refresh":
                if not self._is_local_request():
                    raise StoreError(HTTPStatus.FORBIDDEN, "请在这台 Mac 的浏览器中刷新局域网访问口令。")
                code = self.access.rotate()
                self._json(HTTPStatus.OK, {**self._access_status(), "code": code})
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "未找到请求的资源。"})
        except StoreError as error:
            self._error(error)
        except OSError:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "无法更新局域网访问口令。"})


def has_running_instance() -> bool:
    try:
        with urllib.request.urlopen(f"http://{LOOPBACK_HOST}:{PORT}/api/health", timeout=1) as response:
            return json.loads(response.read().decode("utf-8")).get("service") == "lele-task-manager"
    except (urllib.error.URLError, ValueError, TimeoutError):
        return False


def create_server(project_root: Path, port: int = PORT) -> ThreadingHTTPServer:
    handler = type(
        "LeleHandler",
        (AppHandler,),
        {"store": JsonStore(project_root), "access": AccessControl(project_root), "index_file": project_root / "index.html"},
    )
    return ThreadingHTTPServer((BIND_HOST, port), handler)


def main() -> int:
    parser = argparse.ArgumentParser(description="乐乐成长计划本机数据服务")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--no-browser", action="store_true", help="服务就绪后不自动打开浏览器（供后台服务使用）")
    parser.add_argument("--log-dir", help="后台服务日志目录；日志会自动轮转")
    args = parser.parse_args()
    configure_service_logging(args.log_dir)
    root = Path(__file__).resolve().parent
    try:
        server = create_server(root, args.port)
    except OSError as error:
        if args.port == PORT and has_running_instance():
            service_log("乐乐成长计划已经在运行。")
            if not args.no_browser:
                webbrowser.open(f"http://{LOOPBACK_HOST}:{PORT}/")
            return 0
        service_log(f"无法启动本机服务：端口 {args.port} 已被其他程序占用。")
        return 1
    url = f"http://{LOOPBACK_HOST}:{args.port}/"
    service_log(f"乐乐成长计划正在运行：{url}")
    lan_urls = [f"http://{address}:{args.port}/" for address in local_network_addresses()]
    if lan_urls:
        service_log("局域网访问地址（首次访问需输入口令）：")
        for lan_url in lan_urls:
            service_log(f"  {lan_url}")
    else:
        service_log("暂未检测到局域网地址；连接 Wi-Fi 后重新启动可显示访问地址。")
    service_log(f"局域网访问口令：{server.RequestHandlerClass.access.code()}")
    service_log("口令会持续有效，直到在设置中手动刷新。")
    if not args.no_browser:
        threading.Timer(0.35, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        service_log("本机服务已停止，数据已保留。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

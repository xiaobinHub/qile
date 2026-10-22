#!/usr/bin/env python3
"""乐乐成长计划本机数据服务，默认允许受口令保护的局域网访问。"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
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

from lele_growth.storage import BACKUP_LIMIT, STORE_FORMAT, STORE_VERSION, DataStore, JsonStore, StoreError, resolve_storage_mode


LOOPBACK_HOST = "127.0.0.1"
BIND_HOST = "0.0.0.0"
PORT = 8787
MAX_BODY_BYTES = 16 * 1024 * 1024
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




class AppHandler(BaseHTTPRequestHandler):
    server_version = "LeleTaskManager/1"
    store: DataStore
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
                is_postgres = not isinstance(self.store, JsonStore)
                ready = self.store.health() if is_postgres else True
                self._json(HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE, {
                    "service": "lele-task-manager", "version": STORE_VERSION,
                    "storage": "postgres" if is_postgres else "json", "databaseReady": ready,
                })
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
        current_revision = None
        http_status = HTTPStatus.INTERNAL_SERVER_ERROR
        try:
            self._require_access()
            payload = self._read_request_json()
            expected = payload.get("expectedRevision")
            if not isinstance(expected, int) or expected < 0:
                raise StoreError(HTTPStatus.BAD_REQUEST, "缺少有效的数据版本号。")
            repair = parse_qs(parsed.query).get("repair") == ["1"]
            record = self.store.write(expected, payload.get("data"), repair=repair)
            current_revision = record["revision"]
            http_status = HTTPStatus.OK
            self._json(HTTPStatus.OK, record)
            result = "saved"
        except StoreError as error:
            http_status = error.status
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
                    "currentRevision": current_revision,
                    "httpStatus": http_status.value,
                    "result": result,
                    "error": locals().get("error_message"),
                })
            except (OSError, StoreError):
                service_log("保存请求日志未能写入；业务结果保持不变。")

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


def create_server(project_root: Path, port: int = PORT, *, storage: str = "json",
                  config_path: Path | None = None, data_root: Path | None = None) -> ThreadingHTTPServer:
    root = data_root or project_root
    if storage == "postgres":
        from lele_growth.postgres_store import PostgresStore
        store = PostgresStore(root, config_path=config_path)
    elif storage == "json":
        store = JsonStore(root)
    else:
        raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, "不支持的数据存储类型。")
    handler = type(
        "LeleHandler",
        (AppHandler,),
        {"store": store, "access": AccessControl(root), "index_file": project_root / "index.html"},
    )
    return ThreadingHTTPServer((BIND_HOST, port), handler)


def main() -> int:
    parser = argparse.ArgumentParser(description="乐乐成长计划本机数据服务")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--no-browser", action="store_true", help="服务就绪后不自动打开浏览器（供后台服务使用）")
    parser.add_argument("--log-dir", help="后台服务日志目录；日志会自动轮转")
    parser.add_argument("--storage", choices=("json", "postgres"), help="明确选择存储方式；未指定时读取本机配置")
    parser.add_argument("--db-config", type=Path, help="本机数据库配置文件")
    parser.add_argument("--data-root", type=Path, help="独立数据根目录（供隔离测试使用）")
    args = parser.parse_args()
    configure_service_logging(args.log_dir)
    root = Path(__file__).resolve().parent
    try:
        args.storage = resolve_storage_mode(root, args.storage)
        server = create_server(root, args.port, storage=args.storage,
                               config_path=args.db_config, data_root=args.data_root)
    except StoreError as error:
        service_log(error.message)
        return 1
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
    service_log("局域网访问口令可在本机页面“设置 → 局域网共享”查看。")
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

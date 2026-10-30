"""Private Unix HTTP worker. Only this process imports a plugin entry module."""
from __future__ import annotations

import argparse
import importlib
import inspect
import asyncio
import json
import os
import re
import signal
import socketserver
import threading
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

MAX_BODY = 1024 * 1024


def invoke(handler, *args):
    value = handler(*args)
    return asyncio.run(value) if inspect.isawaitable(value) else value


class WorkerServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 16
    block_on_close = False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log contexts, payloads or exception strings.

    def setup(self):
        self.request.settimeout(15)
        super().setup()

    def do_GET(self):
        self.respond(405, {"error": "method_not_allowed"})

    def respond(self, status, value):
        try:
            data = json.dumps(value, allow_nan=False, separators=(",", ":")).encode()
            if len(data) > MAX_BODY:
                status, data = 502, b'{"error":"response_too_large"}'
        except (TypeError, ValueError):
            status, data = 502, b'{"error":"invalid_response"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        if not self.server.capacity.acquire(blocking=False):
            return self.respond(503, {"error": "worker_busy"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > MAX_BODY:
                return self.respond(413, {"error": "body_too_large"})
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError()
            module = self.server.plugin
            if self.path == "/health":
                value = invoke(module.health) if hasattr(module, "health") else {"ok": True}
                return self.respond(200, {"ok": value is not False and not (isinstance(value, dict) and value.get("ok") is False), "protocol": "1.0", "pid": os.getpid()})
            if self.path == "/shutdown":
                if hasattr(module, "shutdown"):
                    invoke(module.shutdown)
                self.respond(200, {"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            context = body.get("context")
            if not isinstance(context, dict) or not isinstance(context.get("scopeToken"), str):
                return self.respond(403, {"error": "missing_context"})
            if self.path == "/handle_request":
                value = invoke(module.handle_request, context, body.get("path", ""), body.get("method", "GET"), body.get("body", {}))
            elif self.path == "/handle_job":
                value = invoke(module.handle_job, context, body["task"], body.get("payload", {}))
            elif self.path == "/cancel_job":
                value = invoke(module.cancel_job, context, body.get("jobId")) if hasattr(module, "cancel_job") else {"cancelled": False}
            else:
                return self.respond(404, {"error": "unknown_method"})
            self.respond(200, value)
        except (ValueError, KeyError, TypeError):
            self.respond(400, {"error": "invalid_request"})
        except Exception:
            self.respond(502, {"error": "plugin_handler_failed"})
        finally:
            self.server.capacity.release()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--module", required=True)
    parser.add_argument("--socket", required=True, type=Path)
    parser.add_argument("--max-concurrency", type=int, default=4)
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*", args.module):
        parser.error("invalid module")
    if not 1 <= args.max_concurrency <= 16:
        parser.error("invalid concurrency")
    os.umask(0o077)
    # Limits are installed here rather than preexec_fn, which is unsafe in a
    # threaded parent. systemd adds aggregate CPU/memory/process budgets.
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    # Darwin's RLIMIT_AS does not reliably describe resident memory. Enforce
    # address-space limits on Linux, where production workers run. CPU seconds
    # cap a runaway process independently of the runtime's aggregate cgroup.
    if sys.platform.startswith('linux'):
        resource.setrlimit(resource.RLIMIT_AS, (192 * 1024 * 1024, 192 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (60, 61))
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
    module = importlib.import_module(args.module)
    args.socket.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with WorkerServer(str(args.socket), Handler) as server:
        server.plugin = module
        server.capacity = threading.BoundedSemaphore(args.max_concurrency)
        os.chmod(args.socket, 0o600)
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
        try:
            server.serve_forever(poll_interval=0.1)
        finally:
            args.socket.unlink(missing_ok=True)


if __name__ == "__main__":
    main()

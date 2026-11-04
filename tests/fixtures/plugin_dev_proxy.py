"""Real parent HTTP/WS/CSP host with fail-closed auth/business fixtures, no DB.

Started only by tests/browser/plugin_development_proxy.cjs. All state is private
to --root; sourceRoot deliberately remains the actual plugin source directory.
"""
import argparse
from contextlib import ExitStack
import json
from pathlib import Path
import socket
import sys
from unittest.mock import patch

import uvicorn
from lele_growth import accounts_app
from lele_growth.child_service import ApiError
from lele_growth.plugins.dev_mode import DevRegistry

REPO = Path(__file__).resolve().parents[2]
CONFIG = {"environment": "development", "database": {"host": "127.0.0.1"}, "_object_storage": None}
TOKEN = "isolated-proxy-parent"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    fixture = json.loads((args.root / "api.json").read_text())
    registry = DevRegistry(CONFIG, repo=REPO, root=args.root / "registry")
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    origin = f"http://127.0.0.1:{listener.getsockname()[1]}"

    # Even an accidental future fixture regression cannot contact Mison or a DB.
    def audit(event, values):
        if event == "socket.connect":
            address = values[1]
            descriptor = registry.read("mison-booking")
            if not (isinstance(address, tuple) and descriptor
                    and address[0] == "127.0.0.1" and address[1] == descriptor["port"]):
                raise AssertionError(f"Non-Vite outbound socket blocked: {address!r}")
    sys.addaudithook(audit)

    def authorize(service, token, surface, plugin_id):
        if (token != TOKEN or surface != "parent" or plugin_id != "mison-booking"
                or (args.root / "revoked").exists()):
            raise ApiError(403, "Fixture authorization denied", "fixture_denied")

    class FixtureService:
        config = CONFIG

        def transaction(self, *_args, **_kwargs):
            raise AssertionError("Database access is forbidden in this integration test")

        def origin_trusted(self, value, surface):
            return surface == "parent" and value == origin

        def request(self, method, route, body, token, csrf, request_origin, surface, client):
            authorize(self, token, surface, "mison-booking")
            with (args.root / "requests.jsonl").open("a") as log:
                log.write(json.dumps({"method": method, "path": route}) + "\n")
            if method != "GET":
                raise AssertionError(f"Unexpected business write: {method} {route}")
            if route not in fixture:
                raise AssertionError(f"Missing HTTP fixture: {route}")
            # Production api() pops cookie metadata: return a fresh object.
            return json.loads(json.dumps(fixture[route]))

    with ExitStack() as stack:
        stack.enter_context(patch.object(accounts_app, "ChildService", return_value=FixtureService()))
        stack.enter_context(patch.object(accounts_app, "WEB_ROOT", args.root / "web"))
        stack.enter_context(patch("lele_growth.plugins.dev_mode.DevRegistry", return_value=registry))
        stack.enter_context(patch("lele_growth.plugins.dev_mode.authorize_resource", side_effect=authorize))
        stack.enter_context(patch("lele_growth.plugins.gateway.PluginGateway.route", return_value=NotImplemented))
        app = accounts_app.create_app("fixture-does-not-load-config", "parent")
        print(json.dumps({"origin": origin}), flush=True)
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning", timeout_graceful_shutdown=3))
        server.run(sockets=[listener])


if __name__ == "__main__":
    main()

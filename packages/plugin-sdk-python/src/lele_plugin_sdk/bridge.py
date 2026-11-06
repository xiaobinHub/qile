"""Small standard-library client for the private plugin bridge."""
from __future__ import annotations

import http.client
import json
import os
import socket


class BridgeError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class BridgeClient:
    def __init__(self, path=None, credential=None):
        self.path = path or os.environ.get('LELE_PLUGIN_BRIDGE_SOCKET')
        self.credential = credential or os.environ.get('LELE_PLUGIN_BRIDGE_TOKEN')

    def call(self, context, action, payload, *, timeout=10):
        if not self.path:
            raise RuntimeError('plugin bridge unavailable')
        connection = http.client.HTTPConnection('localhost', timeout=timeout)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(timeout)
        connection.sock.connect(self.path)
        try:
            data = json.dumps({'context': context, 'action': action, 'payload': payload}, allow_nan=False).encode()
            headers = {'Content-Type': 'application/json'}
            if self.credential:
                headers['Authorization'] = 'Bearer ' + self.credential
            connection.request('POST', '/bridge', data, headers)
            response = connection.getresponse()
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise BridgeError('plugin_bridge_failed', '插件登录服务响应过大。')
            result = json.loads(raw)
            if response.status != 200 or not isinstance(result, dict) or not result.get('ok'):
                message = result.get('error') if isinstance(result, dict) else None
                raise BridgeError(result.get('kind', 'plugin_bridge_failed') if isinstance(result, dict) else 'plugin_bridge_failed',
                                  message if isinstance(message, str) else '插件登录服务暂时不可用。')
            return result.get('data')
        finally:
            connection.close()

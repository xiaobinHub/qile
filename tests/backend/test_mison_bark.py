"""Bark transport contract with synthetic device keys and no external requests."""
import json
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

from mison_booking import bark


class BarkTransportTests(unittest.TestCase):
    def send(self, *, keys=None, status=200, data=b'{"code":200}', error=None):
        response = MagicMock()
        response.status = status
        response.read.return_value = data
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value = response
        if error:
            opener.open.side_effect = error
        with patch.object(bark.urllib.request, 'build_opener', return_value=opener) as build:
            result = bark.push({'keys': keys or ['fixture_key_A'], 'title': '美森约课成功', 'body': '2026-11-20 19:30 · 测试老师'})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://api.day.app/push')
        self.assertEqual(request.method, 'POST')
        self.assertEqual(request.get_header('Content-type'), 'application/json')
        self.assertEqual(opener.open.call_args.kwargs, {'timeout': 5})
        self.assertIsInstance(build.call_args.args[0], bark.NoRedirect)
        return result, json.loads(request.data)

    def test_single_and_multiple_keys_use_official_json_fields(self):
        result, payload = self.send()
        self.assertEqual(result, 'succeeded')
        self.assertEqual(payload['device_key'], 'fixture_key_A')
        self.assertEqual(payload['ttl'], 600)
        self.assertEqual(payload['group'], '美森自动约课')
        result, payload = self.send(keys=['fixture_key_A', 'fixture_key_B'])
        self.assertEqual(result, 'succeeded')
        self.assertEqual(payload['device_keys'], ['fixture_key_A', 'fixture_key_B'])
        self.assertNotIn('device_key', payload)

    def test_api_http_and_malformed_responses_never_count_as_success(self):
        for args, expected in [({'data': b'{"code":400}'}, 'failed'), ({'status': 503}, 'failed'),
                               ({'data': b'{"code":"200"}'}, 'failed'), ({'data': b'[]'}, 'failed'),
                               ({'data': b'bad-json'}, 'uncertain'), ({'data': b'x' * 16385}, 'uncertain'),
                               ({'error': TimeoutError('fixture_key_A')}, 'uncertain'),
                               ({'error': urllib.error.HTTPError(bark.ENDPOINT, 401, 'invalid', {}, None)}, 'failed'),
                               ({'error': urllib.error.HTTPError(bark.ENDPOINT, 302, 'redirect', {}, None)}, 'uncertain')]:
            with self.subTest(args=args):
                self.assertEqual(self.send(**args)[0], expected)

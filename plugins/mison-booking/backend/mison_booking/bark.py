"""Bounded Bark POSTs; notification failures never change booking outcomes."""
import http.client
import json
import urllib.error
import urllib.request

from .auth import NoRedirect

ENDPOINT = 'https://api.day.app/push'


def push(notification):
    keys = notification['keys']
    payload = {'title': notification['title'], 'body': notification['body'],
               'group': '美森自动约课', 'ttl': 600,
               **({'device_key': keys[0]} if len(keys) == 1 else {'device_keys': keys})}
    request = urllib.request.Request(ENDPOINT, data=json.dumps(payload, ensure_ascii=False).encode(),
                                     headers={'Content-Type': 'application/json', 'Accept': 'application/json'}, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=5) as response:
            raw = response.read(16385)
            if len(raw) > 16384:
                return 'uncertain'
            value = json.loads(raw)
            if response.status == 200 and isinstance(value, dict) and type(value.get('code')) is int and value['code'] == 200:
                return 'succeeded'
            return 'failed'
    except urllib.error.HTTPError as error:
        error.close()
        return 'failed' if 400 <= error.code < 500 and error.code != 408 else 'uncertain'
    except (OSError, ValueError, http.client.HTTPException):
        return 'uncertain'

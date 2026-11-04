"""Lazy public teacher avatars. Never sends a Mison bearer or follows redirects."""
import base64
import hashlib
import http.client
import ipaddress
import socket
import ssl
from urllib.parse import urlsplit
from .auth import AuthError
from .read_store import memo, Cache

HOSTS = {'mp.mison.cn', 'file.mison.cn'}
MAX_IMAGE_BYTES = 4 * 1024 * 1024
CHUNK_CHARS = 384 * 1024
image_cache = Cache(32, 24 * 1024 * 1024)

def reference(client, url):
    if not isinstance(url, str) or not url: return None
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme not in ('https', 'http') or parsed.hostname not in HOSTS or parsed.username or parsed.password or port not in (None, 80, 443):
        return None
    # These verified public CDN origins support HTTPS. No bearer or query credentials.
    safe = 'https://' + parsed.hostname + parsed.path + ('?' + parsed.query if parsed.query else '')
    key = hashlib.sha256(safe.encode()).hexdigest()
    memo.put(('image-ref', *client.scope, key), safe, ttl=600)
    return 'mison-image:' + key

class PinnedConnection(http.client.HTTPSConnection):
    def connect(self):
        addresses = socket.getaddrinfo(self.host, 443, type=socket.SOCK_STREAM)
        # Local Clash/TUN DNS uses the reserved benchmark ranges. Only the two
        # fixed CDN hostnames are accepted, and TLS still verifies that hostname.
        benchmarks = (ipaddress.ip_network('198.18.0.0/15'), ipaddress.ip_network('2001:2::/48'))
        def permitted(address):
            ip = ipaddress.ip_address(address)
            return ip.is_global or any(ip.version == net.version and ip in net for net in benchmarks)
        if self.host not in HOSTS or not addresses or any(not permitted(row[4][0]) for row in addresses):
            raise OSError('invalid resource address')
        raw = socket.create_connection((addresses[0][4][0], 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise

def image_part(data, chunk):
    if len(data) <= CHUNK_CHARS:
        if chunk: raise AuthError('VALIDATION_ERROR', '头像分段不正确。')
        return {'dataUrl': data}
    header, encoded = data.split(',', 1)
    count = (len(encoded) + CHUNK_CHARS - 1) // CHUNK_CHARS
    if chunk >= count: raise AuthError('VALIDATION_ERROR', '头像分段不正确。')
    return {'chunk': encoded[chunk * CHUNK_CHARS:(chunk + 1) * CHUNK_CHARS],
            'chunkIndex': chunk, 'totalChunks': count, 'mimeType': header[5:].split(';')[0]}

def load(client, key, chunk='0'):
    if not isinstance(chunk, str) or not chunk.isdecimal() or len(chunk) > 2 or int(chunk) > 15:
        raise AuthError('VALIDATION_ERROR', '头像分段不正确。')
    chunk = int(chunk)
    url = memo.get(('image-ref', *client.scope, key))
    if not url:
        raise AuthError('RESOURCE_EXPIRED', '头像引用已过期，请刷新老师列表。')
    cached = image_cache.get(key)
    if cached: return image_part(cached, chunk)
    parsed = urlsplit(url)
    connection = PinnedConnection(parsed.hostname, timeout=5, context=ssl.create_default_context())
    try:
        connection.request('GET', parsed.path + ('?' + parsed.query if parsed.query else ''), headers={'Accept': 'image/*'})
        response = connection.getresponse()
        raw = response.read(MAX_IMAGE_BYTES + 1)
        mime = response.getheader('Content-Type', '').split(';')[0].lower()
        valid = ((mime in ('image/jpeg', 'image/jpg') and raw.startswith(b'\xff\xd8\xff')) or
                 (mime == 'image/png' and raw.startswith(b'\x89PNG\r\n\x1a\n')) or
                 (mime == 'image/webp' and raw.startswith(b'RIFF') and raw[8:12] == b'WEBP') or
                 (mime == 'image/gif' and raw[:6] in (b'GIF87a', b'GIF89a')))
        if response.status != 200 or not valid or len(raw) > MAX_IMAGE_BYTES:
            raise AuthError('RESOURCE_UNAVAILABLE', '头像暂时不可用。')
        data = 'data:' + mime + ';base64,' + base64.b64encode(raw).decode()
        image_cache.put(key, data, ttl=300)
        return image_part(data, chunk)
    except (OSError, http.client.HTTPException):
        raise AuthError('RESOURCE_UNAVAILABLE', '头像暂时不可用。') from None
    finally:
        connection.close()

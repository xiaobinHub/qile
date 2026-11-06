"""Scoped, short-lived public teacher video tickets and bounded Range streaming."""
from datetime import datetime, timedelta, timezone
import http.client
import ipaddress
import re
import secrets
import socket
import ssl
from urllib.parse import urlsplit, urlunsplit, quote
from lele_growth.child_service import require, ApiError
from .policy import active_context, catalog_row, row_dict
from . import private_store

MAX_VIDEO_BYTES = 200 * 1024 * 1024
HOSTS = {'file.mison.cn', 'mp.mison.cn'}

def video_url(value, origins, purpose='teacher-intro-video'):
    require(isinstance(value, str) and 0 < len(value) <= 2048 and all(ord(c) >= 33 and ord(c) != 127 for c in value), 400, '视频地址不正确。')
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ApiError(400, '视频地址不正确。') from None
    require(parsed.scheme == 'https' and parsed.hostname in HOSTS and not parsed.username and not parsed.password
            and port in (None, 443) and not parsed.fragment and parsed.path.lower().endswith('.pdf' if purpose == 'courseware-pdf' else '.mp4')
            and 'https://' + parsed.hostname in origins, 400, '视频来源不受支持。', 'plugin_resource_origin_denied')
    return value

def issue(cur, current, context, payload):
    require('plugin.resources' in current['capabilities'] and 'plugin.resources' in context.get('capabilities', []), 403, '插件未获资源能力。')
    cur.execute("SELECT 1 FROM lele.memberships m JOIN lele.users u ON u.id=m.user_id WHERE m.child_id=%s AND m.user_id=%s AND u.status='active'", (current['child_id'], context['actorId']))
    require(cur.fetchone() is not None, 403, '无权访问该儿童的资源。')
    purpose = payload.get('purpose')
    require(purpose in ('teacher-intro-video', 'courseware-pdf'), 400, '资源用途不受支持。')
    mime = 'application/pdf' if purpose == 'courseware-pdf' else 'video/mp4'
    source_url = payload.get('url')
    if purpose == 'courseware-pdf' and isinstance(source_url, str):
        # App applies encodeURI before opening PDFs. Preserve existing percent escapes.
        require(all(ord(char) >= 32 and ord(char) != 127 for char in source_url), 400, '课件地址不正确。')
        parsed = urlsplit(source_url)
        source_url = urlunsplit((parsed.scheme, parsed.netloc, quote(parsed.path, safe="/%:@!$&'()*+,;=-._~"),
                                quote(parsed.query, safe="%:@!$&'()*+,;=/?-._~"), parsed.fragment))
    url = video_url(source_url, current['manifest'].get('resourceOrigins', []), purpose)
    saved = private_store.get(cur, current, 'login-session', 'current')
    binding = saved['payload'] if saved else {}
    require(isinstance(binding.get('credentialId'), str) and binding.get('credentialId') == payload.get('credentialId')
            and type(payload.get('bindingRevision')) is int and binding.get('bindingRevision') == payload.get('bindingRevision'),
            409, '账号状态已改变。', 'BINDING_CHANGED')
    cur.execute("SELECT revision,expires_at FROM lele.plugin_credentials WHERE id=%s AND child_id=%s AND plugin_id=%s AND state='active'",
                (binding['credentialId'], current['child_id'], current['plugin_id']))
    credential = row_dict(cur)
    now = datetime.now(timezone.utc)
    require(credential and credential['expires_at'] and credential['expires_at'] > now, 409, '美森登录已失效。', 'RECONNECT_REQUIRED')
    cur.execute('DELETE FROM lele.plugin_resource_tickets WHERE child_id=%s AND plugin_id=%s AND expires_at<=now()', (current['child_id'], current['plugin_id']))
    # Prefix is an availability fence, not authority; the random suffix and DB row authorize it.
    prefix = str(current['release_epoch']) + '.'
    cur.execute('''SELECT ticket,expires_at FROM lele.plugin_resource_tickets WHERE child_id=%s AND plugin_id=%s
AND credential_id=%s AND binding_revision=%s AND installation_generation=%s AND upstream_url=%s
AND purpose=%s AND ticket LIKE %s AND expires_at>now()+interval '2 minutes' LIMIT 1''',
        (current['child_id'], current['plugin_id'], binding['credentialId'], binding['bindingRevision'], current['generation'], url, purpose, prefix+'%'))
    old = row_dict(cur)
    if old:
        ticket = old['ticket']
    else:
        ticket = prefix + secrets.token_urlsafe(32)
        expires = min(now + timedelta(minutes=20), credential['expires_at'])
        cur.execute('''INSERT INTO lele.plugin_resource_tickets(ticket,child_id,plugin_id,credential_id,credential_revision,
binding_revision,installation_generation,upstream_url,purpose,mime,expires_at)
VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
            (ticket, current['child_id'], current['plugin_id'], binding['credentialId'], credential['revision'],
             binding['bindingRevision'], current['generation'], url, purpose, mime, expires))
    return {'url': f"/api/children/{current['child_id']}/plugins/{current['plugin_id']}/media/{ticket}", 'mimeType': mime}

def authorize(service, token, surface, child_id, plugin_id, ticket):
    require(surface == 'parent' and re.fullmatch(r'[0-9]+\.[A-Za-z0-9_-]{43}', ticket or ''), 403, '视频资源不可访问。')
    def work(cur):
        user = service.authenticate(cur, token, surface)
        require(not user[5] and user[4] == 'active', 403, '当前账号不可访问视频。')
        catalog_row(cur, plugin_id)
        service.access(cur, user, child_id, write=False)
        current = active_context(cur, plugin_id, child_id)
        require('plugin.resources' in current['capabilities'], 403, '插件未获资源能力。')
        cur.execute('SELECT * FROM lele.plugin_resource_tickets WHERE ticket=%s AND child_id=%s AND plugin_id=%s', (ticket, child_id, plugin_id))
        row = row_dict(cur)
        require(row and row['expires_at'] > datetime.now(timezone.utc) and row['purpose'] in ('teacher-intro-video', 'courseware-pdf')
                and row['installation_generation'] == current['generation'] and ticket.startswith(str(current['release_epoch']) + '.'),
                403, '视频已过期，请重新打开教师档案。', 'plugin_resource_expired')
        saved = private_store.get(cur, current, 'login-session', 'current')
        binding = saved['payload'] if saved else {}
        require(binding.get('credentialId') == row['credential_id'] and binding.get('bindingRevision') == row['binding_revision'],
                403, '账号状态已改变，请重新打开教师档案。')
        cur.execute("SELECT revision,expires_at FROM lele.plugin_credentials WHERE id=%s AND child_id=%s AND plugin_id=%s AND state='active'", (row['credential_id'], child_id, plugin_id))
        credential = row_dict(cur)
        require(credential and credential['revision'] == row['credential_revision'] and credential['expires_at']
                and credential['expires_at'] > datetime.now(timezone.utc), 403, '美森登录已失效。')
        return video_url(row['upstream_url'], current['manifest'].get('resourceOrigins', []), row['purpose'])
    return service.transaction(work)

class PublicConnection(http.client.HTTPSConnection):
    def connect(self):
        addresses = socket.getaddrinfo(self.host, 443, type=socket.SOCK_STREAM)
        # Preserve certificate verification with the user's local Clash/TUN fake DNS.
        ranges = (ipaddress.ip_network('198.18.0.0/15'), ipaddress.ip_network('2001:2::/48'))
        def public(address):
            value = ipaddress.ip_address(address)
            return value.is_global or any(value.version == network.version and value in network for network in ranges)
        require(self.host in HOSTS and addresses and all(public(row[4][0]) for row in addresses), 502, '视频网络地址不可用。')
        raw = socket.create_connection((addresses[0][4][0], 443), self.timeout)
        try: self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise

class VideoStream:
    def __init__(self, connection, response, head, mime='video/mp4'):
        self.connection, self.response, self.head = connection, response, head
        self.status = response.status
        limit = 50 * 1024 * 1024 if mime == 'application/pdf' else MAX_VIDEO_BYTES
        length = response.getheader('Content-Length')
        require(length and length.isdecimal() and 0 <= int(length) <= limit, 502, '视频大小超出限制。')
        require(response.getheader('Content-Type', '').split(';')[0].lower() in (mime, 'application/octet-stream'), 502, '视频格式不受支持。')
        self.length = int(length)
        self.headers = {'Content-Type': mime, 'Content-Length': length, 'Accept-Ranges': 'bytes',
                        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'}
        content_range = response.getheader('Content-Range')
        if self.status == 206:
            match = re.fullmatch(r'bytes ([0-9]+)-([0-9]+)/([0-9]+)', content_range or '')
            require(match and 0 <= int(match[1]) <= int(match[2]) < int(match[3]) <= limit
                    and int(match[2]) - int(match[1]) + 1 == self.length, 502, '视频分段响应不正确。')
            self.headers['Content-Range'] = content_range

    def body(self):
        try:
            if self.head: return
            remaining = self.length
            while remaining:
                chunk = self.response.read(min(65536, remaining))
                if not chunk: break
                remaining -= len(chunk)
                yield chunk
        finally: self.close()

    def close(self): self.connection.close()

def pdf_download_disposition(filename):
    """Use the courseware title for a user-initiated download without header injection."""
    from urllib.parse import quote
    raw = filename if isinstance(filename, str) else ''
    name = re.sub(r'[\x00-\x1f\x7f\\/:*?"<>|]+', ' ', raw)
    name = re.sub(r'\s+', ' ', name).strip(' .')[:120] or '课件'
    if not name.lower().endswith('.pdf'):
        name += '.pdf'
    ascii_name = re.sub(r'[^A-Za-z0-9._ -]+', '_', name)
    ascii_name = re.sub(r'\s+', '_', ascii_name).strip('._') or 'courseware'
    if not ascii_name.lower().endswith('.pdf'):
        ascii_name += '.pdf'
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


def open_video(service, token, surface, child_id, plugin_id, ticket, method='GET', range_header=None, download_name=None):
    url = authorize(service, token, surface, child_id, plugin_id, ticket)
    require(method in ('GET', 'HEAD'), 405)
    require(range_header is None or re.fullmatch(r'bytes=(?:[0-9]+-[0-9]*|-[0-9]+)', range_header), 416, '视频分段范围不正确。')
    parsed = urlsplit(url)
    mime = 'application/pdf' if parsed.path.lower().endswith('.pdf') else 'video/mp4'
    connection = PublicConnection(parsed.hostname, timeout=15, context=ssl.create_default_context())
    try:
        headers = {'Accept': mime}
        if range_header: headers['Range'] = range_header
        connection.request(method, parsed.path + ('?' + parsed.query if parsed.query else ''), headers=headers)
        response = connection.getresponse()
        require(response.status in (200, 206), 416 if response.status == 416 else 502, '视频暂时不可用。')
        stream = VideoStream(connection, response, method == 'HEAD', mime)
        if mime == 'application/pdf':
            stream.headers['Content-Disposition'] = pdf_download_disposition(download_name) if isinstance(download_name, str) and download_name.strip() else 'inline; filename=courseware.pdf'
            stream.headers['Content-Security-Policy'] = "sandbox; default-src 'none'; frame-ancestors 'self'; base-uri 'none'"
        authorize(service, token, surface, child_id, plugin_id, ticket)
        return stream
    except (OSError, http.client.HTTPException):
        connection.close()
        raise ApiError(502, '视频暂时不可用，请稍后重试。') from None
    except BaseException:
        connection.close()
        raise

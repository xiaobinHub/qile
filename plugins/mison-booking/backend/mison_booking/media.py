"""Public Mison media URLs. The browser loads and caches them directly."""
from urllib.parse import quote, urlsplit, urlunsplit

VIDEO_HOSTS = {'file.mison.cn', 'mp.mison.cn'}
PDF_HOSTS = {'file.mison.cn'}


def public_media_url(url, kind):
    hosts = PDF_HOSTS if kind == 'pdf' else VIDEO_HOSTS if kind == 'video' else None
    extension = '.pdf' if kind == 'pdf' else '.mp4' if kind == 'video' else None
    if hosts is None or not isinstance(url, str) or not 0 < len(url) <= 2048:
        return None
    if any(ord(char) < 32 or ord(char) == 127 for char in url):
        return None
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return None
    if (parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.username or parsed.password
            or parsed.fragment or port not in (None, 443)):
        return None
    path = quote(parsed.path, safe="/%:@!$&'()*+,;=-._~")
    query = quote(parsed.query, safe="%:@!$&'()*+,;=/?-._~")
    if not path.lower().endswith(extension):
        return None
    return urlunsplit(('https', parsed.hostname, path, query, ''))

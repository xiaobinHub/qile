"""Public teacher avatar URLs. The browser loads and caches them directly."""
from urllib.parse import urlsplit, urlunsplit

HOSTS = {'mp.mison.cn', 'file.mison.cn'}


def public_url(url):
    if not isinstance(url, str) or not url:
        return None
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return None
    if (parsed.scheme not in ('https', 'http') or parsed.hostname not in HOSTS
            or parsed.username or parsed.password or port not in (None, 80, 443)):
        return None
    return urlunsplit(('https', parsed.hostname, parsed.path, parsed.query, ''))

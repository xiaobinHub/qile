"""Negotiate the browser host API before delivering or invoking a page plugin."""
import re

from lele_growth.child_service import require


def require_frontend(manifest, advertised):
    if manifest.get('type') != 'page':
        return
    required = manifest['frontendApi']
    # Browsers opened before negotiation existed implement frontend API 1.0.
    value = '1.0' if advertised is None else advertised
    match = re.fullmatch(r'([1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})', value) if isinstance(value, str) else None
    require(match is not None and int(match[1]) == required['major'] and int(match[2]) >= required['minMinor'],
            409, '此应用需要新版页面，请刷新整个页面后重试。', 'plugin_frontend_incompatible')

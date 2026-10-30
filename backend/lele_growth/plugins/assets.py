"""Authorized immutable plugin assets; never exposes manifests, wheels or source."""
from __future__ import annotations
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
from lele_growth.child_service import require
from lele_growth.paths import PROJECT_ROOT
from .policy import active_context


def plugin_root():
    return Path(os.environ.get('LELE_PLUGIN_ROOT', PROJECT_ROOT / 'data/plugin-runtime')).resolve()


def authorized_asset(service, token, plugin_id, version, asset, surface="parent"):
    require(re.fullmatch(r'[a-z][a-z0-9-]{1,63}', plugin_id) is not None,404,'资源不存在。')
    require(re.fullmatch(r'\d+\.\d+\.\d+',version) is not None,404,'资源不存在。')
    parts = PurePosixPath(asset).parts
    require(bool(parts) and not any(p in ('..','.') or p.startswith('.') for p in parts)
            and not asset.startswith('/') and '\\' not in asset,404,'资源不存在。')
    require(asset.startswith(('frontend/','assets/')) and Path(asset).suffix in ('.js','.css','.png','.woff2'),404,'资源不存在。')
    def auth(cur):
        user=service.authenticate(cur,token,surface)
        require(not user[5],403,'请先修改初始密码。','password_change_required')
        cur.execute('SELECT manifest,artifact_sha256 FROM lele.plugin_releases WHERE plugin_id=%s AND version=%s',(plugin_id,version))
        release=cur.fetchone()
        require(release is not None,404,'资源不存在。')
        is_icon=asset in release[0].get('icons',[]) and asset.endswith('.png')
        if surface=='admin':
            require(is_icon,403,'此入口只提供插件图标。')
            return release[0]
        require(surface=='parent',403,'资源不可访问。')
        if is_icon:
            # Discovery metadata may be displayed before installation. Qualified
            # members can view declared PNG icons without loading business code.
            cur.execute("SELECT EXISTS(SELECT 1 FROM lele.plugin_catalog p JOIN lele.memberships m ON m.user_id=%s JOIN lele.children c ON c.id=m.child_id WHERE p.id=%s AND p.publication_status='published' AND c.deleted_at IS NULL AND (p.scope_mode='all' OR EXISTS(SELECT 1 FROM lele.plugin_scope_children sc WHERE sc.plugin_id=p.id AND sc.child_id=c.id)))",(user[0],plugin_id))
            require(cur.fetchone()[0],403,'此应用不在开放范围。')
            return release[0]
        cur.execute('SELECT m.child_id FROM lele.memberships m JOIN lele.child_plugins p ON p.child_id=m.child_id WHERE m.user_id=%s AND p.plugin_id=%s AND p.installed AND p.enabled ORDER BY m.child_id',(user[0],plugin_id))
        children=[row[0] for row in cur.fetchall()]
        allowed=False
        from lele_growth.child_service import ApiError
        for child in children:
            try:
                active_context(cur,plugin_id,child)
                allowed=True; break
            except ApiError:
                continue
        require(allowed,403,'此应用未启用或不可用。','plugin_disabled')
        return release[0]
    manifest=service.transaction(auth)
    root=plugin_root()/plugin_id/'releases'/version
    file=root/asset
    require(file.is_file() and not any(p.is_symlink() for p in (file,*file.parents) if p!=plugin_root()) and root.resolve() in file.resolve().parents,404,'资源不存在。')
    import json
    descriptor=json.loads((root/'artifact.json').read_text())
    expected=descriptor.get('files',{}).get(asset)
    require(expected and hashlib.sha256(file.read_bytes()).hexdigest()==expected,503,'应用资源校验失败。','plugin_asset_invalid')
    # Recheck revocation after filesystem I/O, before releasing any bytes.
    service.transaction(auth)
    return file

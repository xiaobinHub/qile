"""Validate the complete Vite resource graph before packaging either surface."""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

ASSET = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:js|css|woff2|png)')


class PageResources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'script' and values.get('src'):
            self.urls.append((values['src'], False))
        if tag == 'link' and values.get('href'):
            self.urls.append((values['href'], values.get('rel') == 'icon'))


def validate_assets(root: Path, surface: str) -> set[Path]:
    directory = root / 'web' / (surface + '-dist')
    prefix = '/' + surface + '-assets/'
    required = set()

    def file(name):
        if name != 'index.html' and not ASSET.fullmatch(name):
            raise ValueError(f'{surface}: 非法构建资源路径：{name}')
        path = directory / name
        if not path.is_file() or any(p.is_symlink() for p in (path, *path.parents) if p != root):
            raise ValueError(f'{surface}: 构建资源缺失或包含链接：{name}')
        required.add(path)
        return path

    def resource(url, *, inline=False):
        if inline and url.startswith('data:'):
            return None
        parsed = urlsplit(url)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or '\\' in url:
            raise ValueError(f'{surface}: 构建资源必须为同入口本地文件：{url}')
        if url.startswith(prefix):
            name = url[len(prefix):]
        elif url.startswith('/'):
            raise ValueError(f'{surface}: 构建资源入口不匹配：{url}')
        else:
            name = url.removeprefix('./')
        file(name)
        return name

    page = file('index.html')
    manifest_path = directory / '.vite/manifest.json'
    if (not manifest_path.is_file() or manifest_path.is_symlink()
            or manifest_path.parent.is_symlink()):
        raise ValueError(f'{surface}: 缺少 Vite 构建清单，请重新构建。')
    try:
        manifest = json.loads(manifest_path.read_text())
        if not isinstance(manifest, dict) or not manifest:
            raise ValueError()
        entries = [entry for entry in manifest.values() if entry.get('isEntry')]
        if len(entries) != 1 or entries[0].get('src') != 'index.html':
            raise ValueError()
        for entry in manifest.values():
            file(entry['file'])
            for name in (*entry.get('css', []), *entry.get('assets', [])):
                file(name)
            for key in (*entry.get('imports', []), *entry.get('dynamicImports', [])):
                if key not in manifest:
                    raise ValueError(f'{surface}: 清单缺失依赖：{key}')
    except (KeyError, TypeError, AttributeError, json.JSONDecodeError):
        raise ValueError(f'{surface}: Vite 构建清单无效。') from None
    parser = PageResources()
    parser.feed(page.read_text())
    html_assets = {resource(url, inline=inline) for url, inline in parser.urls}
    if entries[0]['file'] not in html_assets:
        raise ValueError(f'{surface}: HTML 入口与构建清单不一致。')
    declared = {path.name for path in required}
    # Check generated references as well as the manifest: this catches stale or
    # incomplete manifests, preload tables, dynamic imports and CSS font URLs.
    for path in list(required):
        if path.suffix == '.css':
            urls = re.findall(r'url\(\s*[\'"]?([^\'"\)\s]+)[\'"]?\s*\)', path.read_text())
            for url in urls:
                name = resource(url, inline=True)
                if name and name not in declared:
                    raise ValueError(f'{surface}: CSS 引用未列入构建清单：{name}')
        elif path.suffix == '.js':
            urls = re.findall(r'[\'"`]([^\'"`\s]+\.(?:js|css|woff2|png))[\'"`]', path.read_text())
            for url in urls:
                name = resource(url)
                if name not in declared:
                    raise ValueError(f'{surface}: JS 引用未列入构建清单：{name}')
    required.add(manifest_path)
    return required

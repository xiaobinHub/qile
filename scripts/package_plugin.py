"""Build an immutable, verified plugin archive independently of the host release."""
from __future__ import annotations
import argparse
import base64
import csv
import hashlib
import gzip
import io
import json
import platform
import re
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from lele_growth.child_service import ApiError

MAX_FILES = 2000
MAX_BYTES = 64 * 1024 * 1024


def pure_wheel(name, version, files):
    """Reproducible PEP 427 wheel for dependency-free first-party Python modules."""
    normalized = name.replace('-', '_')
    info = f'{normalized}-{version}.dist-info'
    content = dict(files)
    content[f'{info}/METADATA'] = f'Metadata-Version: 2.1\nName: {name}\nVersion: {version}\nRequires-Python: >=3.11\n'.encode()
    content[f'{info}/WHEEL'] = b'Wheel-Version: 1.0\nGenerator: lele-plugin-builder\nRoot-Is-Purelib: true\nTag: py3-none-any\n'
    records = []
    for path, data in sorted(content.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
        records.append([path, 'sha256=' + digest, str(len(data))])
    records.append([f'{info}/RECORD', '', ''])
    out = io.StringIO(); csv.writer(out, lineterminator='\n').writerows(records)
    content[f'{info}/RECORD'] = out.getvalue().encode()
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path, data in sorted(content.items()):
            item = zipfile.ZipInfo(path, (2026, 1, 1, 0, 0, 0)); item.compress_type = zipfile.ZIP_DEFLATED
            item.external_attr = 0o644 << 16
            archive.writestr(item, data)
    return f'{normalized}-{version}-py3-none-any.whl', result.getvalue()


def package_plugin(root, plugin_id, *, allow_dirty=False):
    from lele_growth.plugins.manifest import validate_manifest
    root = Path(root).resolve()
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,63}', plugin_id):
        raise ValueError('无效的插件 ID。')
    source = root / 'plugins' / plugin_id
    initial_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    initial_dirty = bool(subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=root))
    if initial_dirty and not allow_dirty:
        raise ValueError('正式插件包要求已提交的干净工作区；本地验收可以使用 --allow-dirty。')
    raw = json.loads((source / 'plugin.json').read_text())
    # Ignored output is not evidence of committed source. Always rebuild using
    # the current checked source before recording provenance.
    subprocess.run(['node', str(root/'scripts/build_plugin.mjs'), plugin_id], cwd=root,
                   check=True, stdout=subprocess.DEVNULL)
    build = root / 'output/plugin-releases' / plugin_id / raw['version'] / 'build'
    manifest = validate_manifest(json.loads((build / 'plugin.json').read_text()))
    dirty = initial_dirty or bool(subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=root))
    if dirty and not allow_dirty:
        raise ValueError('正式插件包要求已提交的干净工作区；本地验收可以使用 --allow-dirty。')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if commit != initial_commit:
        raise ValueError('构建期间来源提交发生变化，请重新打包。')
    contents = {}
    for path in sorted(build.rglob('*')):
        if path.is_symlink():
            raise ValueError('插件包不接受符号链接。')
        if path.is_file():
            name = path.relative_to(build).as_posix()
            if name.startswith('.') or any(part in ('__pycache__', '.env', 'node_modules') for part in path.relative_to(build).parts):
                raise ValueError('插件构建目录含私有或临时文件。')
            if path.suffix not in ('.json', '.js', '.css', '.py', '.png', '.woff2'):
                raise ValueError('插件构建目录含非白名单文件。')
            contents[name] = path.read_bytes()
    if len(contents) > MAX_FILES or sum(map(len, contents.values())) > MAX_BYTES:
        raise ValueError('插件包超出大小限制。')
    if manifest['frontend']:
        for name in [manifest['frontend']['entry'], *manifest['frontend'].get('styles', [])]:
            if name not in contents:
                raise ValueError('插件页面资源缺失：' + name)
        # Reject remote imports and unresolved relative chunks in compiled ESM.
        for name, data in list(contents.items()):
            if not name.endswith(('.js', '.css')):
                continue
            text = data.decode()
            if re.search(r'(?:import\s*\(|from\s*|url\(\s*)[\'"`]?https?://', text):
                raise ValueError('插件不能依赖外部运行资源。')
            for ref in re.findall(r'[\'"`]([^\'"`\s]+\.(?:js|css|woff2|png))[\'"`]', text):
                resolved = (Path(name).parent / ref).as_posix()
                if ref.startswith('/') or '..' in Path(resolved).parts or resolved not in contents:
                    raise ValueError('插件构建资源依赖缺失：' + ref)
    if any(icon not in contents or not icon.endswith('.png') for icon in manifest.get('icons',[])):
        raise ValueError('插件图标资源缺失或格式不正确。')
    schema_ref=manifest.get('configSchema')
    if isinstance(schema_ref,str) and schema_ref not in contents:
        raise ValueError('插件配置 schema 缺失。')
    resolved_schema=json.loads(contents[schema_ref]) if isinstance(schema_ref,str) else schema_ref or {'type':'object','properties':{}}
    validate_manifest(manifest,config_schema=resolved_schema)
    if manifest['backend']:
        module = manifest['backend']['entryModule'].replace('.', '/')
        if 'backend/' + module + '.py' not in contents and 'backend/' + module + '/__init__.py' not in contents:
            raise ValueError('插件后端入口缺失。')
        backend_files = {name[len('backend/'):]: data for name, data in contents.items() if name.startswith('backend/') and name.endswith('.py')}
        filename, wheel = pure_wheel(plugin_id, manifest['version'], backend_files)
        contents['wheels/' + filename] = wheel
        sdk_root = root / 'packages/plugin-sdk-python/src'
        sdk = {path.relative_to(sdk_root).as_posix(): path.read_bytes() for path in sdk_root.rglob('*.py') if '__pycache__' not in path.parts}
        if not sdk:
            raise ValueError('插件 Python SDK 尚未准备。')
        sdk_version = re.search(r'^version\s*=\s*["\']([^"\']+)', (root / 'packages/plugin-sdk-python/pyproject.toml').read_text(), re.M).group(1)
        filename, wheel = pure_wheel('lele-plugin-sdk', sdk_version, sdk)
        contents['wheels/' + filename] = wheel
    descriptor = {'format': 1, 'pluginId': manifest['id'], 'version': manifest['version'],
                  'sourceCommit': commit, 'purpose': 'development' if dirty else 'release',
                  'buildPlatform': {'system': platform.system(), 'machine': platform.machine(), 'python': platform.python_version(), 'purePython': True},
                  'files': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(contents.items())}}
    contents['artifact.json'] = (json.dumps(descriptor, ensure_ascii=False, indent=2) + '\n').encode()
    out = build.parent
    archive_path = out / f'{plugin_id}-{manifest["version"]}{"-dirty" if dirty else ""}.tar.gz'
    temporary = archive_path.with_suffix('.tmp')
    with temporary.open('wb') as target:
        with gzip.GzipFile(filename='',fileobj=target,mode='wb',mtime=0) as compressed:
            with tarfile.open(fileobj=compressed,mode='w') as archive:
                for name, data in sorted(contents.items()):
                    info = tarfile.TarInfo(name); info.mode = 0o644; info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
    temporary.replace(archive_path)
    archive_path.with_name(archive_path.name + '.sha256').write_text(hashlib.sha256(archive_path.read_bytes()).hexdigest() + '  ' + archive_path.name + '\n')
    return archive_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plugin', required=True)
    parser.add_argument('--allow-dirty', action='store_true')
    args = parser.parse_args()
    try:
        print(package_plugin(ROOT, args.plugin, allow_dirty=args.allow_dirty))
    except (ValueError, OSError, KeyError, ApiError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()

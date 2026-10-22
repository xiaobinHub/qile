"""Private, bounded object access. No import-time connections or credential logging."""
import hashlib
import json
import os
import re
import tempfile
from http import HTTPStatus
from pathlib import Path
from urllib.parse import urlsplit
from storage import StoreError
from media_types import MAX_IMAGE_BYTES


def storage_config(value, config_path, environment, database):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError('invalid storage configuration')
    cfg = dict(value)
    if cfg.get('provider') == 'test-filesystem':
        if environment != 'development' or not database.startswith('lele_test') or set(cfg) != {'provider', 'root'}:
            raise ValueError('test storage is isolated')
        root = Path(cfg['root'])
        if not root.is_absolute() or root == Path('/'):
            raise ValueError('invalid test storage root')
        return {**cfg, 'root': str(root.resolve())}
    allowed = {'provider', 'bucket', 'endpoint', 'region', 'prefix', 'credentials_file'}
    if set(cfg) - allowed or cfg.get('provider') != 'oss':
        raise ValueError('invalid storage provider')
    bucket, region, prefix = cfg.get('bucket'), cfg.get('region'), cfg.get('prefix')
    if not isinstance(bucket, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', bucket):
        raise ValueError('invalid bucket')
    if not isinstance(region, str) or not re.fullmatch(r'[a-z]{2}-[a-z0-9-]+', region):
        raise ValueError('invalid region')
    url = urlsplit(cfg.get('endpoint', ''))
    if url.scheme != 'https' or url.netloc != 'oss-' + region + '.aliyuncs.com' or url.path not in ('', '/') or url.query or url.fragment:
        raise ValueError('invalid endpoint')
    if not isinstance(prefix, str) or len(prefix) > 180 or not re.fullmatch(r'[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*', prefix) or environment not in prefix.split('/'):
        raise ValueError('invalid isolated prefix')
    if database.startswith('lele_test') and not {'checks','tests'}.intersection(prefix.split('/')):
        raise ValueError('test OSS requires an isolated prefix')
    if cfg.get('credentials_file'):
        path = Path(cfg['credentials_file'])
        if not path.is_absolute():
            path = Path(config_path).resolve().parent / path
        if path.stat().st_mode & 0o077:
            raise ValueError('credentials must be private')
        credentials = json.loads(path.read_text())
        if set(credentials) != {'access_key_id', 'access_key_secret'}:
            raise ValueError('invalid credentials')
    else:
        credentials = { 'access_key_id': os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID'),
                        'access_key_secret': os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET') }
    if any(not isinstance(v, str) or not 8 <= len(v) <= 256 or any(c.isspace() for c in v) for v in credentials.values()):
        raise ValueError('missing credentials')
    return {**cfg, '_credentials': credentials}


class ObjectStorage:
    def __init__(self, config):
        self.config = config
        self.bucket = None
        if config and config['provider'] == 'oss':
            import oss2
            c = config['_credentials']
            self.bucket = oss2.Bucket(oss2.AuthV4(c['access_key_id'], c['access_key_secret']),
                config['endpoint'], config['bucket'], region=config['region'], connect_timeout=10)

    def key(self, child, image):
        if not re.fullmatch(r'[0-9a-f-]{36}', child):
            raise StoreError(HTTPStatus.BAD_REQUEST, '文件所属孩子不正确。')
        prefix = self.config.get('prefix', 'test') if self.config else 'disabled'
        return f'{prefix}/children/{child}/images/{image.sha256}.{image.extension}'

    def _path(self, key):
        root = Path(self.config['root'])
        path = (root / key).resolve()
        if not path.is_relative_to(root) or path == root:
            raise StoreError(HTTPStatus.BAD_REQUEST, '文件位置不正确。')
        return path

    def put(self, key, image):
        if not self.config:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, '图片存储尚未配置，请联系管理员。')
        if self.config['provider'] == 'test-filesystem':
            path = self._path(key)
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp = tempfile.mkstemp(dir=path.parent)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(image.content)
                os.replace(temp, path)
            finally:
                Path(temp).unlink(missing_ok=True)
        else:
            try:
                self.bucket.put_object(key, image.content, headers={
                    'Content-Type': image.mime, 'x-oss-object-acl': 'private',
                    'x-oss-meta-sha256': image.sha256, 'Cache-Control': 'private, no-store'})
            except Exception:
                raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, '图片上传暂时失败，请保留输入并重试原上传。') from None
        # Verify actual bytes before the database can reference the object.
        if self.get(key, image.sha256) != image.content:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, '图片上传校验失败，请重试。')

    def get(self, key, sha256):
        if not self.config:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, '图片存储尚未配置，请联系管理员。')
        try:
            if self.config['provider'] == 'test-filesystem':
                with self._path(key).open('rb') as stream:
                    content = stream.read(MAX_IMAGE_BYTES + 1)
            else:
                result = self.bucket.get_object(key)
                try:
                    content = result.read(MAX_IMAGE_BYTES + 1)
                finally:
                    result.close()
        except StoreError:
            raise
        except Exception:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, '图片暂时无法读取，请稍后重试。') from None
        if len(content) > MAX_IMAGE_BYTES or hashlib.sha256(content).hexdigest() != sha256:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, '图片完整性校验失败，请联系管理员。')
        return content

    def delete(self, key):
        if not self.config:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, '图片存储尚未配置。')
        try:
            if self.config['provider'] == 'test-filesystem':
                self._path(key).unlink(missing_ok=True)
            else:
                self.bucket.delete_object(key)
        except Exception:
            raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE, '暂存图片清理失败。') from None

"""AES-GCM credential vault. Keys never leave the host runtime."""
from __future__ import annotations

import base64
import os
import re
import secrets
from pathlib import Path

from lele_growth.child_service import ApiError, require
from .policy import row_dict


class CredentialVault:
    def __init__(self, key_path):
        self.keys = {}
        path = Path(key_path)
        if not path.is_file():
            raise ApiError(503, '插件凭据密钥尚未配置。', 'plugin_vault_unavailable')
        require(not path.is_symlink() and path.stat().st_mode & 0o077 == 0,
                503, '插件凭据密钥权限不正确。', 'plugin_vault_unavailable')
        for line in path.read_text().splitlines():
            key_id, value = line.split(':', 1)
            require(re.fullmatch(r'[A-Za-z0-9_-]{1,64}', key_id) is not None and len(base64.urlsafe_b64decode(value)) == 32,
                    503, '插件凭据密钥格式不正确。', 'plugin_vault_unavailable')
            self.keys[key_id] = base64.urlsafe_b64decode(value)

    def active_key_id(self):
        return next(reversed(self.keys))

    def encrypt(self, *, provider, plugin_id, child_id, credential_id, token):
        key_id, key = self.active_key_id(), self.keys[self.active_key_id()]
        nonce = secrets.token_bytes(12)
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        ciphertext = AESGCM(key).encrypt(nonce, token.encode(), f'{provider}:{plugin_id}:{child_id}:{credential_id}'.encode())
        return key_id, base64.urlsafe_b64encode(nonce).decode(), base64.urlsafe_b64encode(ciphertext).decode()

    def decrypt(self, *, provider, plugin_id, child_id, credential_id, key_id, nonce, ciphertext):
        require(key_id in self.keys, 503, '插件凭据密钥不存在。', 'plugin_vault_unavailable')
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        try:
            return AESGCM(self.keys[key_id]).decrypt(base64.urlsafe_b64decode(nonce), base64.urlsafe_b64decode(ciphertext),
                                                     f'{provider}:{plugin_id}:{child_id}:{credential_id}'.encode()).decode()
        except Exception:
            raise ApiError(503, '插件凭据解密失败。', 'plugin_vault_unavailable') from None


def token(cur, current, credential_id, vault):
    require(isinstance(credential_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', credential_id) is not None,
            400, '凭据标识不正确。', 'plugin_invalid_credential')
    cur.execute("SELECT * FROM lele.plugin_credentials WHERE id=%s AND child_id=%s AND plugin_id=%s AND state IN ('candidate','active')",
                (credential_id, current['child_id'], current['plugin_id']))
    record = row_dict(cur)
    require(record is not None and (not record['expires_at'] or record['expires_at'] > cur.execute('SELECT now()').fetchone()[0]),
            404, '插件凭据不存在或已过期。', 'plugin_credential_not_found')
    return vault.decrypt(provider=record['provider'], plugin_id=current['plugin_id'], child_id=current['child_id'],
                         credential_id=credential_id, key_id=record['key_id'], nonce=record['nonce'], ciphertext=record['ciphertext'])

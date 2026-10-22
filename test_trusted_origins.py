"""Origin/configuration guards; no database connections or business data writes."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from child_service import ApiError, ChildService


class TrustedOriginTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'config.json'
        self.config = {
            'environment': 'development',
            'database': {'host': '127.0.0.1', 'dbname': 'lele_test_origin', 'user': 'test',
                         'sslmode': 'disable', 'allow_unencrypted': True},
            'parent_origin': 'http://127.0.0.1:18787',
            'admin_origin': 'http://127.0.0.1:18788',
        }

    def service(self, config=None):
        self.path.write_text(json.dumps(config or self.config))
        return ChildService(self.path)

    def test_explicit_forwarding_addresses_are_surface_and_port_scoped(self):
        self.config.update(parent_trusted_origins=['http://chenxiaobin.cn:18787/', 'https://parent.example.com:443'],
                           admin_trusted_origins=['https://admin.example.com:24443'])
        service = self.service()
        for origin in ('http://chenxiaobin.cn:18787', 'https://parent.example.com',
                       'http://127.0.0.1:18787', 'http://localhost:18787',
                       'http://192.168.1.20:18787', 'http://[::1]:18787'):
            with self.subTest(origin=origin):
                self.assertTrue(service.origin_trusted(origin, 'parent'))
        self.assertTrue(service.origin_trusted('https://admin.example.com:24443', 'admin'))
        for origin in ('http://chenxiaobin.cn:18788', 'https://chenxiaobin.cn:18787',
                       'http://chenxiaobin.cn.evil.example:18787', 'https://admin.example.com:24443',
                       'https://evil.example', None, 'null', 'http://localhost:bad',
                       'http://127.0.0.1:18787/path', 'http://127.0.0.1:18787?x=1'):
            with self.subTest(origin=origin):
                self.assertFalse(service.origin_trusted(origin, 'parent'))
        self.assertFalse(service.origin_trusted('http://chenxiaobin.cn:18787', 'admin'))

    def test_forwarded_domain_requires_opt_in(self):
        self.assertFalse(self.service().origin_trusted('http://chenxiaobin.cn:18787', 'parent'))

    def test_invalid_allowlists_rejected_at_startup(self):
        for value in ('*', 'http://*.example.com', 'null', 'https://example.com/path',
                      'https://example.com?', 'https://example.com#', 'https://user@example.com',
                      'https://example.com:0', 'https://example.com:65536', 'https://example.com:',
                      'https://example.com\n', 'https://exa\\mple.com', 'http://[::1]evil:18787',
                      'ftp://example.com', None, 42):
            config = copy.deepcopy(self.config)
            config['parent_trusted_origins'] = [value]
            with self.subTest(value=value), self.assertRaises(ApiError):
                self.service(config)
        for value in ('https://example.com', {}, None):
            config = copy.deepcopy(self.config)
            config['parent_trusted_origins'] = value
            with self.subTest(value=value), self.assertRaises(ApiError):
                self.service(config)

    def test_surface_overlap_rejected(self):
        for parent, admin in ((['https://same.example:443'], ['https://same.example/']),
                              (['http://127.0.0.1:18788'], [])):
            config = {**self.config, 'parent_trusted_origins': parent, 'admin_trusted_origins': admin}
            with self.subTest(parent=parent), self.assertRaises(ApiError):
                self.service(config)

    def test_production_stays_exact_and_rejects_development_allowlists(self):
        self.config.update(environment='production', parent_origin='https://parent.example.com',
                           admin_origin='https://admin.example.com')
        service = self.service()
        self.assertTrue(service.origin_trusted('https://parent.example.com', 'parent'))
        for origin in ('http://192.168.1.20', 'https://admin.example.com', 'https://forward.example.com'):
            self.assertFalse(service.origin_trusted(origin, 'parent'))
        self.config['parent_trusted_origins'] = ['https://forward.example.com']
        with self.assertRaises(ApiError):
            self.service()


if __name__ == '__main__':
    unittest.main()

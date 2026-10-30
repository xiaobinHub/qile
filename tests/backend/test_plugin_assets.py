"""Asset authorization checks use a disposable database and temporary artifacts."""
import hashlib
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

from lele_growth.child_service import ApiError
from lele_growth.plugins.assets import authorized_asset
from lele_growth.plugins.catalog import register_release
from tests.backend.test_plugin_lifecycle import PluginDatabaseCase
from tests.backend.test_plugin_manifest import manifest


class PluginAssetTests(PluginDatabaseCase):
    def setUp(self):
        super().setUp()
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.root=Path(temp.name).resolve();self.directory=self.root/self.plugin_id/'releases/1.0.1'
        value=manifest(self.plugin_id);value['version']='1.0.1';value['icons']=['assets/icon.png']
        self.service.transaction(lambda cur:register_release(cur,value,artifact_sha256='c'*64,source_commit='asset-test',activate=True),exclusive=True)
        self.files={'frontend/entry.js':b'export function mount() { return ()=>{} }','assets/icon.png':b'\x89PNG\r\n\x1a\nfixture'}
        for name,data in self.files.items():
            path=self.directory/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        (self.directory/'artifact.json').write_text(json.dumps({'files':{name:hashlib.sha256(data).hexdigest() for name,data in self.files.items()}}))
        self.environment=patch('lele_growth.plugins.assets.plugin_root',return_value=self.root);self.environment.start();self.addCleanup(self.environment.stop)

    def asset(self,name,actor='owner',surface='parent'):
        return authorized_asset(self.service,self.sessions[actor][0],self.plugin_id,'1.0.1',name,surface)

    def test_catalog_icons_visible_before_install_but_business_code_is_not(self):
        self.publish()
        self.assertEqual(self.asset('assets/icon.png').read_bytes(),self.files['assets/icon.png'])
        with self.assertRaises(ApiError):self.asset('frontend/entry.js')
        self.install()
        self.assertEqual(self.asset('frontend/entry.js').read_bytes(),self.files['frontend/entry.js'])
        self.action('disable')
        with self.assertRaises(ApiError):self.asset('frontend/entry.js')
        self.assertEqual(self.asset('assets/icon.png').read_bytes(),self.files['assets/icon.png'])

    def test_admin_sees_declared_icons_without_parent_or_business_access(self):
        self.assertEqual(self.asset('assets/icon.png','admin','admin').read_bytes(),self.files['assets/icon.png'])
        with self.assertRaises(ApiError):self.asset('frontend/entry.js','admin','admin')
        with self.assertRaises(ApiError):self.asset('assets/unknown.png','admin','admin')
        with self.assertRaises(ApiError):self.asset('assets/icon.png') # pending hidden to families

    def test_scope_hash_and_paths_are_enforced(self):
        self.publish();self.install()
        (self.directory/'frontend/entry.js').write_bytes(b'changed')
        with self.assertRaises(ApiError):self.asset('frontend/entry.js')
        for name in ('../plugin.json','backend/source.py','assets/../../config.json','frontend/%2e%2e/x.js'):
            with self.subTest(name=name),self.assertRaises(ApiError):self.asset(name)
        with self.assertRaises(ApiError):self.asset('assets/icon.png','outsider')

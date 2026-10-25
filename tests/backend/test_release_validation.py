"""Release checks run in disposable Git repositories, never cloud runtimes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import sys

from lele_growth.paths import PROJECT_ROOT
from scripts.package_release import package, release_files


class ReleaseValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = (Path(self.temp.name) / 'source').resolve()
        self.root.mkdir()
        self.output = Path(self.temp.name) / 'output'
        for source in release_files(PROJECT_ROOT):
            target = self.root / source.relative_to(PROJECT_ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Release Test')
        self.git('config', 'user.email', 'release@example.invalid')
        # Keep disposable repos synchronous; detached maintenance can race cleanup.
        self.git('config', 'maintenance.auto', 'false')
        self.git('config', 'gc.auto', '0')
        self.commit()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.STDOUT)

    def commit(self):
        self.git('add', '.')
        self.git('commit', '--allow-empty', '-qm', 'synthetic release fixture')

    def test_clean_package_hashes_and_unpacked_resources(self):
        archive_path = package(self.root, self.output)
        with tarfile.open(archive_path) as archive:
            manifest = json.load(archive.extractfile('release-manifest.json'))
            self.assertFalse(manifest['workingTreeDirty'])
            self.assertEqual(manifest['purpose'], 'release')
            extracted = (Path(self.temp.name) / 'unpacked').resolve()
            archive.extractall(extracted, filter='data')
        self.assertIn(extracted / 'web/parent-dist/.vite/manifest.json', release_files(extracted))
        config = Path(self.temp.name) / 'static-test.json'
        config.write_text(json.dumps({'environment': 'development',
            'database': {'host': '127.0.0.1', 'dbname': 'lele_test_static_no_connection', 'user': 'unused',
                         'sslmode': 'disable', 'allow_unencrypted': True},
            'parent_origin': 'http://127.0.0.1:18887', 'admin_origin': 'http://127.0.0.1:18888'}))
        environment = {**os.environ, 'PYTHONPATH': str(extracted / 'backend')}
        smoke = '''
import hashlib,json,sys
from pathlib import Path
from fastapi.testclient import TestClient
from lele_growth.accounts_app import create_app
from lele_growth.paths import PROJECT_ROOT
manifest=json.loads((PROJECT_ROOT/'release-manifest.json').read_text())
for surface in ('parent','admin'):
 client=TestClient(create_app(sys.argv[1],surface))
 assert client.get('/').status_code==200
 assert client.get('/'+surface+'-assets/.vite/manifest.json').status_code==404
 for name,sha in manifest['files'].items():
  prefix='web/'+surface+'-dist/'
  if not name.startswith(prefix) or name.endswith(('.html','.json')): continue
  response=client.get('/'+surface+'-assets/'+name[len(prefix):])
  assert response.status_code==200,name
  assert hashlib.sha256(response.content).hexdigest()==sha,name
 assert client.get('/data/development/config.json').status_code==404
'''
        subprocess.run([sys.executable, '-B', '-c', smoke, str(config)], cwd=extracted,
                       env=environment, check=True, capture_output=True, text=True)
        result = subprocess.run([sys.executable, '-B', str(extracted / 'deploy/manage.py'), '--help'],
                                cwd=extracted, env=environment, capture_output=True, text=True, check=True)
        self.assertIn('bootstrap-admin', result.stdout)

    def test_untracked_modified_staged_and_deleted_sources_refuse_release(self):
        for state in ('untracked', 'modified', 'staged', 'deleted'):
            with self.subTest(state=state):
                file = self.root / 'backend/lele_growth/release_probe.py'
                if state != 'untracked':
                    file.write_text('initial = True\n')
                    self.commit()
                if state == 'deleted':
                    file.unlink()
                else:
                    file.write_text('modified = True\n')
                if state == 'staged': self.git('add', '.')
                with self.assertRaisesRegex(ValueError, '干净'):
                    package(self.root, self.output)
                with tarfile.open(package(self.root, self.output, allow_dirty=True)) as archive:
                    manifest = json.load(archive.extractfile('release-manifest.json'))
                    self.assertTrue(manifest['workingTreeDirty'])
                    self.assertEqual(manifest['purpose'], 'development')
                self.git('reset', '--hard', '-q', 'HEAD')
                self.git('clean', '-fdq')

    def test_committed_missing_entry_dynamic_css_and_font_refused(self):
        manifest_path = self.root / 'web/parent-dist/.vite/manifest.json'
        manifest = json.loads(manifest_path.read_text())
        entry = manifest['index.html']
        paths = [entry['file'], entry['css'][0], entry['assets'][0]]
        paths += [manifest[key]['file'] for key in entry['dynamicImports']]
        for name in paths:
            with self.subTest(name=name):
                file = self.root / 'web/parent-dist' / name
                content = file.read_bytes()
                file.unlink()
                self.commit()
                with self.assertRaisesRegex(ValueError, '缺失'):
                    package(self.root, self.output)
                file.write_bytes(content)
                self.commit()

    def test_manifest_cannot_hide_missing_dynamic_import(self):
        manifest_path = self.root / 'web/parent-dist/.vite/manifest.json'
        manifest = json.loads(manifest_path.read_text())
        key = 'src/features/store.tsx'
        file = self.root / 'web/parent-dist' / manifest[key]['file']
        file.unlink()
        del manifest[key]
        manifest['index.html']['dynamicImports'].remove(key)
        manifest_path.write_text(json.dumps(manifest))
        self.commit()
        with self.assertRaises(ValueError): package(self.root, self.output)

    def test_external_cross_surface_traversal_and_symlink_refused(self):
        page = self.root / 'web/parent-dist/index.html'
        original = page.read_text()
        for url in ('https://cdn.example.invalid/app.js', '/admin-assets/app.js', '../outside.js'):
            with self.subTest(url=url):
                page.write_text(original + '<script src="' + url + '"></script>')
                with self.assertRaises(ValueError): package(self.root, self.output, allow_dirty=True)
        page.write_text(original)
        manifest = json.loads((page.parent / '.vite/manifest.json').read_text())
        entry = page.parent / manifest['index.html']['file']
        outside = Path(self.temp.name) / 'outside.js'
        outside.write_bytes(entry.read_bytes())
        entry.unlink()
        entry.symlink_to(outside)
        with self.assertRaises(ValueError): package(self.root, self.output, allow_dirty=True)

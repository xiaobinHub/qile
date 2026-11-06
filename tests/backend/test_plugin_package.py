"""Plugin package checks use disposable source trees, never production data."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import zipfile

from scripts.package_plugin import package_plugin, pure_wheel
from lele_growth.paths import PROJECT_ROOT


class PluginPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        manifest=json.loads((PROJECT_ROOT/'plugins/growth-notes/plugin.json').read_text())
        source=self.root/'plugins/growth-notes'; source.mkdir(parents=True)
        (source/'plugin.json').write_text(json.dumps(manifest))
        built=self.root/'output/plugin-releases/growth-notes'/manifest['version']/'build'; built.mkdir(parents=True)
        (built/'plugin.json').write_text(json.dumps(manifest))
        (built/'frontend').mkdir(); (built/'schemas').mkdir()
        (built/'frontend/entry.js').write_text('export function mount() { return () => {} }')
        (built/'frontend/style.css').write_text('.growth-notes-plugin { color: inherit }')
        (built/'schemas/config.json').write_text('{"type":"object","properties":{}}')
        self.built=built
        (self.root/'scripts').mkdir()
        (self.root/'scripts/build_plugin.mjs').write_text('// synthetic fixture builds are already explicit\n')
        subprocess.run(['git','init','-q',str(self.root)],check=True,capture_output=True)
        for args in [('config','user.name','Plugin Test'),('config','user.email','plugin@example.invalid'),('add','.'),('commit','-qm','fixture')]:
            subprocess.run(['git',*args],cwd=self.root,check=True,capture_output=True)

    def test_package_complete_graph_with_exact_hashes(self):
        target=package_plugin(self.root,'growth-notes')
        with tarfile.open(target) as archive:
            descriptor=json.load(archive.extractfile('artifact.json'))
            self.assertEqual(descriptor['purpose'],'release')
            self.assertEqual(set(archive.getnames()),set(descriptor['files'])|{'artifact.json'})
            for name,sha in descriptor['files'].items():
                self.assertEqual(hashlib.sha256(archive.extractfile(name).read()).hexdigest(),sha)
        self.assertTrue(target.with_name(target.name+'.sha256').exists())
        original=target.read_bytes()
        # The output directory is intentionally ignored, just as in the real repo.
        (self.root/'.gitignore').write_text('output/\n')
        subprocess.run(['git','add','.gitignore'],cwd=self.root,check=True,capture_output=True)
        subprocess.run(['git','commit','-qm','ignore build output'],cwd=self.root,check=True,capture_output=True)
        first=package_plugin(self.root,'growth-notes').read_bytes()
        self.assertEqual(first,package_plugin(self.root,'growth-notes').read_bytes())

    def test_declared_icon_must_be_present_in_artifact(self):
        manifest=json.loads((self.built/'plugin.json').read_text())
        manifest['icons']=['assets/missing.png']
        (self.built/'plugin.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError,'图标资源缺失'):
            package_plugin(self.root,'growth-notes',allow_dirty=True)

    def test_missing_entry_rejected_before_archiving(self):
        (self.built/'frontend/entry.js').unlink()
        with self.assertRaisesRegex(ValueError,'缺失'):
            package_plugin(self.root,'growth-notes',allow_dirty=True)

    def test_symlink_and_remote_runtime_dependency_rejected(self):
        (self.built/'frontend/hidden.js').symlink_to(self.built/'frontend/entry.js')
        with self.assertRaisesRegex(ValueError,'符号链接'):
            package_plugin(self.root,'growth-notes',allow_dirty=True)
        (self.built/'frontend/hidden.js').unlink()
        (self.built/'frontend/entry.js').write_text('import("https://example.invalid/remote.js")')
        with self.assertRaisesRegex(ValueError,'外部'):
            package_plugin(self.root,'growth-notes',allow_dirty=True)

    def test_missing_dynamic_chunk_rejected(self):
        (self.built/'frontend/entry.js').write_text('import("./missing.js")')
        with self.assertRaisesRegex(ValueError,'缺失'):
            package_plugin(self.root,'growth-notes',allow_dirty=True)

    def test_dirty_source_cannot_be_labeled_release(self):
        (self.built/'frontend/style.css').write_text('.growth-notes-plugin { color: green }')
        with self.assertRaisesRegex(ValueError,'干净'):
            package_plugin(self.root,'growth-notes')


    def test_ignored_stale_output_is_rebuilt_from_current_source(self):
        builder=self.root/'scripts/build_plugin.mjs'
        entry=(self.built/'frontend/entry.js').relative_to(self.root).as_posix()
        builder.write_text("import fs from 'node:fs';fs.writeFileSync("+json.dumps(entry)+",'export const currentSource=true;');")
        (self.root/'.gitignore').write_text('output/\n')
        subprocess.run(['git','rm','-r','--cached','output'],cwd=self.root,check=True,capture_output=True)
        subprocess.run(['git','add','scripts/build_plugin.mjs','.gitignore'],cwd=self.root,check=True,capture_output=True)
        subprocess.run(['git','commit','-qm','source-aware builder'],cwd=self.root,check=True,capture_output=True)
        (self.built/'frontend/entry.js').write_text('export const staleIgnored=true;')
        target=package_plugin(self.root,'growth-notes')
        with tarfile.open(target) as archive:
            self.assertEqual(archive.extractfile('frontend/entry.js').read(),b'export const currentSource=true;')
            self.assertEqual(json.load(archive.extractfile('artifact.json'))['purpose'],'release')

    def test_pure_wheel_has_valid_record_and_reproducible_bytes(self):
        name,data=pure_wheel('sample-plugin','1.0.0',{'sample.py':b'VALUE=1\n'})
        self.assertEqual((name,data),pure_wheel('sample-plugin','1.0.0',{'sample.py':b'VALUE=1\n'}))
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertIn('sample_plugin-1.0.0.dist-info/RECORD',archive.namelist())
            self.assertIn(b'py3-none-any',archive.read('sample_plugin-1.0.0.dist-info/WHEEL'))

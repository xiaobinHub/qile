"""Real single-plugin update/rollback probe, restricted to its dedicated test DB."""
from datetime import datetime,timezone
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import time
import uuid

from lele_growth.child_service import ChildService
from lele_growth.plugins.deployment import PluginDeployment
from lele_growth.plugins.gateway import PluginGateway
from lele_growth.plugins.scheduler import PluginScheduler
from lele_growth.production_maintenance import target_details
sys.path.insert(0,str(Path(__file__).resolve().parents[3]))
from scripts.package_plugin import pure_wheel

root=Path.cwd();folder=root/'data/testing/plugins-browser'
service=ChildService(folder/'config.json')
assert service.config['environment']=='development' and service.config['_connect']['dbname']=='lele_test_plugin_browser'
mode=sys.argv[1]
state=json.loads((folder/'state.json').read_text()); child=state['childId']
if mode=='enqueue':
    scheduler=PluginScheduler(service,PluginGateway(service))
    job=scheduler.enqueue('reminder-demo',child,'daily-reminder','probe-'+uuid.uuid4().hex,datetime.now(timezone.utc))
    print(json.dumps({'jobId':job}))
elif mode=='records':
    def read(cur):
        cur.execute("SELECT count(*) FROM lele.child_plugin_records WHERE plugin_id='reminder-demo' AND child_id=%s AND collection='executions'",(child,))
        return cur.fetchone()[0]
    print(json.dumps({'records':service.transaction(read)}))
else:
    manager=PluginDeployment(service)
    confirm=target_details(service)['targetId']
    if mode=='rollback':
        print(json.dumps(manager.execute('rollback',plugin_id='reminder-demo',version='1.0.0',apply=True,confirm=confirm)))
    elif mode=='update':
        old=folder/'runtime/reminder-demo/releases/1.0.0'
        descriptor=json.loads((old/'artifact.json').read_text())
        files={name:(old/name).read_bytes() for name in descriptor['files']}
        manifest=json.loads(files['plugin.json']);manifest['version']='1.0.1';files['plugin.json']=json.dumps(manifest).encode()
        for name in list(files):
            if name.startswith('wheels/reminder_demo-'): del files[name]
        name,wheel=pure_wheel('reminder-demo','1.0.1',{'reminder_demo.py':files['backend/reminder_demo.py']});files['wheels/'+name]=wheel
        descriptor.update(version='1.0.1',files={name:hashlib.sha256(data).hexdigest() for name,data in files.items()})
        files['artifact.json']=json.dumps(descriptor).encode()
        package=folder/'reminder-demo-1.0.1.tar.gz'
        with tarfile.open(package,'w:gz') as archive:
            for name,data in sorted(files.items()):
                member=tarfile.TarInfo(name);member.size=len(data);member.mode=0o644;archive.addfile(member,io.BytesIO(data))
        def hook(phase):
            if phase=='updating':time.sleep(2)
        manager.stage_hook=hook
        print(json.dumps(manager.execute('deploy',package=package,apply=True,confirm=confirm)))
    else:raise ValueError('unsupported probe')

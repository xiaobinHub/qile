"""Real workers and optional guarded PostgreSQL integration, no shared truncation.

LELE_TEST_CONFIG must point to local lele_test*. Tests use their own database
lele_test_plugin_runtime and unique fixtures. No production config is accepted.
"""
from concurrent.futures import ThreadPoolExecutor
import copy
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import time
import unittest
import uuid

from psycopg.types.json import Jsonb
from lele_growth.child_service import ApiError, ChildService, initialize, digest, load_config
from lele_growth.plugins.catalog import register_release
from lele_growth.plugins.gateway import ContextSigner, PluginGateway
from lele_growth.plugins.policy import active_context, row_dict
from lele_growth.plugins.supervisor import PluginSupervisor
from lele_growth.plugins.deployment import inspect_package, prepare_release

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / 'packages/plugin-sdk-python/src'
CONFIG = os.environ.get('LELE_TEST_CONFIG')

WORKER = '''import os,time

def health(): return {"ok":True}
def handle_request(context,path,method,body):
    if path=='crash': os._exit(7)
    if path=='slow': time.sleep(2)
    return {"pid":os.getpid(),"childId":context['childId'],"config":context['config'],"secrets":any(k in os.environ for k in ('PGPASSWORD','LELE_ACCOUNTS_CONFIG','DATABASE_URL'))}
def handle_job(context,task,payload):
    return {"effects":[{"collection":"executions","id":payload['occurrenceKey'],"payload":{"message":context['config'].get('message','ok')}}]}
'''


def manifest(plugin_id='runtime-demo', version='1.0.0', *, backend=True):
    return {'manifestVersion': 1, 'id': plugin_id, 'version': version, 'type': 'service' if backend else 'page',
            'platformApi': {'major': 1, 'minMinor': 0}, 'frontendApi': {'major': 1, 'minMinor': 0},
            'frontend': None if backend else {'entry': 'frontend/entry.js', 'styles': []},
            'backend': {'entryModule': 'runtime_demo'} if backend else None, 'configSchema': 'schemas/config.json',
            'dataSchemaVersion': 1, 'capabilities': ['plugin.state.read', 'plugin.state.write'],
            'tasks': [{'id': 'remind', 'intervalSeconds': 60, 'misfirePolicy': 'skip'}] if backend else [], 'events': [], 'icons': []}


def make_package(directory, data=None, *, worker=WORKER, schema=None, sdk_version='1.0.0'):
    from scripts.package_plugin import pure_wheel
    data = copy.deepcopy(data or manifest())
    schema = schema or {'type': 'object', 'properties': {'message': {'type': 'string', 'default': 'ok'}}}
    files = {'plugin.json': json.dumps(data).encode(), 'schemas/config.json': json.dumps(schema).encode()}
    if data['backend']:
        files['backend/runtime_demo.py'] = worker.encode()
        name, wheel = pure_wheel(data['id'], data['version'], {'runtime_demo.py': worker.encode()})
        files['wheels/' + name] = wheel
        name, wheel = pure_wheel('lele-plugin-sdk', sdk_version, {p.relative_to(SDK).as_posix(): p.read_bytes() for p in SDK.rglob('*.py')})
        files['wheels/' + name] = wheel
    else:
        files['frontend/entry.js'] = b'export function mount(){return ()=>{}}'
    descriptor = {'format': 1, 'pluginId': data['id'], 'version': data['version'], 'sourceCommit': 'test-fixture', 'purpose': 'development',
                  'buildPlatform': {'system': 'Darwin', 'machine': 'arm64', 'python': '3.13', 'purePython': True},
                  'files': {name: hashlib.sha256(value).hexdigest() for name, value in files.items()}}
    files['artifact.json'] = json.dumps(descriptor).encode()
    target = Path(directory) / (data['id'] + '-' + data['version'] + '.tar.gz')
    with tarfile.open(target, 'w:gz') as archive:
        for name, value in files.items():
            member = tarfile.TarInfo(name); member.size = len(value)
            archive.addfile(member, io.BytesIO(value))
    return target


def scope():
    return {'pluginId': 'runtime-demo', 'childId': 'child-a', 'releaseId': 'release-a', 'generation': 1, 'configRevision': 1,
            'releaseEpoch': 1, 'policyRevision': 1, 'version': '1.0.0', 'config': {}, 'capabilities': ['plugin.state.read', 'plugin.state.write']}


class ContextTests(unittest.TestCase):
    def test_standalone_signed_context_rejects_every_forged_fence(self):
        signer = ContextSigner(b'x' * 32)
        signed = signer.issue(scope(), actor='parent-a', capabilities=['plugin.state.read'])
        self.assertEqual(signer.verify(signed, capability='plugin.state.read')['childId'], 'child-a')
        for field in ('pluginId', 'childId', 'releaseId', 'generation', 'configRevision', 'releaseEpoch', 'policyRevision', 'actorId', 'jobId', 'capabilities', 'expiresAt', 'version', 'configSha256', 'config'):
            with self.subTest(field=field), self.assertRaises(ApiError):
                signer.verify({**signed, field: 'forged'})
        with self.assertRaises(ApiError): signer.verify(signed, capability='plugin.state.write')
        with self.assertRaises(ApiError): signer.verify(signed, child_id='child-b')
        with self.assertRaises(ApiError): ContextSigner(b'y' * 32).verify(signed)

    def test_expiry_and_invalid_tokens(self):
        now = [100]
        signer = ContextSigner(b'x' * 32, clock=lambda: now[0])
        signed = signer.issue(scope(), ttl=1)
        now[0] = 101
        with self.assertRaises(ApiError): signer.verify(signed)
        for token in ('', '.', 'bad.mac', 'x' * 20000, None):
            with self.assertRaises(ApiError): signer.verify({'scopeToken': token})
        with self.assertRaises(ApiError): signer.issue(scope(), capabilities=['raw.sql'])

    def test_unrelated_paths_never_access_database(self):
        class NoDatabase:
            def transaction(self, *args): raise AssertionError('unrelated path accessed plugin DB')
        gateway = PluginGateway(NoDatabase())
        self.assertIs(gateway.route('POST', 'auth/login', {}, None, None, None, 'parent', None), NotImplemented)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='plugin-worker-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'runtime'
        package = make_package(self.temp.name)
        self.release = prepare_release(inspect_package(package), self.root)
        self.supervisor = PluginSupervisor(self.root, start_timeout=2, call_timeout=0.3, drain_timeout=0.1)
        self.addCleanup(self.supervisor.close)
        self.context = ContextSigner().issue(scope())

    def test_real_private_venv_process_health_and_child_scoping(self):
        health = self.supervisor.health('runtime-demo', '1.0.0')
        self.assertTrue(health['ok']); self.assertNotEqual(health['pid'], os.getpid())
        first = self.supervisor.call(self.context, 'handle_request', {'path': 'ok'})
        second = self.supervisor.call({**self.context, 'childId': 'child-b'}, 'handle_request', {'path': 'ok'})
        self.assertEqual(first['pid'], second['pid'])
        self.assertEqual((first['childId'], second['childId']), ('child-a', 'child-b'))
        self.assertFalse(first['secrets'])
        self.assertNotIn('runtime_demo', sys.modules)
        self.assertIn('include-system-site-packages = false', (self.release / '.venv/pyvenv.cfg').read_text())
        self.assertEqual(self.supervisor.stop('runtime-demo')['stopped'], 1)
        self.assertFalse(self.supervisor.workers)

    def test_concurrent_requests_survive_bounded_cache_allocation(self):
        source = '''import threading,time
cache=bytearray(64*1024*1024)
barrier=threading.Barrier(4)
def health(): return {'ok':True}
def handle_request(context,path,method,body):
    barrier.wait(timeout=3)
    time.sleep(.05)
    return {'ok':True,'cacheBytes':len(cache)}
'''
        package = make_package(self.temp.name, manifest(version='1.0.2'), worker=source, sdk_version='1.1.1')
        prepare_release(inspect_package(package), self.root)
        context = ContextSigner().issue({**scope(), 'version': '1.0.2'})
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(self.supervisor.call, context, 'handle_request', {'path': 'read'}, timeout=5)
                       for _ in range(4)]
            results = [future.result(timeout=8) for future in futures]
        self.assertEqual(results, [{'ok': True, 'cacheBytes': 64*1024*1024}] * 4)
        self.assertTrue(self.supervisor.health('runtime-demo', '1.0.2')['ok'])

    def test_crash_timeout_and_failed_health_are_bounded(self):
        start = time.monotonic()
        with self.assertRaises(ApiError): self.supervisor.call(self.context, 'handle_request', {'path': 'slow'})
        self.assertLess(time.monotonic() - start, 2)
        with self.assertRaises(ApiError): self.supervisor.call(self.context, 'handle_request', {'path': 'crash'})
        self.supervisor.stop('runtime-demo', timeout=0)
        package = make_package(self.temp.name, manifest(version='1.0.1'), worker='raise RuntimeError("do not print secrets")')
        prepare_release(inspect_package(package), self.root)
        with self.assertRaises(ApiError): self.supervisor.health('runtime-demo', '1.0.1')
        with self.assertRaises(ApiError) as error: self.supervisor.health('runtime-demo', '1.0.1')
        self.assertEqual(error.exception.kind, 'plugin_restart_backoff')

    def test_subsequent_real_health_degradation_is_rejected(self):
        worker = '''healthy = True
def health(): return {'ok': healthy}
def handle_request(context, path, method, body):
    global healthy
    healthy = False
    return {'ok': True}
'''
        package = make_package(self.temp.name, manifest(version='1.0.1'), worker=worker)
        prepare_release(inspect_package(package), self.root)
        healthy = self.supervisor.health('runtime-demo', '1.0.1')
        self.assertTrue(healthy['ok'])
        context = ContextSigner().issue({**scope(), 'version': '1.0.1'})
        self.supervisor.call(context, 'handle_request', {'path': 'degrade'})
        with self.assertRaises(ApiError) as error:
            self.supervisor.health('runtime-demo', '1.0.1')
        self.assertEqual(error.exception.kind, 'plugin_health_failed')
        self.assertIsNone(self.supervisor.workers[('runtime-demo', '1.0.1')].process.poll())

    def test_cached_worker_health_still_requires_exact_ok_and_protocol(self):
        from unittest.mock import patch
        self.supervisor.health('runtime-demo', '1.0.0')
        for health in ({'ok': True, 'protocol': '2.0'}, {'ok': 1, 'protocol': '1.0'}, {'ok': True}):
            with self.subTest(health=health), patch('lele_growth.plugins.supervisor.unix_request', return_value=health):
                with self.assertRaises(ApiError) as error:
                    self.supervisor.health('runtime-demo', '1.0.0')
                self.assertEqual(error.exception.kind, 'plugin_health_failed')


class DatabaseFixture(unittest.TestCase):
    """Reusable opt-in fixture. Never drops/truncates any database/table."""
    @classmethod
    def setUpClass(cls):
        if not CONFIG:
            raise unittest.SkipTest('Set LELE_TEST_CONFIG to explicit local lele_test* config')
        import ipaddress
        import psycopg
        from psycopg import sql
        source = load_config(CONFIG)
        db = source['_connect']
        if source['environment'] != 'development' or not db['dbname'].startswith('lele_test') or not ipaddress.ip_address(db['host']).is_loopback:
            raise RuntimeError('Refusing tests outside isolated localhost lele_test*')
        cls.directory = tempfile.TemporaryDirectory(prefix='lele-plugin-db-')
        cls.addClassCleanup(cls.directory.cleanup)
        raw = json.loads(Path(CONFIG).read_text())
        from lele_growth.maintenance import schema_sources, plugin_schema_source
        schema_fingerprint = hashlib.sha256((schema_sources()[3][6] + plugin_schema_source()).encode()).hexdigest()[:10]
        test_database = 'lele_test_plugin_runtime_' + schema_fingerprint + '_' + str(os.getpid())
        raw['database']['dbname'] = test_database
        with psycopg.connect(**{**db, 'dbname': 'postgres'}, autocommit=True) as connection:
            if not connection.execute('SELECT 1 FROM pg_database WHERE datname=%s', (test_database,)).fetchone():
                connection.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(test_database)))
        cls.config_path = Path(cls.directory.name) / 'config.json'
        cls.config_path.write_text(json.dumps(raw))
        cls.service = ChildService(cls.config_path)
        initialized = cls.service.transaction(lambda cur: cur.execute("SELECT to_regclass('lele.schema_versions')").fetchone()[0], schema_check=False)
        if not initialized:
            initialize(cls.config_path)
        from lele_growth.maintenance import initialize_plugin_platform
        initialize_plugin_platform(cls.service)

    def setUp(self):
        self.plugin_id = 'test-' + uuid.uuid4().hex[:16]
        self.child_id, self.user_id = str(uuid.uuid4()), str(uuid.uuid4())
        self.token, self.csrf = uuid.uuid4().hex, uuid.uuid4().hex
        self.data = manifest(self.plugin_id)
        self.schema = {'type': 'object', 'properties': {'message': {'type': 'string', 'default': 'ok'}}}
        def fixture(cur):
            cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status,must_change_password) VALUES(%s,%s,'runtime-test','unused','parent','active',false)", (self.user_id, 'runtime-' + self.user_id))
            cur.execute("INSERT INTO lele.children(id,name,owner_id) VALUES(%s,'测试',%s)", (self.child_id, self.user_id))
            cur.execute('INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES(%s,%s,%s)', (self.child_id, self.user_id, str(uuid.uuid4())))
            cur.execute("INSERT INTO lele.sessions(token_hash,user_id,surface,csrf_hash) VALUES(%s,%s,'parent',%s)", (digest(self.token), self.user_id, digest(self.csrf)))
            release = register_release(cur, self.data, artifact_sha256='a' * 64, source_commit='test', config_schema=self.schema, activate=True)
            cur.execute("UPDATE lele.plugin_catalog SET publication_status='published' WHERE id=%s", (self.plugin_id,))
            cur.execute('INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled) VALUES(%s,%s,true,true)', (self.child_id, self.plugin_id))
            cur.execute('INSERT INTO lele.child_plugin_configs(child_id,plugin_id,config,config_revision) VALUES(%s,%s,%s,1)', (self.child_id, self.plugin_id, Jsonb({'message': 'ok'})))
            return release['release_id']
        self.release_id = self.service.transaction(fixture)
        self.gateway = PluginGateway(self.service)

    def context(self):
        return self.service.transaction(lambda cur: active_context(cur, self.plugin_id, self.child_id))

    def sql(self, query, args=None):
        def work(cur):
            cur.execute(query, args)
            return cur.fetchall() if cur.description else None
        return self.service.transaction(work)

    def route(self, method, endpoint, body=None, **changes):
        return self.gateway.route(method, f'children/{self.child_id}/plugins/{self.plugin_id}/runtime/{endpoint}', body or {},
                                  changes.get('token', self.token), changes.get('csrf', self.csrf),
                                  changes.get('origin', self.service.config['parent_origin']), changes.get('surface', 'parent'), changes.get('release_id', self.release_id))


class GatewayDatabaseTests(DatabaseFixture):
    def test_generic_records_auth_capability_idempotency_and_release(self):
        body = {'payload': {'note': 'shared'}, 'operationId': str(uuid.uuid4())}
        first = self.route('PUT', 'records/notes/note1', body)
        self.assertEqual(self.route('PUT', 'records/notes/note1', body), first)
        records = self.route('GET', 'records/notes')['records']
        self.assertIsInstance(records, list)
        self.assertEqual(len(records), 1); self.assertEqual(records[0]['revision'], 1)
        for changes in ({'token': None}, {'csrf': 'wrong'}, {'origin': 'https://untrusted.test'}, {'surface': 'admin'}, {'release_id': 'old'}):
            with self.subTest(changes=changes), self.assertRaises(ApiError): self.route('PUT', 'records/notes/note1', body, **changes)
        self.sql('UPDATE lele.child_plugins SET enabled=false,generation=generation+1 WHERE plugin_id=%s', (self.plugin_id,))
        with self.assertRaises(ApiError): self.route('GET', 'records/notes')

    def test_late_effect_revocation_and_concurrent_effect_dedup(self):
        signed = self.gateway.issue_job_context(self.context(), 'test-job')
        result = {'effects': [{'collection': 'executions', 'id': 'same', 'payload': {'ok': True}}]}
        def effect(_):
            return self.service.transaction(lambda cur: self.gateway.apply_effects(cur, signed, result, effect_key='stable-occurrence'))
        with ThreadPoolExecutor(max_workers=4) as pool:
            outcomes = list(pool.map(effect, range(4)))
        self.assertEqual(outcomes, [outcomes[0]] * 4)
        self.assertEqual(self.sql('SELECT revision FROM lele.child_plugin_records WHERE plugin_id=%s', (self.plugin_id,)), [(1,)])
        self.sql('UPDATE lele.child_plugins SET generation=generation+1 WHERE plugin_id=%s', (self.plugin_id,))
        with self.assertRaises(ApiError): effect(0)

    def test_records_pagination_query_forwarded_by_accounts_app(self):
        self.sql("INSERT INTO lele.child_plugin_records(child_id,plugin_id,collection,record_id,payload) SELECT %s,%s,'notes','note-'||lpad(i::text,3,'0'),'{}'::jsonb FROM generate_series(1,105) AS i", (self.child_id, self.plugin_id))
        first = self.route('GET', 'records/notes', {'limit': '100'})
        self.assertIsInstance(first['records'], list)
        self.assertEqual(len(first['records']), 100)
        self.assertEqual(first['nextCursor'], 'note-100')
        second = self.route('GET', 'records/notes', {'limit': '100', 'cursor': first['nextCursor']})
        self.assertEqual(len(second['records']), 5); self.assertIsNone(second['nextCursor'])
        query = self.route('GET', 'records/notes?limit=2&after=note-102')
        self.assertEqual([record['id'] for record in query['records']], ['note-103', 'note-104'])
        for params in ({'limit': '0'}, {'limit': '999'}, {'limit': []}, {'cursor': '../escape'}, {'after': 'a', 'cursor': 'b'}):
            with self.subTest(params=params), self.assertRaises(ApiError): self.route('GET', 'records/notes', params)

    def test_rpc_does_not_retain_db_locks_and_late_archive_revokes_result(self):
        with tempfile.TemporaryDirectory(prefix='plugin-rpc-locks-') as directory:
            root = Path(directory) / 'runtime'
            prepare_release(inspect_package(make_package(directory, self.data, schema=self.schema)), root)
            supervisor = PluginSupervisor(root)
            service = self.service
            class ArchiveDuringRPC:
                def call(inner, context, action, payload, *, timeout=None):
                    # A separate DB transaction must finish while the worker RPC
                    # is in progress. It would timeout if gateway retained locks.
                    service.transaction(lambda cur: cur.execute('UPDATE lele.children SET archived=true WHERE id=%s', (self.child_id,)))
                    return supervisor.call(context, action, payload)
            self.gateway.runtime = ArchiveDuringRPC()
            try:
                with self.assertRaises(ApiError) as error: self.route('GET', 'whoami')
                self.assertEqual(error.exception.kind, 'child_unavailable')
            finally:
                supervisor.close()

    def test_archive_advisory_lock_and_gateway_have_no_lock_inversion(self):
        import threading
        from unittest.mock import patch
        archived, gateway_access = threading.Event(), threading.Event()
        access = self.service.access
        def inspect_access(*args, **kwargs):
            gateway_access.set()
            return access(*args, **kwargs)
        def archive():
            def work(cur):
                self.service.lock_child(cur, self.child_id)
                archived.set()
                if not gateway_access.wait(2): raise AssertionError('gateway did not reach child access')
                cur.execute('UPDATE lele.children SET archived=true WHERE id=%s', (self.child_id,))
            self.service.transaction(work)
        def request():
            if not archived.wait(2): raise AssertionError('archive did not obtain advisory lock')
            try:
                self.route('PUT', 'records/notes/race', {'payload': {}, 'operationId': str(uuid.uuid4())})
            except ApiError as error:
                return error.kind
            raise AssertionError('archived child accepted write')
        with patch.object(self.service, 'access', side_effect=inspect_access), ThreadPoolExecutor(max_workers=2) as pool:
            a, b = pool.submit(archive), pool.submit(request)
            a.result(timeout=4)
            self.assertIn(b.result(timeout=4), ('archived', 'child_unavailable'))

    def test_real_runtime_service_unix_transport_and_signed_scope(self):
        import subprocess
        from unittest.mock import patch
        from lele_growth.plugins.supervisor import RuntimeClient, socket_root
        with tempfile.TemporaryDirectory(prefix='plugin-service-') as directory:
            root = Path(directory) / 'runtime'
            prepare_release(inspect_package(make_package(directory, self.data, schema=self.schema)), root)
            # Short explicit path keeps AF_UNIX within platform path limits.
            sockets = Path(tempfile.mkdtemp(prefix='prpc-'))
            self.addCleanup(lambda: __import__('shutil').rmtree(sockets, ignore_errors=True))
            with patch.dict(os.environ, {'LELE_PLUGIN_ROOT': str(root), 'LELE_PLUGIN_SOCKET_ROOT': str(sockets)}):
                process = subprocess.Popen([sys.executable, str(ROOT / 'deploy/plugin_runtime.py'), '--config', str(self.config_path)],
                                           cwd=ROOT, env={**os.environ, 'PYTHONPATH': str(ROOT / 'backend')}, stdin=subprocess.DEVNULL,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    deadline = time.monotonic() + 8
                    while time.monotonic() < deadline and process.poll() is None and not (sockets / 'control.sock').exists():
                        time.sleep(0.025)
                    self.assertIsNone(process.poll()); self.assertTrue((sockets / 'control.sock').exists())
                    client = RuntimeClient(root)
                    self.gateway.runtime = client
                    response = self.route('GET', 'whoami')
                    self.assertEqual(response['childId'], self.child_id)
                    self.assertNotEqual(response['pid'], process.pid)
                    signed = self.gateway.issue_job_context(self.context(), 'transport-job')
                    with self.assertRaises(ApiError):
                        client._request('/call', {'context': {**signed, 'childId': 'forged'}, 'action': 'handle_request', 'payload': {'path': 'whoami'}})
                    self.sql('UPDATE lele.child_plugins SET enabled=false,generation=generation+1 WHERE plugin_id=%s', (self.plugin_id,))
                    with self.assertRaises(ApiError): client.call(signed, 'handle_request', {'path': 'whoami'})
                finally:
                    process.terminate()
                    try: process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait(timeout=2)

    def test_reconcile_two_plugins_same_child_does_not_invert_catalog_locks(self):
        import threading
        from unittest.mock import patch
        from deploy import plugin_runtime
        from lele_growth.plugins.policy import catalog_row
        second = 'zz-' + uuid.uuid4().hex[:12]
        data = copy.deepcopy(self.data); data['id'] = second
        def install(cur):
            register_release(cur, data, artifact_sha256='e' * 64, source_commit='test', config_schema=self.schema, activate=True)
            cur.execute("UPDATE lele.plugin_catalog SET publication_status='published' WHERE id=%s", (second,))
            cur.execute('INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled) VALUES(%s,%s,true,true)', (self.child_id, second))
            cur.execute('INSERT INTO lele.child_plugin_configs(child_id,plugin_id,config) VALUES(%s,%s,%s)', (self.child_id, second, Jsonb({'message': 'ok'})))
        self.service.transaction(install)
        first_checked, owner_locked = threading.Event(), threading.Event()
        original = plugin_runtime.active_context
        def inspect(cur, plugin_id, child_id):
            result = original(cur, plugin_id, child_id)
            if plugin_id == self.plugin_id and child_id == self.child_id:
                first_checked.set()
                if not owner_locked.wait(2): raise AssertionError('owner did not lock second catalog')
            return result
        def disable_second():
            def work(cur):
                catalog_row(cur, second, lock='UPDATE')
                owner_locked.set()
                if not first_checked.wait(2): raise AssertionError('reconcile did not reach first plugin')
                cur.execute('UPDATE lele.children SET name=name WHERE id=%s', (self.child_id,))
                cur.execute('UPDATE lele.child_plugins SET enabled=false,generation=generation+1 WHERE child_id=%s AND plugin_id=%s', (self.child_id, second))
            self.service.transaction(work)
        with tempfile.TemporaryDirectory(prefix='reconcile-locks-') as directory:
            runtime = plugin_runtime.PluginRuntimeService(self.service, Path(directory) / 'runtime')
            try:
                with patch.object(plugin_runtime, 'active_context', side_effect=inspect), ThreadPoolExecutor(max_workers=2) as pool:
                    owner = pool.submit(disable_second)
                    self.assertTrue(owner_locked.wait(2))
                    reconciled = pool.submit(runtime.reconcile)
                    owner.result(timeout=5)
                    reconciled.result(timeout=5)
            finally:
                runtime.close()
        self.assertEqual(self.sql('SELECT enabled FROM lele.child_plugins WHERE child_id=%s AND plugin_id=%s', (self.child_id, second)), [(False,)])

    def test_runtime_tick_continues_after_one_failed_stage_with_bounded_logging(self):
        from unittest.mock import patch, Mock
        from deploy.plugin_runtime import PluginRuntimeService
        with tempfile.TemporaryDirectory(prefix='runtime-stages-') as directory:
            runtime = PluginRuntimeService(self.service, Path(directory) / 'runtime')
            try:
                runtime.scheduler.reap = Mock()
                runtime.scheduler.schedule_due = Mock(side_effect=TypeError('malformed task'))
                runtime.events.dispatch = Mock()
                runtime.reconcile = Mock()
                def once(*args):
                    runtime.stopped.set()
                    return True
                with patch.object(runtime.stopped, 'wait', side_effect=once), self.assertLogs('deploy.plugin_runtime', level='WARNING') as logs:
                    runtime._loop()
                    runtime._stage('scheduling', runtime.scheduler.schedule_due)
                runtime.events.dispatch.assert_called_once()
                runtime.reconcile.assert_called_once()
                self.assertEqual(len(logs.output), 1)
            finally:
                runtime.close()

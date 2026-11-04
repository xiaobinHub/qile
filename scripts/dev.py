"""Local-only development lifecycle; never reads or migrates the RDS config."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
RUNTIME = ROOT / 'data' / 'development'
CONFIG = RUNTIME / 'config.json'
TEST_RUNTIME = ROOT / 'data' / 'testing' / 'backend'


def private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as target:
        json.dump(value, target, ensure_ascii=False, indent=2)
        target.write('\n')


def pg_bin(name):
    for candidate in (Path('/opt/homebrew/opt/postgresql@16/bin') / name,
                      Path('/usr/local/opt/postgresql@16/bin') / name):
        if candidate.is_file():
            return str(candidate)
    found = shutil.which(name)
    if not found:
        raise RuntimeError('请先安装 PostgreSQL 16，例如 brew install postgresql@16。')
    return found


def prepare_database():
    RUNTIME.mkdir(parents=True, exist_ok=True)
    RUNTIME.chmod(0o700)
    if not CONFIG.exists():
        password = secrets.token_urlsafe(28)
        db = dict(host='127.0.0.1', port=55432, dbname='lele_dev', user='lele_local',
                  password=password, sslmode='disable', allow_unencrypted=True)
        private_json(CONFIG, dict(environment='development', database=db,
                     parent_origin='http://127.0.0.1:18787', admin_origin='http://127.0.0.1:18788'))
    from lele_growth.child_service import load_config
    config = load_config(CONFIG)
    if config['environment'] != 'development':
        raise RuntimeError('开发工具只允许 development 配置。')
    password_file = RUNTIME / 'pg-password'
    if not password_file.exists():
        descriptor = os.open(password_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as target:
            target.write(config['database']['password'])
    cluster = RUNTIME / 'pgdata'
    if not (cluster / 'PG_VERSION').exists():
        subprocess.run([pg_bin('initdb'), '-D', str(cluster), '--username=' + config['database']['user'],
                        '--pwfile=' + str(password_file), '--auth-local=trust', '--auth-host=scram-sha-256',
                        '--encoding=UTF8', '--locale=C'], check=True, stdout=subprocess.DEVNULL)
    ready = subprocess.run([pg_bin('pg_ctl'), '-D', str(cluster), 'status'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if ready.returncode:
        subprocess.run([pg_bin('pg_ctl'), '-D', str(cluster), '-l', str(RUNTIME / 'postgres.log'),
                        '-o', '-h 127.0.0.1 -p 55432 -k ' + str(RUNTIME), 'start'], check=True, stdout=subprocess.DEVNULL)
    import psycopg
    from psycopg import sql
    params = {**config['_connect'], 'dbname': 'postgres'}
    with psycopg.connect(**params, autocommit=True) as connection:
        for name in ('lele_dev', 'lele_test_accounts', 'lele_test'):
            if not connection.execute('SELECT 1 FROM pg_database WHERE datname=%s', (name,)).fetchone():
                connection.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    TEST_RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
    TEST_RUNTIME.parent.chmod(0o700)
    TEST_RUNTIME.chmod(0o700)
    for filename, database in [('config.json', 'lele_test_accounts'), ('postgres-config.json', 'lele_test')]:
        target = TEST_RUNTIME / filename
        if not target.exists():
            db = {**config['database'], 'dbname': database}
            value = db if filename == 'postgres-config.json' else {k: v for k, v in config.items() if not k.startswith('_')}
            if filename != 'postgres-config.json':
                value = {**value, 'database': db, 'object_storage': {'provider': 'test-filesystem', 'root': str(TEST_RUNTIME / 'objects')}}
            private_json(target, value)
    return config


def setup(source=None):
    config = prepare_database()
    from lele_growth.child_service import ChildService, bootstrap, initialize, import_child
    initialize(CONFIG)
    service = ChildService(CONFIG)
    exists = service.transaction(lambda cur: (cur.execute('SELECT EXISTS(SELECT 1 FROM lele.users)'), cur.fetchone()[0])[1])
    accounts_path = RUNTIME / 'accounts.json'
    if exists and not accounts_path.exists():
        print('本机开发数据库已就绪，保留已有账号及测试数据。')
        return
    if accounts_path.exists():
        accounts = json.loads(accounts_path.read_text())
    else:
        accounts = {'environment': 'development', 'parentUrl': config['parent_origin'], 'adminUrl': config['admin_origin'],
                    'admin': {'loginName': 'admin', 'password': (secrets.token_urlsafe(22) + 'A7')},
                    'lele': {'loginName': 'lele', 'password': (secrets.token_urlsafe(22) + 'A7'), 'mustChangePassword': True},
                    'source': str(Path(source).resolve()) if source else None}
        private_json(accounts_path, accounts)
    if accounts.get('initialChildId'):
        print('本机开发数据库已就绪，保留已有账号及测试数据。')
        return
    admin_password, parent_password = accounts['admin']['password'], accounts['lele']['password']
    if not exists:
        bootstrap(CONFIG, 'admin', '管理员', admin_password)
    session = service.request('POST', 'auth/login', dict(loginName='admin', password=admin_password),
                              None, None, config['admin_origin'], 'admin', '127.0.0.1')
    if session['user']['mustChangePassword']:
        # Complete the bootstrap gate for the generated development administrator.
        new_password = (secrets.token_urlsafe(22) + 'A7')
        service.request('POST', 'account/password', {'currentPassword': admin_password, 'newPassword': new_password},
                        session['_cookie'], session['csrfToken'], config['admin_origin'], 'admin', '127.0.0.1')
        accounts['admin']['password'] = new_password
        with accounts_path.open('w') as target:
            json.dump(accounts, target, ensure_ascii=False, indent=2)
        session = service.request('POST', 'auth/login', dict(loginName='admin', password=new_password),
                                  None, None, config['admin_origin'], 'admin', '127.0.0.1')
    existing = service.request('GET', 'admin/users', {}, session['_cookie'], None, None, 'admin', '127.0.0.1')
    owner = next((u for u in existing['users'] if u['loginName'] == 'lele'), None)
    if owner is None:
        owner = service.request('POST', 'admin/users', dict(loginName='lele', nickname='乐乐家长', password=parent_password),
                                session['_cookie'], session['csrfToken'], config['admin_origin'], 'admin', '127.0.0.1')['user']
    owner_id = owner['id']
    # Activate for offline import, while retaining the first-login password-change gate.
    service.request('PATCH', 'admin/users/' + owner_id + '/status', {'status': 'active'},
                    session['_cookie'], session['csrfToken'], config['admin_origin'], 'admin', '127.0.0.1')
    if source:
        record = json.loads(Path(source).read_text())
        child = import_child(CONFIG, owner_id, record)
        print('已将指定本机数据副本导入开发数据库，修订号 ' + str(record['revision']) + '。')
    else:
        child = service.transaction(lambda cur: service.create_child(cur, owner_id, '乐乐'), exclusive=True)
    accounts['initialChildId'] = child['id']
    descriptor = os.open(accounts_path, os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as target:
        json.dump(accounts, target, ensure_ascii=False, indent=2)
    print('本机账号信息已保存到 data/development/accounts.json（仅本机，权限 0600）。')


def health(url):
    try:
        with urllib.request.urlopen(url + '/api/health', timeout=2) as response:
            value = json.load(response)
            return value.get('environment') == 'development' and value.get('databaseReady') is True
    except Exception:
        return False


def plugin_runtime_ready():
    """Probe the authenticated control service, not just a possibly stale socket file."""
    from lele_growth.plugins.supervisor import unix_request
    sockets = RUNTIME / 'plugin-sockets'
    try:
        result = unix_request(sockets / 'control.sock', '/ready', {}, timeout=1,
                              credential=(sockets / 'control.token').read_text().strip())
        return result.get('ok') is True and result.get('protocol') == '1.0'
    except Exception:
        return False


def ensure_plugin_runtime():
    """Keep the development runtime alive across starts and plugin deployments."""
    from lele_growth.child_service import load_config
    config = load_config(CONFIG)
    if config['environment'] != 'development' or config['database']['host'] not in ('127.0.0.1', 'localhost', '::1'):
        raise RuntimeError('插件运行服务仅允许使用本机 development 配置。')
    RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
    root, sockets = RUNTIME / 'plugin-runtime', RUNTIME / 'plugin-sockets'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    sockets.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Serialize two concurrent `start` or deployment commands.
    with (sockets / 'start.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if plugin_runtime_ready():
            return
        # Do not replace an active runtime's socket if its readiness check failed.
        with (sockets / 'service.lock').open('a+') as owner:
            try:
                fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('插件运行服务进程仍在运行但未就绪，请查看 data/development/plugin-runtime.log。') from None
        environment = {**os.environ, 'PYTHONPATH': str(ROOT / 'backend'),
                       'LELE_PLUGIN_ROOT': str(root), 'LELE_PLUGIN_SOCKET_ROOT': str(sockets)}
        vault_key = RUNTIME / 'plugin-vault.txt'
        if not vault_key.exists():
            import base64
            descriptor = os.open(vault_key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w') as target:
                target.write('local-v1:' + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode() + '\n')
        environment['LELE_PLUGIN_VAULT_KEY'] = str(vault_key)
        with (RUNTIME / 'plugin-runtime.log').open('ab', buffering=0) as log:
            process = subprocess.Popen([sys.executable, 'deploy/plugin_runtime.py', '--config', str(CONFIG)],
                                       cwd=ROOT, env=environment, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=log, start_new_session=True)
        try:
            for _ in range(80):
                if plugin_runtime_ready():
                    (RUNTIME / 'plugin-runtime.pid').write_text(str(process.pid))
                    return
                if process.poll() is not None:
                    break
                time.sleep(.1)
        except BaseException:
            process.terminate()
            process.wait(timeout=5)
            raise
        process.terminate()
        process.wait(timeout=5)
        raise RuntimeError('插件运行服务启动失败，请查看 data/development/plugin-runtime.log。')


def stop_plugin_runtime():
    pid_path = RUNTIME / 'plugin-runtime.pid'
    if not pid_path.is_file():
        return
    try:
        pid = int(pid_path.read_text())
        command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True).strip()
        if 'deploy/plugin_runtime.py' in command and str(CONFIG) in command:
            os.kill(pid, signal.SIGTERM)
            for _ in range(100):
                current = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], text=True, capture_output=True)
                if current.returncode or 'deploy/plugin_runtime.py' not in current.stdout:
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('插件运行服务尚未结束，请查看本机日志后重试。')
    except (ValueError, ProcessLookupError, subprocess.CalledProcessError):
        pass
    pid_path.unlink(missing_ok=True)


def start():
    config = prepare_database()
    from lele_growth.child_service import initialize
    initialize(CONFIG)
    plugin_root = RUNTIME / 'plugin-runtime'
    plugin_socket_root = RUNTIME / 'plugin-sockets'
    plugin_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    plugin_socket_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    ensure_plugin_runtime()
    for surface, port in [('parent', 18787), ('admin', 18788)]:
        origin = config[surface + '_origin']
        if health(origin):
            continue
        pid_path = RUNTIME / (surface + '.pid')
        environment = {**os.environ, 'PYTHONPATH': str(ROOT / 'backend'), 'LELE_ACCOUNTS_CONFIG': str(CONFIG),
                       'LELE_SURFACE': surface, 'LELE_PLUGIN_ROOT': str(plugin_root),
                       'LELE_PLUGIN_SOCKET_ROOT': str(plugin_socket_root)}
        with (RUNTIME / (surface + '.log')).open('ab', buffering=0) as log:
            process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'lele_growth.accounts_app:create_from_env', '--factory',
                                        '--host', '0.0.0.0', '--port', str(port), '--no-proxy-headers'],
                                       cwd=ROOT, env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                       start_new_session=True)
        pid_path.write_text(str(process.pid))
        for attempt in range(30):
            if health(origin):
                break
            if process.poll() is not None:
                raise RuntimeError('开发服务启动失败，请查看 data/development/' + surface + '.log。')
            time.sleep(.25)
        else:
            raise RuntimeError('开发服务尚未就绪，请查看本机日志。')
    print('家长端：' + config['parent_origin'])
    print('管理员：' + config['admin_origin'])
    lan_ip = _lan_ip()
    if lan_ip:
        print('局域网家长端：http://{}:18787'.format(lan_ip))
        print('局域网管理端：http://{}:18788'.format(lan_ip))


def _lan_ip():
    import ipaddress
    import socket
    import subprocess
    candidates = []
    try:
        listing = subprocess.check_output(['ifconfig'], text=True, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError):
        listing = ''
    for line in listing.splitlines():
        line = line.strip()
        if not line.startswith('inet '):
            continue
        address = line.split()[1]
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            continue
        if parsed.version != 4 or parsed.is_loopback or parsed.is_link_local:
            continue
        if not parsed.is_private or parsed in ipaddress.ip_network('198.18.0.0/15'):
            continue
        candidates.append(str(parsed))
    if not candidates:
        try:
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.connect(('10.255.255.255', 1))
            address = probe.getsockname()[0]
            probe.close()
            parsed = ipaddress.ip_address(address)
            if parsed.is_private and not parsed.is_loopback and parsed not in ipaddress.ip_network('198.18.0.0/15'):
                return str(parsed)
        except OSError:
            return None
        return None
    for prefix in ('192.168.', '10.', '172.'):
        for address in candidates:
            if address.startswith(prefix):
                return address
    return candidates[0]


def stop():
    for surface in ('parent', 'admin'):
        file = RUNTIME / (surface + '.pid')
        if file.exists():
            try:
                pid = int(file.read_text())
                # Avoid signaling a PID reused by an unrelated application.
                cmd = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True).strip()
                if 'uvicorn lele_growth.accounts_app:create_from_env' in cmd:
                    os.kill(pid, signal.SIGTERM)
            except (ValueError, ProcessLookupError, subprocess.CalledProcessError):
                pass
            file.unlink(missing_ok=True)
    stop_plugin_runtime()
    print('本机新版 Web 服务及插件运行服务已停止；开发数据库及数据保留。')


def plugins_deploy(package_path):
    """Deploy one development plugin package to the explicit local development root."""
    package = Path(package_path).resolve()
    require_file = subprocess.run([sys.executable, '-c', 'from pathlib import Path; import sys; p=Path(sys.argv[1]); print(p.is_file())', str(package)],
                                  text=True, capture_output=True, check=True)
    if require_file.stdout.strip() != 'True':
        raise RuntimeError('插件包不存在：' + str(package))
    from lele_growth.child_service import ChildService, initialize
    from lele_growth.maintenance import initialize_plugin_platform
    from lele_growth.plugins.deployment import PluginDeployment
    from lele_growth.plugins.supervisor import RuntimeClient
    prepare_database()
    initialize(CONFIG)
    initialize_plugin_platform(ChildService(CONFIG))
    plugin_root = ROOT / 'data' / 'development' / 'plugin-runtime'
    runtime_client = RuntimeClient(plugin_root)
    runtime_client.sockets = RUNTIME / 'plugin-sockets'
    manager = PluginDeployment(ChildService(CONFIG), root=plugin_root, runtime=runtime_client, actor='local-development')
    ensure_plugin_runtime()
    preview = manager.execute('deploy', package=package)
    result = manager.execute('deploy', package=package, apply=True, confirm=preview['target']['targetId'])
    print(json.dumps(result, ensure_ascii=False))


def plugins_preview(package_path):
    """Register a development-only package for UI review without a runtime service."""
    package = Path(package_path).resolve()
    if not package.is_file():
        raise RuntimeError('插件包不存在：' + str(package))
    from lele_growth.child_service import ChildService, initialize
    from lele_growth.maintenance import initialize_plugin_platform
    from lele_growth.plugins.catalog import register_release, set_publication, set_scope
    from lele_growth.plugins.deployment import inspect_package, prepare_release
    from lele_growth.plugins.policy import catalog_row
    prepare_database()
    initialize(CONFIG)
    service = ChildService(CONFIG)
    initialize_plugin_platform(service)
    info = inspect_package(package)
    root = ROOT / 'data' / 'development' / 'plugin-runtime'
    prepare_release(info, root)
    manifest = info['manifest']
    plugin_id = manifest['id']
    def register(cur):
        cur.execute("SELECT operation_state FROM lele.plugin_catalog WHERE id=%s", (plugin_id,))
        state = cur.fetchone()
        if state and state[0] != 'ready':
            cur.execute("UPDATE lele.plugin_catalog SET operation_state='ready',updated_at=now() WHERE id=%s", (plugin_id,))
        release = register_release(cur, manifest, artifact_sha256=info['sha256'],
                                   source_commit=info['descriptor']['sourceCommit'],
                                   config_schema=info['configSchema'], activate=True)
        revision = catalog_row(cur, plugin_id)['policy_revision']
        set_scope(cur, plugin_id, {'scopeMode': 'all', 'childIds': [], 'expectedRevision': revision})
        revision = catalog_row(cur, plugin_id)['policy_revision']
        set_publication(cur, plugin_id, True, revision)
        cur.execute('''SELECT c.id FROM lele.children c LEFT JOIN lele.child_plugins p
                       ON p.child_id=c.id AND p.plugin_id=%s
                       WHERE c.deleted_at IS NULL ORDER BY c.id''', (plugin_id,))
        for (child_id,) in cur.fetchall():
            cur.execute('''INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled,revision,generation)
                           VALUES(%s,%s,true,true,1,1)
                           ON CONFLICT(child_id,plugin_id) DO UPDATE SET
                             installed=true,enabled=true,requires_reenable=false,
                             revision=lele.child_plugins.revision+1,
                             generation=lele.child_plugins.generation+1''',
                        (child_id, plugin_id))
            cur.execute('''INSERT INTO lele.child_plugin_configs(child_id,plugin_id,config,config_schema_version)
                           VALUES(%s,%s,'{}'::jsonb,1)
                           ON CONFLICT(child_id,plugin_id) DO UPDATE SET
                             config='{}'::jsonb,config_schema_version=1''',
                        (child_id, plugin_id))
        return release
    release = service.transaction(register, exclusive=True)
    print(json.dumps({'environment': 'development', 'pluginId': plugin_id,
                      'version': manifest['version'], 'releaseId': release['release_id'],
                      'mode': 'ui-preview'}, ensure_ascii=False))


def plugins_inspect(plugin_id, child_id=None):
    """Read one local development installation status without changing it."""
    from lele_growth.child_service import ChildService
    from lele_growth.plugins.installations import child_plugin
    if child_id is None:
        accounts_path = RUNTIME / 'accounts.json'
        if not accounts_path.is_file():
            raise RuntimeError('本机开发账号尚未初始化。')
        child_id = json.loads(accounts_path.read_text()).get('initialChildId')
    if not isinstance(child_id, str) or not child_id:
        raise RuntimeError('没有可检查的本机开发儿童。')
    service = ChildService(CONFIG)
    result = service.transaction(lambda cur: child_plugin(cur, plugin_id, child_id))
    print(json.dumps(result, ensure_ascii=False))


def reset_admin(login_name):
    import getpass
    from lele_growth.child_service import ChildService, PASSWORDS, login_value, password_value, require
    service = ChildService(CONFIG)
    require(service.config['environment'] == 'development', 403, '只允许重置本机开发账号。')
    password = password_value(getpass.getpass('新的管理员初始密码（6–128 位，须含字母和数字）：'))
    require(password == getpass.getpass('再次输入密码：'), 400, '两次密码不一致。')
    encoded = PASSWORDS.hash(password)
    def run(cursor):
        cursor.execute("SELECT id FROM lele.users WHERE login_name=%s AND role='admin'", (login_value(login_name),))
        row = cursor.fetchone()
        require(row is not None, 404, '管理员账号不存在。')
        cursor.execute("UPDATE lele.users SET password_hash=%s,status='active',must_change_password=true WHERE id=%s", (encoded,row[0]))
        cursor.execute('DELETE FROM lele.sessions WHERE user_id=%s', (row[0],))
        service.audit(cursor,row[0],'operator.reset_admin',detail={'environment':'development'})
    service.transaction(run, exclusive=True)
    print('本机管理员密码已重置，旧会话已撤销，下次登录必须修改密码。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('setup').add_argument('--source', help='可选：导入到本机开发库的旧版数据包；原文件只读')
    sub.add_parser('reset-admin').add_argument('--login-name', default='admin')
    for name in ('start', 'stop', 'restart', 'plugins-setup', 'plugins-runtime-start', 'status', 'test'):
        sub.add_parser(name)
    sub.add_parser('plugins-deploy').add_argument('package')
    sub.add_parser('plugins-preview').add_argument('package')
    inspect_parser = sub.add_parser('plugins-inspect')
    inspect_parser.add_argument('plugin')
    inspect_parser.add_argument('--child')
    args = parser.parse_args()
    try:
        if args.command == 'setup': setup(args.source)
        elif args.command == 'start': start()
        elif args.command == 'stop': stop()
        elif args.command == 'restart':
            stop()
            for _ in range(30):
                if not any(health('http://127.0.0.1:' + str(port)) for port in (18787,18788)):
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('旧开发服务仍在结束，请稍后再启动。')
            start()
        elif args.command == 'plugins-setup':
            prepare_database()
            from lele_growth.child_service import ChildService, initialize
            from lele_growth.maintenance import initialize_plugin_platform
            initialize(CONFIG)
            result=initialize_plugin_platform(ChildService(CONFIG))
            print(json.dumps({'environment':'development','plugins':result},ensure_ascii=False))
        elif args.command == 'plugins-deploy':
            plugins_deploy(args.package)
        elif args.command == 'plugins-preview':
            plugins_preview(args.package)
        elif args.command == 'plugins-inspect':
            plugins_inspect(args.plugin, args.child)
        elif args.command == 'plugins-runtime-start':
            ensure_plugin_runtime()
            print('本机插件运行服务已就绪。')
        elif args.command == 'reset-admin': reset_admin(args.login_name)
        elif args.command == 'status':
            print(json.dumps({**{surface: health('http://127.0.0.1:' + str(port)) for surface, port in [('parent',18787),('admin',18788)]},
                              'pluginRuntime': plugin_runtime_ready()}))
        else:
            prepare_database()
            environment = {**os.environ, 'PYTHONPATH': str(ROOT / 'backend'), 'LELE_TEST_CONFIG': str(TEST_RUNTIME / 'config.json'),
                           'LELE_TEST_DB_CONFIG': str(TEST_RUNTIME / 'postgres-config.json')}
            subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/backend', '-t', '.', '-v'], cwd=ROOT, env=environment, check=True)
    except Exception as error:
        # Do not print raw DB exceptions: they may include connection information.
        if type(error).__module__.startswith('psycopg'):
            parser.exit(1, '本机开发数据库操作失败，请检查本机服务状态。\n')
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()

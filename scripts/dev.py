"""Local-only development lifecycle; never reads or migrates the RDS config."""
from __future__ import annotations

import argparse
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
    for filename, database in [('test-config.json', 'lele_test_accounts'), ('legacy-test-config.json', 'lele_test')]:
        target = RUNTIME / filename
        if not target.exists():
            db = {**config['database'], 'dbname': database}
            value = db if filename.startswith('legacy') else {k: v for k, v in config.items() if not k.startswith('_')}
            if not filename.startswith('legacy'):
                value = {**value, 'database': db, 'object_storage': {'provider': 'test-filesystem', 'root': str(RUNTIME / (database + '-objects'))}}
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


def start():
    config = prepare_database()
    from lele_growth.child_service import initialize
    initialize(CONFIG)
    for surface, port in [('parent', 18787), ('admin', 18788)]:
        origin = config[surface + '_origin']
        if health(origin):
            continue
        pid_path = RUNTIME / (surface + '.pid')
        environment = {**os.environ, 'PYTHONPATH': str(ROOT / 'backend'), 'LELE_ACCOUNTS_CONFIG': str(CONFIG), 'LELE_SURFACE': surface}
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
    print('本机新版 Web 服务已停止；开发数据库及数据保留。')


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
    for name in ('start', 'stop', 'status', 'test'):
        sub.add_parser(name)
    args = parser.parse_args()
    try:
        if args.command == 'setup': setup(args.source)
        elif args.command == 'start': start()
        elif args.command == 'stop': stop()
        elif args.command == 'reset-admin': reset_admin(args.login_name)
        elif args.command == 'status':
            print(json.dumps({surface: health('http://127.0.0.1:' + str(port)) for surface, port in [('parent',18787),('admin',18788)]}))
        else:
            prepare_database()
            environment = {**os.environ, 'PYTHONPATH': str(ROOT / 'backend'), 'LELE_TEST_CONFIG': str(RUNTIME / 'test-config.json'),
                           'LELE_TEST_DB_CONFIG': str(RUNTIME / 'legacy-test-config.json')}
            subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/backend', '-t', '.', '-v'], cwd=ROOT, env=environment, check=True)
    except Exception as error:
        # Do not print raw DB exceptions: they may include connection information.
        if type(error).__module__.startswith('psycopg'):
            parser.exit(1, '本机开发数据库操作失败，请检查本机服务状态。\n')
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()

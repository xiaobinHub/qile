"""Transactional account and child service; configuration is always explicit.

Every request holds the account gate in shared mode, except identity/security
changes, which take it exclusively. Child mutations then take a per-child lock.
Thus account revocation cannot race a write while unrelated children can write
concurrently. SQL and authentication failures never expose connection details.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import ipaddress
import json
import re
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import psycopg
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from psycopg.types.json import Jsonb

from child_store import ChildStore
from postgres_store import canonical_sha256, canonical_bytes, validate_data, validate_record, PostgresStore
from storage import StoreError, STORE_FORMAT, STORE_VERSION, BACKUP_LIMIT

PASSWORDS = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2)
DUMMY_HASH = PASSWORDS.hash(secrets.token_urlsafe(32))
SESSION_SECONDS = {'parent': 30 * 24 * 3600, 'admin': 8 * 3600}
USER_COLUMNS = 'id,login_name,nickname,role,status,must_change_password,password_hash'

class ApiError(Exception):
    def __init__(self, status, error, kind=None):
        self.status, self.error, self.kind = status, error, kind
        super().__init__(error)


def require(condition, status=400, message='提交的信息不正确。', kind=None):
    if not condition:
        raise ApiError(status, message, kind)


def text_value(value, limit=40):
    require(isinstance(value, str) and 1 <= len(value.strip()) <= limit)
    return value.strip()


def login_value(value):
    require(isinstance(value, str))
    value = value.strip().lower()
    require(bool(re.fullmatch(r'[a-z0-9][a-z0-9_.-]{2,31}', value)))
    return value


def password_value(value):
    require(isinstance(value, str) and 15 <= len(value) <= 128, message='密码需为 15 至 128 个字符。')
    return value


def password_matches(encoded, value):
    try:
        return PASSWORDS.verify(encoded, value if isinstance(value, str) and len(value) <= 128 else '')
    except (VerificationError, InvalidHashError):
        return False


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def identity():
    return str(uuid.uuid4())


def public_user(row):
    return dict(id=row[0], loginName=row[1], nickname=row[2], role=row[3], mustChangePassword=row[5])


def load_config(config_path):
    """Never falls back to an RDS configuration or accepts DNS aliases in dev."""
    try:
        config = json.loads(Path(config_path).read_text())
        require(isinstance(config, dict) and set(config) <= {'environment','database','parent_origin','admin_origin'})
        require(config.get('environment') in ('development','production'))
        db = config.get('database')
        require(isinstance(db, dict) and set(db) <= {'host','port','dbname','user','password','sslmode','sslrootcert','allow_unencrypted','connect_timeout'})
        for key in ('host','dbname','user'):
            require(isinstance(db.get(key), str) and db[key] and '\x00' not in db[key])
        require(type(db.get('port',5432)) is int and 1 <= db.get('port',5432) <= 65535)
        require('password' not in db or isinstance(db['password'],str) and '\x00' not in db['password'])
        dev = config['environment'] == 'development'
        if dev:
            require(ipaddress.ip_address(db['host']).is_loopback)
            require(db['dbname'] == 'lele_dev' or db['dbname'].startswith('lele_test'))
        mode = db.get('sslmode','verify-full')
        require(mode in ('disable','require','verify-ca','verify-full'))
        require(mode != 'disable' or db.get('allow_unencrypted') is True)
        require('allow_unencrypted' not in db or type(db['allow_unencrypted']) is bool)
        require(mode not in ('verify-ca','verify-full') or bool(db.get('sslrootcert')))
        for origin_key in ('parent_origin','admin_origin'):
            origin = config.get(origin_key)
            require(isinstance(origin,str))
            url = urlsplit(origin)
            require(url.scheme in ('http','https') and url.hostname and not url.username and not url.password and url.path in ('','/') and not url.query and not url.fragment)
            require(not origin.endswith('/'))
            require(url.port is None or 1 <= url.port <= 65535)
            if dev:
                require(ipaddress.ip_address(url.hostname).is_loopback)
            else:
                require(url.scheme == 'https')
        require(config['parent_origin'] != config['admin_origin'])
        params = {k:v for k,v in db.items() if k not in ('allow_unencrypted','connect_timeout')}
        params.update(port=db.get('port',5432),sslmode=mode,connect_timeout=5,options='-c statement_timeout=10000 -c lock_timeout=5000')
        if params.get('sslrootcert'):
            cert=Path(params['sslrootcert']).expanduser()
            if not cert.is_absolute(): cert=Path(config_path).parent/cert
            require(cert.is_file())
            params['sslrootcert']=str(cert.resolve())
        config['_connect']=params
        return config
    except (ValueError, TypeError, OSError, ApiError):
        raise ApiError(503,'账号服务配置不完整或环境不匹配。') from None


class ChildService:
    def __init__(self, config_path):
        self.config = load_config(config_path)
        self.store = ChildStore()

    def transaction(self, work, *, exclusive=False, schema_check=True):
        try:
            with psycopg.connect(**self.config['_connect']) as connection:
                with connection.cursor() as cur:
                    cur.execute('SELECT '+('pg_advisory_xact_lock' if exclusive else 'pg_advisory_xact_lock_shared')+'(1818586213,2)')
                    if schema_check:
                        cur.execute('SELECT version FROM lele.schema_versions')
                        require(cur.fetchall()==[(2,)],503,'数据库尚未完成账号版本初始化。')
                    return work(cur)
        except (ApiError, StoreError):
            raise
        except psycopg.Error as error:
            if error.sqlstate == '23505':
                raise ApiError(409,'此信息已存在，请刷新后重试。') from None
            if error.sqlstate and error.sqlstate[:2] in ('22','23'):
                raise ApiError(400,'提交的信息或关联不正确。') from None
            raise ApiError(503,'数据库暂时无法访问；保存结果未确认时请刷新检查。') from None

    @staticmethod
    def audit(cur, actor, action, child=None, detail=None):
        cur.execute('INSERT INTO lele.audit_events(actor_id,child_id,action,detail) VALUES(%s,%s,%s,%s)',(actor,child,action,Jsonb(detail or {})))

    @staticmethod
    def lock_child(cur, child_id):
        # Stable 64-bit advisory key; no untrusted SQL interpolation.
        cur.execute('SELECT pg_advisory_xact_lock(%s)',(int.from_bytes(hashlib.sha256(('child:'+child_id).encode()).digest()[:8],'big',signed=True),))

    def access(self, cur, user, child_id, *, owner=False, write=False, allow_archived=False):
        require(user[3]=='parent',403,'管理员不能访问孩子业务数据。')
        self.lock_child(cur,child_id)
        cur.execute('SELECT c.id,c.name,c.owner_id,c.archived,m.membership_version FROM lele.children c JOIN lele.memberships m ON m.child_id=c.id WHERE c.id=%s AND m.user_id=%s FOR UPDATE OF c,m',(child_id,user[0]))
        row=cur.fetchone()
        require(row is not None,403,'没有此孩子的访问权限。','membership_revoked')
        require(not owner or row[2]==user[0],403,'只有负责人可以执行此操作。')
        require(not write or not row[3] or allow_archived,409,'孩子已归档，当前仅可查看。','archived')
        return row

    @staticmethod
    def child_public(row, user_id):
        return dict(id=row[0],name=row[1],ownerId=row[2],archived=row[3],role='owner' if row[2]==user_id else 'parent',membershipVersion=row[4])

    def authenticate(self, cur, token, surface):
        require(isinstance(token,str) and len(token)<200,401,'请先登录。')
        cur.execute(f'SELECT {",".join("u."+x for x in USER_COLUMNS.split(","))},s.csrf_hash FROM lele.sessions s JOIN lele.users u ON u.id=s.user_id WHERE s.token_hash=%s AND s.surface=%s AND s.expires_at>now()',(digest(token),surface))
        row=cur.fetchone()
        require(row is not None and row[4] in ('active','pending'),401,'登录已失效，请重新登录。')
        require(row[3]==('admin' if surface=='admin' else 'parent'),403,'此账号不能使用当前入口。')
        return row

    def request(self, method, path, body, token, csrf, origin, surface, client):
        require(surface in ('parent','admin'))
        require(isinstance(body,dict))
        write=method not in ('GET','HEAD')
        if write:
            require(origin==self.config[surface+'_origin'],403,'请求来源不受信任。')
        exclusive=path.startswith('auth/') or path.startswith('account/') or path.startswith('admin/')
        def run(cur):
            if path=='auth/login' and method=='POST':
                return self.login(cur,body,surface,client)
            user=self.authenticate(cur,token,surface)
            if write:
                require(isinstance(csrf,str) and hmac.compare_digest(digest(csrf),user[7]),403,'请求校验失败，请刷新页面。')
            require(not user[5] or path in ('auth/me','auth/logout','account/password'),403,'请先修改初始密码。','password_change_required')
            if path=='auth/me' and method=='GET':
                return dict(user=public_user(user),csrfToken=digest('csrf:'+token))
            if path=='auth/logout' and method=='POST':
                cur.execute('DELETE FROM lele.sessions WHERE token_hash=%s',(digest(token),))
                self.audit(cur,user[0],'auth.logout')
                return {'ok':True,'_clear_cookie':True}
            if path=='account/password' and method=='POST':
                require(set(body)=={'currentPassword','newPassword'})
                require(password_matches(user[6],body['currentPassword']),403,'当前密码不正确。')
                new=password_value(body['newPassword'])
                require(not password_matches(user[6],new),400,'新密码不能与当前密码相同。')
                cur.execute("UPDATE lele.users SET password_hash=%s,must_change_password=false,status='active' WHERE id=%s",(PASSWORDS.hash(new),user[0]))
                cur.execute('DELETE FROM lele.sessions WHERE user_id=%s',(user[0],))
                self.audit(cur,user[0],'account.password')
                return {'ok':True,'_clear_cookie':True}
            if path=='account/profile' and method=='PATCH':
                require(bool(body) and set(body) <= {'loginName','nickname','currentPassword'} and bool(set(body)&{'loginName','nickname'}))
                login=login_value(body.get('loginName',user[1]))
                nickname=text_value(body.get('nickname',user[2]))
                if login != user[1]:
                    require(password_matches(user[6],body.get('currentPassword')),403,'修改登录名需要正确的当前密码。')
                cur.execute('UPDATE lele.users SET login_name=%s,nickname=%s WHERE id=%s RETURNING '+USER_COLUMNS,(login,nickname,user[0]))
                result=public_user(cur.fetchone())
                self.audit(cur,user[0],'account.profile')
                return {'user':result}
            if path.startswith('admin/'):
                require(surface=='admin' and user[3]=='admin',403,'需要管理员权限。')
                return self.admin(cur,user,method,path,body)
            require(surface=='parent' and user[3]=='parent',403,'管理员不能访问孩子业务数据。')
            return self.parent(cur,user,method,path,body)
        result=self.transaction(run,exclusive=exclusive)
        # Login failures must commit their rate-limit counters before returning 401.
        if '_error' in result:
            raise ApiError(*result['_error'])
        return result

    def login(self,cur,body,surface,client):
        require(set(body)=={'loginName','password'})
        try: login=login_value(body['loginName'])
        except ApiError: login='!invalid'
        buckets=['login:'+digest(login),'ip:'+digest(client)]
        for bucket in sorted(buckets):
            cur.execute('INSERT INTO lele.login_limits(bucket) VALUES(%s) ON CONFLICT DO NOTHING',(bucket,))
            cur.execute("UPDATE lele.login_limits SET failures=0,window_start=now() WHERE bucket=%s AND window_start<now()-interval '15 minutes'",(bucket,))
            cur.execute('SELECT failures FROM lele.login_limits WHERE bucket=%s FOR UPDATE',(bucket,))
            if cur.fetchone()[0]>=10:
                return {'_error':(429,'登录暂时受限，请稍后重试。')}
        cur.execute('SELECT '+USER_COLUMNS+' FROM lele.users WHERE login_name=%s',(login,))
        user=cur.fetchone()
        valid=password_matches(user[6] if user else DUMMY_HASH,body['password'])
        if not user or not valid or user[4]=='disabled' or user[3]!=('admin' if surface=='admin' else 'parent'):
            for bucket in buckets:
                cur.execute('UPDATE lele.login_limits SET failures=failures+1 WHERE bucket=%s',(bucket,))
            self.audit(cur,user[0] if user else None,'auth.login_failed')
            return {'_error':(401,'账号或密码不正确。')}
        cur.execute('DELETE FROM lele.login_limits WHERE bucket=%s',(buckets[0],))
        token=secrets.token_urlsafe(48); csrf=digest('csrf:'+token)
        cur.execute("INSERT INTO lele.sessions(token_hash,user_id,surface,csrf_hash,expires_at) VALUES(%s,%s,%s,%s,now()+%s*interval '1 second')",(digest(token),user[0],surface,digest(csrf),SESSION_SECONDS[surface]))
        self.audit(cur,user[0],'auth.login')
        return dict(user=public_user(user),csrfToken=csrf,_cookie=token)

    def admin(self,cur,user,method,path,body):
        if path=='admin/users' and method=='GET':
            cur.execute('SELECT '+USER_COLUMNS+' FROM lele.users ORDER BY created_at,id')
            return {'users':[{**public_user(u),'status':u[4]} for u in cur.fetchall()]}
        if path=='admin/users' and method=='POST':
            require(set(body)=={'loginName','nickname','password'})
            uid=identity()
            cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES(%s,%s,%s,%s,'parent','pending') RETURNING "+USER_COLUMNS,(uid,login_value(body['loginName']),text_value(body['nickname']),PASSWORDS.hash(password_value(body['password']))))
            result=public_user(cur.fetchone()); self.audit(cur,user[0],'admin.create_user',detail={'userId':uid})
            return {'user':{**result,'status':'pending'}}
        parts=path.split('/')
        require(len(parts)==4 and parts[:2]==['admin','users'],404,'接口不存在。')
        target=parts[2]
        cur.execute('SELECT role FROM lele.users WHERE id=%s FOR UPDATE',(target,))
        row=cur.fetchone()
        require(row is not None,404,'账号不存在。')
        require(target!=user[0] and row[0]=='parent',403,'不能通过此接口修改管理员。')
        if parts[3]=='status' and method=='PATCH':
            require(set(body)=={'status'} and body['status'] in ('active','disabled'))
            cur.execute('UPDATE lele.users SET status=%s WHERE id=%s',(body['status'],target))
        elif parts[3]=='password' and method=='POST':
            require(set(body)=={'password'})
            cur.execute('UPDATE lele.users SET password_hash=%s,must_change_password=true WHERE id=%s',(PASSWORDS.hash(password_value(body['password'])),target))
        else: raise ApiError(404,'接口不存在。')
        cur.execute('DELETE FROM lele.sessions WHERE user_id=%s',(target,))
        self.audit(cur,user[0],'admin.'+parts[3],detail={'userId':target})
        return {'ok':True}

    def create_child(self,cur,user_id,name,record=None):
        from business_operations import default_data
        name=text_value(name)
        child=identity(); member=identity()
        cur.execute('INSERT INTO lele.children(id,name,owner_id) VALUES(%s,%s,%s)',(child,name,user_id))
        cur.execute('INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES(%s,%s,%s)',(child,user_id,member))
        record=record or dict(format=STORE_FORMAT,version=STORE_VERSION,revision=0,updatedAt=now_iso(),data=default_data(name))
        validate_record(record)
        self.store.replace(cur,child,record['data']); self.store.metadata(cur,child,record,insert=True)
        self.audit(cur,user_id,'child.create',child)
        return dict(id=child,name=name,ownerId=user_id,role='owner',archived=False,membershipVersion=member)

    def parent(self,cur,user,method,path,body):
        if path=='children' and method=='GET':
            cur.execute('SELECT c.id,c.name,c.owner_id,c.archived,m.membership_version FROM lele.children c JOIN lele.memberships m ON m.child_id=c.id WHERE m.user_id=%s ORDER BY c.created_at,c.id',(user[0],))
            return {'children':[self.child_public(r,user[0]) for r in cur.fetchall()]}
        if path=='children' and method=='POST':
            require(set(body)=={'name'})
            return {'child':self.create_child(cur,user[0],body['name'])}
        if path=='invitations' and method=='GET':
            cur.execute("SELECT i.id,i.child_id,c.name,i.created_by,i.expires_at FROM lele.invitations i JOIN lele.children c ON c.id=i.child_id WHERE i.target_id=%s AND i.status='pending' AND i.expires_at>now() ORDER BY i.created_at",(user[0],))
            return {'invitations':[dict(id=r[0],childId=r[1],childName=r[2],createdBy=r[3],expiresAt=r[4].isoformat()) for r in cur.fetchall()]}
        parts=path.split('/')
        if len(parts)==3 and parts[0]=='invitations' and method=='POST':
            return self.answer_invitation(cur,user,parts[1],parts[2],body)
        require(len(parts)>=2 and parts[0]=='children',404,'接口不存在。')
        child_id=parts[1]; suffix='/'.join(parts[2:])
        if suffix=='':
            require(method=='PATCH' and len(body)==1 and set(body)<= {'name','archived'},404,'接口不存在。')
            child=self.access(cur,user,child_id,owner=True,write=True,allow_archived=body=={'archived':False})
            if 'name' in body:
                name=text_value(body['name'])
                current=self.store.read(cur,child_id,locked=True)
                data=copy.deepcopy(current['data']); data['settings']['childName']=name
                self.save(cur,child_id,current,data)
                cur.execute('UPDATE lele.children SET name=%s WHERE id=%s',(name,child_id))
            else:
                require(type(body['archived']) is bool)
                cur.execute('UPDATE lele.children SET archived=%s WHERE id=%s',(body['archived'],child_id))
            self.audit(cur,user[0],'child.update',child_id,body)
            return {'ok':True}
        if suffix=='transfer' and method=='POST':
            require(set(body)=={'userId'} and isinstance(body['userId'],str) and len(body['userId']) <= 100)
            self.access(cur,user,child_id,owner=True,write=True)
            cur.execute("SELECT m.user_id FROM lele.memberships m JOIN lele.users u ON u.id=m.user_id WHERE m.child_id=%s AND m.user_id=%s AND u.status='active'",(child_id,body['userId']))
            require(cur.fetchone() is not None,400,'新负责人必须是有效的共同管理家长。')
            cur.execute('UPDATE lele.children SET owner_id=%s WHERE id=%s',(body['userId'],child_id))
            self.audit(cur,user[0],'child.transfer',child_id,body)
            return {'ok':True}
        if suffix=='members' and method=='GET':
            child=self.access(cur,user,child_id)
            cur.execute('SELECT u.id,u.login_name,u.nickname FROM lele.memberships m JOIN lele.users u ON u.id=m.user_id WHERE m.child_id=%s ORDER BY m.created_at',(child_id,))
            return {'members':[dict(userId=r[0],loginName=r[1],nickname=r[2],role='owner' if r[0]==child[2] else 'parent') for r in cur.fetchall()]}
        if len(parts)==4 and parts[2]=='members' and method=='DELETE':
            leaving_self=parts[3]==user[0]
            child=self.access(cur,user,child_id,owner=not leaving_self,write=not leaving_self)
            require(parts[3]!=child[2],400,'负责人需要先转移拥有权，再退出家庭。')
            cur.execute('DELETE FROM lele.memberships WHERE child_id=%s AND user_id=%s',(child_id,parts[3]))
            require(cur.rowcount==1,404,'成员不存在。')
            self.audit(cur,user[0],'member.leave' if leaving_self else 'member.remove',child_id,{'userId':parts[3]})
            return {'ok':True}
        if suffix=='invitations' or len(parts)==4 and parts[2]=='invitations':
            return self.manage_invitation(cur,user,child_id,parts,method,body)
        if suffix=='context' and method=='GET':
            child=self.access(cur,user,child_id)
            cur.execute('SELECT revision FROM lele.app_metadata WHERE child_id=%s AND id=1',(child_id,))
            metadata=cur.fetchone()
            require(metadata is not None,503,'孩子数据尚未准备好。')
            return {'child':self.child_public(child,user[0]),'revision':metadata[0]}
        if suffix in ('data','data/export') and method=='GET':
            child=self.access(cur,user,child_id)
            record=self.store.read(cur,child_id)
            if suffix=='data/export': return record
            return {**record,'context':dict(childId=child_id,membershipVersion=child[4])}
        if suffix in ('operations','data/restore') and method=='POST':
            return self.operation(cur,user,child_id,body,restore=suffix=='data/restore')
        raise ApiError(404,'接口不存在。')

    def manage_invitation(self,cur,user,child_id,parts,method,body):
        self.access(cur,user,child_id,owner=True,write=method!='GET')
        if method=='GET' and len(parts)==3:
            cur.execute("SELECT i.id,i.target_id,u.login_name,u.nickname,i.status,i.expires_at FROM lele.invitations i JOIN lele.users u ON u.id=i.target_id WHERE i.child_id=%s ORDER BY i.created_at DESC",(child_id,))
            return {'invitations':[dict(id=r[0],userId=r[1],loginName=r[2],nickname=r[3],status=r[4] if r[5]>datetime.now(timezone.utc) or r[4]!='pending' else 'expired',expiresAt=r[5].isoformat()) for r in cur.fetchall()]}
        if method=='POST' and len(parts)==3:
            require(set(body)=={'loginName'})
            cur.execute("SELECT id FROM lele.users WHERE login_name=%s AND role='parent' AND status IN ('pending','active')",(login_value(body['loginName']),))
            target=cur.fetchone(); require(target is not None,404,'未找到可邀请的账号。')
            cur.execute('SELECT 1 FROM lele.memberships WHERE child_id=%s AND user_id=%s',(child_id,target[0]))
            require(cur.fetchone() is None,409,'此账号已是共同管理家长。')
            cur.execute("UPDATE lele.invitations SET status='revoked' WHERE child_id=%s AND target_id=%s AND status='pending' AND expires_at<=now()",(child_id,target[0]))
            invite=identity()
            cur.execute("INSERT INTO lele.invitations(id,child_id,target_id,created_by,status) VALUES(%s,%s,%s,%s,'pending') RETURNING expires_at",(invite,child_id,target[0],user[0]))
            expires=cur.fetchone()[0].isoformat(); self.audit(cur,user[0],'invitation.create',child_id,{'invitationId':invite,'targetId':target[0]})
            return {'invitation':dict(id=invite,childId=child_id,userId=target[0],expiresAt=expires,status='pending')}
        if method=='DELETE' and len(parts)==4:
            cur.execute("UPDATE lele.invitations SET status='revoked' WHERE id=%s AND child_id=%s AND status='pending'",(parts[3],child_id))
            require(cur.rowcount==1,409,'邀请已处理或不存在。')
            self.audit(cur,user[0],'invitation.revoke',child_id,{'invitationId':parts[3]})
            return {'ok':True}
        raise ApiError(404,'接口不存在。')

    def answer_invitation(self,cur,user,invite,answer,body):
        require(answer in ('accept','reject') and not body,404,'接口不存在。')
        cur.execute('SELECT child_id FROM lele.invitations WHERE id=%s AND target_id=%s',(invite,user[0]))
        row=cur.fetchone(); require(row is not None,404,'邀请不存在。')
        child_id=row[0]; self.lock_child(cur,child_id)
        cur.execute("SELECT c.archived,i.status,i.expires_at>now() FROM lele.invitations i JOIN lele.children c ON c.id=i.child_id WHERE i.id=%s AND i.target_id=%s FOR UPDATE OF i,c",(invite,user[0]))
        row=cur.fetchone()
        require(row and row[1]=='pending' and row[2],409,'邀请已过期或已处理。')
        require(not row[0],409,'孩子已归档，暂不能处理邀请。','archived')
        if answer=='accept':
            cur.execute('INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES(%s,%s,%s)',(child_id,user[0],identity()))
        cur.execute('UPDATE lele.invitations SET status=%s WHERE id=%s',('accepted' if answer=='accept' else 'rejected',invite))
        self.audit(cur,user[0],'invitation.'+answer,child_id,{'invitationId':invite})
        return {'ok':True,'childId':child_id}

    def save(self,cur,child,current,data):
        validate_data(data)
        updated={**current,'data':data,'revision':current['revision']+1,'updatedAt':now_iso()}
        cur.execute('INSERT INTO lele.data_snapshots(child_id,revision,captured_at,snapshot_json,content_sha256) VALUES(%s,%s,now(),%s,%s)',(child,current['revision'],Jsonb(current),canonical_sha256(current)))
        self.store.replace(cur,child,data); self.store.metadata(cur,child,updated)
        cur.execute('DELETE FROM lele.data_snapshots WHERE child_id=%s AND id NOT IN (SELECT id FROM lele.data_snapshots WHERE child_id=%s ORDER BY captured_at DESC,id DESC LIMIT %s)',(child,child,BACKUP_LIMIT))
        return updated

    def operation(self,cur,user,child_id,body,restore=False):
        from business_operations import apply_operation
        fields={'expectedRevision','membershipVersion','operationId','data'} if restore else {'expectedRevision','membershipVersion','operationId','kind','payload'}
        require(set(body)==fields)
        require(type(body['expectedRevision']) is int and body['expectedRevision']>=0)
        require(isinstance(body['operationId'],str) and bool(re.fullmatch(r'[A-Za-z0-9._:-]{8,100}',body['operationId'])))
        child=self.access(cur,user,child_id,owner=restore,write=True)
        require(body['membershipVersion']==child[4],409,'管理权限已更新，请重新打开孩子。','membership_changed')
        request_hash=canonical_sha256(body)
        cur.execute('SELECT actor_id,membership_version,payload_sha256 FROM lele.idempotency_records WHERE child_id=%s AND operation_id=%s',(child_id,body['operationId']))
        previous=cur.fetchone()
        current=self.store.read(cur,child_id,locked=True)
        if previous:
            require(previous==(user[0],child[4],request_hash),409,'操作编号已被其他请求使用。','operation_conflict')
            return {**current,'context':dict(childId=child_id,membershipVersion=child[4])}
        require(current['revision']==body['expectedRevision'],409,'数据已更新，请刷新后重试。','revision_conflict')
        if restore:
            data=copy.deepcopy(body['data'])
            require(isinstance(data,dict) and isinstance(data.get('settings'),dict))
            data['settings']['childName']=child[1]
            # A backup is a business document, never an account/permission payload.
            require(not set(data)&{'users','children','memberships','invitations','sessions','context'})
            validate_data(data)
        else:
            require(isinstance(body['kind'],str) and isinstance(body['payload'],dict))
            data=apply_operation(copy.deepcopy(current['data']),body['kind'],body['payload'],actor_id=user[0],revision=current['revision']+1,now=now_iso())
            stored_name=data['settings'].get('childName')
            require(isinstance(stored_name,str) and stored_name.strip()==child[1],400,'孩子名称请通过资料设置修改。')
        updated=self.save(cur,child_id,current,data)
        cur.execute('INSERT INTO lele.idempotency_records(child_id,operation_id,actor_id,membership_version,payload_sha256,result_revision) VALUES(%s,%s,%s,%s,%s,%s)',(child_id,body['operationId'],user[0],child[4],request_hash,updated['revision']))
        self.audit(cur,user[0],'data.restore' if restore else 'operation.'+body['kind'],child_id,{'operationId':body['operationId'],'revision':updated['revision']})
        return {**updated,'context':dict(childId=child_id,membershipVersion=child[4])}


def initialize(config_path):
    service=ChildService(config_path)
    require(service.config['environment']=='development',403,'此初始化工具仅允许本地开发环境。')
    source=Path(__file__).with_name('db').joinpath('schema_v2.sql').read_text()
    source_hash=hashlib.sha256(source.encode()).hexdigest()
    def run(cur):
        cur.execute("SELECT obj_description(oid,'pg_namespace') FROM pg_namespace WHERE nspname='lele'")
        namespace=cur.fetchone()
        if namespace:
            marker=f'lele-schema-v2:{source_hash}:{PostgresStore._catalog(cur)}'
            require(namespace[0]==marker,409,'检测到未知或旧版结构，初始化停止。请使用独立开发数据库。')
            return {'initialized':False,'version':2}
        cur.execute(source)
        marker=f'lele-schema-v2:{source_hash}:{PostgresStore._catalog(cur)}'
        cur.execute(psycopg.sql.SQL('COMMENT ON SCHEMA lele IS {}').format(psycopg.sql.Literal(marker)))
        return {'initialized':True,'version':2}
    return service.transaction(run,exclusive=True,schema_check=False)


def bootstrap(config_path,login_name,nickname,password):
    service=ChildService(config_path)
    require(service.config['environment']=='development',403,'引导工具仅允许本地开发环境。')
    def run(cur):
        cur.execute('SELECT EXISTS(SELECT 1 FROM lele.users)')
        require(not cur.fetchone()[0],409,'已有账号，不能重复引导管理员。')
        uid=identity()
        cur.execute("INSERT INTO lele.users(id,login_name,nickname,password_hash,role,status) VALUES(%s,%s,%s,%s,'admin','active') RETURNING "+USER_COLUMNS,(uid,login_value(login_name),text_value(nickname),PASSWORDS.hash(password_value(password))))
        result=public_user(cur.fetchone()); service.audit(cur,uid,'bootstrap.admin')
        return result
    return service.transaction(run,exclusive=True)


def import_child(config_path,owner_id,record):
    """Import an immutable local v1 JSON copy into a NEW child, preserving revision.

    This deliberately does not connect to, migrate, or mutate a production v1 DB.
    Repeating an already imported file is rejected by its canonical source hash.
    """
    service=ChildService(config_path)
    require(service.config['environment']=='development',403,'导入工具仅允许本地开发环境。')
    validate_record(record)
    source_hash=canonical_sha256(record)
    def run(cur):
        cur.execute("SELECT id FROM lele.users WHERE id=%s AND role='parent' AND status='active'",(owner_id,))
        require(cur.fetchone() is not None,400,'导入负责人必须是有效家长账号。')
        cur.execute('SELECT 1 FROM lele.migration_runs WHERE source_sha256=%s',(source_hash,))
        require(cur.fetchone() is None,409,'此备份已经导入。')
        child=service.create_child(cur,owner_id,record['data']['settings']['childName'],copy.deepcopy(record))
        rebuilt=service.store.read(cur,child['id'])
        require(canonical_bytes(record)==canonical_bytes(rebuilt),409,'导入后内容校验不一致，已回滚。')
        cur.execute('INSERT INTO lele.migration_runs(child_id,source_sha256,source_revision,source_updated_at_raw,target_revision,migrated_at,entity_counts,business_sha256,db_schema_version) VALUES(%s,%s,%s,%s,%s,now(),%s,%s,2)',(child['id'],source_hash,record['revision'],record['updatedAt'],record['revision'],Jsonb(PostgresStore._counts(record['data'])),canonical_sha256(record['data'])))
        service.audit(cur,owner_id,'migration.import',child['id'],{'sourceSha256':source_hash,'sourceRevision':record['revision']})
        return child
    return service.transaction(run,exclusive=True)


def main():
    """Local-only operator CLI; passwords are read without echo, never argv/logged."""
    import argparse
    import getpass
    parser=argparse.ArgumentParser(description='本地账号数据库初始化与备份导入；不支持生产数据库。')
    parser.add_argument('--config',required=True)
    commands=parser.add_subparsers(dest='command',required=True)
    commands.add_parser('initialize')
    admin=commands.add_parser('bootstrap')
    admin.add_argument('--login-name',required=True)
    admin.add_argument('--nickname',required=True)
    migration=commands.add_parser('import-child')
    migration.add_argument('--owner-id',required=True)
    migration.add_argument('--source',required=True)
    args=parser.parse_args()
    try:
        if args.command=='initialize':
            result=initialize(args.config)
        elif args.command=='bootstrap':
            password=getpass.getpass('初始管理员密码（15–128 字符）：')
            require(password==getpass.getpass('再次输入密码：'),400,'两次密码不一致。')
            result=bootstrap(args.config,args.login_name,args.nickname,password)
        else:
            record=json.loads(Path(args.source).read_text())
            result=import_child(args.config,args.owner_id,record)
        print(json.dumps(result,ensure_ascii=False))
    except (ApiError,StoreError) as error:
        parser.exit(1,str(error)+'\n')


if __name__=='__main__':
    main()

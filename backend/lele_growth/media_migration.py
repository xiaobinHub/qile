"""Explicit, resumable development-only migration and conservative staged cleanup.

Defaults to a read-only scan. Original content is backed up OUTSIDE PostgreSQL.
Never deploys, operates production, or rewrites request idempotency fingerprints.
"""
import argparse
import copy
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
from lele_growth.child_service import ChildService, require, ApiError
from lele_growth.media_types import inline_fields, decode_image, transform_images, referenced_assets
from lele_growth.postgres_store import canonical_sha256
from lele_growth.storage import StoreError


def columns(cur):
    cur.execute("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='lele' AND data_type IN ('json','jsonb') AND is_generated='NEVER' ORDER BY table_name,ordinal_position")
    found=cur.fetchall()
    result=[]
    for table,column in found:
        cur.execute("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=%s::regclass AND i.indisprimary ORDER BY array_position(i.indkey,a.attnum)",('lele.'+table,))
        pk=[r[0] for r in cur.fetchall()]
        require(bool(pk),409,'JSON 表缺少主键，迁移停止。')
        cur.execute("SELECT 1 FROM information_schema.columns WHERE table_schema='lele' AND table_name=%s AND column_name='child_id'",(table,))
        result.append((table,column,pk,bool(cur.fetchone())))
    return result


def rows(cur):
    result=[]
    for table,column,pk,has_child in columns(cur):
        names=list(dict.fromkeys([*pk,*(['child_id'] if has_child else []),*(['content_sha256'] if table=='data_snapshots' and column=='snapshot_json' else []),column]))
        cur.execute(sql.SQL('SELECT {} FROM lele.{}').format(sql.SQL(',').join(map(sql.Identifier,names)),sql.Identifier(table)))
        for row in cur.fetchall():
            record=dict(zip(names,row)); value=record[column]
            if table=='data_snapshots' and column=='snapshot_json':
                require(record['content_sha256']==canonical_sha256(value),409,'历史快照摘要不一致，迁移停止。')
            # Include empty imageData keys so migration removes placeholders as well.
            if transform_images(value,lambda image:'scan')==value: continue
            child=record.get('child_id')
            require(child is not None,409,'发现无法确定所属孩子的图片字段，迁移停止。')
            result.append({'table':table,'column':column,'pk':{key:record[key] for key in pk},'child':child,'value':value,'sha256':canonical_sha256(value)})
    return result


def summary(entries):
    images=[(e['child'],decode_image(v)) for e in entries for v in inline_fields(e['value'])]
    return {'jsonFields':len(entries),'embeddedImages':len(images),'embeddedBytes':sum(len(v.encode()) for e in entries for v in inline_fields(e['value'])),
            'uniqueObjects':len({(child,image.sha256) for child,image in images}),'children':len({e['child'] for e in entries})}


def private_json(path,value):
    # O_EXCL prevents accidentally overwriting an earlier protected backup/manifest.
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:
        json.dump(value,f,ensure_ascii=False,indent=2)


def snapshot(cur):
    cur.execute("SELECT tablename FROM pg_tables WHERE schemaname='lele' ORDER BY tablename")
    tables=[r[0] for r in cur.fetchall()]
    backup={}
    for table in tables:
        cur.execute(sql.SQL('SELECT to_jsonb(t) FROM lele.{} t').format(sql.Identifier(table)))
        backup[table]=[r[0] for r in cur.fetchall()]
    return backup


def migrate(config_path,*,apply=False,backup_dir=None):
    s=ChildService(config_path)
    require(s.config['environment']=='development',403,'此迁移工具只允许本地开发及隔离测试库。')
    entries=s.transaction(rows,schema_check=apply)
    before=summary(entries)
    if not apply: return {'dryRun':True,**before}
    require(backup_dir is not None,400,'必须指定数据库外的私有备份目录。')
    root=Path(backup_dir).resolve();root.mkdir(parents=True,exist_ok=True,mode=0o700)
    require(not root.stat().st_mode & 0o077,400,'备份目录必须仅当前用户可访问。')
    run=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+uuid.uuid4().hex[:8]
    # Snapshot and source candidates are captured under one exclusive account gate.
    def capture(cur):
        candidates=rows(cur)
        return candidates,snapshot(cur)
    entries,backup=s.transaction(capture,exclusive=True)
    before=summary(entries)
    private_json(root/(run+'-database.json'),{'database':s.config['_connect']['dbname'],'tables':backup})
    private_json(root/(run+'-source.json'),entries)
    manifest=[]
    grouped=defaultdict(list)
    for entry in entries: grouped[entry['child']].append(entry)
    for child,items in grouped.items():
        images={}
        for entry in items:
            for value in inline_fields(entry['value']):
                image=decode_image(value);images[image.sha256]=image
        assets={sha:str(uuid.uuid5(uuid.NAMESPACE_URL,'lele-media:'+child+':'+sha)) for sha in images}
        for sha,image in images.items():
            # No DB locks are held during verified object upload.
            s.media.objects.put(s.media.objects.key(child,image),image)
        def commit(cur):
            s.lock_child(cur,child)
            cur.execute('SELECT c.owner_id,m.membership_version FROM lele.children c LEFT JOIN lele.memberships m ON c.id=m.child_id AND c.owner_id=m.user_id WHERE c.id=%s',(child,))
            owner=cur.fetchone();require(owner and owner[1],409,'孩子元数据异常，迁移停止。')
            changes=[]
            for entry in items:
                where=sql.SQL(' AND ').join(sql.SQL('{}=%s').format(sql.Identifier(k)) for k in entry['pk'])
                cur.execute(sql.SQL('SELECT {} FROM lele.{} WHERE {} FOR UPDATE').format(sql.Identifier(entry['column']),sql.Identifier(entry['table']),where),tuple(entry['pk'].values()))
                row=cur.fetchone();require(row and canonical_sha256(row[0])==entry['sha256'],409,'迁移期间数据发生变化，原记录保留；请重新运行。')
                value=transform_images(entry['value'],lambda image:assets[image.sha256])
                changes.append((entry,value,where))
            for sha,image in images.items():
                cur.execute("INSERT INTO lele.media_assets(id,child_id,uploaded_by,upload_id,membership_version,object_key,content_sha256,mime_type,byte_size,width,height,state,attached_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'attached',now()) ON CONFLICT(id) DO NOTHING",(assets[sha],child,owner[0],'migration:'+sha,owner[1],s.media.objects.key(child,image),sha,image.mime,len(image.content),image.width,image.height))
                cur.execute("SELECT child_id,content_sha256,object_key,state FROM lele.media_assets WHERE id=%s",(assets[sha],))
                require(cur.fetchone()==(child,sha,s.media.objects.key(child,image),'attached'),409,'迁移文件元数据不一致，停止。')
            for entry,value,where in changes:
                sets=sql.SQL('{}=%s').format(sql.Identifier(entry['column']))
                params=[Jsonb(value)]
                if entry['table']=='data_snapshots' and entry['column']=='snapshot_json':
                    sets+=sql.SQL(', content_sha256=%s');params.append(canonical_sha256(value))
                cur.execute(sql.SQL('UPDATE lele.{} SET {} WHERE {}').format(sql.Identifier(entry['table']),sets,where),(*params,*entry['pk'].values()))
            if changes: s.audit(cur,owner[0],'media.migrate',child,{'fields':len(changes),'objects':len(images),'run':run})
            return [{k:v for k,v in entry.items() if k!='value'}|{'newSha256':canonical_sha256(value)} for entry,value,_ in changes]
        manifest.extend(s.transaction(commit))
        private_json(root/(run+'-'+child+'-manifest.json'),manifest[-len(items):])
    residual=s.transaction(rows)
    after=summary(residual)
    require(after['embeddedImages']==0 and after['jsonFields']==0,409,'数据库仍有内嵌图片字段，迁移未完成。')
    result={'complete':True,'before':before,'after':after,'run':run,'backupDirectory':str(root),'changedFields':len(manifest)}
    private_json(root/(run+'-result.json'),result)
    return result


def cleanup(config_path,*,apply=False):
    s=ChildService(config_path)
    require(s.config['environment']=='development',403,'此清理工具仅允许本地开发环境。')
    # One session lock spans external I/O, without holding business transactions.
    # It prevents another cleaner from completing a tombstone while this cleaner
    # still has an in-flight DELETE for the same immutable object key.
    with psycopg.connect(**s.config['_connect'],autocommit=True) as maintenance:
        require(maintenance.execute('SELECT pg_try_advisory_lock(1818586213,5)').fetchone()[0],409,'图片清理正在进行，请稍后重试。')
        try:
            return _cleanup(s,apply=apply)
        finally:
            maintenance.execute('SELECT pg_advisory_unlock(1818586213,5)')


def _cleanup(s,*,apply):
    def candidates(cur):
        cur.execute("SELECT DISTINCT child_id FROM lele.media_assets WHERE (state IN ('uploading','staged','failed') AND created_at<now()-interval '24 hours') OR (state='deleted' AND lease_token IS NOT NULL) ORDER BY child_id")
        return [r[0] for r in cur.fetchall()]
    deleted=[]
    for child in s.transaction(candidates):
        def reserve(cur):
            s.lock_child(cur,child)
            refs=set()
            for table,column,pk,has_child in columns(cur):
                query=sql.SQL('SELECT {} FROM lele.{}').format(sql.Identifier(column),sql.Identifier(table))
                if has_child: query+=sql.SQL(' WHERE child_id=%s')
                cur.execute(query,(child,) if has_child else ())
                for (value,) in cur.fetchall(): refs.update(referenced_assets(value))
            cur.execute("SELECT id,object_key,state,created_at<now()-interval '24 hours',coalesce(lease_until>now(),false),lease_token FROM lele.media_assets WHERE child_id=%s FOR UPDATE",(child,))
            by_key=defaultdict(list)
            for row in cur.fetchall(): by_key[row[1]].append(row)
            jobs=[]
            for key,records in by_key.items():
                active=[r for r in records if r[2]!='deleted']
                pending=[r for r in records if r[2]=='deleted' and r[5] is not None]
                if not active and not pending: continue
                if any(r[0] in refs or r[2]=='attached' for r in records): continue
                if any(not r[3] or r[4] for r in active): continue
                token='cleanup:'+uuid.uuid4().hex
                if apply:
                    # Commit unavailability BEFORE irreversible object deletion.
                    cur.execute("UPDATE lele.media_assets SET state='deleted',lease_token=%s,lease_until=NULL WHERE child_id=%s AND object_key=%s",(token,child,key))
                jobs.append((key,token,[r[0] for r in active+pending]))
            return jobs
        jobs=s.transaction(reserve)
        for key,token,ids in jobs:
            if apply:
                s.media.objects.delete(key)
                # Failure here leaves a durable, non-attachable tombstone. A later
                # run repeats idempotent DELETE; it never revives staged metadata.
                s.transaction(lambda cur:cur.execute("UPDATE lele.media_assets SET lease_token=NULL,lease_until=NULL WHERE child_id=%s AND object_key=%s AND state='deleted' AND lease_token=%s",(child,key,token)))
            deleted.extend(ids)
    return {'dryRun':not apply,'assets':len(deleted)}


def main():
    parser=argparse.ArgumentParser(description='本地私有图片迁移；默认只扫描，生产环境禁止执行。')
    parser.add_argument('--config',required=True)
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--backup-dir')
    parser.add_argument('--cleanup-staged',action='store_true')
    args=parser.parse_args()
    try:
        result=cleanup(args.config,apply=args.apply) if args.cleanup_staged else migrate(args.config,apply=args.apply,backup_dir=args.backup_dir)
        print(json.dumps(result,ensure_ascii=False))
    except (ApiError,StoreError) as error: parser.exit(1,str(error)+'\n')

if __name__=='__main__': main()

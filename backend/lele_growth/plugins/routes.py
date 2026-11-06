"""Authenticated API adapter. ChildService owns session/surface/origin/CSRF checks."""
from urllib.parse import urlsplit, parse_qs

from lele_growth.child_service import require
from lele_growth.maintenance import PLUGIN_SCHEMA_VERSION
from . import catalog, installations
from .child_picker import list_plugin_children
from .manifest import safe_relative_path
from .frontend_protocol import require_frontend
from .policy import active_context, catalog_row, rows_dict


class PluginRoutes:
    def __init__(self, service):
        self.service=service

    def handle(self, cur, user, method, path, body, *, frontend_api=None):
        url=urlsplit(path)
        path=url.path.removeprefix('/api/').strip('/')
        parts=path.split('/')
        admin=path=='admin/plugin-children' or parts[:2]==['admin','plugins']
        child=len(parts)>=3 and parts[0]=='children' and parts[2]=='plugins'
        if not admin and not child:
            return NotImplemented
        # Runtime invocation is handled outside this short database transaction.
        if child and len(parts)>=5 and parts[4]=='runtime':
            return NotImplemented
        cur.execute("SELECT to_regclass('lele.plugin_platform_versions') IS NOT NULL")
        require(cur.fetchone()[0],503,'插件平台尚未完成显式数据库维护。','plugin_schema_unavailable')
        cur.execute('SELECT max(version) FROM lele.plugin_platform_versions')
        require(cur.fetchone()[0] == PLUGIN_SCHEMA_VERSION,503,'插件平台需要完成增量数据库维护。','plugin_schema_unavailable')
        query={key:values[-1] for key,values in parse_qs(url.query).items()}
        if method=='GET':
            require(set(body)<={'q','view','cursor'},400,'查询字段不正确。')
            query.update(body)
            require(all(isinstance(value,str) and len(value)<=512 for value in query.values()),400,'查询值不正确。')
        if admin:
            require(user[3]=='admin',403,'需要管理员权限。')
            return self.admin(cur,user,method,parts,body,query)
        require(user[3]=='parent',403,'管理员不能访问孩子业务数据。')
        child_id=parts[1]
        if len(parts)==3 or len(parts)==4 and parts[3]=='status':
            require(method=='GET',405,'接口不支持此操作。')
            # A catalog lock must precede existing service.access child locks.
            cur.execute('SELECT id FROM lele.plugin_catalog ORDER BY id FOR SHARE')
            cur.fetchall()
            self.service.access(cur,user,child_id)
            view='status' if len(parts)==4 else query.get('view','available')
            return {'plugins':installations.list_child(cur,child_id,view=view,query=query.get('q',''))}
        require(len(parts)==5,404,'接口不存在。')
        plugin_id,action=parts[3:]
        require(action in ('install','enable','disable','installation','config','entry'),404,'接口不存在。')
        write=method!='GET'
        catalog_row(cur,plugin_id,lock='UPDATE' if write else 'SHARE')
        self.service.access(cur,user,child_id,owner=write,write=write,
                            allow_archived=action in ('disable','installation'))
        if method=='GET' and action=='config':
            return installations.get_config(cur,plugin_id,child_id)
        if method=='PUT' and action=='config':
            result=installations.put_config(cur,plugin_id,child_id,user[0],body)
            self.service.audit(cur,user[0],'plugin.config',child_id,{'pluginId':plugin_id,'configRevision':result['revision']})
            return result
        if method=='GET' and action=='entry':
            context=active_context(cur,plugin_id,child_id)
            require(context['type']=='page',409,'后台型应用没有页面入口。','plugin_no_page')
            require_frontend(context['manifest'], frontend_api)
            frontend=context['manifest']['frontend']
            prefix='/plugin-assets/'+plugin_id+'/'+context['version']+'/'
            return dict(entry=prefix+safe_relative_path(frontend['entry']),styles=[prefix+safe_relative_path(s) for s in frontend.get('styles',[])],releaseId=context['release_id'],version=context['version'],frontendApi=context['manifest']['frontendApi'])
        if method=='POST' and action in ('install','enable','disable') or method=='DELETE' and action=='installation':
            performed='uninstall' if action=='installation' else action
            result=installations.mutate_installation(cur,plugin_id,child_id,user[0],performed,body)
            if plugin_id=='mison-booking' and performed in ('disable','uninstall'):
                from lele_growth.course_sync_host import purge_saved
                purge_saved(self.service,cur,child_id,user[0])
            self.service.audit(cur,user[0],'plugin.'+action,child_id,{'pluginId':plugin_id,'revision':result['plugin']['revision']})
            return result
        require(False,405,'接口不支持此操作。')

    def admin(self, cur, user, method, parts, body, query):
        if parts==['admin','plugin-children']:
            require(method=='GET',405,'接口不支持此操作。')
            search=query.get('q',''); require(isinstance(search,str) and len(search)<=200)
            return list_plugin_children(cur, search, query.get('cursor', ''))
        if len(parts)==2:
            require(method=='GET',405,'接口不支持此操作。')
            return {'plugins':catalog.list_admin(cur,query.get('q',''))}
        plugin_id=parts[2]
        if len(parts)==3:
            require(method=='PATCH',405,'接口不支持此操作。')
            result=catalog.update_metadata(cur,plugin_id,body)
            action='metadata'
        else:
            require(len(parts)==4,404,'接口不存在。')
            action=parts[3]
            if method=='GET' and action=='deployments':
                catalog_row(cur,plugin_id)
                cur.execute('SELECT d.*,r.version AS version,old.version AS old_version FROM lele.plugin_deployments d LEFT JOIN lele.plugin_releases r ON r.release_id=d.new_release_id LEFT JOIN lele.plugin_releases old ON old.release_id=d.old_release_id WHERE d.plugin_id=%s ORDER BY d.created_at DESC,d.id LIMIT 100',(plugin_id,))
                records=rows_dict(cur)
                # JSON-ready without exposing internal lease owner or operational paths.
                return {'deployments':[dict(id=d['id'],pluginId=d['plugin_id'],version=d['version'],oldVersion=d['old_version'],phase=d['phase'],status=d['status'],createdAt=d['created_at'].isoformat(),updatedAt=d['updated_at'].isoformat(),errorCode=d['error_code']) for d in records]}
            if method=='POST' and action in ('publish','unpublish'):
                require(set(body)=={'expectedRevision'})
                result=catalog.set_publication(cur,plugin_id,action=='publish',body['expectedRevision'])
            elif method=='PUT' and action=='scope':
                result=catalog.set_scope(cur,plugin_id,body)
            else:
                require(False,405,'接口不支持此操作。')
        self.service.audit(cur,user[0],'admin.plugin.'+action,detail={'pluginId':plugin_id,'revision':result['revision'],'publicationStatus':result['publicationStatus'],'scopeMode':result['scopeMode']})
        return {'plugin':result}

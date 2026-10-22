"""Child-authorized image lifecycle. Object I/O runs outside request transactions."""
import copy
import hmac
import re
from http import HTTPStatus
from lele_growth.child_service import ApiError, require, digest, identity
from lele_growth.media_types import ImageResponse, inspect_image, inline_fields, referenced_assets, image_url
from lele_growth.storage import StoreError
from lele_growth.upload_guard import UPLOAD_GUARD

UPLOAD_ID = re.compile(r'[A-Za-z0-9._:-]{8,100}\Z')


class MediaService:
    def __init__(self, service, objects):
        self.service, self.objects = service, objects
        self.upload_guard = UPLOAD_GUARD

    def auth(self, cur, child, token, csrf=None, origin=None, *, write=False, member=None, owner=False):
        s = self.service
        if write:
            require(s.origin_trusted(origin,'parent'),403,'请求来源不受信任。')
        user = s.authenticate(cur,token,'parent')
        require(not user[5],403,'请先修改初始密码。','password_change_required')
        if write:
            require(isinstance(csrf,str) and hmac.compare_digest(digest(csrf),user[7]),403,'请求校验失败，请刷新页面。')
        context = s.access(cur,user,child,write=write,owner=owner)
        if write:
            require(member==context[4],409,'管理权限已更新，请重新打开孩子。','membership_changed')
        return user,context

    @staticmethod
    def require_external(data):
        require(not any(inline_fields(data)),503,'图片尚未完成文件存储迁移，请先完成核验。')
        # No empty placeholders or derived response URLs persist either.
        def check(node):
            if isinstance(node,dict):
                require('imageData' not in node and 'imageUrl' not in node,400,'请使用已上传的图片引用。')
                for item in node.values(): check(item)
            elif isinstance(node,list):
                for item in node: check(item)
        check(data)

    def route(self,method,path,body,token,csrf,origin,surface):
        if surface!='parent': return NotImplemented
        match=re.fullmatch(r'children/([^/]+)/assets/([^/]+)',path)
        if method=='GET' and match:
            return self.read_asset(match[1],match[2],token)
        match=re.fullmatch(r'children/([^/]+)/assets/uploads/([^/]+)',path)
        if method=='GET' and match:
            return self.status(match[1],match[2],token)
        return NotImplemented

    def upload(self,child,content,mime,upload_id,member,token,csrf,origin):
        require(isinstance(upload_id,str) and UPLOAD_ID.fullmatch(upload_id),400,'上传编号不正确。')
        user,_=self.service.transaction(lambda cur:self.auth(cur,child,token,csrf,origin,write=True,member=member))
        with self.upload_guard.acquire(user[0]):
            return self._upload(child,content,mime,upload_id,member,token,csrf,origin)

    def _upload(self,child,content,mime,upload_id,member,token,csrf,origin):
        image=inspect_image(content,mime)
        key=self.objects.key(child,image)
        lease=identity()
        def begin(cur):
            user,context=self.auth(cur,child,token,csrf,origin,write=True,member=member)
            cur.execute("SELECT 1 FROM lele.media_assets WHERE child_id=%s AND object_key=%s AND state='deleted' AND lease_token IS NOT NULL LIMIT 1",(child,key))
            require(cur.fetchone() is None,409,'图片正在清理，请稍后重试原上传。','asset_cleanup')
            cur.execute('SELECT id,content_sha256,state,lease_until>now(),membership_version FROM lele.media_assets WHERE child_id=%s AND uploaded_by=%s AND upload_id=%s FOR UPDATE',(child,user[0],upload_id))
            row=cur.fetchone()
            if row:
                require(row[1]==image.sha256 and row[4]==context[4],409,'此上传编号已用于其他图片或权限版本。')
                if row[2] in ('staged','attached'): return {'assetId':row[0],'status':row[2],'imageUrl':image_url(child,row[0])}
                require(row[2]!='deleted',409,'此上传已过期，请重新选择图片。')
                if row[2]=='uploading' and row[3]: return {'assetId':row[0],'status':'uploading'}
                asset=row[0]
                cur.execute("UPDATE lele.media_assets SET state='uploading',lease_token=%s,lease_until=now()+interval '2 minutes' WHERE id=%s",(lease,asset))
            else:
                asset=identity()
                cur.execute("INSERT INTO lele.media_assets(id,child_id,uploaded_by,upload_id,membership_version,object_key,content_sha256,mime_type,byte_size,width,height,state,lease_token,lease_until) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'uploading',%s,now()+interval '2 minutes')",(asset,child,user[0],upload_id,context[4],key,image.sha256,image.mime,len(content),image.width,image.height,lease))
            return asset
        result=self.service.transaction(begin)
        if isinstance(result,dict): return result
        asset=result
        try:
            self.objects.put(key,image)
            def finish(cur):
                self.auth(cur,child,token,csrf,origin,write=True,member=member)
                cur.execute("UPDATE lele.media_assets SET state='staged',lease_token=NULL,lease_until=NULL WHERE id=%s AND lease_token=%s AND state='uploading'",(asset,lease))
                require(cur.rowcount==1,409,'上传状态已变化，请检查原上传结果。')
            self.service.transaction(finish)
        except (StoreError,ApiError):
            self.service.transaction(lambda cur:cur.execute("UPDATE lele.media_assets SET state='failed',lease_token=NULL,lease_until=NULL WHERE id=%s AND lease_token=%s AND state='uploading'",(asset,lease)))
            raise
        return {'assetId':asset,'status':'staged','imageUrl':image_url(child,asset)}

    def status(self,child,upload_id,token):
        require(UPLOAD_ID.fullmatch(upload_id),400,'上传编号不正确。')
        def run(cur):
            user,_=self.auth(cur,child,token)
            cur.execute('SELECT id,state FROM lele.media_assets WHERE child_id=%s AND uploaded_by=%s AND upload_id=%s',(child,user[0],upload_id))
            row=cur.fetchone()
            require(row is not None,404,'上传记录不存在。')
            return {'assetId':row[0],'status':row[1],**({'imageUrl':image_url(child,row[0])} if row[1] in ('staged','attached') else {})}
        return self.service.transaction(run)

    def asset_metadata(self,cur,user,child,asset):
        cur.execute('SELECT object_key,content_sha256,mime_type,state,uploaded_by,membership_version FROM lele.media_assets WHERE id=%s AND child_id=%s',(asset,child))
        row=cur.fetchone()
        require(row is not None and (row[3]=='attached' or row[3]=='staged' and row[4]==user[0]),404,'图片不存在或不可访问。')
        return row

    def read_asset(self,child,asset,token):
        def run(cur):
            user,context=self.auth(cur,child,token)
            row=self.asset_metadata(cur,user,child,asset)
            require(row[3]=='attached' or row[5]==context[4],404,'图片不存在或不可访问。')
            return row
        row=self.service.transaction(run)
        content=self.objects.get(row[0],row[1])
        self.service.transaction(run) # revoke/delete during object read cannot release bytes
        return ImageResponse(content,row[2])

    def attach(self,cur,user,child,data,*,mark=True):
        self.require_external(data)
        for asset in set(referenced_assets(data)):
            row=self.asset_metadata(cur,user,child,asset)
            if row[3]=='staged':
                cur.execute('SELECT membership_version FROM lele.memberships WHERE child_id=%s AND user_id=%s',(child,user[0]))
                member=cur.fetchone()
                require(member and member[0]==row[5],409,'图片上传时的权限已更新，请重新上传。')
                if mark:
                    cur.execute("UPDATE lele.media_assets SET state='attached',attached_at=now() WHERE id=%s",(asset,))

    @staticmethod
    def decorate(result):
        if not isinstance(result,dict) or not result.get('context',{}).get('childId'): return result
        result=copy.deepcopy(result)
        child=result['context']['childId']
        def visit(node):
            if isinstance(node,dict):
                if node.get('imageAssetId'): node['imageUrl']=image_url(child,node['imageAssetId'])
                for item in list(node.values()): visit(item)
            elif isinstance(node,list):
                for item in node: visit(item)
        visit(result.get('data'))
        return result

"""Integration tests: isolated lele_test* DB and filesystem objects only."""
import base64
import copy
import io
import json
import os
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch
from PIL import Image
from psycopg.types.json import Jsonb
from fastapi.testclient import TestClient
import tests.backend.test_child_backend as backend
from lele_growth.child_service import ApiError
from lele_growth.media_types import inspect_image, decode_image, inline_fields, referenced_assets
from lele_growth.media_migration import migrate, cleanup
from lele_growth.postgres_store import canonical_sha256
from lele_growth.storage import StoreError
from http import HTTPStatus

CONFIG=os.environ.get('LELE_TEST_CONFIG')


def png(color='red'):
    stream=io.BytesIO();Image.new('RGB',(16,12),color).save(stream,format='PNG');return stream.getvalue()


def data_url(content): return 'data:image/png;base64,'+base64.b64encode(content).decode()


class ImageValidationTests(unittest.TestCase):
    def test_actual_type_dimensions_and_corruption(self):
        image=inspect_image(png(),'image/png')
        self.assertEqual((image.width,image.height),(16,12))
        self.assertEqual(decode_image(data_url(png())).content,png())
        for raw,mime in ((b'<svg/>','image/png'),(png(),'image/jpeg'),(b'X'*184321,'image/png'),(png()[:28],'image/png')):
            with self.subTest(mime=mime,length=len(raw)),self.assertRaises(StoreError): inspect_image(raw,mime)


@unittest.skipUnless(CONFIG,'Set isolated LELE_TEST_CONFIG')
class MediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Never use an OSS provider even when the caller copied a development config.
        from pathlib import Path
        cfg=json.loads(Path(CONFIG).read_text())
        cls.temp=tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cfg['object_storage']={'provider':'test-filesystem','root':str(Path(cls.temp.name)/'objects')}
        cls.config_path=str(Path(cls.temp.name)/'config.json')
        Path(cls.config_path).write_text(json.dumps(cfg))
        with patch.object(backend,'CONFIG',cls.config_path):
            backend.ChildBackendTests.setUpClass.__func__(cls)
    login=classmethod(backend.ChildBackendTests.login.__func__)
    call=classmethod(backend.ChildBackendTests.call.__func__)
    new_parent=classmethod(backend.ChildBackendTests.new_parent.__func__)
    child=backend.ChildBackendTests.child
    data=backend.ChildBackendTests.data
    archive_fixture=backend.ChildBackendTests.archive_fixture

    def setUp(self):
        self.child_info=self.child()
        self.app_service=self.parent_app.state.service
        self.objects=self.app_service.media.objects
        self.assertEqual(self.objects.config['provider'],'test-filesystem')

    def upload(self,child=None,client=None,content=None,upload_id=None,**overrides):
        child=child or self.child_info;client=client or self.a
        headers={'Origin':str(client.base_url).rstrip('/'),'X-Upload-Id':upload_id or str(uuid.uuid4()),'X-Membership-Version':child['membershipVersion'],'Content-Type':'image/png',**overrides}
        return client.post(f"/api/children/{child['id']}/assets",content=content or png(),headers=headers)

    def command(self,kind,payload,child=None,client=None):
        child=child or self.child_info;client=client or self.a
        pkg=self.data(child,client)
        return self.call(client,'POST',f"/api/children/{child['id']}/operations",{'expectedRevision':pkg['revision'],'membershipVersion':child['membershipVersion'],'operationId':str(uuid.uuid4()),'kind':kind,'payload':payload})

    def member(self):
        child=self.child_info
        invite=self.call(self.a,'POST',f"/api/children/{child['id']}/invitations",{'loginName':self.bu['loginName']}).json()['invitation']
        self.assertEqual(self.call(self.b,'POST',f"/api/invitations/{invite['id']}/accept",{}).status_code,200)

    def gift(self,asset,child=None):
        return self.command('gift.save',{'gift':{'name':'OSS 礼品','points':7,'imageAssetId':asset}},child=child)

    def test_upload_private_attach_idempotency_and_cross_child(self):
        self.member();child=self.child_info
        before=self.data(child)['revision'];upload_id=str(uuid.uuid4())
        result=self.upload(upload_id=upload_id);self.assertEqual(result.status_code,200,result.text)
        asset=result.json();url=asset['imageUrl']
        self.assertEqual(self.data(child)['revision'],before)
        self.assertEqual(self.a.get(url).content,png())
        self.assertEqual(self.b.get(url).status_code,404)
        self.assertEqual(self.outsider.get(url).status_code,403)
        with TestClient(self.parent_app,base_url=str(self.a.base_url)) as anonymous: self.assertEqual(anonymous.get(url).status_code,401)
        self.assertEqual(self.upload(upload_id=upload_id).json()['assetId'],asset['assetId'])
        self.assertEqual(self.upload(upload_id=upload_id,content=png('blue')).status_code,409)
        response=self.gift(asset['assetId']);self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(self.b.get(url).content,png())
        self.assertIn('private',self.b.get(url).headers['cache-control'])
        record=self.service.transaction(lambda cur:self.service.store.read(cur,child['id']))
        gift=record['data']['gifts'][0]
        self.assertEqual(gift['imageAssetId'],asset['assetId']);self.assertNotIn('imageData',gift);self.assertNotIn('imageUrl',gift)
        second=self.child()
        self.assertEqual(self.gift(asset['assetId'],second).status_code,404)
        self.assertEqual(self.a.get(f"/api/children/{second['id']}/assets/{asset['assetId']}").status_code,404)
        self.assertEqual(self.admin.get(url).status_code,403)
        self.assertEqual(self.call(self.a,'DELETE',f"/api/children/{child['id']}",{}).status_code,200)
        self.assertEqual(self.a.get(url).status_code,403);self.assertEqual(self.b.get(url).status_code,403)

    def test_failure_retry_status_protection_and_revocation_during_upload(self):
        child=self.child_info;uid=str(uuid.uuid4())
        for headers in ({'Origin':'https://evil.example'},{'X-CSRF-Token':'wrong'},{'X-Membership-Version':'wrong'}):
            self.assertIn(self.upload(**headers).status_code,(403,409))
        self.assertEqual(self.upload(content=b'not an image').status_code,400)
        self.assertEqual(self.upload(content=b'a'*184321).status_code,413)
        with patch.object(self.objects,'put',side_effect=StoreError(HTTPStatus.SERVICE_UNAVAILABLE,'图片上传暂时失败。')):
            self.assertEqual(self.upload(upload_id=uid).status_code,503)
        status=f"/api/children/{child['id']}/assets/uploads/{uid}"
        self.assertEqual(self.a.get(status).json()['status'],'failed')
        self.assertEqual(self.outsider.get(status).status_code,403)
        retried=self.upload(upload_id=uid);self.assertEqual(retried.status_code,200,retried.text)
        self.assertEqual(self.a.get(status).json()['status'],'staged')
        original=self.objects.put
        def revoked(key,image):
            original(key,image)
            self.call(self.a,'DELETE',f"/api/children/{child['id']}",{})
        with patch.object(self.objects,'put',side_effect=revoked):
            self.assertEqual(self.upload(content=png('blue')).status_code,403)
        self.assertEqual(self.a.get(retried.json()['imageUrl']).status_code,403)

    def test_concurrent_upload_lease_and_same_request(self):
        started=Event();release=Event();uid=str(uuid.uuid4());original=self.objects.put
        def delay(key,image):
            started.set();self.assertTrue(release.wait(10));original(key,image)
        with patch.object(self.objects,'put',side_effect=delay),ThreadPoolExecutor() as pool:
            first=pool.submit(self.upload,upload_id=uid)
            try:
                self.assertTrue(started.wait(10))
                second=self.upload(upload_id=uid)
                self.assertEqual(second.json()['status'],'uploading')
            finally: release.set()
            self.assertEqual(first.result().json()['assetId'],second.json()['assetId'])

    def test_attached_readonly_history_and_cleanup(self):
        child=self.child_info;asset=self.upload().json()
        self.assertEqual(self.gift(asset['assetId']).status_code,200)
        self.assertEqual(self.command('ledger.manual',{'amount':1,'reason':'快照','date':'2026-10-23'}).status_code,200)
        self.archive_fixture(child,True)
        self.assertEqual(self.a.get(asset['imageUrl']).status_code,200)
        self.assertEqual(self.upload().status_code,409)
        self.archive_fixture(child,False)
        duplicate=self.upload().json();orphan=self.upload(content=png('green')).json()
        self.service.transaction(lambda cur:cur.execute("UPDATE lele.media_assets SET created_at=now()-interval '25 hours' WHERE id=ANY(%s)",([duplicate['assetId'],orphan['assetId']],)))
        self.assertGreaterEqual(cleanup(self.config_path)['assets'],1)
        cleanup(self.config_path,apply=True)
        self.assertEqual(self.a.get(asset['imageUrl']).content,png())
        self.assertEqual(self.a.get(orphan['imageUrl']).status_code,404)

    def test_unauthorized_upload_never_decodes(self):
        import lele_growth.media_service as media_service
        child=self.child_info
        with patch.object(media_service,'inspect_image',side_effect=AssertionError('不得解码')) as decode:
            anonymous=TestClient(self.parent_app,base_url=str(self.a.base_url))
            self.assertEqual(self.upload(client=anonymous).status_code,401)
            for overrides,status in (({'Origin':'https://evil.example'},403),({'X-CSRF-Token':'wrong'},403),({'X-Membership-Version':'wrong'},409)):
                self.assertEqual(self.upload(**overrides).status_code,status)
            self.archive_fixture(child,True)
            self.assertEqual(self.upload().status_code,409)
            self.archive_fixture(child,False)
            self.call(self.a,'DELETE',f"/api/children/{child['id']}",{})
            self.assertEqual(self.upload().status_code,403)
            decode.assert_not_called()

    def test_upload_rate_and_concurrency_limits_before_decode(self):
        import lele_growth.media_service as media_service
        from lele_growth.upload_guard import UploadGuard
        guard=UploadGuard(concurrency=1,per_minute=1)
        with patch.object(self.app_service.media,'upload_guard',guard):
            self.assertEqual(self.upload().status_code,200)
            with patch.object(media_service,'inspect_image',side_effect=AssertionError('不得解码')) as decode:
                self.assertEqual(self.upload().status_code,429)
                decode.assert_not_called()
            guard=UploadGuard(concurrency=1)
            with patch.object(self.app_service.media,'upload_guard',guard),guard.acquire('another'):
                with patch.object(media_service,'inspect_image') as decode:
                    self.assertEqual(self.upload().status_code,429)
                    decode.assert_not_called()

    def old_staged(self,colors=('red','blue')):
        assets=[self.upload(content=png(color)).json() for color in colors]
        self.service.transaction(lambda cur:cur.execute("UPDATE lele.media_assets SET created_at=now()-interval '25 hours' WHERE id=ANY(%s)",([a['assetId'] for a in assets],)))
        return assets

    def test_cleanup_partial_failure_keeps_durable_tombstones_and_retries(self):
        from lele_growth.object_storage import ObjectStorage
        assets=self.old_staged();original=ObjectStorage.delete;calls=[]
        def fail(storage,key):
            calls.append(key)
            if len(calls)==2: raise StoreError(HTTPStatus.SERVICE_UNAVAILABLE,'注入失败')
            original(storage,key)
        with patch.object(ObjectStorage,'delete',fail),self.assertRaises(StoreError):
            cleanup(self.config_path,apply=True)
        for asset in assets:
            self.assertEqual(self.gift(asset['assetId']).status_code,404)
            self.assertEqual(self.a.get(asset['imageUrl']).status_code,404)
        with patch.object(self.objects,'put') as put:
            self.assertEqual(self.upload(content=png('blue')).status_code,409)
            put.assert_not_called()
        self.assertEqual(cleanup(self.config_path,apply=True)['assets'],1)
        self.assertEqual(cleanup(self.config_path,apply=True)['assets'],0)
        self.assertEqual(self.upload(content=png('blue')).status_code,200)

    def test_cleanup_reserve_failure_never_deletes_objects(self):
        from lele_growth.child_service import ChildService
        from lele_growth.object_storage import ObjectStorage
        asset=self.old_staged(('green',))[0];original=ChildService.transaction
        def fail(service,work,**options):
            if work.__name__=='reserve':
                def rollback(cur):
                    work(cur)
                    raise ApiError(503,'注入提交失败')
                return original(service,rollback,**options)
            return original(service,work,**options)
        with patch.object(ChildService,'transaction',fail),patch.object(ObjectStorage,'delete') as delete,self.assertRaises(ApiError):
            cleanup(self.config_path,apply=True)
        delete.assert_not_called()
        self.assertEqual(self.a.get(asset['imageUrl']).status_code,200)

    def test_cleanup_finalization_failure_never_revives_deleted_file(self):
        from lele_growth.child_service import ChildService
        asset=self.old_staged(('green',))[0];original=ChildService.transaction
        def fail(service,work,**options):
            if work.__name__=='<lambda>':raise ApiError(503,'注入确认失败')
            return original(service,work,**options)
        with patch.object(ChildService,'transaction',fail),self.assertRaises(ApiError):
            cleanup(self.config_path,apply=True)
        self.assertEqual(self.gift(asset['assetId']).status_code,404)
        self.assertEqual(self.a.get(asset['imageUrl']).status_code,404)
        self.assertEqual(cleanup(self.config_path,apply=True)['assets'],1)

    def test_cleanup_blocks_concurrent_cleaner_and_same_key_upload(self):
        from lele_growth.object_storage import ObjectStorage
        asset=self.old_staged(('green',))[0];started=Event();release=Event();original=ObjectStorage.delete
        def delay(storage,key):
            started.set()
            self.assertTrue(release.wait(10))
            original(storage,key)
        with patch.object(ObjectStorage,'delete',delay),ThreadPoolExecutor() as pool:
            pending=pool.submit(cleanup,self.config_path,apply=True)
            try:
                self.assertTrue(started.wait(10))
                with self.assertRaises(ApiError) as failure:cleanup(self.config_path,apply=True)
                self.assertEqual(failure.exception.status,409)
                self.assertEqual(self.upload(content=png('green')).status_code,409)
            finally:release.set()
            pending.result()
        self.assertEqual(self.upload(content=png('green')).status_code,200)

    def test_import_embedded_images_preserves_revision_and_duplicate_guard(self):
        from lele_growth.child_service import import_child
        child=self.child_info
        record=self.service.transaction(lambda cur:self.service.store.read(cur,child['id']))
        from lele_growth.business_operations import apply_operation
        record['data']=apply_operation(record['data'],'gift.save',{'gift':{'name':'旧备份图片','points':9,'imageData':data_url(png())}},actor_id=self.au['id'],revision=71,now='2026-10-20T00:00:00Z')
        record['revision']=71
        result=import_child(self.config_path,self.au['id'],record)
        rebuilt=self.data(result)
        self.assertEqual(rebuilt['revision'],71)
        self.assertNotIn('imageData',rebuilt['data']['gifts'][0])
        imported=self.service.transaction(lambda cur:self.service.store.read(cur,result['id']))
        self.assertEqual(imported['revision'],record['revision'])
        self.assertEqual(self.a.get(rebuilt['data']['gifts'][0]['imageUrl']).content,png())
        with self.assertRaises(ApiError): import_child(self.config_path,self.au['id'],record)

    def test_migrate_current_snapshots_audit_deleted_and_repeat(self):
        from lele_growth.business_operations import apply_operation
        child=self.child_info;deleted=self.child()
        def insert(cur):
            for c in (child,deleted):
                current=self.service.store.read(cur,c['id'])
                data=apply_operation(current['data'],'gift.save',{'gift':{'name':'原图','points':9,'imageData':data_url(png())}},actor_id=self.au['id'],revision=1,now='2026-10-20T00:00:00Z')
                with patch('lele_growth.media_service.MediaService.require_external'):
                    self.service.store.replace(cur,c['id'],data)
                snap={**current,'data':copy.deepcopy(data)}
                snap['data']['gifts'][0]['imageData']=data_url(png('blue'))
                cur.execute('INSERT INTO lele.data_snapshots(child_id,revision,captured_at,snapshot_json,content_sha256) VALUES(%s,0,now(),%s,%s)',(c['id'],Jsonb(snap),canonical_sha256(snap)))
                self.service.audit(cur,self.au['id'],'test.legacy',c['id'],{'gift':{'imageData':data_url(png('green'))}})
        self.service.transaction(insert)
        self.call(self.a,'DELETE',f"/api/children/{deleted['id']}",{})
        old=self.service.transaction(lambda cur:self.service.store.read(cur,child['id']))
        self.assertGreaterEqual(migrate(self.config_path)['embeddedImages'],6)
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory,0o700)
            result=migrate(self.config_path,apply=True,backup_dir=directory)
            self.assertEqual(result['after']['embeddedBytes'],0)
            self.assertEqual(migrate(self.config_path)['embeddedImages'],0)
            self.assertEqual(migrate(self.config_path,apply=True,backup_dir=directory)['changedFields'],0)
            self.assertTrue(all(os.stat(os.path.join(directory,p)).st_mode & 0o077==0 for p in os.listdir(directory)))
        new=self.service.transaction(lambda cur:self.service.store.read(cur,child['id']))
        self.assertEqual((new['revision'],new['updatedAt']),(old['revision'],old['updatedAt']))
        self.assertNotIn('imageData',new['data']['gifts'][0])
        def read(cur):
            cur.execute('SELECT snapshot_json,content_sha256 FROM lele.data_snapshots WHERE child_id=%s',(child['id'],));return cur.fetchall()
        for snap,sha in self.service.transaction(read):
            self.assertEqual(canonical_sha256(snap),sha)
            for asset in referenced_assets(snap): self.assertEqual(self.a.get(f"/api/children/{child['id']}/assets/{asset}").content,png('blue'))
        self.assertEqual(self.a.get(f"/api/children/{deleted['id']}/data").status_code,403)
        self.assertEqual(self.a.get(self.data(child)['data']['gifts'][0]['imageUrl']).content,png())

if __name__=='__main__': unittest.main()

"""Video ticket authorization and streaming use an isolated lele_test* database."""
import io
import base64
from pathlib import Path
import secrets
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import Mock, patch
from psycopg.types.json import Jsonb
from lele_growth.child_service import ApiError
from lele_growth.plugins import resources
from tests.backend.test_plugin_runtime import DatabaseFixture
from lele_growth.plugins.credential_vault import CredentialVault
from lele_growth.plugins.private_bridge import PluginBridge

class Reply(io.BytesIO):
    def __init__(self, data=b'video-segment', status=206, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {'Content-Length': str(len(data)), 'Content-Type': 'video/mp4',
                                   'Content-Range': f'bytes 0-{len(data)-1}/1024'}
    def getheader(self, key, default=None): return self.headers.get(key, default)

class VideoTests(DatabaseFixture):
    def setUp(self):
        super().setUp()
        self.data['platformApi']['minMinor'] = 1
        self.data['capabilities'] += ['plugin.private-state', 'plugin.credentials', 'plugin.resources']
        temp = tempfile.TemporaryDirectory(prefix='video-vault-')
        self.addCleanup(temp.cleanup)
        key = Path(temp.name) / 'key'
        key.write_text('test-v1:' + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())
        key.chmod(0o600)
        self.bridge = PluginBridge(self.service, CredentialVault(key))
        self.body = {'operationId': str(uuid.uuid4()), 'bindingRevision': 0, 'username': 'video-test', 'password': '{{SECRET_c2pj7zxs}}'}
        self.data['resourceOrigins'] = ['https://file.mison.cn', 'https://mp.mison.cn']
        self.sql('UPDATE lele.plugin_releases SET manifest=%s WHERE release_id=%s', (Jsonb(self.data), self.release_id))
        self.ctx = {**self.context(), 'actorId': self.user_id}
        self.bridge.handle(self.ctx, 'session.begin', self.body)
        self.session = self.bridge.handle(self.ctx, 'session.finish', {
            'operationId': self.body['operationId'], 'token': '{{SECRET_damtsotz}}', 'userid': '42',
            'expiresAt': (datetime.now(timezone.utc)+timedelta(days=29)).isoformat(), 'maskedAccount': 'test***'})['data']
        self.payload = {'purpose': 'teacher-intro-video', 'url': 'https://file.mison.cn/teacher/test.mp4',
                        'credentialId': self.session['credentialId'], 'bindingRevision': 1}
        issued = self.bridge.handle(self.ctx, 'resource.issue', self.payload)['data']
        self.ticket = issued['url'].rsplit('/', 1)[1]

    def authorize(self, **changes):
        return resources.authorize(self.service, changes.get('token', self.token), changes.get('surface', 'parent'),
            changes.get('child_id', self.child_id), self.plugin_id, self.ticket)

    def open(self, method='GET', range_header='bytes=0-12'):
        return resources.open_video(self.service, self.token, 'parent', self.child_id, self.plugin_id,
                                    self.ticket, method, range_header)

    def test_ticket_reuse_and_membership_are_required(self):
        again = self.bridge.handle(self.ctx, 'resource.issue', self.payload)['data']
        self.assertEqual(again['url'].rsplit('/', 1)[1], self.ticket)
        self.assertEqual(self.authorize(), self.payload['url'])
        self.assertEqual(self.sql('SELECT count(*) FROM lele.plugin_resource_tickets WHERE child_id=%s', (self.child_id,)), [(1,)])
        for change in ({'token': None}, {'surface': 'admin'}, {'child_id': 'other-child'}):
            with self.subTest(change=change), self.assertRaises(ApiError): self.authorize(**change)

    def test_expiry_and_release_switch_revoke_tickets(self):
        self.sql('UPDATE lele.plugin_catalog SET release_epoch=release_epoch+1 WHERE id=%s', (self.plugin_id,))
        with self.assertRaises(ApiError): self.authorize()
        self.ctx = {**self.context(), 'actorId': self.user_id}
        self.ticket = self.bridge.handle(self.ctx, 'resource.issue', self.payload)['data']['url'].rsplit('/',1)[1]
        self.sql('UPDATE lele.plugin_resource_tickets SET expires_at=now()-interval \'1 second\' WHERE ticket=%s', (self.ticket,))
        with self.assertRaises(ApiError): self.authorize()

    def test_disable_and_binding_change_revoke_tickets(self):
        self.bridge.handle(self.ctx, 'session.disconnect', {'operationId': self.body['operationId'], 'bindingRevision': 1})
        with self.assertRaises(ApiError): self.authorize()

    def test_stream_preserves_range_without_forwarding_credentials_and_closes(self):
        connection = Mock()
        connection.getresponse.return_value = Reply()
        with patch.object(resources, 'PublicConnection', return_value=connection):
            stream = self.open()
            self.assertEqual(stream.status, 206)
            self.assertEqual(stream.headers['Content-Range'], 'bytes 0-12/1024')
            self.assertEqual(b''.join(stream.body()), b'video-segment')
        sent = connection.request.call_args
        self.assertEqual(sent.args[:2], ('GET', '/teacher/test.mp4'))
        self.assertEqual(sent.kwargs['headers'], {'Accept': 'video/mp4', 'Range': 'bytes=0-12'})
        connection.close.assert_called()

    def test_head_does_not_read_video_and_redirect_does_not_follow(self):
        connection = Mock()
        response = Reply()
        connection.getresponse.return_value = response
        with patch.object(resources, 'PublicConnection', return_value=connection):
            stream = self.open('HEAD')
            self.assertEqual(list(stream.body()), [])
            self.assertEqual(response.tell(), 0)
            connection.getresponse.return_value = Reply(status=302)
            with self.assertRaises(ApiError): self.open()
        self.assertEqual(connection.request.call_count, 2)

    def test_authority_is_rechecked_after_upstream_io(self):
        connection = Mock()
        connection.getresponse.return_value = Reply()
        def disable(*args, **kwargs):
            self.sql('UPDATE lele.child_plugins SET enabled=false,generation=generation+1 WHERE child_id=%s AND plugin_id=%s', (self.child_id,self.plugin_id))
        connection.request.side_effect = disable
        with patch.object(resources, 'PublicConnection', return_value=connection), self.assertRaises(ApiError): self.open()
        connection.close.assert_called()

    def test_parent_http_route_streams_video_with_existing_csp_and_cookies(self):
        from fastapi.testclient import TestClient
        from lele_growth.accounts_app import create_app
        connection = Mock()
        connection.getresponse.side_effect = lambda: Reply()
        app = create_app(self.config_path, 'parent')
        path = f'/api/children/{self.child_id}/plugins/{self.plugin_id}/media/{self.ticket}'
        with TestClient(app) as client, patch.object(resources, 'PublicConnection', return_value=connection):
            self.assertEqual(client.get(path).status_code, 401)
            client.cookies.set('lele_parent', self.token)
            response = client.get(path, headers={'Range': 'bytes=0-12'})
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.content, b'video-segment')
            self.assertEqual(response.headers['content-type'], 'video/mp4')
            self.assertIn("default-src 'self'", response.headers['content-security-policy'])
            self.assertNotIn('file.mison.cn', response.headers['content-security-policy'])
            self.assertEqual(client.head(path, headers={'Range': 'bytes=0-12'}).content, b'')

    def test_pdf_ticket_range_and_same_origin_embed_policy(self):
        issued = self.bridge.handle(self.ctx, 'resource.issue', {**self.payload, 'purpose':'courseware-pdf', 'url':'https://file.mison.cn/student.pdf'})['data']
        self.assertEqual(issued['mimeType'], 'application/pdf')
        self.ticket = issued['url'].rsplit('/',1)[1]
        self.assertEqual(self.authorize(), 'https://file.mison.cn/student.pdf')
        from fastapi.testclient import TestClient
        from lele_growth.accounts_app import create_app
        data=b'%PDF-1.7\nfixture'
        connection=Mock()
        connection.getresponse.side_effect=lambda:Reply(data=data,headers={'Content-Type':'application/pdf','Content-Length':str(len(data)),'Content-Range':f'bytes 0-{len(data)-1}/1024'})
        app=create_app(self.config_path,'parent')
        with TestClient(app) as client,patch.object(resources,'PublicConnection',return_value=connection):
            self.assertEqual(client.get(issued['url']).status_code,401)
            client.cookies.set('lele_parent',self.token)
            response=client.get(issued['url'],headers={'Range':'bytes=0-15'})
            self.assertEqual(response.status_code,206)
            self.assertEqual(response.content,data)
            self.assertEqual(response.headers['content-type'],'application/pdf')
            self.assertEqual(response.headers['content-disposition'],'inline; filename=courseware.pdf')
            named=client.get(issued['url']+'?filename=Unit%201%20%E8%87%AA%E6%88%91%E4%BB%8B%E7%BB%8D',headers={'Range':'bytes=0-15'})
            self.assertIn("filename*=UTF-8''Unit%201%20%E8%87%AA%E6%88%91%E4%BB%8B%E7%BB%8D.pdf", named.headers['content-disposition'])
            self.assertNotIn('\r', named.headers['content-disposition'])
            self.assertIn("frame-ancestors 'self'",response.headers['content-security-policy'])
            self.assertIn('sandbox',response.headers['content-security-policy'])
            self.assertEqual(response.headers['x-frame-options'],'SAMEORIGIN')
        self.assertEqual(connection.request.call_args.kwargs['headers']['Accept'],'application/pdf')
        self.assertNotIn('Authorization',connection.request.call_args.kwargs['headers'])


    def test_pdf_url_is_encoded_like_app_without_changing_origin(self):
        result=self.bridge.handle(self.ctx,'resource.issue',{**self.payload,'purpose':'courseware-pdf','url':'https://file.mison.cn/student lessons/中文课件.pdf'})['data']
        ticket=result['url'].rsplit('/',1)[1]
        target=self.sql('SELECT upstream_url FROM lele.plugin_resource_tickets WHERE ticket=%s',(ticket,))[0][0]
        self.assertEqual(target,'https://file.mison.cn/student%20lessons/%E4%B8%AD%E6%96%87%E8%AF%BE%E4%BB%B6.pdf')
        for url in ('https://127.0.0.1/a b.pdf','https://file.mison.cn.evil.test/a b.pdf','https://file.mison.cn/a\nb.pdf'):
            with self.assertRaises(ApiError):self.bridge.handle(self.ctx,'resource.issue',{**self.payload,'purpose':'courseware-pdf','url':url})


class VideoValidationTests(unittest.TestCase):
    def test_fixed_origins_and_mp4_only(self):
        for url in ('http://file.mison.cn/a.mp4', 'https://127.0.0.1/a.mp4', 'https://file.mison.cn.evil.test/a.mp4',
                    'https://u:p@file.mison.cn/a.mp4', 'https://file.mison.cn/a.pptx', 'https://file.mison.cn:444/a.mp4'):
            with self.subTest(url=url), self.assertRaises(ApiError): resources.video_url(url, ['https://file.mison.cn'])

    def test_size_range_and_mime_limits(self):
        for response in (Reply(headers={'Content-Length': str(resources.MAX_VIDEO_BYTES+1), 'Content-Type':'video/mp4'}),
                         Reply(headers={'Content-Length':'13','Content-Type':'text/html'}),
                         Reply(headers={'Content-Length':'13','Content-Type':'video/mp4','Content-Range':'bytes 0-12/999999999999'})):
            with self.assertRaises(ApiError): resources.VideoStream(Mock(), response, False)
        with patch.object(resources, 'authorize', return_value='https://file.mison.cn/test.mp4'), patch.object(resources, 'PublicConnection') as connect:
            with self.assertRaises(ApiError): resources.open_video(None, None, 'parent','a','b','ticket',range_header='bytes=1-2,4-5')
            connect.assert_not_called()

if __name__ == '__main__': unittest.main()

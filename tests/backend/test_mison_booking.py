"""Actual plugin routes + private DB bridge; synthetic Mison transport only."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from datetime import timedelta
import json
import unittest
import uuid
from unittest.mock import patch
from psycopg.types.json import Jsonb
from tests.backend.test_mison_login import token
from lele_growth.plugins.credential_vault import CredentialVault
from lele_growth.plugins.private_bridge import PluginBridge
import base64, secrets, tempfile
from pathlib import Path
from tests.backend.test_mison_reads import FakeClient
from tests.backend.test_plugin_runtime import DatabaseFixture
from mison_booking import auth, read_api, read_store, handle_request, operations
from mison_booking.upstream import Client
from lele_growth.child_service import ApiError
from lele_plugin_sdk.bridge import BridgeError

class BookingApiTests(DatabaseFixture):
    def setUp(self):
        super().setUp()
        self.data['capabilities'] += ['plugin.private-state','plugin.credentials']
        self.data['platformApi']['minMinor'] = 1
        self.data['backend']['requestTimeoutSeconds'] = 45
        folder = tempfile.TemporaryDirectory(prefix='mison-booking-tests-')
        self.addCleanup(folder.cleanup)
        key = Path(folder.name)/'vault.key'
        key.write_text('test-v1:'+base64.urlsafe_b64encode(secrets.token_bytes(32)).decode());key.chmod(0o600)
        self.vault=CredentialVault(key);self.bridge=PluginBridge(self.service,self.vault)
        self.body={'operationId':str(uuid.uuid4()),'bindingRevision':0,'username':'fixture-user','password':'fixture-pass'}
        self.data['capabilities'] += ['plugin.external-operations','plugin.resources']
        self.data['resourceOrigins'] = ['https://file.mison.cn','https://mp.mison.cn']
        self.sql('UPDATE lele.plugin_releases SET manifest=%s WHERE release_id=%s',(Jsonb(self.data),self.release_id))
        self.ctx={**self.context(),'actorId':self.user_id}
        self.fake=FakeClient();self.fake.userid=42
        self.day=(read_api.now().date()+timedelta(days=3)).isoformat()
        self.live=[];self.cancelled=[];self.sent=[];self.remaining=5;self.drop=None;self.reject=False
        self.course=lambda i:{'id':i,'title':f'合成课件{i}','category_id':5,'category_name':'测试分类','status':1,'student_file_url':f'https://file.mison.cn/course{i}.pdf'}
        for cache in (read_store.memo,read_store.cursors):cache.values.clear();cache.size=0
        read_store.teacher_cursors.clear()

    @contextmanager
    def connected(self):
        def invoke(context,action,payload):
            try:return self.bridge.handle(context,action,payload)['data']
            except ApiError as e:raise BridgeError(e.kind,e.error) from None
        def read(client,endpoint,body):
            if endpoint=='onevoneGetTeacherInfo':
                return {'data':{**self.fake.teacher(101),'name':'Teacher 101','lessonTime':'25分钟/课时',
                    'all_date':[{'dtime':time,'is_dated':42 if any(r['datestart']==body['ddate']+' '+time for r in self.live) else 0} for time in ('19:00','19:30','20:00')]}}
            if endpoint=='onevoneGetDaysAvailable':return {'data':[1]*17}
            if endpoint=='getRecommendCourseware':return {'data':{'status':1,'list':[self.course(501+i) for i in range(body['count'])],'lastCourse':self.course(500)}}
            if endpoint=='getCoursewareCategoryTree':return {'data':{'tree':[{'id':5,'name':'测试分类','children':[]}]}}
            if endpoint=='getCoursewareList':return {'data':[self.course(501+i) for i in range(4)],'count':4}
            if endpoint=='onevoneGetChangeCoursewareTimes':return {'data':{'leftTimes':self.remaining,'allTimes':5}}
            if endpoint=='onevoneGetCancelCourseware':return {'data':deepcopy(self.cancelled),'count':len(self.cancelled)}
            if endpoint in ('getLiveList','getBackList'):return {'data':{'list':deepcopy(self.live),'allPage':1,'allRow':len(self.live),'lastPage':True}}
            if endpoint=='onevoneGetCancelLesson':return {'data':deepcopy(self.cancelled),'count':len(self.cancelled)}
            if endpoint=='courseClassResource':return {'data':[{'id':1,'filename':'学生资料','filepath':'https://file.mison.cn/student.pdf','use_type':1}]}
            return self.fake.call(endpoint,body)
        def mutate(client,endpoint,body):
            self.sent.append((endpoint,deepcopy(body)))
            if self.reject:raise auth.AuthError('UPSTREAM_REJECTED','时段不可约')
            if endpoint=='onevoneAppointment':
                ids=body['courseware_id'].split(',')
                for i,course in enumerate(ids):
                    start=(read_api.datetime.fromisoformat(body['ddate']+'T'+body['dtime'])+timedelta(minutes=30*i)).strftime('%Y-%m-%d %H:%M')
                    self.live.append({**self.fake.record(9000+len(self.live),start),'teachername':'Teacher 101','courseware_id':course,'courseid':'12345'})
                data=[]
            elif endpoint=='teacherCollect':
                self.fake.favorite_rows=[r for r in self.fake.favorite_rows if int(r['tid'])!=body['tid']]
                if body['status']==1:self.fake.favorite_rows.append(self.fake.teacher(body['tid']))
                data=[]
            elif endpoint=='onevonePreviewCourseware':self.remaining-=1;data='https://file.mison.cn/preview.pdf'
            elif endpoint=='cancelLesson':
                row=next(r for r in self.live if r['cid']==body['cid']);self.cancel_target=deepcopy(row);self.live.remove(row);data={'status':1}
            elif endpoint=='onevoneSaveCancelLesson':
                row=self.cancel_target;self.cancelled.append({'cid':row['cid'],'dateTime':row['datestart'],'teachername':row['teachername'],'course_name':row['course_name'],'courseware_id':row['courseware_id']});data=[]
            else:raise AssertionError(endpoint)
            if endpoint==self.drop:raise auth.AuthError('RESULT_UNCERTAIN','模拟上游已写入但响应丢失')
            return {'code':200,'data':data}
        with patch.object(auth.BridgeClient,'call',side_effect=invoke),patch.object(Client,'call',read),patch.object(Client,'mutate',mutate),patch.object(auth,'upstream_login',return_value={'token':token(),'userid':'42','expiresAt':(read_api.now()+timedelta(days=29)).isoformat(),'maskedAccount':'fixture'}):
            if not self.bridge.handle(self.ctx,'session.get',{})['data']['status']=='connected':
                result=handle_request(self.ctx,'connection/login','POST',self.body)
                assert result['ok'],result
            yield

    def run_api(self,path,method='GET',body=None):
        value=handle_request(self.ctx,path,method,body or {})
        self.assertTrue(value['ok'],value)
        return value['data']

    def create_draft(self,starts=None):
        return self.run_api('drafts','POST',{'operationId':str(uuid.uuid4()),'bindingRevision':1,'teacherId':'101','date':self.day,'slotStarts':starts or ['19:00','19:30']})

    def submit_body(self,draft):return {'operationId':str(uuid.uuid4()),'bindingRevision':1,'draftId':draft['id'],'expectedRevision':draft['revision']}

    def test_favorite_set_unset_and_operation_replay_no_duplicate_dispatch(self):
        with self.connected():
            body={'operationId':str(uuid.uuid4()),'bindingRevision':1,'favorite':True}
            result=self.run_api('teachers/101/favorite','PUT',body)
            self.assertEqual(result,{'teacherId':'101','favorite':True})
            self.assertEqual(self.run_api('teachers/101/favorite','PUT',body),result)
            self.assertEqual(len(self.sent),1)
            self.assertEqual(self.sent[0],('teacherCollect',{'userid':42,'tid':101,'status':1}))
            body={**body,'operationId':str(uuid.uuid4()),'favorite':False}
            self.assertFalse(self.run_api('teachers/101/favorite','PUT',body)['favorite'])
            self.assertEqual(self.sent[-1][1]['status'],0)
            self.assertEqual(self.fake.favorite_rows,[])

    def test_favorite_uncertain_response_reconciles_with_reads_only(self):
        with self.connected():
            self.drop='teacherCollect'
            body={'operationId':str(uuid.uuid4()),'bindingRevision':1,'favorite':True}
            self.assertTrue(self.run_api('teachers/101/favorite','PUT',body)['favorite'])
            self.assertEqual(len(self.sent),1)
            op=self.run_api('operations/'+body['operationId'])
            self.assertEqual(op['state'],'succeeded')
            self.assertEqual(len(self.sent),1)

    def test_smart_teacher_favorite_passes_contract_and_rejects_invalid_binding(self):
        with self.connected():
            original=self.fake.teacher
            with patch.object(self.fake,'teacher',side_effect=lambda tid:original(tid,smart=1)):
                body={'operationId':str(uuid.uuid4()),'bindingRevision':1,'favorite':True}
                self.run_api('teachers/101/favorite','PUT',body)
                self.assertEqual(self.sent[-1][1]['user1v1_id'],'70001')
                bad=handle_request(self.ctx,'teachers/101/favorite','PUT',{**body,'operationId':str(uuid.uuid4()),'bindingRevision':0})
                self.assertFalse(bad['ok'])
                self.assertEqual(len(self.sent),1)

    def test_two_lesson_csv_single_dispatch_persistent_receipt_and_cid_match(self):
        with self.connected():
            d=self.create_draft();self.assertTrue(d['valid']);body=self.submit_body(d)
            result=self.run_api('bookings','POST',body)
            self.assertEqual(result['state'],'succeeded');self.assertEqual(len(result['result']['bookingKeys']),2)
            self.run_api('bookings','POST',body)
            self.run_api('operations/'+body['operationId'])
            self.assertEqual(len(self.sent),1)
            self.assertEqual(self.sent[0],('onevoneAppointment',{'tid':101,'userid':42,'ddate':self.day,'dtime':'19:00','user1v1_id':'70001','lesson_period':2,'courseware_id':'501,502'}))
            self.assertEqual(self.sql('SELECT state FROM lele.plugin_external_operations WHERE operation_id=%s',(body['operationId'],)),[('succeeded',)])
            self.assertNotIn('token',json.dumps(result))

    def test_response_lost_reconciliation_never_resends(self):
        with self.connected():
            d=self.create_draft();body=self.submit_body(d);self.drop='onevoneAppointment'
            result=self.run_api('bookings','POST',body)
            self.assertEqual(result['state'],'succeeded') # Only read matching confirms.
            self.run_api('bookings','POST',body);self.assertEqual(len(self.sent),1)

    def test_ambiguous_match_cannot_claim_success_or_resend(self):
        with self.connected(),patch.object(operations,'reconcile_book',side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE','读取失败')):
            d=self.create_draft();body=self.submit_body(d);self.drop='onevoneAppointment'
            result=self.run_api('bookings','POST',body);self.assertEqual(result['state'],'uncertain')
        with self.connected():
            result=self.run_api('operations/'+body['operationId']);self.assertEqual(result['state'],'succeeded')
            self.assertEqual(len(self.sent),1)

    def test_gaps_stale_binding_and_duplicate_courseware_fail_before_write(self):
        with self.connected():
            for changes in ({'bindingRevision':0},{'slotStarts':['19:00','20:00']}):
                body={'operationId':str(uuid.uuid4()),'bindingRevision':1,'teacherId':'101','date':self.day,'slotStarts':['19:00'],**changes}
                self.assertFalse(handle_request(self.ctx,'drafts','POST',body)['ok'])
            d=self.create_draft();self.run_api(f"courseware?categoryId=5&draftId={d['id']}&slotStart=19:00")
            result=handle_request(self.ctx,f"drafts/{d['id']}/lessons/19%3A00/courseware",'PUT',{'operationId':str(uuid.uuid4()),'bindingRevision':1,'expectedRevision':1,'coursewareId':'502','source':'category'})
            self.assertEqual(result['error']['code'],'COURSEWARE_DUPLICATE');self.assertEqual(self.sent,[])

    def test_manual_choice_is_local_and_zero_quota_does_not_block_booking(self):
        with self.connected():
            d=self.create_draft(['19:00']);self.remaining=0
            self.run_api(f"courseware?categoryId=5&draftId={d['id']}&slotStart=19:00")
            changed=self.run_api(f"drafts/{d['id']}/lessons/19%3A00/courseware",'PUT',{'operationId':str(uuid.uuid4()),'bindingRevision':1,'expectedRevision':1,'coursewareId':'503','source':'category'})
            self.assertEqual(changed['state'],'succeeded');self.assertEqual(self.sent,[])
            d=changed['result']['draft'];result=self.run_api('bookings','POST',self.submit_body(d));self.assertEqual(result['state'],'succeeded')
            self.assertEqual(self.sent[0][1]['courseware_id'],'503')

    def test_preview_opens_student_file_without_debit(self):
        with self.connected():
            self.remaining=0
            self.course=lambda i:{'id':i,'title':f'合成课件{i}','category_id':5,'category_name':'测试分类','status':1,
                'student_file_url':'https://file.mison.cn/courseware/91/PU0 U4 At home L2 语音练习1.pdf' if i==501 else f'https://file.mison.cn/course{i}.pdf'}
            d=self.create_draft(['19:00']);body={'operationId':str(uuid.uuid4()),'bindingRevision':1,'draftId':d['id'],'expectedRevision':1,'slotStart':'19:00'}
            r=self.run_api('courseware/501/preview','POST',body)
            self.assertEqual(r['state'],'succeeded');self.assertNotIn('quota',r['result'])
            self.assertEqual(r['result']['resource']['mimeType'],'application/pdf')
            self.assertTrue(r['result']['resource']['url'].startswith('/api/children/'))
            stored=self.sql('SELECT upstream_url FROM lele.plugin_resource_tickets WHERE child_id=%s AND plugin_id=%s',(self.ctx['childId'],self.ctx['pluginId']))
            self.assertEqual(stored,[('https://file.mison.cn/courseware/91/PU0%20U4%20At%20home%20L2%20%E8%AF%AD%E9%9F%B3%E7%BB%83%E4%B9%A01.pdf',)])
            self.run_api('courseware/501/preview','POST',body)
            self.run_api('operations/'+body['operationId'])
            self.run_api('courseware/501/preview','POST',{**body,'operationId':str(uuid.uuid4())})
            self.assertEqual(self.sent,[]);self.assertEqual(self.remaining,0)

    def test_direct_preview_rejects_missing_or_untrusted_student_files(self):
        with self.connected():
            draft=self.create_draft(['19:00'])
            body={'bindingRevision':1,'draftId':draft['id'],'expectedRevision':1,'slotStart':'19:00'}
            bad=handle_request(self.ctx,'courseware/501/preview','POST',{**body,'operationId':str(uuid.uuid4()),'bindingRevision':0})
            self.assertEqual(bad['error']['code'],'BINDING_CHANGED')
            for url in (None,'https://example.com/student.pdf','https://file.mison.cn/teacher.pptx'):
                self.sql("UPDATE lele.plugin_private_records SET payload=jsonb_set(payload,'{_assets,501,student_file_url}',%s) WHERE child_id=%s AND record_id=%s",(Jsonb(url),self.ctx['childId'],draft['id']))
                result=handle_request(self.ctx,'courseware/501/preview','POST',{**body,'operationId':str(uuid.uuid4())})
                self.assertFalse(result['ok'])
            self.assertEqual(self.sent,[])
            self.assertEqual(self.sql('SELECT operation_id FROM lele.plugin_external_operations WHERE child_id=%s',(self.ctx['childId'],)),[])

    def test_cancel_two_steps_and_unknown_marker_read_only_recovery(self):
        with self.connected():
            d=self.create_draft(['19:00']);self.run_api('bookings','POST',self.submit_body(d))
            b=self.run_api('bookings')['items'][0];self.drop='onevoneSaveCancelLesson'
            body={'operationId':str(uuid.uuid4()),'bindingRevision':1,'snapshotVersion':b['snapshotVersion'],'adjustLessons':False}
            r=self.run_api('bookings/'+b['key']+'/cancel','POST',body);self.assertEqual(r['state'],'needs_repair')
            self.assertEqual(self.sent[-2:],[('cancelLesson',{'userid':42,'cid':9000}),('onevoneSaveCancelLesson',{'userid':42,'cid':9000,'status':1,'adjust_lessons':0})])
            r=self.run_api('operations/'+body['operationId']);self.assertEqual(r['state'],'succeeded')
            self.run_api('bookings/'+b['key']+'/cancel','POST',body);self.assertEqual(len(self.sent),3)

    def test_draft_revision_and_operation_conflict(self):
        with self.connected():
            d=self.create_draft();body=self.submit_body(d);self.reject=True
            r=self.run_api('bookings','POST',body);self.assertEqual(r['state'],'failed')
            self.run_api('bookings','POST',body);self.assertEqual(len(self.sent),1)
            bad=handle_request(self.ctx,'bookings','POST',{**body,'expectedRevision':2});self.assertEqual(bad['error']['code'],'OPERATION_CONFLICT')

    def test_draft_has_no_fixed_expiry(self):
        with self.connected():
            draft=self.create_draft()
            self.assertIsNone(draft['expiresAt'])
            self.assertEqual(self.sql('SELECT expires_at FROM lele.plugin_private_records WHERE record_id=%s',(draft['id'],)),[(None,)])
            self.assertEqual(self.sent,[])

    def legacy_draft(self):
        draft=self.create_draft(['19:00'])
        self.sql("""UPDATE lele.plugin_private_records
            SET expires_at=now()-interval '1 hour',
                payload=jsonb_set(payload,'{expiresAt}',to_jsonb('2000-01-01T00:00:00+08:00'::text))
            WHERE record_id=%s""",(draft['id'],))
        return draft

    def test_legacy_expired_draft_can_read_change_preview_and_submit(self):
        with self.connected():
            draft=self.legacy_draft()
            restored=self.run_api('drafts/'+draft['id'])
            self.assertIsNone(restored['expiresAt'])
            self.assertEqual(restored['revision'],draft['revision'])
            self.assertTrue(self.run_api(f"courseware?categoryId=5&draftId={draft['id']}&slotStart=19:00")['items'])
            preview=self.run_api('courseware/501/preview','POST',{
                'operationId':str(uuid.uuid4()),'bindingRevision':1,
                'draftId':draft['id'],'expectedRevision':draft['revision'],'slotStart':'19:00'})
            self.assertEqual(preview['state'],'succeeded')
            changed=self.run_api(f"drafts/{draft['id']}/lessons/19%3A00/courseware",'PUT',{
                'operationId':str(uuid.uuid4()),'bindingRevision':1,'expectedRevision':draft['revision'],
                'coursewareId':'503','source':'category'})
            restored=changed['result']['draft']
            self.assertIsNone(restored['expiresAt'])
            self.assertEqual(self.sql('SELECT expires_at FROM lele.plugin_private_records WHERE record_id=%s',(draft['id'],)),[(None,)])
            self.assertEqual(self.sent,[])
            self.assertEqual(self.run_api('bookings','POST',self.submit_body(restored))['state'],'succeeded')
            self.assertEqual(len(self.sent),1)
            self.assertEqual(self.sent[0][1]['courseware_id'],'503')

    def test_legacy_expired_draft_still_checks_binding_and_real_slots(self):
        with self.connected():
            draft=self.legacy_draft()
            self.sql("""UPDATE lele.plugin_private_records
                SET payload=jsonb_set(payload,'{_scope,1}','99'::jsonb) WHERE record_id=%s""",(draft['id'],))
            rejected=handle_request(self.ctx,'drafts/'+draft['id'],'GET',{})
            self.assertFalse(rejected['ok'])
            self.sql("""UPDATE lele.plugin_private_records
                SET payload=jsonb_set(payload,'{_scope,1}','1'::jsonb) WHERE record_id=%s""",(draft['id'],))
            # Simulate someone else taking the slot after this draft was created.
            self.live.append({**self.fake.record(9000,self.day+' 19:00'),'courseware_id':'501','courseid':'12345'})
            rejected=handle_request(self.ctx,'bookings','POST',self.submit_body(draft))
            self.assertEqual(rejected['error']['code'],'SLOT_UNAVAILABLE')
            self.assertEqual(self.sent,[])

    def test_legacy_expired_draft_creation_replay_and_direct_submit(self):
        with self.connected():
            draft=self.legacy_draft()
            replayed=self.run_api('drafts','POST',{
                'operationId':draft['id'],'bindingRevision':1,'teacherId':'101',
                'date':self.day,'slotStarts':['19:00']})
            self.assertEqual(replayed['id'],draft['id'])
            self.assertEqual(replayed['revision'],draft['revision'])
            bad=handle_request(self.ctx,'drafts','POST',{
                'operationId':draft['id'],'bindingRevision':1,'teacherId':'101',
                'date':self.day,'slotStarts':['19:00','19:30']})
            self.assertEqual(bad['error']['code'],'OPERATION_CONFLICT')
            self.assertEqual(self.sent,[])
            body=self.submit_body(draft)
            self.assertEqual(self.run_api('bookings','POST',body)['state'],'succeeded')
            self.run_api('bookings','POST',body)
            self.assertEqual(len(self.sent),1)
            self.assertEqual(self.sql('SELECT expires_at FROM lele.plugin_private_records WHERE record_id=%s',(draft['id'],)),[(None,)])

    def test_private_expiry_default_and_explicit_opt_in_remain_scoped(self):
        with self.connected():
            draft=self.legacy_draft()
            payload={'collection':'booking-draft','recordId':draft['id']}
            self.assertIsNone(self.bridge.handle(self.ctx,'private.get',payload)['data']['record'])
            record=self.bridge.handle(self.ctx,'private.get',{**payload,'includeExpired':True})['data']['record']
            self.assertEqual(record['payload']['id'],draft['id'])
            with self.assertRaises(ApiError):
                self.bridge.handle(self.ctx,'private.get',{**payload,'includeExpired':'true'})
            with self.assertRaises(ApiError):
                self.bridge.handle({**self.ctx,'childId':str(uuid.uuid4())},'private.get',{**payload,'includeExpired':True})

    def test_concurrent_operation_claim_only_one_wins(self):
        with self.connected():
            context=self.ctx
            def claim(i):
                try:
                    return self.bridge.handle(context,'operation.begin',{'operationId':str(uuid.uuid4()),'bindingRevision':1,'kind':'book','canonicalRequest':{'i':i}})['data']['mayExecute']
                except ApiError:return False
            with ThreadPoolExecutor(max_workers=4) as pool:outcomes=list(pool.map(claim,range(4)))
            self.assertEqual(sum(outcomes),1)

    def test_student_materials_and_app_only_learning_entry(self):
        with self.connected():
            d=self.create_draft(['19:00']);self.run_api('bookings','POST',self.submit_body(d));b=self.run_api('bookings')['items'][0]
            resource=self.run_api('bookings/'+b['key']+'/resources')['items'][0];self.assertEqual(resource['mimeType'],'application/pdf')
            r=self.run_api('bookings/'+b['key']+'/actions/classroom','POST',{'operationId':str(uuid.uuid4())})
            self.assertEqual(r['result']['resource']['action'],'instructions');self.assertEqual(len(self.sent),1)

    def test_partial_booking_and_worker_restart_reconciliation(self):
        with self.connected(),patch.object(operations,'reconcile_book',side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE','读取失败')):
            draft=self.create_draft();body=self.submit_body(draft);self.drop='onevoneAppointment'
            self.run_api('bookings','POST',body)
            saved=self.live.pop()
        for cache in (read_store.memo,read_store.cursors):cache.values.clear();cache.size=0
        read_store.teacher_cursors.clear()
        with self.connected():
            result=self.run_api('operations/'+body['operationId'])
            self.assertEqual(result['state'],'partially_succeeded')
            self.assertEqual([r['state'] for r in result['result']['lessons']],['succeeded','uncertain'])
            self.live.append(saved)
            self.assertEqual(self.run_api('operations/'+body['operationId'])['state'],'succeeded')
            self.assertEqual(len(self.sent),1)

    def test_manual_acknowledgement_only_after_lease_and_without_resend(self):
        with self.connected():
            draft=self.create_draft(['19:00']);body=self.submit_body(draft)
            self.drop='onevoneAppointment'
            with patch.object(operations,'reconcile_book',side_effect=auth.AuthError('UPSTREAM_UNAVAILABLE','读取失败')):
                self.run_api('bookings','POST',body)
            ack={'bindingRevision':1,'confirmedInApp':True}
            rejected=handle_request(self.ctx,'operations/'+body['operationId']+'/acknowledge','POST',ack)
            self.assertEqual(rejected['error']['code'],'OPERATION_IN_PROGRESS')
            self.sql("UPDATE lele.plugin_external_operations SET updated_at=now()-interval '61 seconds' WHERE operation_id=%s",(body['operationId'],))
            result=self.run_api('operations/'+body['operationId']+'/acknowledge','POST',ack)
            self.assertEqual(result['state'],'cancelled');self.assertEqual(len(self.sent),1)

    def test_terminal_request_cannot_be_dispatched_again(self):
        with self.connected():
            draft=self.create_draft(['19:00']);body=self.submit_body(draft)
            self.run_api('bookings','POST',body)
            value=self.bridge.handle(self.ctx,'operation.get',{'operationId':body['operationId']})['data']
            with self.assertRaises(ApiError):
                self.bridge.handle(self.ctx,'operation.mark-dispatch',{'operationId':body['operationId'],'canonicalRequest':value['canonicalRequest'],'expectedStageVersion':value['stageVersion']})
            self.assertEqual(len(self.sent),1)

    def test_same_upstream_account_across_children_shares_write_fence(self):
        with self.connected():
            peer=str(uuid.uuid4())
            def peer_fixture(cur):
                cur.execute("INSERT INTO lele.children(id,name,owner_id) VALUES(%s,'peer',%s)",(peer,self.user_id))
                cur.execute('INSERT INTO lele.memberships(child_id,user_id,membership_version) VALUES(%s,%s,%s)',(peer,self.user_id,str(uuid.uuid4())))
                cur.execute('INSERT INTO lele.child_plugins(child_id,plugin_id,installed,enabled) VALUES(%s,%s,true,true)',(peer,self.plugin_id))
                cur.execute('INSERT INTO lele.child_plugin_configs(child_id,plugin_id,config,config_revision) VALUES(%s,%s,%s,1)',(peer,self.plugin_id,Jsonb({'message':'ok'})))
            self.service.transaction(peer_fixture)
            from lele_growth.plugins.policy import active_context
            other=self.service.transaction(lambda cur:active_context(cur,self.plugin_id,peer));other['actorId']=self.user_id
            r=handle_request(other,'connection/login','POST',{**self.body,'operationId':str(uuid.uuid4())});self.assertTrue(r['ok'],r)
            body={'operationId':str(uuid.uuid4()),'bindingRevision':1,'kind':'book','canonicalRequest':{'request':{},'details':{}}}
            self.bridge.handle(self.ctx,'operation.begin',body)
            with self.assertRaises(ApiError) as error:self.bridge.handle(other,'operation.begin',{**body,'operationId':str(uuid.uuid4())})
            self.assertEqual(error.exception.kind,'OPERATION_IN_PROGRESS')
            with self.assertRaises(ApiError):self.bridge.handle(other,'operation.get',{'operationId':body['operationId']})
            self.assertEqual(self.sent,[])

    def test_relogin_preserves_unresolved_receipt_but_cannot_dispatch_old_binding(self):
        with self.connected():
            body={'operationId':str(uuid.uuid4()),'bindingRevision':1,'kind':'book','canonicalRequest':{'request':{},'details':{}}}
            old=self.bridge.handle(self.ctx,'operation.begin',body)['data']['operation']
            result=handle_request(self.ctx,'connection/login','POST',{**self.body,'operationId':str(uuid.uuid4()),'bindingRevision':1})
            self.assertTrue(result['ok'],result)
            saved=self.bridge.handle(self.ctx,'operation.list',{})['data']['operations']
            self.assertEqual([row['operationId'] for row in saved],[body['operationId']])
            with self.assertRaises(ApiError) as error:self.bridge.handle(self.ctx,'operation.mark-dispatch',{**body,'expectedStageVersion':old['stageVersion']})
            self.assertEqual(error.exception.kind,'BINDING_CHANGED');self.assertEqual(self.sent,[])

class UpstreamWriteTests(unittest.TestCase):
    def client(self):
        self.session={'status':'connected','bindingRevision':1,'credentialId':'test-credential','userid':'42','token':'synthetic-bearer'}
        with patch('mison_booking.upstream.session',return_value=self.session):return Client({'childId':'test-child'})

    def test_fixed_mutation_protocol_and_business_response(self):
        import io
        from unittest.mock import Mock
        opener=Mock();opener.open.return_value=io.BytesIO(b'{"code":200,"data":[]}')
        client=self.client()
        with patch('mison_booking.upstream.urllib.request.build_opener',return_value=opener):
            client.mutate('onevoneAppointment',{'lesson_period':2,'courseware_id':'501,502'})
        request=opener.open.call_args.args[0]
        self.assertEqual(request.full_url,'https://mp.mison.cn/wechatapi/onevoneAppointment')
        self.assertEqual(json.loads(request.data),{'lesson_period':2,'courseware_id':'501,502'})
        self.assertEqual(request.get_header('Authorization'),'Bearer synthetic-bearer')
        opener.open.assert_called_once()
        with self.assertRaises(auth.AuthError):client.call('onevoneAppointment',{})
        with self.assertRaises(auth.AuthError):client.mutate('arbitraryEndpoint',{})

    def test_mutation_transport_failure_is_uncertain_and_never_retried(self):
        import io,http.client
        from unittest.mock import Mock
        for error in (TimeoutError(),http.client.IncompleteRead(b'partial')):
            opener=Mock();opener.open.side_effect=error
            with patch('mison_booking.upstream.urllib.request.build_opener',return_value=opener),self.assertRaises(auth.AuthError) as caught:
                self.client().mutate('onevoneAppointment',{})
            self.assertEqual(caught.exception.code,'RESULT_UNCERTAIN');opener.open.assert_called_once()
        opener=Mock();opener.open.return_value=io.BytesIO(b'<html>bad gateway</html>')
        with patch('mison_booking.upstream.urllib.request.build_opener',return_value=opener),self.assertRaises(auth.AuthError) as caught:
            self.client().mutate('onevoneAppointment',{})
        self.assertEqual(caught.exception.code,'RESULT_UNCERTAIN');opener.open.assert_called_once()

    def test_business_rejection_is_sanitized_and_not_retried(self):
        import io
        from unittest.mock import Mock
        opener=Mock();opener.open.return_value=io.BytesIO(b'{"code":4001,"msg":"<b>conflict</b> synthetic-bearer"}')
        with patch('mison_booking.upstream.urllib.request.build_opener',return_value=opener),self.assertRaises(auth.AuthError) as caught:
            self.client().mutate('onevoneAppointment',{})
        self.assertEqual(caught.exception.code,'UPSTREAM_REJECTED');self.assertNotIn('synthetic-bearer',str(caught.exception));opener.open.assert_called_once()

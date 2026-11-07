"""Write orchestration. One durable dispatch, then read-only reconciliation."""
from copy import deepcopy
from datetime import datetime, timedelta
import re
from .auth import AuthError, bridge
from . import courseware, drafts, read_api
from .media import public_media_url

MESSAGES = {'prepared':'正在准备操作。','dispatching':'操作已发送，请核对结果。','succeeded':'操作成功。',
            'failed':'操作未完成。','uncertain':'结果待核对，请勿重复提交。','partially_succeeded':'部分课时已预约，请核对剩余课时。',
            'needs_repair':'取消记录尚未确认，请核对结果。','cancelled':'操作已结束。'}

def raw_get(client, operation_id): return bridge(client.context,'operation.get',{'operationId':drafts.uid(operation_id)})

def replay(client, body):
    operation_id = drafts.uid(body.get('operationId'))
    try: op = raw_get(client,operation_id)
    except AuthError as error:
        if error.code == 'OPERATION_NOT_FOUND': return None
        raise
    if op['canonicalRequest']['request'] != body: raise AuthError('OPERATION_CONFLICT','操作标识已用于其他请求。')
    return output(client,op)

def begin(client,kind,body,details,baseline=None):
    drafts.binding(client,body.get('bindingRevision'))
    result = bridge(client.context,'operation.begin',{'operationId':drafts.uid(body.get('operationId')),
        'bindingRevision':client.session['bindingRevision'],'kind':kind,'canonicalRequest':{'request':body,'details':details},
        'baseline':baseline or {},'resourceKeys':[kind]})
    if not result['mayExecute']: raise AuthError('RESULT_UNCERTAIN','操作已被接收，请核对结果。',body['operationId'])
    return result['operation']

def advance(client,op,action,**changes):
    try:
        return bridge(client.context,'operation.'+action,{'operationId':op['operationId'],'canonicalRequest':op['canonicalRequest'],
                      'expectedStageVersion':op['stageVersion'],**changes})['operation']
    except AuthError as error:
        raise AuthError('RESULT_UNCERTAIN','操作记录更新未确认，请核对结果，勿重复操作。',op['operationId']) from None

def finish(client,op,state,message=None,**result):
    return advance(client,op,'finish',state=state,result={'message':message or MESSAGES[state],**result})

def pdf(url,title='课件预览'):
    public=public_media_url(url,'pdf')
    if not public: raise AuthError('COURSEWARE_UNAVAILABLE','该课件没有可直接预览的学员文件。')
    return {'id':'courseware-pdf','title':title,'action':'inline','url':public,'mimeType':'application/pdf','instructions':None,'reason':None}

def output(client,op):
    result=deepcopy(op.get('result') or {})
    if result.get('_pdfUrl'):
        try: result['resource']=pdf(result['_pdfUrl'],result.get('_pdfTitle') or '课件预览')
        except AuthError:
            result['message']='课件文件暂时无法打开，请稍后重试。本次不会消耗预览次数。' if op['canonicalRequest']['details'].get('source')=='student_file_url' else '历史预览文件暂时不可用；核对时只重新加载文件，不再次扣额。'
    result={k:v for k,v in result.items() if not k.startswith('_')}
    return {'operationId':op['operationId'],'kind':op['kind'],'state':op['state'],'stageVersion':op['stageVersion'],
            'message':result.pop('message',None) or MESSAGES[op['state']],
            'canReconcile':op['state'] not in ('failed','cancelled'), 'canRepair':False,'result':result or None}

def live_rows(client,status='upcoming'):
    contract=read_api.contracts(client); values=[];seen=set()
    for page in range(1,6):
        data=client.call('getLiveList' if status=='upcoming' else 'getBackList',
             {'classid':contract['classId'],'page_size':100,'page_no':page,'courseway':0,'blockid':0,
              **({'is_lesson_status':1} if status=='completed' else {})}).get('data')
        if not isinstance(data,dict) or type(data.get('allPage')) is not int: read_api.schema()
        source=read_api.rows(data.get('list'))
        for row in source:
            cid=read_api.identifier(row.get('cid'))
            if cid not in seen:values.append(row);seen.add(cid)
        if data.get('lastPage') is True or page>=data['allPage']:return values
    raise AuthError('QUERY_TOO_LARGE','预约记录过多，本次未发送操作，请缩小范围后重试。')

def validate_courses(client,draft):
    recommended,_=courseware.recommend(client,len(draft['lessons']))
    available={item['id']:item for item in recommended}
    for lesson in draft['lessons']:
        selected=lesson['courseware']
        if not selected: raise AuthError('COURSEWARE_REQUIRED','请先选择课件。')
        if lesson['origin']!='recommended':
            asset=draft['_assets'].get(selected['id'],{})
            page=asset.get('_page');category=asset.get('category_id')
            if not page or not category: raise AuthError('QUERY_EXPIRED','课件选择已过期，请重新选择。')
            values=read_api.rows(client.call('getCoursewareList',{'category_id':int(category),'page':page,'limit':20,
                        'user1v1_id':read_api.contracts(client)['id'],'splitPage':1}).get('data'))
            available.update({str(row['id']):courseware.remember(client,row) for row in values})
        current=available.get(selected['id'])
        if not current or not current['active'] or current['selectedElsewhere']:
            raise AuthError('COURSEWARE_UNAVAILABLE','所选课件已不可用，请返回重新选择。')

def book(client,body):
    if set(body)!={'operationId','bindingRevision','draftId','expectedRevision'}:read_api.invalid()
    previous=replay(client,body)
    if previous:return previous
    drafts.binding(client,body['bindingRevision']);record=drafts.get_record(client,body['draftId']);draft=record['payload']
    drafts.expected(draft,body['expectedRevision']);drafts.check_editable(client,draft);drafts.refresh_valid(draft)
    if not draft['valid']: raise AuthError('COURSEWARE_REQUIRED','请先补齐有效且不重复的课件。')
    drafts.slots(client,draft['teacher']['id'],draft['date'],[item['start'] for item in draft['lessons']])
    validate_courses(client,draft)
    baseline=live_rows(client)
    details={'draftId':draft['id'],'teacher':draft['teacher'],'date':draft['date'],'lessons':draft['lessons']}
    op=begin(client,'book',body,details,{'cids':[str(row['cid']) for row in baseline]})
    try:
        drafts.lock(client,record,op['operationId'])
        # Second availability read inside the account lock; no stale schedule write.
        drafts.slots(client,draft['teacher']['id'],draft['date'],[item['start'] for item in draft['lessons']])
    except AuthError as error:return output(client,finish(client,op,'failed',str(error)))
    op=advance(client,op,'mark-dispatch',stage='appointment_sent')
    payload={'tid':int(draft['teacher']['id']),'userid':client.userid,'ddate':draft['date'],
             'dtime':draft['lessons'][0]['start'],'user1v1_id':read_api.contracts(client)['id'],
             'lesson_period':len(draft['lessons']),'courseware_id':','.join(item['courseware']['id'] for item in draft['lessons'])}
    try:client.mutate('onevoneAppointment',payload)
    except AuthError as error:
        state='failed' if error.code in ('UPSTREAM_REJECTED','RECONNECT_REQUIRED') else 'uncertain'
        op=finish(client,op,state,str(error))
    else:op=finish(client,op,'succeeded','预约成功。',bookingKeys=[],pendingRecordSync=True)
    if op['state'] in ('succeeded','uncertain'):
        try:op=reconcile_book(client,op)
        except AuthError:pass
    return output(client,op)

def reconcile_book(client,op):
    rows=live_rows(client);details=op['canonicalRequest']['details'];baseline=set(op['baseline']['cids']);contract=read_api.contracts(client)
    found=[];items=[]
    for lesson in details['lessons']:
        expected=details['date']+'T'+lesson['start']
        candidates=[]
        for raw in rows:
            value=read_api.booking(client,contract,'upcoming',raw)
            if value['cid'] in baseline or not value['startsAt'].startswith(expected) or not value['courseware'] or value['courseware']['id']!=lesson['courseware']['id']:continue
            teacher=value['teacher']
            if (teacher['id']==details['teacher']['id'] if teacher['id'] else teacher['name'].strip().casefold()==details['teacher']['name'].strip().casefold()):candidates.append(value)
        if len(candidates)==1:found.append(candidates[0]['key'])
        items.append({'start':lesson['start'],'coursewareTitle':lesson['courseware']['title'],'state':'succeeded' if len(candidates)==1 else 'uncertain'})
    all_found=len(found)==len(details['lessons'])
    if op['state']=='succeeded':
        # A positive appointment acknowledgement is definitive; list lag isn't failure.
        if op.get('result',{}).get('pendingRecordSync'):
            # Terminal receipts stay immutable. Resource keys can be re-read by the client.
            op={**op,'result':{**op['result'],'bookingKeys':found,'pendingRecordSync':not all_found,'lessons':items}}
        return op
    if all_found:return finish(client,op,'succeeded','已核对，预约成功。',bookingKeys=found,lessons=items)
    if found:return finish(client,op,'partially_succeeded',bookingKeys=found,lessons=items)
    return op

def change(client,draft_id,start,body):
    if set(body)!={'operationId','bindingRevision','expectedRevision','coursewareId','source'}:read_api.invalid()
    body={**body,'draftId':draft_id,'slotStart':start}
    previous=replay(client,body)
    if previous:return previous
    record=drafts.get_record(client,draft_id);draft=record['payload'];drafts.check_editable(client,draft);drafts.expected(draft,body['expectedRevision'])
    lesson=next((item for item in draft['lessons'] if item['start']==start),None)
    if not lesson:read_api.invalid()
    selected=courseware.remember(client,courseware.raw(client,body['coursewareId']))
    if not selected['active'] or selected['selectedElsewhere']:raise AuthError('COURSEWARE_UNAVAILABLE','该课件不可选择。')
    if any(item['start']!=start and item['courseware'] and item['courseware']['id']==selected['id'] for item in draft['lessons']):raise AuthError('COURSEWARE_DUPLICATE','本次其他课时已选择该课件。')
    op=begin(client,'change-draft',body,{'draftId':draft_id})
    try:
        lesson.update(courseware=selected,origin='unlearned' if body['source']=='unlearned' else 'manual')
        draft['_assets'][selected['id']]=drafts.asset(client,selected);draft['revision']+=1;draft['_lockedBy']=None
        draft['_receipts'][op['operationId']]=drafts.digest(body)
        drafts.refresh_valid(draft);drafts.put(client,draft,record['revision'])
    except AuthError as error:return output(client,finish(client,op,'uncertain' if error.code == 'UPSTREAM_UNAVAILABLE' else 'failed',str(error)))
    return output(client,finish(client,op,'succeeded','课件已更新；选择本身不消耗预览次数。',draft=drafts.public(draft)))

def preview(client,course_id,body):
    if set(body)!={'operationId','bindingRevision','draftId','expectedRevision','slotStart'}:read_api.invalid()
    body={**body,'coursewareId':course_id};previous=replay(client,body)
    if previous:return previous
    drafts.binding(client,body['bindingRevision'])
    record=drafts.get_record(client,body['draftId']);draft=record['payload'];drafts.expected(draft,body['expectedRevision']);drafts.check_editable(client,draft)
    lesson=next((item for item in draft['lessons'] if item['start']==body['slotStart']),None)
    if not lesson or not lesson['courseware'] or lesson['courseware']['id']!=course_id:read_api.invalid('预览课件不属于当前课时。')
    asset=draft.get('_assets',{}).get(course_id) or {}
    url=asset.get('student_file_url')
    pdf(url,asset.get('title') or '课件预览')
    op=begin(client,'preview',body,{'draftId':draft['id'],'source':'student_file_url'})
    op=finish(client,op,'succeeded','已打开学员课件。',_pdfUrl=url,_pdfTitle=asset.get('title') or '课件预览')
    return output(client,op)

def favorite_result(value):
    if value['state'] == 'succeeded': return value['result']
    raise AuthError('RESULT_UNCERTAIN' if value['state'] not in ('failed','cancelled') else 'UPSTREAM_REJECTED',
                    value['message'], value['operationId'])

def reconcile_favorite(client, op):
    details = op['canonicalRequest']['details']
    collected = {read_api.identifier(row['tid']) for row in read_api.rows(client.call('getTeacherCollect', {'userid': client.userid}).get('data'))}
    if (details['teacherId'] in collected) == details['favorite']:
        return finish(client, op, 'succeeded', '收藏状态已更新。', **details)
    return op

def favorite(client, tid, body):
    if set(body) != {'operationId','bindingRevision','favorite'} or type(body['favorite']) is not bool: read_api.invalid()
    tid = read_api.identifier(tid)
    body = {**body, 'teacherId': tid}
    previous = replay(client, body)
    if previous: return favorite_result(previous)
    drafts.binding(client, body['bindingRevision'])
    info = client.call('onevoneGetTeacherInfo', {'tid': int(tid), 'userid': client.userid, 'ddate': read_api.now().date().isoformat()}).get('data')
    if not isinstance(info, dict) or str(info.get('tid')) != tid: read_api.schema()
    payload = {'tid': int(tid), 'userid': client.userid, 'status': int(body['favorite'])}
    if info.get('is_smart_matching') in (1, '1'):
        payload['user1v1_id'] = read_api.contracts(client)['id']
    details = {'teacherId': tid, 'favorite': body['favorite']}
    op = begin(client, 'favorite', body, details)
    op = advance(client, op, 'mark-dispatch', stage='favorite_sent')
    try:
        client.mutate('teacherCollect', payload)
    except AuthError as error:
        op = finish(client, op, 'failed' if error.code in ('UPSTREAM_REJECTED','RECONNECT_REQUIRED') else 'uncertain', str(error))
        if op['state'] == 'uncertain':
            try: op = reconcile_favorite(client, op)
            except AuthError: pass
    else:
        op = finish(client, op, 'succeeded', '收藏状态已更新。', **details)
    return favorite_result(output(client, op))

def get(client,operation_id):
    op=raw_get(client,operation_id)
    if op['kind']=='book' and op['state'] in ('dispatching','uncertain','partially_succeeded','succeeded'):
        op=reconcile_book(client,op)
    elif op['kind']=='favorite' and op['state'] in ('dispatching','uncertain'):
        op=reconcile_favorite(client,op)
    elif op['kind']=='cancel' and op['state'] in ('dispatching','uncertain','needs_repair'):
        op=reconcile_cancel(client,op)
    elif op['kind']=='change-draft' and op['state'] in ('prepared','uncertain'):
        record=drafts.get_record(client,op['canonicalRequest']['details']['draftId']);draft=record['payload']
        if op['operationId'] in draft['_receipts']:op=finish(client,op,'succeeded','课件已更新。',draft=drafts.public(draft))
    if op['state']=='prepared' and datetime.fromisoformat(op['updatedAt'])+timedelta(seconds=60)<read_api.now():
        op=finish(client,op,'cancelled','操作在发送前中断，可重新选择后提交。')
    return output(client,op)

def lookup_booking(client,key,statuses=('upcoming',)):
    if not re.fullmatch(r'[a-f0-9]{64}',key or ''):read_api.invalid()
    contract=read_api.contracts(client)
    for status in statuses:
        for row in live_rows(client,status):
            value=read_api.booking(client,contract,status,row)
            if value['key']==key:return value,row
    raise AuthError('BOOKING_CHANGED','课程状态已改变，请刷新我的预约。')

def cancel(client,key,body):
    if set(body)!={'operationId','bindingRevision','snapshotVersion','adjustLessons'} or body.get('adjustLessons') is not False:read_api.invalid('本次仅支持取消当前课程，不自动顺延。')
    body={**body,'bookingKey':key};previous=replay(client,body)
    if previous:return previous
    value,row=lookup_booking(client,key)
    if body['snapshotVersion']!=value['snapshotVersion']:raise AuthError('REVISION_CONFLICT','课程记录已改变，请刷新预约。')
    if not value['actions'].get('cancel',{}).get('allowed'):raise AuthError('ACTION_UNAVAILABLE','该课程已临近上课，请在美森App确认取消规则。')
    from .course_sync import _lesson
    contract = read_api.contracts(client)
    sync = {'accountId': str(client.session['userid']), 'contractId': contract['id'],
            'lesson': _lesson({**row, 'dateTime': row.get('datestart')}, 'cancelled')}
    op=begin(client,'cancel',body,{'booking':value, 'courseSync': sync})
    op=advance(client,op,'mark-dispatch',stage='cancel_sent')
    try:
        data=client.mutate('cancelLesson',{'userid':client.userid,'cid':int(value['cid'])}).get('data')
    except AuthError as error:return output(client,finish(client,op,'failed' if error.code in ('UPSTREAM_REJECTED','RECONNECT_REQUIRED') else 'uncertain',str(error)))
    if not isinstance(data,dict) or data.get('status')!=1:
        # Status 2 has penalty confirmation in the App; never accept it implicitly.
        return output(client,finish(client,op,'failed' if isinstance(data,dict) and data.get('status') == 3 else 'uncertain','美森取消规则需进一步确认，请在美森App处理。'))
    op=advance(client,op,'stage',stage='cancel_confirmed')
    op=advance(client,op,'stage',stage='marker_sent')
    try:client.mutate('onevoneSaveCancelLesson',{'cid':int(value['cid']),'status':1,'userid':client.userid,'adjust_lessons':0})
    except AuthError as error:return output(client,finish(client,op,'needs_repair','取消处理已开始，取消记录尚未确认。请核对结果，勿重复取消。'))
    return output(client,finish(client,op,'succeeded','课程已取消。'))

def reconcile_cancel(client,op):
    value=op['canonicalRequest']['details']['booking'];contract=read_api.contracts(client)
    raw=client.call('onevoneGetCancelLesson',{'userid':client.userid,'classid':contract['id'],'page':1,'limit':1000})
    cancelled=read_api.rows(raw.get('data'))
    count=raw.get('count')
    if type(count) is int and count>len(cancelled):return op
    matches=[]
    for row in cancelled:
        item=read_api.booking(client,contract,'cancelled',row)
        if (item['cid']==value['cid'] if item['cid'] else item['startsAt']==value['startsAt'] and item['teacher']['name']==value['teacher']['name'] and item['courseware'] and value['courseware'] and item['courseware']['id']==value['courseware']['id']):matches.append(item)
    if len(matches)==1 and all(str(row['cid'])!=value['cid'] for row in live_rows(client)):
        return finish(client,op,'succeeded','已核对，课程已取消。')
    return op

def resources(client,key):
    value,row=lookup_booking(client,key,('upcoming','completed'))
    data=client.call('courseClassResource',{'lessonid':row['courseid'],'type':'live' if value['status']=='upcoming' else 'back',
                     'cid':int(value['cid']),'producttype':row.get('producttype','')}).get('data')
    items=[]
    for item in read_api.rows(data):
        url=item.get('filepath')
        if item.get('use_type') not in (1, '1', None): continue
        if isinstance(url,str) and urlsplit_path_pdf(url):
            if not url.startswith('https://'):
                data = client.call('downloadPdf', {'fid': int(read_api.identifier(item.get('id')))}).get('data')
                url = data.get('file_url') if isinstance(data, dict) else None
            if isinstance(url, str) and url.startswith('https://') and urlsplit_path_pdf(url):
                items.append(pdf(url,read_api.text(item.get('title') or item.get('filename') or item.get('name'),200) or '课程资料'))
            if len(items) >= 10: break
    if not items:
        items=[{'id':'materials-app','title':'课程资料','action':'instructions','url':None,'mimeType':None,
                'instructions':'该课程暂无可在PC预览的学生PDF。请打开美森App → 一对一约课 → 我的预约 → 课程资料查看其他文件。','reason':None}]
    return {'items':items}

def urlsplit_path_pdf(url):
    from urllib.parse import urlsplit
    return urlsplit(url).path.lower().endswith('.pdf')

def learning(client,key,kind,body):
    if kind not in ('classroom','replay','prestudy','homework'):read_api.invalid()
    value,_=lookup_booking(client,key,('upcoming',) if kind in ('classroom','prestudy') else ('completed',))
    title={'classroom':'去上课','replay':'观看课程','prestudy':'课前预习','homework':'课后作业'}[kind]
    resource={'id':kind+'-app','title':title,'action':'instructions','url':None,'mimeType':None,
              'instructions':f'该课程的{title}使用美森App专属入口。请打开美森App → 一对一约课 → 我的预约 → {title}。','reason':None}
    return {'operationId':drafts.uid(body.get('operationId')),'state':'succeeded','stageVersion':1,'message':'请在美森App继续。','result':{'resource':resource}}

def acknowledge(client,operation_id,body):
    if set(body)!={'bindingRevision','confirmedInApp'} or body['confirmedInApp'] is not True:read_api.invalid()
    drafts.binding(client,body['bindingRevision'])
    op=raw_get(client,operation_id)
    if op['state'] in ('succeeded','failed','cancelled'):return output(client,op)
    if datetime.fromisoformat(op['updatedAt'])+timedelta(seconds=60)>read_api.now():
        raise AuthError('OPERATION_IN_PROGRESS','操作可能仍在执行，请至少一分钟后再处理。')
    return output(client,finish(client,op,'cancelled','已按你的确认结束核对；此操作不会取消或重发任何美森课程。',**{k:v for k,v in (op.get('result') or {}).items() if k!='message'}))

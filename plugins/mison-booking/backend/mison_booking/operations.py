"""Write orchestration. One durable dispatch, then read-only reconciliation."""
from copy import deepcopy
from datetime import datetime, timedelta
import re
from .auth import AuthError, bridge
from . import course_sync, courseware, drafts, read_api
from .media import public_media_url

MESSAGES = {'prepared':'正在准备操作。','dispatching':'操作已发送，请核对结果。','succeeded':'操作成功。',
            'failed':'操作未完成。','uncertain':'结果待核对，请勿重复提交。','partially_succeeded':'部分课时已预约，请核对剩余课时。',
            'needs_repair':'取消记录尚未确认，请核对结果。','cancelled':'操作已结束。'}


class NotDispatched(AuthError):
    """Local admission failed before handing the write to the transport."""


def raw_get(client, operation_id, *, settle_cancelled=False):
    body = {'operationId': drafts.uid(operation_id)}
    if settle_cancelled:
        body['settleCancelled'] = True
    return bridge(client.context, 'operation.get', body)

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

def live_rows(client,status='upcoming', *, max_pages=5):
    contract=read_api.contracts(client); values=[];seen=set()
    for page in range(1,max_pages + 1):
        data=client.call('getLiveList' if status=='upcoming' else 'getBackList',
             {'classid':contract['classId'],'page_size':100,'page_no':page,'courseway':0,'blockid':0,
              **({'is_lesson_status':1} if status=='completed' else {})}).get('data')
        if not isinstance(data,dict) or type(data.get('allPage')) is not int or data['allPage'] < 0: read_api.schema()
        complete=read_api._listed_complete(data,page)
        source=read_api.rows(data.get('list'))
        for row in source:
            cid=read_api.identifier(row.get('cid'))
            if cid not in seen:values.append(row);seen.add(cid)
        if complete:return values
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


def booking_failure(error):
    details = {'errorCode': error.code, 'retryAfter': error.retry_after}
    if isinstance(error, drafts.UnavailableSlots):
        details['unavailableStarts'] = error.starts
    return details


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
        if client.context.get('jobId'):
            occupied_dates = set()
            for status in ('upcoming', 'completed'):
                for row in live_rows(client, status, max_pages=100):
                    raw_date = row.get('datestart')
                    if not isinstance(raw_date, str) or not re.match(r'^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}', raw_date):
                        read_api.schema('已有课程日期不完整，未提交自动预约。')
                    occupied_dates.add(read_api.date_arg(raw_date[:10]))
            if draft['date'] in occupied_dates:
                raise AuthError('AUTO_BOOKING_DAY_OCCUPIED', '当天已有课程，本次没有提交预约。')
            bridge(client.context, 'autoBooking.guard', {})
    except AuthError as error:
        details = {**booking_failure(error), 'notDispatched': True} if client.context.get('jobId') else {}
        return output(client, finish(client, op, 'failed', str(error), **details))
    payload={'tid':int(draft['teacher']['id']),'userid':client.userid,'ddate':draft['date'],
             'dtime':draft['lessons'][0]['start'],'user1v1_id':read_api.contracts(client)['id'],
             'lesson_period':len(draft['lessons']),'courseware_id':','.join(item['courseware']['id'] for item in draft['lessons'])}
    # Prepare anything that may read Mison before marking dispatch. Afterwards,
    # only the guarded write may run, so a denial has an unambiguous origin.
    op=advance(client,op,'mark-dispatch',stage='appointment_sent')
    try:client.mutate('onevoneAppointment',payload)
    except AuthError as error:
        unsent = isinstance(error, NotDispatched)
        state='failed' if unsent or error.code in ('UPSTREAM_REJECTED','RECONNECT_REQUIRED','UPSTREAM_RATE_LIMITED') else 'uncertain'
        op=finish(client,op,state,str(error),errorCode=error.code,retryAfter=error.retry_after,
                  **({'notDispatched': True} if unsent else {}))
    else:op=finish(client,op,'succeeded','预约成功。',bookingKeys=[],pendingRecordSync=True)
    if op['state'] in ('succeeded','uncertain'):
        try:op=reconcile_book(client,op)
        except AuthError:pass
    return output(client,op)

def reconcile_book(client,op):
    details=op['canonicalRequest']['details'];baseline=set(op['baseline']['cids']);contract=read_api.contracts(client)
    rows=[('upcoming',row) for row in live_rows(client)]
    if details['date'] <= read_api.now().date().isoformat():
        rows += [('completed',row) for row in live_rows(client,'completed',max_pages=100 if client.context.get('jobId') else 5)]
    unique={}
    for status,row in rows:
        unique.setdefault(read_api.identifier(row.get('cid')),(status,row))
    available = []
    for cid, (status, raw) in unique.items():
        if cid in baseline:
            continue
        value = read_api.booking(client, contract, status, raw)
        teacher = value['teacher']
        same_teacher = (teacher['id'] == details['teacher']['id'] if teacher['id'] else
                        teacher['name'].strip().casefold() == details['teacher']['name'].strip().casefold())
        if same_teacher and value['startsAt'][:10] == details['date']:
            available.append((value, course_sync._lesson(raw, status)))

    lessons = details['lessons']
    if len(lessons) > 1:
        expected_ids = [lesson['courseware']['id'] for lesson in lessons]
        expected_end = lessons[-1].get('end')
        groups = [(value, row) for value, row in available if not row['invalid']
                  and row['startTime'] == lessons[0]['start'] and row.get('coursewareIds') == expected_ids
                  and (expected_end is None or row['endTime'] == expected_end)]
        if len(groups) > 1:
            return op
        if groups:
            value, row = groups[0]
            evidence = {key: row[key] for key in ('cid', 'date', 'startTime', 'endTime', 'teacherId', 'teacherName',
                                                'coursewareId', 'coursewareIds', 'bookingId', 'bid')}
            result = {'bookingKeys': [value['key']], 'bookingEvidence': [evidence],
                      'lessons': [{'start': item['start'], 'coursewareTitle': item['courseware']['title'], 'state': 'succeeded'}
                                  for item in lessons]}
            if op['state'] == 'succeeded':
                if (op.get('result') or {}).get('pendingRecordSync'):
                    return {**op, 'result': {**op['result'], **result, 'pendingRecordSync': False}}
                return op
            return finish(client, op, 'succeeded', '已核对，预约成功。', **result)

    found=[];items=[];booking_evidence=[]
    for lesson in lessons:
        candidates = [(value, row) for value, row in available if row['startTime'] == lesson['start']
                      and row['coursewareId'] == lesson['courseware']['id']]
        if len(candidates)==1:
            value, source_evidence = candidates[0]
            found.append(value['key'])
            booking_evidence.append({'cid':value['cid'],'date':details['date'],'startTime':lesson['start'],
                'teacherId':value['teacher']['id'],'teacherName':value['teacher']['name'],
                'coursewareId':lesson['courseware']['id'],'bookingId':source_evidence['bookingId'],'bid':source_evidence['bid']})
        items.append({'start':lesson['start'],'coursewareTitle':lesson['courseware']['title'],'state':'succeeded' if len(candidates)==1 else 'uncertain'})
    all_found=len(found)==len(details['lessons'])
    if op['state']=='succeeded':
        # A positive appointment acknowledgement is definitive; list lag isn't failure.
        if op.get('result',{}).get('pendingRecordSync'):
            # Terminal receipts stay immutable. Resource keys can be re-read by the client.
            op={**op,'result':{**op['result'],'bookingKeys':found,'bookingEvidence':booking_evidence,'pendingRecordSync':not all_found,'lessons':items}}
        return op
    if all_found:return finish(client,op,'succeeded','已核对，预约成功。',bookingKeys=found,bookingEvidence=booking_evidence,lessons=items)
    if found:
        previous = op.get('result') or {}
        previous_starts = [item['start'] for item in previous.get('lessons', []) if item['state'] == 'succeeded']
        confirmed = dict(zip(previous_starts, previous.get('bookingKeys', [])))
        current = {item['startTime']: key for item, key in zip(booking_evidence, found)}
        if op['state'] == 'partially_succeeded' and current.keys() <= confirmed.keys():
            return op  # Keep the receipt and its acknowledgement wait when the list regresses.
        # The booking request fixes each lesson's start. Keep the first confirmed
        # receipt for a lesson if a subsequent list response temporarily omits it.
        confirmed = {**current, **confirmed}
        evidence = {item['startTime']: item for item in booking_evidence}
        evidence.update({item['startTime']: item for item in previous.get('bookingEvidence', [])})
        ordered_starts = [item['start'] for item in items if item['start'] in confirmed]
        for item in items:
            if item['start'] in confirmed:
                item['state'] = 'succeeded'
        keys = [confirmed[start] for start in ordered_starts]
        evidence = [evidence[start] for start in ordered_starts if start in evidence]
        if len(set(keys)) == len(details['lessons']):
            return finish(client, op, 'succeeded', '已核对，预约成功。', bookingKeys=keys,
                          bookingEvidence=evidence, lessons=items)
        return finish(client, op, 'partially_succeeded', bookingKeys=keys, bookingEvidence=evidence, lessons=items)
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
    contract = read_api.contracts(client)
    sync = {'accountId': str(client.session['userid']), 'contractId': contract['id'],
            'lesson': course_sync._lesson({**row, 'dateTime': row.get('datestart')}, 'cancelled')}
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
    details = op['canonicalRequest']['details']
    value = details['booking']
    known = details.get('courseSync', {}).get('lesson', {})
    identity = {**known, 'cid': value['cid']}
    requested_ids = course_sync.courseware_ids((value.get('courseware') or {}).get('id'))
    contract = read_api.contracts(client)
    raw=client.call('onevoneGetCancelLesson',{'userid':client.userid,'classid':contract['id'],'page':1,'limit':1000})
    cancelled=read_api.rows(raw.get('data'))
    count=raw.get('count')
    if type(count) is int and count>len(cancelled):return op
    identified = []
    fallback = []
    for row in cancelled:
        evidence = course_sync._lesson(row, 'cancelled')
        if course_sync.matches_identity(identity, evidence):
            identified.append(evidence)
            continue
        if evidence['cid'] or any(known.get(key) and evidence.get(key) and known[key] != evidence[key]
                                  for key in ('bookingId', 'bid')):
            continue
        item = read_api.booking(client, contract, 'cancelled', row)
        if (item['startsAt'] == value['startsAt'] and item['teacher']['name'] == value['teacher']['name']
                and requested_ids and course_sync.courseware_ids(row.get('courseware_id')) == requested_ids
                and (len(requested_ids) == 1 or item['timeLabel'] == value['timeLabel'])):
            fallback.append(evidence)
    matches = identified or fallback
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
    op=raw_get(client,operation_id,settle_cancelled=True)
    if op['state'] in ('succeeded','failed','cancelled'):return output(client,op)
    if datetime.fromisoformat(op['updatedAt'])+timedelta(seconds=60)>read_api.now():
        raise AuthError('OPERATION_IN_PROGRESS','操作可能仍在执行，请至少一分钟后再处理。')
    try:
        op = finish(client, op, 'cancelled', '已按你的确认结束核对；此操作不会取消或重发任何美森课程。',
                    **{key: value for key, value in (op.get('result') or {}).items() if key != 'message'})
    except AuthError as error:
        if error.code != 'RESULT_UNCERTAIN':
            raise
        op = raw_get(client, operation_id, settle_cancelled=True)
        if op['state'] not in ('succeeded', 'failed', 'cancelled'):
            raise
    return output(client, op)

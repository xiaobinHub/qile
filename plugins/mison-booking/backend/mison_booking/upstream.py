"""Fixed Mison read/write adapters. Fixed endpoint allowlist; existing token is never refreshed here."""
import json
import http.client
import re
import time
import urllib.error
import urllib.request
from .auth import AuthError, NoRedirect, bridge, session
from .read_store import scope

API = {'myOneToOneList', 'myCourseList', 'getLiveList', 'getBackList', 'courseClassResource', 'downloadPdf'}
MP = {'onevoneSearchTeacher', 'onevoneGetDaysAvailable', 'onevoneGetTeacherInfo',
      'getTeacherLabelGroups', 'onevoneTimeTemplateV2', 'getTeacherCollect', 'onevoneGetCancelLesson',
      'getRecommendCourseware', 'getCoursewareCategoryTree', 'getCoursewareList',
      'onevoneGetChangeCoursewareTimes', 'onevoneGetCancelCourseware'}
WRITES = {'teacherCollect', 'onevoneAppointment', 'cancelLesson', 'onevoneSaveCancelLesson'}

class Client:
    def __init__(self, context):
        self.context = context
        self.session = session(context)
        if self.session['status'] != 'connected':
            raise AuthError('RECONNECT_REQUIRED', '请先登录美森网课账号。')
        self.scope = scope(context, self.session)
        self.deadline = time.monotonic() + 35
        self.userid = int(self.session['userid'])

    def call(self, endpoint, body):
        return self._request(endpoint, body, False)

    def mutate(self, endpoint, body):
        if endpoint not in WRITES:
            raise AuthError('ACTION_UNAVAILABLE', '该写入操作尚未接入。')
        return self._request(endpoint, body, True)

    def _request(self, endpoint, body, writing):
        if endpoint not in (WRITES if writing else API | MP):
            raise AuthError('ACTION_UNAVAILABLE', '该操作尚未接入。')
        remaining = self.deadline - time.monotonic()
        if remaining < 1:
            raise AuthError('RESULT_UNCERTAIN' if writing else 'UPSTREAM_UNAVAILABLE', '美森请求超时，请核对操作结果。' if writing else '美森查询超时，请稍后刷新。')
        url = ('https://api.mison.cn/v2/course/' if endpoint in API else 'https://mp.mison.cn/wechatapi/') + endpoint
        if endpoint == 'downloadPdf': url = 'https://api.mison.cn/v2/download/pdf'
        request = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
                    headers={'Content-Type': 'application/json', 'Accept': 'application/json',
                             'Authorization': 'Bearer ' + self.session['token']})
        http_status = 200
        try:
            try:
                response = urllib.request.build_opener(NoRedirect()).open(request, timeout=min(10, remaining))
            except urllib.error.HTTPError as error:
                if error.code in (401, 403): self.expired()
                http_status, response = error.code, error
            with response:
                raw = bytearray()
                while True:
                    if time.monotonic() > self.deadline:
                        raise TimeoutError()
                    chunk = response.read(65536)
                    if not chunk: break
                    raw.extend(chunk)
                    if len(raw) > 3 * 1024 * 1024:
                        raise AuthError('RESULT_UNCERTAIN' if writing else 'UPSTREAM_SCHEMA_CHANGED', '美森响应过大，请核对操作结果。')
                value = json.loads(raw)
        except (OSError, ValueError, http.client.HTTPException):
            raise AuthError('RESULT_UNCERTAIN' if writing else 'UPSTREAM_UNAVAILABLE', '美森未返回完整结果，请核对操作状态。' if writing else '美森查询服务暂时不可用，请稍后刷新。') from None
        if not isinstance(value, dict):
            raise AuthError('RESULT_UNCERTAIN' if writing else 'UPSTREAM_SCHEMA_CHANGED', '美森响应格式异常，请核对操作结果。')
        code = value.get('status' if endpoint in API else 'code')
        if code in (13000, 50000): self.expired()
        if writing and (http_status >= 500 or http_status in (301, 302, 307, 308) or type(code) is not int):
            raise AuthError('RESULT_UNCERTAIN', '美森响应异常，请核对操作结果。')
        if http_status != 200 or code != (0 if endpoint in API else 200):
            message = re.sub(r'<[^>]*>', '', str(value.get('msg') or '美森查询失败，请稍后刷新。'))
            raise AuthError('UPSTREAM_REJECTED', message.replace(self.session['token'], '***')[:160])
        return value

    def expired(self):
        try:
            bridge(self.context, 'session.invalidate', {'credentialId': self.session['credentialId'],
                                                      'bindingRevision': self.session['bindingRevision']})
        except AuthError:
            pass
        raise AuthError('RECONNECT_REQUIRED', '美森登录已失效，请重新登录。')

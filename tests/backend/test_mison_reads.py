"""Read adapters with synthetic upstream records. No external service or business writes."""
from copy import deepcopy
from datetime import datetime, timedelta
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'plugins/mison-booking/backend'), str(ROOT/'packages/plugin-sdk-python/src')]
from mison_booking import read_api as api, read_store, images, media, auth, handle_request
from mison_booking.upstream import Client

class FakeClient:
    def __init__(self):
        self.scope = ('child-a', 1, 'credential-a')
        self.userid = 987654
        self.context = {'childId': 'child-a'}
        self.session = {'bindingRevision': 1, 'credentialId': 'credential-a'}
        self.calls = []
        self.today = api.now().date().isoformat()
        self.contracts = [{'id': 70001, 'courseid': 90001, 'gradeid': 60001, 'gradestatus': '正常',
                           'endtime': '2099-01-01 00:00', 'name': '测试一对一', 'type': '合成课程'}]
        self.courses = [{'classid': 90001, 'liveid': 70001, 'new_liveid': 60001, 'expire': False}]
        self.search_pages = {}
        self.smart_count = 0
        self.favorite_rows = []
        self.booking_pages = {}
        self.cancel_pages = {}
        self.search_teacher = self.teacher(101)

    def teacher(self, tid, smart=0, labels=None):
        return {'tid': tid, 'name': f'Teacher {tid}', 'intro': '合成教师', 'labels': labels or ['互动'],
                'ddate': self.today, 'dtime': '19:00', 'is_smart_matching': smart, 'collect': 0,
                'headerUrl': 'https://mp.mison.cn/public/fixture.jpg'}

    def record(self, cid, start='2099-01-02 19:00'):
        return {'cid': cid, 'tid': 101, 'teachername': '合成教师', 'datestart': start, 'dateend': '19:25',
                'course_name': '合成课件', 'courseware_id': '10001', 'headerUrl': ''}

    def call(self, endpoint, body):
        self.calls.append((endpoint, deepcopy(body)))
        if endpoint == 'myOneToOneList': return {'data': deepcopy(self.contracts)}
        if endpoint == 'myCourseList': return {'data': deepcopy(self.courses)}
        if endpoint == 'getTeacherLabelGroups':
            return {'data': [{'category_id': 1, 'name': '风格', 'list': [{'label_id': 12, 'name': '互动'}, {'label_id': 13, 'name': '亲和'}]}]}
        if endpoint == 'onevoneTimeTemplateV2': return {'data': ['19:00', '19:30']}
        if endpoint == 'onevoneSearchTeacher':
            return {'data': deepcopy(self.search_pages.get(body['page'], [self.search_teacher])), 'smart_count': self.smart_count}
        if endpoint == 'getTeacherCollect': return {'data': deepcopy(self.favorite_rows)}
        if endpoint == 'onevoneGetDaysAvailable': return {'data': [1, 0, 1]}
        if endpoint == 'onevoneGetTeacherInfo':
            return {'data': {**self.teacher(int(body['tid'])), 'lessonTime': '25分钟/课时',
                'all_date': [{'dtime': '19:00', 'is_dated': -1}, {'dtime': '19:30', 'is_dated': 0},
                             {'dtime': '20:00', 'is_dated': self.userid}, {'dtime': '20:30', 'is_dated': 999999}]}}
        if endpoint == 'onevoneGetCancelLesson': return {'data': deepcopy(self.cancel_pages.get(body['page'], []))}
        if endpoint in ('getLiveList', 'getBackList'):
            return {'data': deepcopy(self.booking_pages.get(body['page_no'], {'list': [], 'allPage': 0, 'lastPage': True, 'allRow': 0}))}
        raise AssertionError('Unexpected endpoint: ' + endpoint)

class ReadAdapterTests(unittest.TestCase):
    def setUp(self):
        for cache in (read_store.memo, read_store.cursors):
            cache.values.clear(); cache.size = 0
        read_store.teacher_cursors.clear()
        self.client = FakeClient()

    def test_contract_ids_are_joined_and_never_interchanged(self):
        contract = api.contracts(self.client)
        self.assertEqual((contract['id'], contract['classId'], contract['liveId']), ('70001', '90001', '60001'))
        api.teacher_query(self.client, {})
        api.bookings(self.client, {'status': 'upcoming'})
        api.bookings(self.client, {'status': 'cancelled'})
        sent = {endpoint: body for endpoint, body in self.client.calls}
        self.assertEqual(sent['onevoneSearchTeacher']['user1v1_id'], '70001')
        self.assertEqual(sent['getLiveList']['classid'], '90001')
        self.assertEqual(sent['onevoneGetCancelLesson']['classid'], '70001')

    def test_no_guessing_for_expired_ambiguous_or_unlinked_contract(self):
        self.client.courses[0]['new_liveid'] = 99999
        with self.assertRaises(auth.AuthError) as failure: api.contracts(self.client)
        self.assertEqual(failure.exception.code, 'NO_ACTIVE_CONTRACT')
        self.client.courses[0]['new_liveid'] = 60001
        self.client.contracts.append({**self.client.contracts[0], 'id': 70002, 'courseid': 90002})
        self.client.courses.append({**self.client.courses[0], 'classid': 90002, 'liveid': 70002})
        with self.assertRaises(auth.AuthError) as failure: api.contracts(self.client)
        self.assertEqual(failure.exception.code, 'CONTRACT_SELECTION_REQUIRED')

    def test_teacher_pagination_deduplicates_repeated_normal_pool(self):
        ordinary = [self.client.teacher(i) for i in range(101, 121)]
        self.client.smart_count = 20
        self.client.search_pages = {1: ordinary + [self.client.teacher(i, 1) for i in range(201, 211)],
                                    2: ordinary + [self.client.teacher(i, 1) for i in range(211, 221)]}
        result = api.teacher_query(self.client, {}); found = result['items']
        while result['nextCursor']:
            result = api.teacher_query(self.client, {'cursor': result['nextCursor']}); found += result['items']
        self.assertEqual(len(found), 40)
        self.assertEqual(len({row['id'] for row in found}), 40)
        self.assertEqual(result['total'], 40)
        self.assertEqual(found[0]['labels'], [{'id': '12', 'name': '互动'}])

    def test_favorites_search_and_label_and_filter(self):
        self.client.favorite_rows = [self.client.teacher(101, labels=['互动', '亲和']), self.client.teacher(102)]
        result = api.teacher_query(self.client, {'favoritesOnly': '1', 'labelIds': '12,13', 'nickname': 'teacher'})
        self.assertEqual([row['id'] for row in result['items']], ['101'])
        self.assertFalse(any(ep == 'onevoneSearchTeacher' for ep, _ in self.client.calls))
        self.client.search_teacher = self.client.teacher(102)
        result = api.teacher_query(self.client, {'favoritesOnly': '1', 'date': self.client.today, 'times': '19:00'})
        self.assertEqual(result['items'][0]['id'], '102')
        self.assertTrue(result['items'][0]['favorite'])

    def test_teacher_cursor_is_scoped_and_not_expired_by_other_reads(self):
        self.client.favorite_rows = [self.client.teacher(i) for i in range(101, 130)]
        result = api.teacher_query(self.client, {'favoritesOnly': '1'})
        cursor = result['nextCursor']; self.assertIsNotNone(cursor)
        with self.assertRaises(auth.AuthError): api.teacher_query(self.client, {'cursor': cursor})
        self.client.scope = ('child-b', 1, 'credential-a')
        with self.assertRaises(auth.AuthError): api.teacher_query(self.client, {'favoritesOnly': '1', 'cursor': cursor})
        self.client.scope = ('child-a', 2, 'credential-b')
        with self.assertRaises(auth.AuthError): api.teacher_query(self.client, {'favoritesOnly': '1', 'cursor': cursor})
        self.client.scope = ('child-a', 1, 'credential-a')
        for index in range(80):
            read_store.continuation({'scope': ['child-z', 1, 'other'], 'kind': 'bookings',
                                     'filters': {'page': index}, 'queryId': f'booking-{index}'})
        with patch('mison_booking.read_store.time.monotonic', return_value=10**20):
            resumed = api.teacher_query(self.client, {'favoritesOnly': '1', 'cursor': cursor})
        self.assertEqual(len(resumed['items']), 9)

    def test_schedule_uses_beijing_base_and_hides_occupant_ids(self):
        fixed = datetime(2099, 1, 1, 12, tzinfo=api.TZ)
        with patch.object(api, 'now', return_value=fixed): result = api.schedule(self.client, '101', {})
        self.assertEqual(result['date'], '2099-01-01')
        self.assertEqual([row['date'] for row in result['days']], ['2099-01-01', '2099-01-02', '2099-01-03'])
        self.assertEqual([row['state'] for row in result['slots']], ['unscheduled', 'available', 'mine', 'occupied'])
        self.assertEqual(result['slots'][1]['end'], '19:55')
        self.assertEqual(result['slotStepMinutes'], 30)
        self.assertNotIn('999999', json.dumps(result))
        self.assertNotIn(str(self.client.userid), json.dumps(result))
        with patch.object(api, 'now', return_value=fixed), self.assertRaises(auth.AuthError):
            api.schedule(self.client, '101', {'date': '2099-01-10'})

    def test_bookings_scan_sort_date_filter_and_real_pagination(self):
        self.client.booking_pages = {1: {'list': [self.client.record(1, '2099-01-03 19:00')], 'allPage': 2, 'lastPage': False},
                                     2: {'list': [self.client.record(2, '2099-01-02 19:00')], 'allPage': 2, 'lastPage': True}}
        result = api.bookings(self.client, {'status': 'upcoming', 'pageSize': '1'})
        self.assertEqual(result['items'][0]['cid'], '2')
        second = api.bookings(self.client, {'status': 'upcoming', 'pageSize': '1', 'cursor': result['nextCursor']})
        self.assertEqual(second['items'][0]['cid'], '1'); self.assertIsNone(second['nextCursor'])
        self.assertEqual(second['total'], 2)
        result = api.bookings(self.client, {'status': 'completed', 'from': '2099-01-03', 'to': '2099-01-03'})
        self.assertEqual([row['cid'] for row in result['items']], ['1'])
        result = api.bookings(self.client, {'status': 'completed'})
        self.assertEqual(result['items'][0]['cid'], '1')
        self.assertFalse(result['items'][0]['actions']['cancel']['allowed'])
        self.assertEqual(result['items'][0]['actions']['replay']['mode'], 'instructions')

    def test_booking_page_keeps_upstream_order_and_does_not_scan_ahead(self):
        rows = [self.client.record(i, f'2099-{(i - 1) // 28 + 1:02d}-{(i - 1) % 28 + 1:02d} 19:00') for i in range(1, 101)]
        self.client.booking_pages = {1: {'list': rows, 'allPage': 2, 'lastPage': False, 'allRow': 101}}
        result = api.booking_page(self.client, {'status': 'upcoming', 'page': '1'})
        self.assertEqual([row['cid'] for row in result['items']], [str(i) for i in range(1, 101)])
        self.assertFalse(result['complete'])
        self.assertEqual(result['pageSize'], 100)
        live = [body for endpoint, body in self.client.calls if endpoint == 'getLiveList']
        self.assertEqual(live, [{'classid': '90001', 'page_size': 100, 'page_no': 1, 'courseway': 0, 'blockid': 0}])
        self.client.booking_pages[1]['list'] = [self.client.record(2, '2099-01-04 19:00'), self.client.record(1, '2099-01-02 19:00')]
        with self.assertRaises(auth.AuthError) as failure:
            api.booking_page(self.client, {'status': 'upcoming', 'page': 1})
        self.assertEqual(failure.exception.code, 'UPSTREAM_SCHEMA_CHANGED')
        self.client.calls.clear()
        self.client.booking_pages = {1: {'list': [self.client.record(2, '2099-01-04 19:00'), self.client.record(1, '2099-01-02 19:00')],
                                          'allPage': 1, 'lastPage': True, 'allRow': 2}}
        result = api.booking_page(self.client, {'status': 'completed'})
        self.assertEqual([row['cid'] for row in result['items']], ['2', '1'])
        self.assertTrue(result['complete'])
        back = [body for endpoint, body in self.client.calls if endpoint == 'getBackList']
        self.assertEqual([body['page_no'] for body in back], [1])
        self.assertEqual(back[0]['is_lesson_status'], 1)
        self.client.cancel_pages = {1: [{'dateTime': '2099-01-03 18:00-18:25', 'teachername': '合成教师', 'course_name': '内容', 'courseware_id': '10001'}]}
        self.client.calls.clear()
        result = api.booking_page(self.client, {'status': 'cancelled', 'page': '1'})
        self.assertTrue(result['complete'])
        self.assertIsNone(result['items'][0]['cid'])
        self.assertEqual(self.client.calls[-1][0], 'onevoneGetCancelLesson')
        self.assertEqual(self.client.calls[-1][1]['limit'], 100)
        self.assertEqual(self.client.calls[-1][1]['classid'], '70001')
        with self.assertRaises(auth.AuthError):
            api.booking_page(self.client, {'status': 'upcoming', 'page': '0'})
        with self.assertRaises(auth.AuthError):
            api.booking_page(self.client, {'status': 'upcoming', 'cursor': 'abc'})

    def test_short_booking_pages_follow_explicit_total_for_live_and_history(self):
        for status in ('upcoming', 'completed'):
            with self.subTest(status=status):
                self.client.booking_pages = {
                    1: {'list': [self.client.record(1)], 'allPage': 2},
                    2: {'list': [self.client.record(2)], 'allPage': 2},
                }
                first = api.booking_page(self.client, {'status': status, 'page': 1})
                self.assertFalse(first['complete'])
                second = api.booking_page(self.client, {'status': status, 'page': 2})
                self.assertTrue(second['complete'])
                self.assertEqual([row['cid'] for row in first['items'] + second['items']], ['1', '2'])

    def test_booking_page_rejects_contradictory_metadata_and_empty_unfinished_pages(self):
        for metadata in ({'allPage': 2, 'lastPage': True}, {'allPage': 1, 'lastPage': False}):
            with self.subTest(metadata=metadata):
                self.client.booking_pages = {1: {'list': [self.client.record(1)], **metadata}}
                with self.assertRaises(auth.AuthError) as failure:
                    api.booking_page(self.client, {'page': 1})
                self.assertEqual(failure.exception.code, 'UPSTREAM_SCHEMA_CHANGED')
        self.client.booking_pages = {1: {'list': [], 'allPage': 2, 'lastPage': False}}
        with self.assertRaises(auth.AuthError) as failure:
            api.booking_page(self.client, {'page': 1})
        self.assertEqual(failure.exception.code, 'UPSTREAM_SCHEMA_CHANGED')

    def test_cancelled_missing_teacher_and_cid_are_nullable(self):
        self.client.cancel_pages = {1: [{'dateTime': '2099-01-02 18:00-18:25', 'teachername': '合成教师', 'course_name': '内容', 'courseware_id': '10001'}]}
        result = api.bookings(self.client, {'status': 'cancelled'})['items'][0]
        self.assertIsNone(result['cid']); self.assertIsNone(result['teacher']['id'])
        self.assertEqual(result['timeLabel'], '18:00–18:25')
        self.assertEqual(result['actions'], {})

    def test_history_builds_with_bounded_source_pages_before_sorted_output(self):
        self.client.booking_pages = {i: {'list': [self.client.record(i, f'2099-01-0{6-i} 19:00')],
            'allPage': 4, 'lastPage': i == 4} for i in range(1, 5)}
        first = api.bookings(self.client, {})
        self.assertEqual((first['state'], first['items'], first['sourceComplete']), ('building', [], False))
        self.assertEqual(len([ep for ep, _ in self.client.calls if ep == 'getLiveList']), 3)
        final = api.bookings(self.client, {'cursor': first['nextCursor']})
        self.assertEqual([row['cid'] for row in final['items']], ['4', '3', '2', '1'])
        self.assertEqual(final['total'], 4)

    def test_cache_respects_memory_limit_and_entry_limit(self):
        cache = read_store.Cache(entries=2, max_bytes=100)
        cache.put('a', {'value': 1}); cache.put('b', {'value': 2}); cache.put('c', {'value': 3})
        self.assertIsNone(cache.get('a'))
        self.assertEqual(cache.get('b'), {'value': 2})
        with self.assertRaises(auth.AuthError): cache.put('oversize', {'value': 'x' * 101})

    def test_teacher_profile_returns_direct_video_url(self):
        original = self.client.call
        def with_video(endpoint, body):
            value = original(endpoint, body)
            if endpoint == 'onevoneGetTeacherInfo': value['data']['intro_video'] = 'https://file.mison.cn/teacher.mp4'
            return value
        self.client.call = with_video
        with patch.object(auth, 'bridge') as issue:
            profile = api.profile(self.client, '101')
        self.assertEqual(profile['introVideo']['action'], 'inline')
        self.assertEqual(profile['introVideo']['url'], 'https://file.mison.cn/teacher.mp4')
        self.assertEqual(profile['introVideo']['mimeType'], 'video/mp4')
        issue.assert_not_called()

    def test_public_media_urls_stay_on_allowlisted_files(self):
        encoded = media.public_media_url('https://file.mison.cn/courseware/91/PU0 U4 At home L2 语音练习1.pdf', 'pdf')
        self.assertEqual(encoded, 'https://file.mison.cn/courseware/91/PU0%20U4%20At%20home%20L2%20%E8%AF%AD%E9%9F%B3%E7%BB%83%E4%B9%A01.pdf')
        self.assertEqual(media.public_media_url('https://file.mison.cn/a%20b.pdf', 'pdf'), 'https://file.mison.cn/a%20b.pdf')
        self.assertEqual(media.public_media_url('https://mp.mison.cn/teacher.mp4', 'video'), 'https://mp.mison.cn/teacher.mp4')
        self.assertEqual(media.public_media_url('https://file.mison.cn:443/teacher.mp4', 'video'), 'https://file.mison.cn/teacher.mp4')
        self.assertIsNone(media.public_media_url('https://file.mison.cn/teacher.mp4#fragment', 'video'))
        for url, kind in (
            ('http://file.mison.cn/a.pdf', 'pdf'),
            ('https://mp.mison.cn/a.pdf', 'pdf'),
            ('https://file.mison.cn/a.pptx', 'pdf'),
            ('https://file.mison.cn.evil.test/a.mp4', 'video'),
            ('https://u:p@file.mison.cn/a.mp4', 'video'),
            ('https://file.mison.cn:444/a.mp4', 'video'),
            ('https://mp.mison.cn/a.mp4\n', 'video'),
        ):
            with self.subTest(url=url, kind=kind):
                self.assertIsNone(media.public_media_url(url, kind))
        original = self.client.call
        def bad_video(endpoint, body):
            value = original(endpoint, body)
            if endpoint == 'onevoneGetTeacherInfo': value['data']['intro_video'] = 'https://example.com/teacher.mp4'
            return value
        self.client.call = bad_video
        with self.assertRaises(auth.AuthError) as failure:
            api.profile(self.client, '101')
        self.assertEqual(failure.exception.code, 'VALIDATION_ERROR')

    def test_invalid_filters_and_repeated_source_pages_fail_clearly(self):
        for query in ({'date': 'yesterday'}, {'times': '99:99'}, {'labelIds': '99999'}, {'favoritesOnly': True}):
            with self.subTest(query=query), self.assertRaises(auth.AuthError): api.teacher_query(self.client, query)
        self.client.smart_count = 1000
        with self.assertRaises(auth.AuthError) as error: api.teacher_query(self.client, {})
        self.assertEqual(error.exception.code, 'UPSTREAM_SCHEMA_CHANGED')

    def test_avatars_are_direct_allowlisted_cdn_urls(self):
        for url in ('https://127.0.0.1/a.jpg', 'https://mp.mison.cn.evil.test/a.jpg', 'https://u:p@mp.mison.cn/a.jpg', 'file:///a', 'https://mp.mison.cn:444/a.jpg', 'mison-image:' + 'ab' * 32):
            self.assertIsNone(images.public_url(url))
        self.assertEqual(images.public_url('https://mp.mison.cn/a.jpg'), 'https://mp.mison.cn/a.jpg')
        self.assertEqual(images.public_url('http://file.mison.cn/a.jpg?x=1#fragment'), 'https://file.mison.cn/a.jpg?x=1')
        self.assertEqual(images.public_url('https://mp.mison.cn:443/a.jpg'), 'https://mp.mison.cn/a.jpg')
        self.assertEqual(api.teacher(self.client, self.client.teacher(101))['avatarUrl'], 'https://mp.mison.cn/public/fixture.jpg')
        unsafe = self.client.teacher(101)
        unsafe['headerUrl'] = 'https://evil.example/a.jpg'
        self.assertIsNone(api.teacher(self.client, unsafe)['avatarUrl'])

class UpstreamReadTests(unittest.TestCase):
    def test_fixed_allowlist_no_login_or_mutation(self):
        session = {'status': 'connected', 'bindingRevision': 1, 'credentialId': 'id-a', 'userid': '123', 'token': 'synthetic-token'}
        with patch('mison_booking.upstream.session', return_value=session): client = Client({'childId': 'a'})
        for endpoint in ('member/login', 'onevoneAppointment', 'cancelLesson', 'teacherCollect'):
            with self.subTest(endpoint=endpoint), self.assertRaises(auth.AuthError): client.call(endpoint, {})

    def test_13000_invalidates_only_current_credential_without_http401(self):
        session = {'status': 'connected', 'bindingRevision': 7, 'credentialId': 'id-a', 'userid': '123', 'token': 'synthetic-token'}
        response = io.BytesIO(json.dumps({'status': 13000, 'msg': '终端数超限'}).encode())
        with patch('mison_booking.upstream.session', return_value=session), \
             patch('mison_booking.upstream.urllib.request.build_opener') as opener, \
             patch('mison_booking.upstream.bridge') as bridge:
            opener.return_value.open.return_value = response
            client = Client({'childId': 'a'})
            with self.assertRaises(auth.AuthError) as failure: client.call('getLiveList', {})
            self.assertEqual(failure.exception.code, 'RECONNECT_REQUIRED')
            bridge.assert_called_once_with({'childId': 'a'}, 'session.invalidate', {'credentialId': 'id-a', 'bindingRevision': 7})

if __name__ == '__main__': unittest.main()

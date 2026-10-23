import copy
import unittest
from lele_growth.business_operations import apply_operation, default_data, occurrence, expand
from lele_growth.storage import StoreError

NOW = '2026-10-15T16:30:00+00:00'

class BusinessCommandsTest(unittest.TestCase):
    def setUp(self):
        self.data = default_data('测试孩子')
        self.task = dict(title='阅读', note='', startDate='2026-10-15', startTime='18:00', endTime='18:30',
                         categoryId=self.data['categories'][0]['id'], points=10, recurrence=None)
    def run_op(self, kind, **payload):
        self.data = apply_operation(self.data, kind, payload, actor_id='tester', revision=1, now=NOW)
        return self.data
    def create(self, rule=None):
        self.task['recurrence'] = rule
        self.run_op('task.create', task=self.task)
        return self.data['series'][-1]['id'] + '@2026-10-15'
    def test_complete_duplicate_reverse_snapshot_and_clock(self):
        key = self.create()
        self.run_op('completion.set', occurrenceKey=key, completed=True)
        self.run_op('completion.set', occurrenceKey=key, completed=True)
        self.assertEqual(len(self.data['ledger']), 1)
        self.assertEqual(self.data['ledger'][0]['date'], '2026-10-16')
        self.data['series'][0]['points'] = 100
        self.run_op('completion.set', occurrenceKey=key, completed=False)
        self.assertEqual(sum(x['amount'] for x in self.data['ledger']), 0)
        self.run_op('completion.set', occurrenceKey=key, completed=False)
        self.assertEqual(len(self.data['ledger']), 2)
    def test_delete_preserves_completed_history(self):
        key = self.create(dict(freq='daily', interval=1, endType='never'))
        self.run_op('completion.set', occurrenceKey=key, completed=True)
        self.run_op('task.delete', occurrenceKey=key.replace('@2026-10-15','@2026-10-16'), scope='series')
        self.assertEqual(self.data['series'], [])
        self.assertTrue(self.data['completions'][0]['completed'])
        self.run_op('completion.set', occurrenceKey=key, completed=False)
        self.assertEqual(sum(x['amount'] for x in self.data['ledger']), 0)
    def test_override_uses_original_key(self):
        key = self.create(dict(freq='daily', interval=1, endType='count', count=5))
        new = {**self.task, 'startDate':'2026-10-17', 'title':'改期'}
        self.run_op('task.edit', occurrenceKey=key, task=new, scope='only')
        item = occurrence(self.data,key)
        self.assertEqual((item['date'],item['originalDate']), ('2026-10-17','2026-10-15'))
        self.run_op('completion.set', occurrenceKey=key, completed=True)
        self.assertEqual(self.data['completions'][0]['snapshot']['title'],'改期')
    def test_month_end_clamp_and_future_count(self):
        task={**self.task,'id':'monthly','startDate':'2026-01-31','recurrence':dict(freq='monthly',interval=1,monthDay=31,endType='count',count=3)}
        self.assertEqual([x['date'] for x in expand(task,'2026-01-01','2026-04-30')],['2026-01-31','2026-02-28','2026-03-31'])
        key=self.create(dict(freq='daily',interval=1,endType='count',count=5))
        self.run_op('task.edit',occurrenceKey=key.replace('@2026-10-15','@2026-10-17'),task={**self.task,'startDate':'2026-10-17','title':'新版'},scope='future')
        self.assertEqual(self.data['series'][0]['revisions'][-1]['recurrence']['count'],3)
        self.assertEqual(occurrence(self.data,key)['title'],'阅读')
        self.assertEqual(occurrence(self.data,key.replace('@2026-10-15','@2026-10-17'))['title'],'新版')
    def test_stop_repeating_preserves_history_and_reediting_single_segment(self):
        key = self.create(dict(freq='daily', interval=1, endType='never'))
        single = key.replace('2026-10-15', '2026-10-19')
        self.run_op('task.edit', occurrenceKey=single,
                    task={**self.task, 'startDate': '2026-10-19', 'recurrence': None}, scope='future')
        self.assertEqual(occurrence(self.data, key)['date'], '2026-10-15')
        self.run_op('completion.set', occurrenceKey=key, completed=True)
        self.run_op('completion.set', occurrenceKey=key, completed=False)
        self.assertEqual(sum(row['amount'] for row in self.data['ledger']), 0)
        self.assertTrue(occurrence(self.data, single)['recurring'])
        self.run_op('task.edit', occurrenceKey=single,
                    task={**self.task, 'startDate': '2026-10-19', 'title': '再次重复'}, scope='future')
        self.assertEqual(occurrence(self.data, key)['title'], '阅读')
        self.assertEqual(occurrence(self.data, single.replace('@2026-10-19', '@2026-10-20'))['title'], '再次重复')

    def test_single_tail_only_edit_and_delete_leave_previous_revision_intact(self):
        key = self.create(dict(freq='daily', interval=1, endType='never'))
        tail = key.replace('2026-10-15', '2026-10-19')
        task = {**self.task, 'startDate': '2026-10-19', 'recurrence': None}
        self.run_op('task.edit', occurrenceKey=tail, task=task, scope='future')
        self.run_op('task.edit', occurrenceKey=tail, task={**task, 'title': '单次修改'}, scope='only')
        self.assertEqual(occurrence(self.data, tail)['title'], '单次修改')
        self.assertEqual(occurrence(self.data, key)['title'], '阅读')
        self.run_op('task.delete', occurrenceKey=tail, scope='only')
        self.assertEqual(occurrence(self.data, key)['title'], '阅读')
        with self.assertRaises(StoreError): occurrence(self.data, tail)

    def test_monthly_all_edits_honor_date_day_and_both(self):
        key = self.create(dict(freq='monthly', interval=1, monthDay=15, endType='never'))
        original = copy.deepcopy(self.data)
        for start, day, expected in [('2026-10-15', 20, 20), ('2026-10-18', 15, 18), ('2026-10-18', 20, 20)]:
            with self.subTest(start=start, day=day):
                self.data = copy.deepcopy(original)
                task = {**self.task, 'startDate': start, 'recurrence': {**self.task['recurrence'], 'monthDay': day}}
                self.run_op('task.edit', occurrenceKey=key, task=task, scope='all')
                self.assertEqual(self.data['series'][0]['recurrence']['monthDay'], expected)

    def test_monthly_all_uses_historical_source_and_original_series_start(self):
        key = self.create(dict(freq='monthly', interval=1, monthDay=15, endType='never'))
        self.run_op('task.edit', occurrenceKey=key.replace('2026-10-15', '2026-11-15'),
                    task={**self.task, 'startDate': '2026-11-15', 'recurrence': {**self.task['recurrence'], 'monthDay': 20}}, scope='future')
        task = {**self.task, 'recurrence': {**self.task['recurrence'], 'monthDay': 25}}
        self.run_op('task.edit', occurrenceKey=key, task=task, scope='all')
        self.assertEqual(self.data['series'][0]['startDate'], '2026-10-15')
        self.assertEqual(self.data['series'][0]['recurrence']['monthDay'], 25)

    def test_changed_repeat_count_applies_from_pivot_unchanged_keeps_remaining(self):
        key = self.create(dict(freq='daily', interval=1, endType='count', count=5))
        original = copy.deepcopy(self.data)
        for count, expected in [(5, 3), (10, 10), (2, 2)]:
            with self.subTest(count=count):
                self.data = copy.deepcopy(original)
                task = {**self.task, 'startDate': '2026-10-17', 'recurrence': {**self.task['recurrence'], 'count': count}}
                self.run_op('task.edit', occurrenceKey=key.replace('2026-10-15', '2026-10-17'), task=task, scope='future')
                self.assertEqual(self.data['series'][0]['recurrence']['count'], expected)
    def test_repeat_count_uses_source_revision_when_editing_history(self):
        key = self.create(dict(freq='daily', interval=1, endType='count', count=5))
        self.run_op('task.edit', occurrenceKey=key.replace('2026-10-15', '2026-10-17'),
                    task={**self.task, 'startDate': '2026-10-17', 'recurrence': {**self.task['recurrence'], 'count': 10}}, scope='future')
        self.run_op('task.edit', occurrenceKey=key.replace('2026-10-15', '2026-10-16'),
                    task={**self.task, 'startDate': '2026-10-16'}, scope='future')
        self.assertEqual(self.data['series'][0]['recurrence']['count'], 4)
        self.assertEqual(occurrence(self.data, key)['date'], '2026-10-15')
    def test_gift_balance_and_reversal_are_authoritative(self):
        self.run_op('gift.save',gift={'name':'绘本','points':20})
        gift=self.data['gifts'][0]['id']
        before=copy.deepcopy(self.data)
        with self.assertRaises(StoreError):self.run_op('gift.redeem',id=gift)
        self.assertEqual(self.data,before)
        self.run_op('ledger.manual',amount=25,reason='奖励',date='2026-10-15')
        self.run_op('gift.redeem',id=gift)
        with self.assertRaises(StoreError):self.run_op('gift.redeem',id=gift)
        self.run_op('gift.reverse',id=gift)
        with self.assertRaises(StoreError):self.run_op('gift.reverse',id=gift)
        self.assertEqual(sum(x['amount'] for x in self.data['ledger']),25)
    def test_refuse_injected_ledger_snapshot_and_unrecognized_operation(self):
        key=self.create()
        for kind,payload in [('completion.set',dict(occurrenceKey=key,completed=True,snapshot={'points':999})),
                             ('data.replace',dict(data={})), ('gift.save',dict(gift={'name':'礼物','points':1,'status':'redeemed'}))]:
            with self.assertRaises(StoreError): self.run_op(kind,**payload)
    def test_referenced_categories_disabled_and_unique_names(self):
        self.create()
        cid=self.task['categoryId']
        self.run_op('category.delete',id=cid)
        self.assertFalse(self.data['categories'][0]['active'])
        with self.assertRaises(StoreError):self.run_op('category.save',category={'name':'作业','color':'#123456'})
    def test_missing_occurrence_cannot_award_points(self):
        key=self.create()
        with self.assertRaises(StoreError):self.run_op('completion.set',occurrenceKey=key.replace('@2026-10-15','@2026-10-16'),completed=True)
        self.assertEqual(self.data['ledger'],[])
    def test_input_unchanged_and_audit_actor_generated(self):
        original=copy.deepcopy(self.data)
        self.run_op('ledger.manual',amount=1,reason='测试',date='2026-10-15')
        self.assertEqual(original['ledger'],[])
        self.assertEqual(self.data['operationLog'][-1]['actorUserId'],'tester')
    def test_gift_image_rejects_attribute_injection_and_invalid_encoding(self):
        for image in ['data:image/png;base64,x"><div id="injected-ui">bad</div>',
                      'data:image/png;base64,AAAA', 'data:image/webp;base64,!!!!']:
            with self.assertRaises(StoreError):
                self.run_op('gift.save',gift={'name':'图片测试','points':1,'imageData':image})
        self.assertEqual(self.data['gifts'],[])
    def test_gift_image_accepts_valid_png(self):
        image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
        self.run_op('gift.save',gift={'name':'图片测试','points':1,'imageData':image})
        self.assertEqual(self.data['gifts'][0]['imageData'],image)

if __name__=='__main__': unittest.main()

class MonthlyCountRegressionTests(unittest.TestCase):
    def test_count_only_includes_dates_on_or_after_start(self):
        task = dict(id='monthly', title='月度', note='', startDate='2026-10-20', startTime='08:00', endTime='09:00', categoryId='cat', points=1,
                    recurrence=dict(freq='monthly', interval=1, monthDay=1, endType='count', count=3))
        self.assertEqual([o['date'] for o in expand(task,'2026-10-20','2027-03-01')],['2026-11-01','2026-12-01','2027-01-01'])
        self.assertEqual([o['date'] for o in expand(task,'2026-12-01','2027-03-01')],['2026-12-01','2027-01-01'])
        task['recurrence']['interval']=2
        self.assertEqual([o['date'] for o in expand(task,'2026-10-20','2027-08-01')],['2026-12-01','2027-02-01','2027-04-01'])
        task['startDate']='2026-01-31'
        task['recurrence'].update(interval=1,monthDay=31)
        self.assertEqual([o['date'] for o in expand(task,'2026-01-01','2026-05-01')],['2026-01-31','2026-02-28','2026-03-31'])

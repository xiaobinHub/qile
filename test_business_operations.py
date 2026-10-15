import copy
import unittest
from business_operations import apply_operation, default_data, occurrence, expand
from storage import StoreError

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

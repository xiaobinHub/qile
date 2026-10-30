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
        self.assertEqual(self.data['ledger'][0]['taskDate'], '2026-10-15')
        self.data['series'][0]['points'] = 100
        self.run_op('completion.set', occurrenceKey=key, completed=False)
        self.assertEqual(sum(x['amount'] for x in self.data['ledger']), 0)
        self.run_op('completion.set', occurrenceKey=key, completed=False)
        self.assertEqual(len(self.data['ledger']), 2)
        self.assertEqual(self.data['ledger'][1]['taskDate'], '2026-10-15')
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
        self.assertEqual(self.data['ledger'][-1]['taskDate'],'2026-10-17')
        self.run_op('completion.set', occurrenceKey=key, completed=False)
        self.assertEqual(self.data['ledger'][-1]['taskDate'],'2026-10-17')
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

    def test_batch_mixed_success_leaves_inputs_unchanged_and_audits_once(self):
        edit_key = self.create()
        delete_key = self.create()
        operations = [
            dict(kind='task.create', payload={'task': {**self.task, 'title': '新任务'}}),
            dict(kind='task.edit', payload=dict(occurrenceKey=edit_key, scope='only',
                                               task={**self.task, 'title': '已修改', 'startDate': '2026-10-16'})),
            dict(kind='task.delete', payload=dict(occurrenceKey=delete_key, scope='only')),
        ]
        original, request = copy.deepcopy(self.data), copy.deepcopy(operations)
        result = apply_operation(self.data, 'task.batch', {'operations': operations},
                                 actor_id='batch-parent', revision=42, now=NOW)
        self.assertEqual(self.data, original)
        self.assertEqual(operations, request)
        self.assertEqual(len(result['series']), 2)
        moved_key = edit_key.replace('2026-10-15', '2026-10-16')
        self.assertEqual(occurrence(result, moved_key)['title'], '已修改')
        self.assertEqual(occurrence(result, moved_key)['date'], '2026-10-16')
        with self.assertRaises(StoreError):
            occurrence(result, edit_key)
        self.assertEqual(result['series'][-1]['title'], '新任务')
        with self.assertRaises(StoreError):
            occurrence(result, delete_key)
        self.assertEqual(result['ledger'], original['ledger'])
        self.assertEqual(result['completions'], original['completions'])
        self.assertEqual(result['operationLog'][:-1], original['operationLog'])
        event = result['operationLog'][-1]
        self.assertEqual((event['action'], event['actorUserId'], event['revision']),
                         ('task.batch', 'batch-parent', 42))

    def test_batch_later_conflict_rolls_back_prior_create_edit_and_delete(self):
        edit_key = self.create()
        delete_key = self.create()
        before = copy.deepcopy(self.data)
        operations = [
            dict(kind='task.create', payload={'task': self.task}),
            dict(kind='task.edit', payload=dict(occurrenceKey=edit_key, scope='only',
                                               task={**self.task, 'title': '不应保存'})),
            dict(kind='task.delete', payload=dict(occurrenceKey=delete_key, scope='only')),
            dict(kind='task.delete', payload=dict(occurrenceKey='missing@2026-10-15', scope='only')),
        ]
        request = copy.deepcopy(operations)
        with self.assertRaises(StoreError) as error:
            self.run_op('task.batch', operations=operations)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.data, before)
        self.assertEqual(operations, request)

    def test_batch_final_validation_failure_is_atomic(self):
        before = copy.deepcopy(self.data)
        with self.assertRaises(StoreError):
            self.run_op('task.batch', operations=[
                dict(kind='task.create', payload={'task': self.task}),
                dict(kind='task.create', payload={'task': {**self.task, 'categoryId': 'missing'}}),
            ])
        self.assertEqual(self.data, before)

    def test_batch_recurring_only_edit_and_delete_preserve_other_dates(self):
        key = self.create(dict(freq='daily', interval=1, endType='count', count=5))
        keys = [key.replace('2026-10-15', f'2026-10-{day}') for day in range(15, 20)]
        self.run_op('completion.set', occurrenceKey=keys[0], completed=True)
        before = copy.deepcopy(self.data)
        self.run_op('task.batch', operations=[
            dict(kind='task.edit', payload=dict(occurrenceKey=keys[1], scope='only',
                                               task={**self.task, 'title': '改期', 'startDate': '2026-10-20', 'recurrence': None})),
            dict(kind='task.delete', payload=dict(occurrenceKey=keys[2], scope='only')),
        ])
        self.assertEqual(self.data['series'], before['series'])
        self.assertEqual(self.data['completions'], before['completions'])
        self.assertEqual(self.data['ledger'], before['ledger'])
        for unchanged in (keys[0], keys[3], keys[4]):
            self.assertEqual(occurrence(self.data, unchanged), occurrence(before, unchanged))
        edited = occurrence(self.data, keys[1])
        self.assertEqual((edited['title'], edited['date'], edited['originalDate']),
                         ('改期', '2026-10-20', '2026-10-16'))
        with self.assertRaises(StoreError):
            occurrence(self.data, keys[2])
        self.assertEqual([e['action'] for e in self.data['exceptions']], ['override', 'cancel'])

    def test_batch_completed_occurrences_remain_frozen(self):
        for recurring in (False, True):
            key = self.create(dict(freq='daily', interval=1, endType='never') if recurring else None)
            self.run_op('completion.set', occurrenceKey=key, completed=True)
            before = copy.deepcopy(self.data)
            for kind in ('task.edit', 'task.delete'):
                with self.subTest(recurring=recurring, kind=kind):
                    payload = dict(occurrenceKey=key, scope='only')
                    if kind == 'task.edit':
                        payload['task'] = {**self.task, 'title': '冻结', 'recurrence': None}
                    with self.assertRaises(StoreError) as error:
                        self.run_op('task.batch', operations=[
                            dict(kind='task.create', payload={'task': {**self.task, 'recurrence': None}}),
                            dict(kind=kind, payload=payload),
                        ])
                    self.assertEqual(error.exception.status, 409)
                    self.assertEqual(self.data, before)

    def test_batch_rejects_duplicate_occurrence_mutations(self):
        key = self.create()
        before = copy.deepcopy(self.data)
        for first in ('task.edit', 'task.delete'):
            for second in ('task.edit', 'task.delete'):
                with self.subTest(first=first, second=second):
                    operations = []
                    for kind in (first, second):
                        payload = dict(occurrenceKey=key, scope='only')
                        if kind == 'task.edit':
                            payload['task'] = self.task
                        operations.append(dict(kind=kind, payload=payload))
                    with self.assertRaises(StoreError) as error:
                        self.run_op('task.batch', operations=operations)
                    self.assertEqual(error.exception.status, 400)
                    self.assertEqual(self.data, before)

    def test_batch_requires_exact_envelope_and_list_of_one_to_200(self):
        before = copy.deepcopy(self.data)
        item = dict(kind='task.create', payload={'task': self.task})
        invalid = [{}, {'operations': [], 'extra': 1}]
        invalid.extend({'operations': value} for value in (None, False, 1, 'bad', {}, (), [], [item] * 201))
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(StoreError) as error:
                    self.run_op('task.batch', **payload)
                self.assertEqual(error.exception.status, 400)
                self.assertEqual(self.data, before)

    def test_batch_accepts_both_size_boundaries(self):
        for count in (1, 200):
            with self.subTest(count=count):
                before = copy.deepcopy(self.data)
                self.run_op('task.batch', operations=[dict(kind='task.create', payload={'task': self.task})] * count)
                self.assertEqual(len(self.data['series']), len(before['series']) + count)
                self.assertEqual(len({s['id'] for s in self.data['series']}), len(self.data['series']))
                self.assertEqual(len(self.data['operationLog']), len(before['operationLog']) + 1)

    def test_batch_rejects_malformed_items_and_disallowed_commands(self):
        before = copy.deepcopy(self.data)
        invalid = [None, False, 1, 'task.create', [], {}, {'kind': 'task.create'}, {'payload': {}},
                   dict(kind='task.create', payload={'task': self.task}, extra=True)]
        invalid.extend(dict(kind=value, payload={}) for value in
                       (None, False, 1, [], {}, 'task.batch', 'completion.set', 'ledger.manual', 'gift.save', 'data.replace', ''))
        invalid.append(dict(kind='task.batch', payload={'operations': [dict(kind='task.create', payload={'task': self.task})]}))
        invalid.extend(dict(kind=kind, payload=value) for kind in ('task.create', 'task.edit', 'task.delete')
                       for value in (None, False, 1, '', [], {}))
        invalid.append(dict(kind='task.create', payload={'task': self.task, 'extra': True}))
        for item in invalid:
            with self.subTest(item=item):
                with self.assertRaises(StoreError) as error:
                    self.run_op('task.batch', operations=[item])
                self.assertEqual(error.exception.status, 400)
                self.assertEqual(self.data, before)

    def test_batch_rejects_invalid_scopes_keys_and_payload_fields(self):
        key = self.create()
        before = copy.deepcopy(self.data)
        for kind in ('task.edit', 'task.delete'):
            valid = dict(occurrenceKey=key, scope='only')
            if kind == 'task.edit':
                valid['task'] = self.task
            invalid = [{**valid, 'scope': scope} for scope in (None, False, 1, [], {}, 'series', 'future', 'all', '')]
            invalid.extend({**valid, 'occurrenceKey': value} for value in
                           (None, False, 1, [], {}, '', 'missing', 'id@bad-date', 'id@2026-02-30'))
            invalid.append({**valid, 'extra': True})
            for field in valid:
                invalid.append({k: v for k, v in valid.items() if k != field})
            if kind == 'task.delete':
                invalid.append({**valid, 'task': self.task})
            for payload in invalid:
                with self.subTest(kind=kind, payload=payload):
                    with self.assertRaises(StoreError) as error:
                        self.run_op('task.batch', operations=[dict(kind=kind, payload=payload)])
                    self.assertEqual(error.exception.status, 400)
                    self.assertEqual(self.data, before)

    def test_batch_rejects_invalid_task_values_and_recurring_tasks(self):
        key = self.create()
        before = copy.deepcopy(self.data)
        invalid = [None, False, 1, '', [], {}, {k: v for k, v in self.task.items() if k != 'recurrence'}]
        invalid.extend({**self.task, 'recurrence': value} for value in
                       (False, 0, '', [], {}, dict(freq='daily', interval=1, endType='never')))
        invalid.extend({**self.task, field: value} for field, value in
                       [('title', None), ('note', []), ('startDate', []), ('startDate', '2026-02-30'),
                        ('startTime', 12), ('endTime', '17:00'), ('categoryId', []), ('points', True),
                        ('points', -1), ('points', '10'), ('extra', 'injected')])
        for field in ('title', 'startDate', 'startTime', 'endTime', 'categoryId', 'points'):
            invalid.append({k: v for k, v in self.task.items() if k != field})
        for kind in ('task.create', 'task.edit'):
            for task in invalid:
                with self.subTest(kind=kind, task=task):
                    payload = {'task': task}
                    if kind == 'task.edit':
                        payload.update(occurrenceKey=key, scope='only')
                    with self.assertRaises(StoreError) as error:
                        self.run_op('task.batch', operations=[dict(kind=kind, payload=payload)])
                    self.assertEqual(error.exception.status, 400)
                    self.assertEqual(self.data, before)

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

"""Pure protocol/schema tests require no database or plugin code execution."""
import copy
import unittest

from lele_growth.child_service import ApiError
from lele_growth.plugins.manifest import validate_manifest, safe_relative_path
from lele_growth.plugins.configuration import validate_schema, validate_config, schema_defaults


def manifest(plugin_id='test-plugin', *, kind='page'):
    return dict(manifestVersion=1,id=plugin_id,version='1.0.0',type=kind,name='测试应用',description='测试介绍',instructions='测试说明',
                platformApi={'major':1,'minMinor':0},frontendApi={'major':1,'minMinor':0},
                frontend={'entry':'frontend/entry.js','styles':['frontend/style.css']} if kind=='page' else None,
                backend={'entryModule':'test_plugin.worker'} if kind=='service' else None,
                configSchema=None,dataSchemaVersion=1,capabilities=['plugin.state.read','plugin.state.write'],tasks=[],events=[],icons=[])


class PluginManifestTests(unittest.TestCase):
    def test_valid_page_service_and_copy_isolation(self):
        for kind in ('page','service'):
            value=manifest(kind=kind); validated=validate_manifest(value)
            self.assertEqual(value,validated); validated['capabilities'].clear()
            self.assertEqual(len(value['capabilities']),2)

    def test_invalid_identity_version_api_capability_unknown_fields_and_entries(self):
        edits=[{'id':'../escape'},{'id':'Upper'},{'version':'01.0.0'},{'version':'1.0.0/dev'},
               {'platformApi':{'major':2,'minMinor':0}},{'frontendApi':{'major':1,'minMinor':2}},
               {'capabilities':['raw.sql']},{'dependencies':['other']},{'frontend':None},
               {'frontend':{'entry':'frontend/../escape.js'}},{'backend':{'entryModule':'x;exec'}},
               {'capabilities':['plugin.state.read','plugin.state.read']},{'events':['user.all']}]
        for edit in edits:
            with self.subTest(edit=edit),self.assertRaises(ApiError): validate_manifest({**manifest(),**edit})
        with self.assertRaises(ApiError): validate_manifest({**manifest(kind='service'),'frontend':{'entry':'main.js'}})

    def test_path_traversal_and_non_local_urls(self):
        for path in ('/tmp/entry.js','../entry.js','a//entry.js','a/./entry.js','a\\entry.js','a/%2e%2e/x','https://x/a','x.js?code=1','x.js#hash','x\x00.js'):
            with self.subTest(path=path),self.assertRaises(ApiError): safe_relative_path(path)

    def test_tasks_require_backend_and_unique_ids(self):
        value=manifest(kind='service'); value['tasks']=[{'id':'daily','schedule':{'configTime':'time'},'misfirePolicy':'latest'}]
        value['configSchema']={'type':'object','properties':{'time':{'type':'string','format':'time','default':'09:00'}}}
        self.assertEqual(validate_manifest(value),value)
        value['tasks'].append(copy.deepcopy(value['tasks'][0]))
        with self.assertRaises(ApiError): validate_manifest(value)
        with self.assertRaises(ApiError): validate_manifest({**manifest(),'tasks':[{'id':'daily'}]})

    def test_task_schedule_rejects_nulls_unknown_keys_invalid_times_zones_and_overlap(self):
        value=manifest(kind='service')
        invalid=[{'schedule':{'time':'09:00','timezone':None}}, {'schedule':None},
                 {'schedule':[]}, {'schedule':{'unknown':'value'}}, {'schedule':{'time':None}},
                 {'schedule':{'time':'9:00'}}, {'schedule':{'time':'24:00'}},
                 {'schedule':{'time':'09:60'}}, {'schedule':{'time':'09:00:60'}},
                 {'schedule':{'timezone':'Unknown/Zone'}}, {'schedule':{'timezone':[]}},
                 {'schedule':{'timezone':'/etc/passwd'}}, {'schedule':'invalid'},
                 {'time':None}, {'timezone':None}, {'time':'99:99'},
                 {'schedule':{'configTime':None}}, {'schedule':{'configTimezone':{}}},
                 {'schedule':{'configTime':'../time'}}, {'intervalSeconds':True},
                 {'intervalSeconds':0}, {'intervalSeconds':60,'schedule':{}},
                 {'intervalSeconds':60,'time':'09:00'}, {'intervalSeconds':60,'timezone':'UTC'}]
        for fields in invalid:
            with self.subTest(fields=fields),self.assertRaises(ApiError) as caught:
                validate_manifest({**value,'tasks':[{'id':'daily',**fields}]})
            self.assertEqual(caught.exception.kind,'plugin_invalid_manifest')

    def test_task_schedule_defaults_valid_daily_shorthand_and_interval_are_supported(self):
        for fields in ({},{'schedule':{}},{'schedule':'09:00'},
                       {'schedule':{'time':'23:59','timezone':'UTC'}},
                       {'time':'00:00','timezone':'Asia/Shanghai'}, {'intervalSeconds':60}):
            value={**manifest(kind='service'),'tasks':[{'id':'daily',**fields}]}
            with self.subTest(fields=fields):self.assertEqual(validate_manifest(value),value)

    def test_schedule_seconds_share_strict_config_and_manifest_time_grammar(self):
        for value in ('20:00', '20:00:00', '20:00:30', '23:59:59'):
            for fields in ({'schedule':value}, {'schedule':{'time':value}}, {'time':value}):
                data={**manifest(kind='service'),'tasks':[{'id':'daily',**fields}]}
                with self.subTest(value=value,fields=fields): self.assertEqual(validate_manifest(data),data)
            schema={'type':'object','properties':{'time':{'type':'string','format':'time','default':value,'enum':[value]}}}
            data={**manifest(kind='service'),'configSchema':'schemas/config.json',
                  'tasks':[{'id':'daily','schedule':{'configTime':'time'}}]}
            self.assertEqual(validate_manifest(data,config_schema=schema),data)
            self.assertEqual(validate_config(schema,{'time':value}),{'time':value})
        for value in ('20:00:60', '20:00:99', '20:00:1', '20:00:-1', '20:00:30.5'):
            with self.subTest(value=value):
                with self.assertRaises(ApiError):
                    validate_manifest({**manifest(kind='service'),'tasks':[{'id':'daily','time':value}]})
                schema={'type':'object','properties':{'time':{'type':'string','format':'time','default':value}}}
                with self.assertRaises(ApiError):
                    validate_manifest({**manifest(kind='service'),'configSchema':schema,
                                       'tasks':[{'id':'daily','schedule':{'configTime':'time'}}]})

    def test_task_schedule_config_references_validate_resolved_types_choices_and_defaults(self):
        schema={'type':'object','properties':{'time':{'type':'string','format':'time','default':'09:00'},
                                             'timezone':{'type':'string','enum':['Asia/Shanghai','UTC'],'default':'Asia/Shanghai'}}}
        value={**manifest(kind='service'),'configSchema':schema,
               'tasks':[{'id':'daily','schedule':{'configTime':'time','configTimezone':'timezone'}}]}
        self.assertEqual(validate_manifest(value),value)
        invalid=[('time',{'type':'integer','default':9}),('time',{'type':'string','default':'09:00'}),
                 ('time',{'type':'string','format':'timezone','default':'UTC'}),
                 ('time',{'type':'string','enum':['09:00','25:00']}),
                 ('time',{'type':'string','format':'time','default':'09:00:60'}),
                 ('timezone',{'type':'boolean','default':False}),
                 ('timezone',{'type':'string','enum':['Unknown/Zone']}),
                 ('timezone',{'type':'string','default':'UTC'}),
                 ('timezone',{'type':'string','format':'date','default':'2026-10-31'})]
        for name,field in invalid:
            changed=copy.deepcopy(value); changed['configSchema']['properties'][name]=field
            with self.subTest(name=name,field=field),self.assertRaises(ApiError):validate_manifest(changed)
        missing=copy.deepcopy(value); del missing['configSchema']['properties']['time']
        with self.assertRaises(ApiError):validate_manifest(missing)
        external={**value,'configSchema':'schemas/config.json'}
        self.assertEqual(validate_manifest(external,config_schema=schema),external)
        with self.assertRaises(ApiError):validate_manifest(external,config_schema={'type':'object','properties':{}})

    def test_configuration_subset_defaults_types_and_bounds(self):
        schema={'type':'object','properties':{'time':{'type':'string','format':'time','default':'09:00'},'timezone':{'type':'string','format':'timezone','default':'Asia/Shanghai'},'count':{'type':'integer','minimum':1,'maximum':3},'on':{'type':'boolean'}},'required':['count']}
        self.assertEqual(schema_defaults(schema),{'time':'09:00','timezone':'Asia/Shanghai'})
        self.assertEqual(validate_config(schema,{'count':2,'on':True}),{'count':2,'on':True})
        for config in ({},{'count':True},{'count':4},{'count':2,'time':'24:01'},{'count':2,'timezone':'Never/Exists'},{'count':2,'extra':'x'}):
            with self.subTest(config=config),self.assertRaises(ApiError): validate_config(schema,config)

    def test_scripts_credentials_unknown_schema_and_non_json_rejected(self):
        schemas=[{'type':'object','properties':{'secret':{'type':'string'}}},
                 {'type':'object','properties':{'x':{'type':'string','script':'eval()'}}},
                 {'type':'object','properties':{'x':{'type':'string','format':'password'}}},
                 {'type':'object','properties':{'x':{'type':[]}}},
                 {'type':'object','properties':{'x':{'type':'string','format':[]}}},
                 {'type':'object','properties':{},'additionalProperties':True},
                 {'type':'object','properties':{},'required':['missing']},
                 {'type':'object','properties':{'x':{'type':'integer','minimum':4,'maximum':1}}}]
        for schema in schemas:
            with self.subTest(schema=schema),self.assertRaises(ApiError): validate_schema(schema)
        with self.assertRaises(ApiError): validate_config({'type':'object','properties':{'x':{'type':'number'}}},{'x':float('nan')})

    def test_multiselect_group_defaults_and_rejected_duplicates_unknown_values(self):
        field={'type':'array','items':{'type':'string','enum':['reading','sport']},'uniqueItems':True,'maxItems':2,'default':[],'group':'偏好'}
        schema={'type':'object','properties':{'topics':field},'required':[]}
        self.assertEqual(schema_defaults(schema),{'topics':[]})
        self.assertEqual(validate_config(schema,{'topics':['reading','sport']}),{'topics':['reading','sport']})
        for value in (['reading','reading'],['unknown'],[True],'reading'):
            with self.subTest(value=value),self.assertRaises(ApiError): validate_config(schema,{'topics':value})
        for edit in ({'group':1},{'maxItems':101},{'uniqueItems':False},{'items':{'type':'object'}},{'default':['reading','reading']}):
            with self.subTest(edit=edit),self.assertRaises(ApiError): validate_schema({'type':'object','properties':{'topics':{**field,**edit}}})
        with self.assertRaises(ApiError): validate_schema({'type':'object','properties':{'name':{'type':'string','group':[]}}})

    def test_protocol_mismatch_is_not_reported_as_an_invalid_manifest(self):
        from lele_growth.plugins.policy import eligibility_reason
        context = dict(publication_status='published', in_scope=True, archived=False, deleted_at=None,
                       installed=True, requires_reenable=False, enabled=True, operation_state='ready',
                       release_id='release', manifest=manifest(), config={},
                       config_schema={'type':'object','properties':{},'required':[]})
        self.assertIsNone(eligibility_reason(context))
        incompatible = copy.deepcopy(context)
        incompatible['manifest']['frontendApi'] = {'major': 1, 'minMinor': 99}
        self.assertEqual(eligibility_reason(incompatible), 'plugin_incompatible')
        invalid = copy.deepcopy(context)
        invalid['manifest']['version'] = 'bad'
        self.assertEqual(eligibility_reason(invalid), 'plugin_manifest_invalid')

"""Protocol 1.0 manifest validation; no code imports or filesystem writes."""
import copy
import re
from pathlib import PurePosixPath
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from lele_growth.child_service import require
from .configuration import validate_schema

PLATFORM_API_MAJOR = 1
PLATFORM_API_MINOR = 1
FRONTEND_API_MINOR = 0
SUPPORTED_CAPABILITIES = frozenset({'plugin.state.read','plugin.state.write','plugin.jobs.schedule','plugin.events.subscribe'})
SUPPORTED_PLUGIN_CAPABILITIES = frozenset({'plugin.private-state','plugin.credentials','plugin.external-operations','plugin.resources'})
SUPPORTED_EVENTS = frozenset({'task.completed'})
MANIFEST_KEYS = {'manifestVersion','id','version','type','name','description','instructions','platformApi','frontendApi','frontend','backend','configSchema','dataSchemaVersion','capabilities','resourceOrigins','tasks','events','icons'}


def safe_relative_path(value):
    require(isinstance(value,str) and 0<len(value)<=240 and '\\' not in value and '%' not in value and not any(ord(c)<33 or ord(c)==127 for c in value),400,'插件资源路径不正确。','plugin_invalid_manifest')
    path = PurePosixPath(value)
    require(not path.is_absolute() and all(part not in ('','..','.') for part in value.split('/')) and ':' not in value and '?' not in value and '#' not in value,400,'插件资源路径越界。','plugin_invalid_manifest')
    return value


def icon_urls(plugin_id, version, manifest):
    """Map exact public metadata URLs to immutable package-relative paths."""
    if not version:
        return {}
    prefix='/plugin-assets/'+plugin_id+'/'+version+'/'
    return {prefix+safe_relative_path(path):path for path in manifest.get('icons',[])}


def _api(value, minor_limit=PLATFORM_API_MINOR):
    require(isinstance(value,dict) and set(value)=={'major','minMinor'} and type(value['major']) is int and type(value['minMinor']) is int and value['major']==1 and 0<=value['minMinor']<=minor_limit,
            400,'插件协议与平台不兼容。','plugin_incompatible')


def _origin(value):
    require(isinstance(value,str) and re.fullmatch(r'https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+',value) is not None,
            400,'插件资源来源不正确。','plugin_invalid_manifest')
    return value


def _schedule_time(value):
    require(isinstance(value,str) and re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?',value) is not None,
            400,'任务时间必须为 HH:MM 或 HH:MM:SS。','plugin_invalid_manifest')


def _schedule_timezone(value):
    require(isinstance(value,str) and 1<=len(value)<=128,400,'任务时区不正确。','plugin_invalid_manifest')
    try:
        ZoneInfo(value)
    except (ValueError,ZoneInfoNotFoundError):
        require(False,400,'任务时区不正确。','plugin_invalid_manifest')


def _schedule_reference(schema, name, *, clock):
    require(isinstance(name,str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}',name) is not None,
            400,'任务配置引用不正确。','plugin_invalid_manifest')
    if schema is None:
        # A path-only manifest cannot resolve package files. Callers validating
        # a complete package pass its already parsed schema to validate_manifest.
        return
    field=schema.get('properties',{}).get(name)
    require(isinstance(field,dict) and field.get('type')=='string',400,'任务配置引用必须指向文本字段。','plugin_invalid_manifest')
    validate_value=_schedule_time if clock else _schedule_timezone
    expected_format='time' if clock else 'timezone'
    require(field.get('format') in (None,expected_format),400,'任务配置引用的格式不匹配。','plugin_invalid_manifest')
    require(field.get('format')==expected_format or bool(field.get('enum')),400,'任务配置引用需要时间/时区格式或固定选项。','plugin_invalid_manifest')
    for value in field.get('enum',[]):
        validate_value(value)
    if 'default' in field:
        validate_value(field['default'])


def _task_schedule(task, schema):
    if 'intervalSeconds' in task:
        require(type(task['intervalSeconds']) is int and 1<=task['intervalSeconds']<=31536000,
                400,'任务间隔不正确。','plugin_invalid_manifest')
        require(not (set(task)&{'schedule','time','timezone'}),400,'间隔任务不能同时声明每日时间计划。','plugin_invalid_manifest')
        return
    schedule=task.get('schedule',{})
    if isinstance(schedule,str):
        schedule={'time':schedule}
    require(isinstance(schedule,dict) and set(schedule)<={'time','timezone','configTime','configTimezone'},
            400,'任务时间计划字段不正确。','plugin_invalid_manifest')
    # Validate explicit fallbacks as well as nested values; null cannot silently
    # replace the safe defaults used by the scheduler.
    for source in (task,schedule):
        if 'time' in source: _schedule_time(source['time'])
        if 'timezone' in source: _schedule_timezone(source['timezone'])
    _schedule_time(schedule.get('time',task.get('time','09:00')))
    _schedule_timezone(schedule.get('timezone',task.get('timezone','Asia/Shanghai')))
    if 'configTime' in schedule:
        _schedule_reference(schema,schedule['configTime'],clock=True)
    if 'configTimezone' in schedule:
        _schedule_reference(schema,schedule['configTimezone'],clock=False)


def validate_manifest(data, *, config_schema=None):
    require(isinstance(data,dict) and set(data)<=MANIFEST_KEYS,400,'插件清单含未知字段。','plugin_invalid_manifest')
    require(type(data.get('manifestVersion')) is int and data['manifestVersion']==1,400,'不支持的清单版本。','plugin_invalid_manifest')
    require(isinstance(data.get('id'),str) and len(data['id'])<=64 and re.fullmatch(r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*',data['id']) is not None,400,'插件标识不正确。','plugin_invalid_manifest')
    require(isinstance(data.get('version'),str) and re.fullmatch(r'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)',data['version']) is not None,400,'插件版本不正确。','plugin_invalid_manifest')
    require(data.get('type') in ('page','service'),400,'插件类型不正确。','plugin_invalid_manifest')
    _api(data.get('platformApi'))
    frontend=data.get('frontend')
    if data['type']=='page':
        _api(data.get('frontendApi'), FRONTEND_API_MINOR)
        require(isinstance(frontend,dict) and set(frontend)<={'entry','styles'},400,'页面型插件缺少入口。','plugin_invalid_manifest')
        safe_relative_path(frontend.get('entry'))
        require(isinstance(frontend.get('styles',[]),list),400,'样式列表不正确。','plugin_invalid_manifest')
        for value in frontend.get('styles',[]): safe_relative_path(value)
    else:
        require(frontend is None,400,'后台型插件不能声明页面入口。','plugin_invalid_manifest')
        if data.get('frontendApi') is not None: _api(data['frontendApi'], FRONTEND_API_MINOR)
    backend=data.get('backend')
    if backend is not None:
        require(isinstance(backend,dict) and set(backend)<={'entryModule','requestTimeoutSeconds'} and 'entryModule' in backend and isinstance(backend['entryModule'],str) and re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*',backend['entryModule']) is not None,400,'后端入口不正确。','plugin_invalid_manifest')
        if 'requestTimeoutSeconds' in backend:
            require(type(backend['requestTimeoutSeconds']) is int and 1<=backend['requestTimeoutSeconds']<=45,400,'后端请求预算不正确。','plugin_invalid_manifest')
    require(data['type']!='service' or backend is not None,400,'后台型插件缺少后端入口。','plugin_invalid_manifest')
    schema=data.get('configSchema')
    if isinstance(schema,dict): validate_schema(schema)
    elif schema is not None: safe_relative_path(schema)
    if config_schema is not None:
        resolved_schema=validate_schema(config_schema)
        require(not isinstance(schema,dict) or resolved_schema==schema,400,'解析后的配置结构与清单不一致。','plugin_invalid_manifest')
    else:
        resolved_schema=schema if isinstance(schema,dict) else None if isinstance(schema,str) else {'type':'object','properties':{}}
    require(type(data.get('dataSchemaVersion')) is int and data['dataSchemaVersion']>=1,400,'数据版本不正确。','plugin_invalid_manifest')
    capabilities=data.get('capabilities',[])
    require(isinstance(capabilities,list) and all(isinstance(c,str) and c in SUPPORTED_CAPABILITIES|SUPPORTED_PLUGIN_CAPABILITIES for c in capabilities) and len(capabilities)==len(set(capabilities)),400,'插件请求未支持的能力。','plugin_incompatible')
    resource_origins=data.get('resourceOrigins',[])
    require(isinstance(resource_origins,list) and len(resource_origins)<=16 and len(resource_origins)==len(set(resource_origins)),400,'插件资源来源不正确。','plugin_invalid_manifest')
    for origin in resource_origins: _origin(origin)
    require(not resource_origins or 'plugin.resources' in capabilities,400,'资源来源需要资源能力。','plugin_incompatible')
    icons=data.get('icons',[])
    require(isinstance(icons,list) and len(icons)<=16,400,'图标列表不正确。','plugin_invalid_manifest')
    for icon in icons: safe_relative_path(icon)
    tasks=data.get('tasks',[])
    require(isinstance(tasks,list) and len(tasks)<=32,400,'任务列表不正确。','plugin_invalid_manifest')
    seen=set()
    for task in tasks:
        require(isinstance(task,dict) and set(task)<={'id','schedule','intervalSeconds','time','timezone','misfirePolicy','timeoutSeconds'} and isinstance(task.get('id'),str) and re.fullmatch(r'[a-z][a-z0-9-]{0,63}',task['id']) is not None and task['id'] not in seen,400,'任务声明不正确。','plugin_invalid_manifest')
        seen.add(task['id'])
        require(task.get('misfirePolicy','skip') in ('skip','latest'),400,'任务补偿策略不正确。','plugin_invalid_manifest')
        if 'timeoutSeconds' in task: require(type(task['timeoutSeconds']) is int and 1<=task['timeoutSeconds']<=300)
        _task_schedule(task,resolved_schema)
    events=data.get('events',[])
    require(isinstance(events,list) and all(isinstance(event,str) and event in SUPPORTED_EVENTS for event in events) and len(events)==len(set(events)),400,'事件声明不正确。','plugin_invalid_manifest')
    require(not tasks and not events or backend is not None,400,'任务与事件需要后端入口。','plugin_invalid_manifest')
    for key in ('name','description','instructions'):
        require(key not in data or isinstance(data[key],str) and len(data[key])<=4000,400,'插件说明不正确。','plugin_invalid_manifest')
    return copy.deepcopy(data)

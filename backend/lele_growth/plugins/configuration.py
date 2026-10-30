"""Strict, side-effect-free JSON Schema subset for shared child configuration."""
import copy
import json
import math
import re
from datetime import date, datetime, time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from lele_growth.child_service import require, ApiError

EMPTY_SCHEMA = {'type':'object','properties':{},'required':[]}
TYPES = {'string','boolean','number','integer','array'}
FORMATS = {'time','date','date-time','timezone','email','uri'}
FIELD_KEYS = {'type','title','description','default','enum','minimum','maximum','format','minLength','maxLength','group','items','uniqueItems','maxItems','minItems'}


def _finite_number(value):
    return type(value) is int or type(value) is float and math.isfinite(value)


def _json_size(value, limit=65536):
    try:
        encoded = json.dumps(value, allow_nan=False, ensure_ascii=False)
    except (TypeError, ValueError, OverflowError):
        require(False, 400, '配置必须为有效 JSON。', 'plugin_invalid_config')
    require(len(encoded.encode()) <= limit, 400, '配置内容过大。', 'plugin_invalid_config')


def _validate_value(field, value):
    kind = field['type']
    valid = ((kind=='string' and isinstance(value,str)) or
             (kind=='boolean' and type(value) is bool) or
             (kind=='integer' and type(value) is int) or
             (kind=='number' and _finite_number(value)) or
             (kind=='array' and isinstance(value,list)))
    require(valid, 400, '配置字段类型不正确。', 'plugin_invalid_config')
    if kind=='array':
        require(field.get('minItems',0)<=len(value)<=field.get('maxItems',100) and all(isinstance(item,str) and item in field['items']['enum'] for item in value),400,'配置包含无效多选选项。','plugin_invalid_config')
        require(len(value)==len(set(value)),400,'配置多选项不能重复。','plugin_invalid_config')
    if 'enum' in field:
        require(any(type(value) is type(item) and value==item or kind=='number' and type(item) in (int,float) and value==item for item in field['enum']),
                400, '配置选项不正确。', 'plugin_invalid_config')
    if kind in ('integer','number'):
        require(('minimum' not in field or value>=field['minimum']) and ('maximum' not in field or value<=field['maximum']),
                400, '配置数值超出范围。', 'plugin_invalid_config')
    if kind=='string':
        require(field.get('minLength',0)<=len(value)<=field.get('maxLength',10000), 400, '配置文本长度不正确。', 'plugin_invalid_config')
        fmt = field.get('format')
        try:
            if fmt=='time':
                require(re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?',value) is not None)
                time.fromisoformat(value)
            elif fmt=='date':
                require(re.fullmatch(r'\d{4}-\d{2}-\d{2}',value) is not None)
                date.fromisoformat(value)
            elif fmt=='date-time':
                require('T' in value and datetime.fromisoformat(value.replace('Z','+00:00')).tzinfo is not None)
            elif fmt=='timezone':
                ZoneInfo(value)
            elif fmt=='email':
                require(re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',value) is not None)
            elif fmt=='uri':
                from urllib.parse import urlsplit
                require(urlsplit(value).scheme in ('https','http') and bool(urlsplit(value).hostname))
        except (ValueError, ZoneInfoNotFoundError, ApiError):
            require(False, 400, '配置格式不正确。', 'plugin_invalid_config')


def validate_schema(schema):
    require(isinstance(schema,dict) and set(schema)<={'type','properties','required','title','description','additionalProperties'},
            400, '不支持的配置结构。', 'plugin_invalid_schema')
    require(schema.get('type')=='object' and isinstance(schema.get('properties',{}),dict),400,'配置必须为对象。','plugin_invalid_schema')
    require(schema.get('additionalProperties',False) is False,400,'不允许未知配置字段。','plugin_invalid_schema')
    for key in ('title','description'):
        require(key not in schema or isinstance(schema[key],str) and len(schema[key])<=2000,400,'配置说明不正确。','plugin_invalid_schema')
    properties = schema.get('properties',{})
    required = schema.get('required',[])
    require(isinstance(required,list) and all(isinstance(k,str) and k in properties for k in required) and len(required)==len(set(required)),400,'必填字段不正确。','plugin_invalid_schema')
    require(len(properties)<=64,400,'配置字段过多。','plugin_invalid_schema')
    for name, field in properties.items():
        require(isinstance(name,str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}',name) is not None,400,'配置字段名不正确。','plugin_invalid_schema')
        require(not re.search(r'secret|password|credential|token|apikey|api_key',name,re.I),400,'配置暂不支持凭据字段。','plugin_invalid_schema')
        require(isinstance(field,dict) and set(field)<=FIELD_KEYS and isinstance(field.get('type'),str) and field['type'] in TYPES,400,'不支持的配置字段。','plugin_invalid_schema')
        for key in ('title','description','group'):
            require(key not in field or isinstance(field[key],str) and len(field[key])<=(80 if key=='group' else 2000),400,'配置说明不正确。','plugin_invalid_schema')
        if field['type']=='array':
            items=field.get('items')
            require(isinstance(items,dict) and set(items)=={'type','enum'} and items['type']=='string' and isinstance(items['enum'],list) and 1<=len(items['enum'])<=100 and all(isinstance(item,str) and len(item)<=1000 for item in items['enum']) and len(items['enum'])==len(set(items['enum'])),400,'多选配置需要固定文本选项。','plugin_invalid_schema')
            require(field.get('uniqueItems',True) is True and 'enum' not in field,400,'多选配置不支持重复值。','plugin_invalid_schema')
        else:
            require(not (set(field)&{'items','uniqueItems','maxItems','minItems'}),400,'多选约束仅用于多选字段。','plugin_invalid_schema')
        for key in ('maxItems','minItems'):
            require(key not in field or type(field[key]) is int and 0<=field[key]<=100,400,'多选数量限制不正确。','plugin_invalid_schema')
        require(field.get('minItems',0)<=field.get('maxItems',100),400,'多选数量限制不正确。','plugin_invalid_schema')
        for key in ('minimum','maximum'):
            require(key not in field or field['type'] in ('number','integer') and _finite_number(field[key]),400,'配置范围不正确。','plugin_invalid_schema')
        require('minimum' not in field or 'maximum' not in field or field['minimum']<=field['maximum'],400,'配置范围不正确。','plugin_invalid_schema')
        for key in ('minLength','maxLength'):
            require(key not in field or field['type']=='string' and type(field[key]) is int and 0<=field[key]<=10000,400,'配置长度不正确。','plugin_invalid_schema')
        require(field.get('minLength',0)<=field.get('maxLength',10000),400,'配置长度不正确。','plugin_invalid_schema')
        require('format' not in field or field['type']=='string' and isinstance(field['format'],str) and field['format'] in FORMATS,400,'不支持的配置格式。','plugin_invalid_schema')
        if 'enum' in field:
            require(isinstance(field['enum'],list) and 1<=len(field['enum'])<=100,400,'配置选项不正确。','plugin_invalid_schema')
            check = {k:v for k,v in field.items() if k not in ('enum','default')}
            for value in field['enum']:
                _validate_value(check,value)
        if 'default' in field:
            _validate_value(field,field['default'])
    _json_size(schema)
    return copy.deepcopy(schema)


def validate_config(schema, config):
    schema = validate_schema(schema)
    _json_size(config)
    require(isinstance(config,dict) and set(config)<=set(schema.get('properties',{})),400,'配置含未知字段。','plugin_invalid_config')
    require(all(key in config and config[key] != '' for key in schema.get('required',[])),400,'请填写必填配置。','plugin_config_required')
    for name,value in config.items():
        _validate_value(schema['properties'][name],value)
    return copy.deepcopy(config)


def schema_defaults(schema):
    schema = validate_schema(schema)
    return {name:copy.deepcopy(field['default']) for name,field in schema.get('properties',{}).items() if 'default' in field}

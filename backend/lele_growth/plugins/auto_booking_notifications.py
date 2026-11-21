"""Encrypted Bark keys and durable, single-attempt booking notifications."""
from copy import deepcopy
import hashlib
import json
import re
import uuid

from lele_growth.child_service import require


def defaults():
    return {'enabled': False, 'barkKeys': [], 'events': ['booked']}


def validate(value):
    required = {'enabled', 'barkKeys', 'events'}
    require(isinstance(value, dict) and set(value) in (required, required | {'barkKeyNames'})
            and type(value['enabled']) is bool, 400, '消息提醒设置不正确。', 'VALIDATION_ERROR')
    keys, events = value['barkKeys'], value['events']
    require(isinstance(keys, list) and len(keys) <= 10
            and all(isinstance(key, str) and re.fullmatch(r'[A-Za-z0-9_-]{8,128}', key) for key in keys)
            and len(keys) == len(set(keys)), 400, '请填写最多10个有效且不重复的Bark Key。', 'VALIDATION_ERROR')
    require(isinstance(events, list) and all(event == 'booked' for event in events) and len(events) <= 1,
            400, '请选择有效的通知场景。', 'VALIDATION_ERROR')
    require(not value['enabled'] or keys and events, 400, '开启消息提醒需要填写Bark Key并选择通知场景。', 'VALIDATION_ERROR')
    if 'barkKeyNames' in value:
        names = value['barkKeyNames']
        require(isinstance(names, list) and len(names) == len(keys)
                and all(isinstance(name, str) and len(name.strip()) <= 40 for name in names),
                400, '设备名称应与Bark Key一一对应，每个名称最多40个字。', 'VALIDATION_ERROR')
        value['barkKeyNames'] = [name.strip() for name in names]


def fingerprint(key):
    return hashlib.sha256(key.encode()).hexdigest()


def scope(current, account_key):
    return {'provider': 'bark', 'plugin_id': current['plugin_id'], 'child_id': current['child_id'],
            'credential_id': 'auto-booking-bark:' + account_key}


def store(state, current, account_key, vault, actor_id):
    config = state['config']['notifications']
    keys = config['barkKeys']
    if keys:
        fingerprints = [fingerprint(key) for key in keys]
        names = config.get('barkKeyNames')
        previous_names = (state.get('notificationCredentials') or {}).get('names')
        if names is None and previous_names is not None and state.get('notificationOwnerId') == actor_id:
            # Legacy saves retain aliases by key identity, never by position or across owners.
            names = [previous_names.get(key, '') for key in fingerprints]
        require(vault is not None, 503, '消息提醒密钥存储暂不可用。', 'plugin_vault_unavailable')
        key_id, nonce, ciphertext = vault.encrypt(**scope(current, account_key), token=json.dumps(keys))
        state['notificationCredentials'] = {'key_id': key_id, 'nonce': nonce, 'ciphertext': ciphertext,
                                            'fingerprints': fingerprints}
        if names is not None:
            state['notificationCredentials']['names'] = dict(zip(fingerprints, names))
        state['notificationOwnerId'] = actor_id
    else:
        state['notificationCredentials'] = None
        state['notificationOwnerId'] = None
    config['barkKeys'] = []
    config.pop('barkKeyNames', None)
    if not config['enabled']:
        for item in state.get('notificationQueue', {}).values():
            if item['state'] == 'pending':
                item['state'] = 'skipped'


def keys(state, current, account_key, vault):
    encrypted = state.get('notificationCredentials')
    if not encrypted:
        return []
    require(vault is not None, 503, '消息提醒密钥存储暂不可用。', 'plugin_vault_unavailable')
    return json.loads(vault.decrypt(**scope(current, account_key), **{
        key: encrypted[key] for key in ('key_id', 'nonce', 'ciphertext')}))


def public(state, can_manage, current, account_key, vault, owner_valid):
    if not owner_valid:
        return defaults()
    value = deepcopy(state['config']['notifications'])
    value.pop('barkKeyNames', None)
    encrypted = state.get('notificationCredentials') or {}
    value['barkKeys'] = keys(state, current, account_key, vault) if can_manage else [
        '已配置' for _ in encrypted.get('fingerprints', [])]
    if can_manage and 'names' in encrypted:
        value['barkKeyNames'] = [encrypted['names'].get(key, '')
                                 for key in encrypted.get('fingerprints', [])]
    return value


def pending(state):
    return any(item['state'] in ('pending', 'sending') for item in state.get('notificationQueue', {}).values())


def enqueue(state, booking):
    config = state['config']['notifications']
    recipients = (state.get('notificationCredentials') or {}).get('fingerprints', [])
    consent_owner = state.get('notificationOwnerId')
    if not config['enabled'] or 'booked' not in config['events'] or not recipients or consent_owner != state['ownerId']:
        return
    queue = state.setdefault('notificationQueue', {})
    queue.setdefault(booking['operationId'], {
        'state': 'pending', 'date': booking['date'], 'time': booking['time'],
        'teacherName': booking['teacher']['name'], 'lessons': len(booking.get('times', [booking['time']])),
        'recipients': recipients, 'ownerId': consent_owner,
    })
    completed = [key for key, item in queue.items() if item['state'] not in ('pending', 'sending')]
    for key in completed[:-10]:
        del queue[key]


def claim(state, current, account_key, vault, record_event):
    config = state['config']['notifications']
    available = None
    for operation_id, item in state.get('notificationQueue', {}).items():
        if item['state'] == 'sending':
            item['state'] = 'uncertain'
            record_event('Bark消息提醒发送结果未确认，未重复推送。', item)
        if item['state'] != 'pending':
            continue
        if (not config['enabled'] or 'booked' not in config['events']
                or item.get('ownerId') != state.get('notificationOwnerId') or item.get('ownerId') != state['ownerId']):
            item['state'] = 'skipped'
            continue
        if available is None:
            available = keys(state, current, account_key, vault)
        recipients = [key for key in available if fingerprint(key) in item['recipients']]
        if not recipients:
            item['state'] = 'skipped'
            continue
        claim_id = str(uuid.uuid4())
        item.update(state='sending', claimId=claim_id, recipientCount=len(recipients))
        _, month, day = item['date'].split('-')
        return {'operationId': operation_id, 'claimId': claim_id, 'keys': recipients,
                'title': '美森约课成功',
                'body': f"成功预约 {item['teacherName']} {int(month)}/{int(day)} {item['time']}"}
    return None


def finish(state, payload, record_event):
    item = state.get('notificationQueue', {}).get(payload.get('operationId'))
    require(item is not None and item.get('claimId') == payload.get('claimId')
            and payload.get('state') in ('succeeded', 'failed', 'uncertain'),
            409, '消息提醒轮次已改变。', 'AUTO_BOOKING_CHANGED')
    if item['state'] != 'sending':
        return
    item['state'] = payload['state']
    message = {'succeeded': f"Bark已接受约课成功提醒（{item['recipientCount']}个设备）。",
               'failed': 'Bark消息提醒发送失败，请检查Key和网络。',
               'uncertain': 'Bark消息提醒发送结果未确认，未重复推送。'}[item['state']]
    record_event(message, item)

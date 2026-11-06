"""One eligibility policy for routes, workers, and final effect transactions.

Lock order is catalog -> child -> installation/config. Never retain these locks
while contacting a plugin process. A final write must obtain a fresh context and
compare every fence using assert_fences before producing an effect.
"""
from lele_growth.child_service import require, ApiError


def row_dict(cur, row=None):
    row = cur.fetchone() if row is None else row
    if row is None:
        return None
    return dict(row) if isinstance(row, dict) else dict(zip((c.name for c in cur.description), row))


def rows_dict(cur):
    names = [c.name for c in cur.description]
    return [dict(row) if isinstance(row, dict) else dict(zip(names, row)) for row in cur.fetchall()]


def catalog_row(cur, plugin_id, *, lock='SHARE'):
    require(lock in ('SHARE','UPDATE'))
    cur.execute('SELECT * FROM lele.plugin_catalog WHERE id=%s FOR ' + lock, (plugin_id,))
    result = row_dict(cur)
    require(result is not None, 404, '应用不存在。', 'plugin_not_found')
    return result


def load_context(cur, plugin_id, child_id):
    context = catalog_row(cur, plugin_id)
    cur.execute('SELECT id AS child_id,name AS child_name,archived,deleted_at,owner_id FROM lele.children WHERE id=%s FOR UPDATE', (child_id,))
    child = row_dict(cur)
    require(child is not None, 404, '孩子不存在。', 'child_not_found')
    context.update(child)
    cur.execute('SELECT * FROM lele.child_plugins WHERE plugin_id=%s AND child_id=%s FOR UPDATE', (plugin_id,child_id))
    installation = row_dict(cur)
    context.update(installation or dict(plugin_id=plugin_id, installed=False, enabled=False, requires_reenable=False, revision=0, generation=0))
    cur.execute('SELECT config,config_revision,config_schema_version FROM lele.child_plugin_configs WHERE plugin_id=%s AND child_id=%s FOR SHARE', (plugin_id,child_id))
    context.update(row_dict(cur) or dict(config={}, config_revision=0, config_schema_version=1))
    cur.execute('SELECT EXISTS(SELECT 1 FROM lele.plugin_scope_children WHERE plugin_id=%s AND child_id=%s) AS in_scope', (plugin_id,child_id))
    context['in_scope'] = context['scope_mode']=='all' or row_dict(cur)['in_scope']
    if context['active_release_id']:
        cur.execute('SELECT release_id,version,manifest,config_schema,data_schema_version,artifact_sha256,source_commit FROM lele.plugin_releases WHERE plugin_id=%s AND release_id=%s', (plugin_id,context['active_release_id']))
        context.update(row_dict(cur) or {})
    context.setdefault('release_id',None)
    context.setdefault('version',None)
    context.setdefault('manifest',{})
    context.setdefault('config_schema',dict(type='object',properties={},required=[]))
    context['capabilities'] = context['manifest'].get('capabilities',[])
    context['policy_revision'] = int(context['policy_revision'])
    context['reason'] = eligibility_reason(context)
    context['effective_enabled'] = context['reason'] is None
    # Stable invocation contract. Snake-case names remain available to SQL consumers.
    for public, column in (('pluginId','plugin_id'),('childId','child_id'),('releaseId','release_id'),('configRevision','config_revision'),('releaseEpoch','release_epoch'),('policyRevision','policy_revision')):
        context[public] = context[column]
    return context


def eligibility_reason(context, *, require_enabled=True):
    if context['publication_status'] != 'published':
        return 'plugin_' + context['publication_status']
    if not context['in_scope']:
        return 'plugin_out_of_scope'
    if context['archived'] or context['deleted_at'] is not None:
        return 'child_unavailable'
    if not context['installed']:
        return 'plugin_not_installed'
    if require_enabled and context['requires_reenable']:
        return 'plugin_requires_reenable'
    if require_enabled and not context['enabled']:
        return 'plugin_disabled'
    if context['operation_state'] != 'ready':
        return 'plugin_' + context['operation_state']
    if not context.get('release_id'):
        return 'plugin_release_unavailable'
    from .manifest import validate_manifest
    from .configuration import validate_config
    try:
        validate_manifest(context['manifest'],config_schema=context['config_schema'])
    except ApiError as error:
        # A stale process can reject a newer protocol. That is not a corrupt package.
        return 'plugin_incompatible' if error.kind == 'plugin_incompatible' else 'plugin_manifest_invalid'
    try:
        validate_config(context['config_schema'], context['config'])
    except ApiError as error:
        return 'plugin_config_required' if error.kind == 'plugin_config_required' else 'plugin_config_invalid'
    return None


def active_context(cur, plugin_id, child_id, require_enabled=True):
    context = load_context(cur, plugin_id, child_id)
    reason = eligibility_reason(context, require_enabled=require_enabled)
    require(reason is None, 503 if reason in ('plugin_updating','plugin_failed') else 409,
            '应用当前不可用，请刷新应用状态。', reason)
    return context


def assert_fences(current, supplied):
    # policyRevision is an administrator's optimistic metadata revision and
    # remains signed. Availability is rechecked by active_context; metadata
    # edits alone must not revoke an otherwise valid in-flight operation.
    for field, alias in (('generation','generation'),('config_revision','configRevision'),('release_epoch','releaseEpoch'),('release_id','releaseId')):
        value = supplied.get(field, supplied.get(alias))
        require(value == current[field], 409, '应用状态已改变，请重试。', 'plugin_context_revoked')
    for field, alias in (('plugin_id','pluginId'),('child_id','childId')):
        require(supplied.get(field,supplied.get(alias)) == current[field], 403, '应用上下文不匹配。', 'plugin_context_revoked')

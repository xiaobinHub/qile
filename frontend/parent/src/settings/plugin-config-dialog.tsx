import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react"
import { Button } from "@shared/components/ui/button"
import { ConfigFields } from "../plugins/config-fields"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@shared/components/ui/dialog"
import { pluginClient } from "../plugins/client"
import {
  configDraft,
  schemaProblem,
  validateConfig,
  type ConfigDraft,
} from "../plugins/config-schema"
import {
  canConfigure,
  ConfigEnableError,
  pluginError,
  pluginReason,
  pluginStore,
  usePlugins,
} from "../plugins/store"
import type { ConfigResponse, Plugin } from "../plugins/types"
import { runtime } from "../lib/runtime"
import type { Child } from "./types"

export function PluginConfigDialog({
  child,
  plugin: initialPlugin,
  onClose,
  notify,
}: {
  child: Child
  plugin: Plugin
  onClose: () => void
  notify: (message: string) => void
}) {
  const state = usePlugins()
  const knownPlugin =
    state.childId === child.id
      ? state.plugins.find((item) => item.id === initialPlugin.id)
      : undefined
  const plugin = knownPlugin || initialPlugin
  const [loaded, setLoaded] = useState<ConfigResponse | null>(null)
  const [draft, setDraft] = useState<ConfigDraft>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)
  const [reading, setReading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const active = useRef(true)
  const pending = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement)
  const epoch = runtime.getSnapshot().epoch
  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    try {
      pluginStore.requireConfirmed(child.id, epoch)
    } catch (failure) {
      setError(pluginError(failure))
      setReading(false)
      return () => controller.abort()
    }
    setReading(true)
    setError("")
    setErrors({})
    setLoaded(null)
    void pluginClient
      .config(child.id, initialPlugin.id, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || !pluginStore.matches(child.id, epoch)) return
        setLoaded(result)
        setDraft(configDraft(result.config, result.schema))
        setConflict(false)
      })
      .catch((failure) => {
        if (!controller.signal.aborted && pluginStore.matches(child.id, epoch))
          setError(pluginError(failure))
      })
      .finally(() => {
        if (!controller.signal.aborted && active.current) setReading(false)
      })
    return () => controller.abort()
  }, [child.id, initialPlugin.id, epoch, reload])
  const unsupported = loaded ? schemaProblem(loaded.schema) : ""
  const changed =
    !!loaded &&
    (plugin.configRevision !== loaded.revision || plugin.releaseId !== loaded.plugin.releaseId)
  const removed = state.childId === child.id && !state.loading && !state.error && !knownPlugin
  const confirmed = state.confirmed && state.childId === child.id && state.epoch === epoch
  const editable =
    confirmed && canConfigure(plugin, child) && !removed && !unsupported && !changed && !conflict
  const canSaveAndEnable = plugin.installed && (!plugin.enabled || plugin.requiresReenable)
  const busy = saving || state.pending.includes(plugin.id)
  function update(key: string, value: ConfigDraft[string] | undefined) {
    setDraft((old) => {
      const next = { ...old }
      if (value === undefined) delete next[key]
      else next[key] = value
      return next
    })
    setErrors((old) => ({ ...old, [key]: "" }))
  }
  async function submit(event?: FormEvent, enable = false) {
    event?.preventDefault()
    if (pending.current || !loaded || !editable || !pluginStore.matches(child.id, epoch)) return
    const checked = validateConfig(draft, loaded.schema)
    setErrors(checked.errors)
    if (Object.keys(checked.errors).length) {
      document.querySelector<HTMLElement>('#pluginConfigDialog [aria-invalid="true"]')?.focus()
      return
    }
    pending.current = true
    setSaving(true)
    setError("")
    try {
      const result = await pluginStore.saveConfig(
        child.id,
        plugin,
        checked.config,
        loaded.revision,
        enable,
      )
      if (!active.current || !pluginStore.matches(child.id, epoch)) return
      setLoaded(result)
      setDraft(configDraft(result.config, result.schema))
      notify(enable ? "应用配置已保存并启用。" : "应用配置已保存，当前儿童的家人共享此配置。")
    } catch (failure) {
      if (active.current && pluginStore.matches(child.id, epoch)) {
        setError(pluginError(failure))
        if (failure instanceof ConfigEnableError) setLoaded(failure.saved)
        else if ((failure as { status?: number }).status === 409) setConflict(true)
      }
    } finally {
      pending.current = false
      if (active.current) setSaving(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose()
      }}
    >
      <DialogContent
        id="pluginConfigDialog"
        className="plugin-config-dialog ui-modal-frame"
        showCloseButton={!saving}
        onEscapeKeyDown={(event) => {
          if (pending.current) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (!pluginStore.matches(child.id, epoch)) return
          const fallback = [
            ...document.querySelectorAll<HTMLButtonElement>("[data-plugin-config]"),
          ].find((button) => button.dataset.pluginConfig === plugin.id)
          const target = returnFocus.current?.isConnected ? returnFocus.current : fallback
          target?.focus()
        }}
      >
        <DialogHeader className="ui-modal-header">
          <DialogTitle>{plugin.name} · 配置</DialogTitle>
          <DialogDescription>
            {child.name}的家人共享此配置{child.role !== "owner" ? "，仅负责人可修改。" : "。"}
          </DialogDescription>
        </DialogHeader>
        <form
          id="pluginConfigForm"
          className="plugin-config-form"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <div className="plugin-config-body">
            {plugin.instructions && <p className="plugin-instructions">{plugin.instructions}</p>}
            {pluginReason(plugin) && <p className="settings-notice">{pluginReason(plugin)}</p>}
            {child.archived && <p className="settings-notice">儿童已归档，配置仅可查看。</p>}
            {reading ? <p role="status">正在读取共享配置…</p> : null}
            {!confirmed && (
              <p role="status" className="settings-notice">
                应用状态未确认，请刷新成功后再操作。配置草稿已保留。
              </p>
            )}
            {removed && (
              <p role="status" className="settings-notice">
                应用安装状态已更新，当前配置仅可查看。
              </p>
            )}
            {(changed || conflict) && (
              <p role="alert" className="settings-notice">
                配置或版本已更新。请重新读取，核对最新配置后再保存。
              </p>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            {unsupported && (
              <p role="alert" className="form-error">
                {unsupported}
              </p>
            )}
            {loaded && !unsupported && (
              <fieldset disabled={!editable || busy || reading} className="plugin-config-fields">
                <ConfigFields
                  schema={loaded.schema}
                  draft={draft}
                  errors={errors}
                  disabled={!editable || busy || reading}
                  update={update}
                />
                {!Object.keys(loaded.schema.properties || {}).length && (
                  <p className="settings-notice">此应用无需配置。</p>
                )}
              </fieldset>
            )}
          </div>
          <DialogFooter className="ui-modal-footer">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              关闭
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!confirmed || busy || reading}
              onClick={() => setReload((value) => value + 1)}
            >
              重新读取
            </Button>
            {!confirmed && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void pluginStore.refresh()}
              >
                刷新状态
              </Button>
            )}
            {child.role === "owner" && (
              <Button type="submit" disabled={!loaded || !editable || busy || reading}>
                {saving ? "正在保存…" : "保存配置"}
              </Button>
            )}
            {child.role === "owner" && canSaveAndEnable && (
              <Button
                type="button"
                data-plugin-save-enable
                disabled={!loaded || !editable || busy || reading}
                onClick={() => void submit(undefined, true)}
              >
                {saving ? "正在处理…" : "保存并启用"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

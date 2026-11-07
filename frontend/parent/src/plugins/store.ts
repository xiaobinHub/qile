import { useSyncExternalStore } from "react"
import { ApiError, runtime } from "../lib/runtime"
import { pluginClient } from "./client"
import type { ConfigResponse, Plugin, PluginAction, PluginConfig } from "./types"

type Child = { id: string; role: "owner" | "parent"; archived: boolean }
type Snapshot = {
  childId: string | null
  epoch: number
  plugins: Plugin[]
  loading: boolean
  confirmed: boolean
  error: string
  pending: string[]
  catalogVersion: number
}
export function inScope(plugin: Plugin, childId: string) {
  return plugin.scopeMode === "all" || plugin.childIds.includes(childId)
}
export function canConfigure(plugin: Plugin, child: Child) {
  return (
    child.role === "owner" &&
    !child.archived &&
    plugin.installed &&
    plugin.publicationStatus === "published" &&
    inScope(plugin, child.id) &&
    plugin.operationState === "ready"
  )
}
export function hasPageTab(plugin: Plugin, childId: string) {
  return (
    plugin.type === "page" &&
    plugin.installed &&
    (plugin.effectiveEnabled ||
      (plugin.enabled &&
        !plugin.requiresReenable &&
        plugin.publicationStatus === "published" &&
        inScope(plugin, childId) &&
        (plugin.operationState === "updating" || plugin.operationState === "failed")))
  )
}
export function pluginStatus(plugin: Plugin) {
  if (!plugin.installed) return "未安装"
  if (plugin.publicationStatus !== "published") return "已下架"
  if (plugin.operationState === "updating") return "更新中"
  if (plugin.operationState === "failed") return "暂不可用"
  if (plugin.configRequired) return "待配置"
  if (plugin.requiresReenable) return "需重新启用"
  if (plugin.effectiveEnabled) return "已启用"
  return plugin.enabled ? "暂不可用" : "已停用"
}
export function pluginReason(plugin: Plugin) {
  if (plugin.publicationStatus !== "published") return "应用已下架，可查看配置或卸载。"
  if (plugin.operationState === "updating")
    return "应用正在更新，请稍后刷新状态；期间可停用或卸载。"
  if (plugin.operationState === "failed") return "应用暂时无法运行，请稍后刷新。"
  if (plugin.reason === "plugin_incompatible")
    return "当前服务与此应用协议不兼容，请重启服务后再试。"
  if (plugin.reason === "plugin_manifest_invalid") return "应用版本定义无效，请联系管理员更新应用。"
  if (plugin.reason === "plugin_config_invalid") return "应用配置无效，请负责人重新检查配置。"
  if (plugin.configRequired) return "请由负责人完成配置后启用。"
  if (plugin.requiresReenable) return "应用恢复可用后，需要负责人手动重新启用。"
  if (plugin.reason === "out_of_scope" || plugin.reason === "plugin_out_of_scope")
    return "当前儿童已不在应用开放范围内，可查看配置或卸载。"
  return plugin.enabled && !plugin.effectiveEnabled ? "当前应用暂不可用，请刷新状态。" : ""
}
export function pluginError(error: unknown) {
  if (error instanceof ApiError && error.code === "plugin_frontend_incompatible")
    return error.message
  if (error instanceof ApiError && error.status === 409)
    return "应用或配置已被更新，请重新读取并核对后再操作。"
  return error instanceof Error ? error.message : "请求未完成，请稍后重试。"
}
export class ConfigEnableError extends Error {
  constructor(
    public saved: ConfigResponse,
    public failure: unknown,
  ) {
    super(`配置已保存，但启用失败：${pluginError(failure)}`)
  }
}

class PluginStore {
  private state: Snapshot = {
    childId: null,
    epoch: -1,
    plugins: [],
    loading: false,
    confirmed: false,
    error: "",
    pending: [],
    catalogVersion: 0,
  }
  private listeners = new Set<() => void>()
  private context = new AbortController()
  private read: AbortController | null = null
  private readPromise: Promise<void> | null = null
  private statusFence = 0
  private refreshQueued = false
  private contextKey = ""
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private patch(next: Partial<Snapshot>) {
    this.state = { ...this.state, ...next }
    this.listeners.forEach((listener) => listener())
  }
  start = () => {
    const sync = () => {
      const { child, epoch, user } = runtime.getSnapshot()
      const key = `${user?.id}:${child?.id}:${epoch}:${child?.role}:${child?.archived}`
      if (key === this.contextKey) return
      this.contextKey = key
      this.context.abort()
      this.context = new AbortController()
      this.read?.abort()
      this.read = null
      this.readPromise = null
      this.statusFence++
      this.refreshQueued = false
      this.patch({
        childId: user ? child?.id || null : null,
        epoch,
        plugins: [],
        loading: !!(user && child),
        confirmed: false,
        error: "",
        pending: [],
        catalogVersion: this.state.catalogVersion + 1,
      })
      if (user && child) void this.refresh()
    }
    const unsubscribe = runtime.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
      this.context.abort()
      this.read?.abort()
      this.read = null
      this.readPromise = null
      this.contextKey = ""
    }
  }
  matches(childId: string, epoch: number) {
    const current = runtime.getSnapshot()
    return (
      current.child?.id === childId &&
      current.epoch === epoch &&
      this.state.childId === childId &&
      this.state.epoch === epoch
    )
  }
  requireConfirmed(childId: string, epoch = this.state.epoch) {
    if (!this.matches(childId, epoch)) throw new ApiError("孩子已切换。", "stale")
    if (!this.state.confirmed)
      throw new ApiError("应用状态未确认，请先刷新状态。", "plugin_status_unconfirmed")
  }
  refresh = (): Promise<void> => {
    const { childId, epoch, pending } = this.state
    if (!childId || pending.length || !this.matches(childId, epoch)) return Promise.resolve()
    if (this.readPromise) return this.readPromise
    const controller = new AbortController()
    this.read = controller
    const fence = this.statusFence
    const promise = this.readStatus(childId, epoch, controller, fence)
    this.readPromise = promise
    return promise
  }
  private async readStatus(
    childId: string,
    epoch: number,
    controller: AbortController,
    fence: number,
  ) {
    try {
      const { plugins } = await pluginClient.status(childId, controller.signal)
      if (controller.signal.aborted || !this.matches(childId, epoch) || fence !== this.statusFence)
        return
      if (!Array.isArray(plugins)) throw new Error("应用状态格式不正确，请刷新重试。")
      const changed = JSON.stringify(plugins) !== JSON.stringify(this.state.plugins)
      this.patch({
        plugins,
        loading: false,
        confirmed: true,
        error: "",
        catalogVersion: this.state.catalogVersion + (changed ? 1 : 0),
      })
    } catch (error) {
      if (!controller.signal.aborted && this.matches(childId, epoch) && fence === this.statusFence)
        this.patch({ loading: false, confirmed: false, error: pluginError(error) })
    } finally {
      if (this.read === controller) {
        this.read = null
        this.readPromise = null
        if (this.refreshQueued) {
          this.refreshQueued = false
          void this.refresh()
        }
      }
    }
  }
  private async write<T>(
    childId: string,
    pluginId: string,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    const { epoch } = this.state
    const child = runtime.getSnapshot().child
    if (!child || !this.matches(childId, epoch)) throw new ApiError("孩子已切换。", "stale")
    if (child.role !== "owner" || child.archived)
      throw new ApiError("仅负责人可管理应用。", "forbidden")
    this.requireConfirmed(childId, epoch)
    if (this.state.pending.includes(pluginId)) throw new ApiError("请等待当前操作完成。", "busy")
    const context = this.context
    // A read started before a mutation cannot overwrite its result. Entry and
    // manual callers share that read; one fresh read follows after mutations finish.
    this.statusFence++
    this.patch({ pending: [...this.state.pending, pluginId] })
    try {
      const result = await work(context.signal)
      if (context.signal.aborted || !this.matches(childId, epoch))
        throw new ApiError("孩子已切换。", "stale")
      return result
    } finally {
      if (!context.signal.aborted && this.matches(childId, epoch)) {
        this.patch({
          pending: this.state.pending.filter((id) => id !== pluginId),
          catalogVersion: this.state.catalogVersion + 1,
        })
        if (this.readPromise) this.refreshQueued = true
        else void this.refresh()
      }
    }
  }
  accept(childId: string, plugin: Plugin) {
    if (this.state.childId !== childId) return
    const plugins = this.state.plugins.filter((item) => item.id !== plugin.id)
    this.patch({ plugins: [...plugins, plugin], catalogVersion: this.state.catalogVersion + 1 })
  }
  manage = (childId: string, plugin: Plugin, action: PluginAction) =>
    this.write(childId, plugin.id, async (signal) => {
      const { plugin: updated } = await pluginClient.manage(childId, plugin, action, signal)
      if (!signal.aborted) this.accept(childId, updated)
      return updated
    })
  saveConfig = (
    childId: string,
    plugin: Plugin,
    config: PluginConfig,
    revision: number,
    enable = false,
  ) =>
    this.write(childId, plugin.id, async (signal) => {
      const child = runtime.getSnapshot().child!
      if (!canConfigure(plugin, child)) throw new ApiError("当前应用仅可查看配置。", "forbidden")
      const result = await pluginClient.saveConfig(childId, plugin.id, config, revision, signal)
      if (!signal.aborted) this.accept(childId, result.plugin)
      if (enable && !signal.aborted) {
        try {
          this.requireConfirmed(childId)
          const { plugin: enabled } = await pluginClient.manage(
            childId,
            result.plugin,
            "enable",
            signal,
          )
          if (!signal.aborted) this.accept(childId, enabled)
          return { ...result, plugin: enabled }
        } catch (error) {
          if (signal.aborted) throw error
          throw new ConfigEnableError(result, error)
        }
      }
      return result
    })
}
export const pluginStore = new PluginStore()
export const usePlugins = () => useSyncExternalStore(pluginStore.subscribe, pluginStore.getSnapshot)

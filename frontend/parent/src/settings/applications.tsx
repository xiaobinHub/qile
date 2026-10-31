import { useEffect, useState, type CSSProperties } from "react"
import { Puzzle, Search } from "lucide-react"
import { AsyncConfirm } from "@shared/components/async-confirm"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/components/ui/tabs"
import { StatusBadge } from "@shared/components/status-badge"
import { Button } from "@shared/components/ui/button"
import { Input } from "@shared/components/ui/input"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@shared/components/ui/card"
import { Skeleton } from "@shared/components/ui/skeleton"
import { pluginClient } from "../plugins/client"
import {
  inScope,
  pluginError,
  pluginReason,
  pluginStatus,
  pluginStore,
  usePlugins,
} from "../plugins/store"
import type { CatalogView, Plugin, PluginAction } from "../plugins/types"
import { runtime } from "../lib/runtime"
import { RowMenu } from "./primitives"
import { PluginConfigDialog } from "./plugin-config-dialog"
import type { Child, Controller } from "./types"

function PluginIcon({ plugin }: { plugin: Plugin }) {
  let src = ""
  try {
    const url = new URL(plugin.icon, location.origin)
    if (
      url.origin === location.origin &&
      url.pathname.startsWith(`/plugin-assets/${encodeURIComponent(plugin.id)}/`) &&
      /\.(png|webp|jpg|jpeg|svg)$/.test(url.pathname)
    )
      src = url.href
  } catch {
    /* Invalid metadata uses the platform icon. */
  }
  const [broken, setBroken] = useState(false)
  return (
    <span className="plugin-icon" aria-hidden="true">
      {src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : <Puzzle />}
    </span>
  )
}

export function Applications({ child, controller }: { child: Child; controller: Controller }) {
  const state = usePlugins()
  const epoch = runtime.getSnapshot().epoch
  const [view, setView] = useState<CatalogView>("available")
  const [query, setQuery] = useState("")
  const [result, setResult] = useState<{
    key: string
    views: Partial<Record<CatalogView, { plugins: Plugin[]; error: string }>>
  } | null>(null)
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null)
  const [uninstall, setUninstall] = useState<Plugin | null>(null)
  const search = query.trim()
  const requestKey = JSON.stringify([child.id, epoch, search])
  useEffect(() => {
    const controller = new AbortController()
    function receive(view: CatalogView, plugins: Plugin[] | null, error = "") {
      if (controller.signal.aborted || !pluginStore.matches(child.id, epoch)) return
      setResult((previous) => {
        const views = previous?.key === requestKey ? previous.views : {}
        return {
          key: requestKey,
          views: {
            ...views,
            [view]: { plugins: plugins ?? views[view]?.plugins ?? [], error },
          },
        }
      })
    }
    const timer = window.setTimeout(
      () => {
        for (const view of ["available", "installed"] as const) {
          void pluginClient
            .list(child.id, view, search, controller.signal)
            .then((response) => receive(view, response.plugins))
            .catch((failure) => receive(view, null, pluginError(failure)))
        }
      },
      search ? 200 : 0,
    )
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [child.id, epoch, requestKey, search, state.catalogVersion, refresh])
  const entry = result?.key === requestKey ? result.views[view] : undefined
  const reading = !entry
  const readError = entry?.error || ""
  const owner = child.role === "owner" && !child.archived
  const current = state.childId === child.id && state.epoch === epoch
  const confirmed = current && state.confirmed
  const known = new Map(current ? state.plugins.map((plugin) => [plugin.id, plugin]) : [])
  const plugins = entry
    ? entry.plugins
        .map((plugin) => known.get(plugin.id) || plugin)
        .filter((plugin) => view !== "installed" || plugin.installed)
    : []
  plugins.sort(
    (a, b) => b.sortOrder - a.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  )
  async function manage(plugin: Plugin, action: PluginAction, propagate = false) {
    setError("")
    try {
      await pluginStore.manage(child.id, plugin, action)
      if (!pluginStore.matches(child.id, epoch)) return
      controller.deps.toast(
        {
          install: "应用已安装",
          enable: "应用已启用",
          disable: "应用已停用",
          uninstall: "应用已卸载，配置和数据已保留",
        }[action],
      )
      setRefresh((value) => value + 1)
    } catch (failure) {
      if (pluginStore.matches(child.id, epoch)) setError(pluginError(failure))
      if (propagate) throw new Error(pluginError(failure))
    }
  }
  return (
    <div className="applications-workspace">
      {!confirmed && (
        <p role="status" className="settings-notice">
          应用状态未确认，请刷新成功后再操作。
        </p>
      )}
      <Tabs value={view} onValueChange={(value) => setView(value as CatalogView)}>
        <div className="applications-toolbar">
          <TabsList variant="line" className="applications-tabs" aria-label="应用目录">
            <TabsTrigger value="available">发现应用</TabsTrigger>
            <TabsTrigger value="installed">已安装</TabsTrigger>
          </TabsList>
          <div className="applications-search">
            <Search aria-hidden="true" />
            <Input
              id="pluginSearch"
              aria-label="搜索应用名称"
              placeholder="搜索应用名称"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <TabsContent forceMount value={view} className="applications-content" aria-busy={reading}>
          {(readError || state.error || error) && (
            <p className="form-error" role="alert">
              {error || readError || state.error}
            </p>
          )}
          {reading && !plugins.length ? (
            <div
              className="applications-grid workspace-card-grid"
              role="status"
              aria-label="正在读取应用"
            >
              <Skeleton className="h-48" />
              <Skeleton className="h-48" />
            </div>
          ) : plugins.length ? (
            <div
              className="applications-grid workspace-card-grid"
              style={{ "--workspace-card-count": plugins.length } as CSSProperties}
            >
              {plugins.map((plugin) => {
                const pending = state.pending.includes(plugin.id)
                const available =
                  plugin.publicationStatus === "published" && inScope(plugin, child.id)
                const enableable =
                  available && plugin.operationState === "ready" && !plugin.configRequired
                const reason =
                  plugin.publicationStatus !== "published" ||
                  plugin.operationState !== "ready" ||
                  !plugin.configRequired
                    ? pluginReason(plugin)
                    : ""
                return (
                  <Card key={plugin.id} className="application-card" data-plugin-id={plugin.id}>
                    <CardHeader>
                      <div className="application-card-heading">
                        <PluginIcon plugin={plugin} />
                        <div className="application-card-identity">
                          <div className="application-card-title">
                            <CardTitle>{plugin.name}</CardTitle>
                            <StatusBadge
                              tone={
                                !confirmed
                                  ? "neutral"
                                  : plugin.effectiveEnabled
                                    ? "success"
                                    : plugin.operationState === "failed"
                                      ? "danger"
                                      : plugin.installed &&
                                          (plugin.configRequired ||
                                            plugin.requiresReenable ||
                                            plugin.operationState === "updating")
                                        ? "warning"
                                        : "neutral"
                              }
                            >
                              {confirmed ? pluginStatus(plugin) : "状态未确认"}
                            </StatusBadge>
                          </div>
                          <p className="application-card-meta">
                            {plugin.type === "page" ? "页面应用" : "后台应用"}
                            {plugin.version && <span>v{plugin.version}</span>}
                          </p>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="application-card-description">
                        {plugin.description || "暂无介绍"}
                      </p>
                      {reason && <p className="settings-notice">{reason}</p>}
                      {!available &&
                        plugin.installed &&
                        plugin.publicationStatus === "published" && (
                          <p className="settings-notice">
                            当前儿童不在开放范围内，仅可查看配置或卸载。
                          </p>
                        )}
                    </CardContent>
                    <CardFooter className="application-card-footer">
                      <div className="application-card-actions">
                        {plugin.installed ? (
                          <>
                            <Button
                              type="button"
                              variant="link"
                              data-plugin-config={plugin.id}
                              disabled={!confirmed}
                              onClick={() => {
                                if (
                                  pluginStore.getSnapshot().confirmed &&
                                  pluginStore.matches(child.id, epoch)
                                )
                                  setConfigPlugin(plugin)
                              }}
                            >
                              {owner && available && plugin.operationState === "ready"
                                ? "配置"
                                : "查看配置"}
                            </Button>
                            {plugin.type === "page" &&
                              plugin.effectiveEnabled &&
                              !child.archived && (
                                <Button
                                  type="button"
                                  variant="link"
                                  data-plugin-open={plugin.id}
                                  disabled={!confirmed}
                                  onClick={() => {
                                    if (
                                      pluginStore.getSnapshot().confirmed &&
                                      pluginStore.matches(child.id, epoch)
                                    )
                                      runtime.setView({ kind: "plugin", pluginId: plugin.id })
                                  }}
                                >
                                  打开
                                </Button>
                              )}
                            {owner && (
                              <>
                                {(!plugin.enabled || plugin.requiresReenable) && (
                                  <Button
                                    type="button"
                                    disabled={pending || !confirmed || !enableable}
                                    variant="link"
                                    data-plugin-enable={plugin.id}
                                    onClick={() => void manage(plugin, "enable")}
                                  >
                                    {pending
                                      ? "处理中…"
                                      : plugin.requiresReenable
                                        ? "重新启用"
                                        : "启用"}
                                  </Button>
                                )}
                                <RowMenu
                                  label={`${plugin.name}的更多操作`}
                                  triggerLabel="更多"
                                  selector={{ "data-plugin-more": plugin.id }}
                                  disabled={pending || !confirmed}
                                  actions={[
                                    ...(plugin.enabled
                                      ? [
                                          {
                                            label: "停用",
                                            selector: { "data-plugin-disable": plugin.id },
                                            onSelect: () => void manage(plugin, "disable"),
                                          },
                                        ]
                                      : []),
                                    {
                                      label: "卸载",
                                      destructive: true,
                                      selector: { "data-plugin-uninstall": plugin.id },
                                      onSelect: () => setUninstall(plugin),
                                    },
                                  ]}
                                />
                              </>
                            )}
                          </>
                        ) : (
                          owner && (
                            <Button
                              type="button"
                              disabled={
                                pending ||
                                !confirmed ||
                                !available ||
                                plugin.operationState !== "ready"
                              }
                              variant="link"
                              data-plugin-install={plugin.id}
                              onClick={() => void manage(plugin, "install")}
                            >
                              {pending ? "处理中…" : "安装"}
                            </Button>
                          )
                        )}
                      </div>
                    </CardFooter>
                  </Card>
                )
              })}
            </div>
          ) : (
            <div className="settings-empty" role="status">
              <Puzzle aria-hidden="true" />
              <strong>
                {readError
                  ? "暂时无法读取应用"
                  : query
                    ? "没有找到匹配的应用"
                    : view === "installed"
                      ? "还没有安装应用"
                      : "暂无可用应用"}
              </strong>
              {(readError || query) && <p>{readError ? "请稍后重试。" : "试试其他名称。"}</p>}
            </div>
          )}
        </TabsContent>
      </Tabs>
      {configPlugin && (
        <PluginConfigDialog
          key={`${child.id}:${configPlugin.id}`}
          child={child}
          plugin={known.get(configPlugin.id) || configPlugin}
          onClose={() => setConfigPlugin(null)}
          notify={controller.deps.toast}
        />
      )}
      {uninstall && (
        <AsyncConfirm
          open
          title={`卸载“${uninstall.name}”？`}
          description="卸载后将停止此应用，已保存的配置和数据会保留，重新安装后仍可使用。"
          confirmLabel="卸载"
          destructive
          onOpenChange={(open) => {
            if (!open) setUninstall(null)
          }}
          onConfirm={() => manage(known.get(uninstall.id) || uninstall, "uninstall", true)}
        />
      )}
    </div>
  )
}

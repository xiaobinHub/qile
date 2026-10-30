import { useEffect, useState } from "react"
import { Puzzle, Search } from "lucide-react"
import { AsyncConfirm } from "@shared/components/async-confirm"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/components/ui/tabs"
import { Badge } from "@shared/components/ui/badge"
import { Button } from "@shared/components/ui/button"
import { Input } from "@shared/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@shared/components/ui/card"
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
  const [result, setResult] = useState<{ key: string; plugins: Plugin[] } | null>(null)
  const [reading, setReading] = useState(true)
  const [readError, setReadError] = useState("")
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null)
  const [uninstall, setUninstall] = useState<Plugin | null>(null)
  const requestKey = `${child.id}:${epoch}:${view}:${query.trim()}`
  useEffect(() => {
    const controller = new AbortController()
    setReading(true)
    setReadError("")
    const timer = window.setTimeout(
      () => {
        void pluginClient
          .list(child.id, view, query.trim(), controller.signal)
          .then((response) => {
            if (!controller.signal.aborted && pluginStore.matches(child.id, epoch))
              setResult({ key: requestKey, plugins: response.plugins })
          })
          .catch((failure) => {
            if (!controller.signal.aborted && pluginStore.matches(child.id, epoch))
              setReadError(pluginError(failure))
          })
          .finally(() => {
            if (!controller.signal.aborted) setReading(false)
          })
      },
      query ? 200 : 0,
    )
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [child.id, epoch, requestKey, state.catalogVersion, refresh])
  const owner = child.role === "owner" && !child.archived
  const current = state.childId === child.id && state.epoch === epoch
  const confirmed = current && state.confirmed
  const known = new Map(current ? state.plugins.map((plugin) => [plugin.id, plugin]) : [])
  const plugins =
    result?.key === requestKey
      ? result.plugins
          .map((plugin) => known.get(plugin.id) || plugin)
          .filter((plugin) => view !== "installed" || plugin.installed)
      : []
  plugins.sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
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
      <p className="settings-notice">
        {child.name}的应用、启用状态和配置由家人共享。
        {!owner
          ? "仅负责人可以管理应用。"
          : "页面应用启用后会显示在主导航中，后台应用通过配置使用。"}
      </p>
      {!confirmed && (
        <p role="status" className="settings-notice">
          应用状态未确认，请刷新成功后再操作。
        </p>
      )}
      <Tabs value={view} onValueChange={(value) => setView(value as CatalogView)}>
        <div className="applications-toolbar">
          <TabsList aria-label="应用目录">
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
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void pluginStore.refresh()
              setRefresh((value) => value + 1)
            }}
          >
            刷新
          </Button>
        </div>
        <TabsContent value={view} className="applications-content" aria-busy={reading}>
          {(readError || state.error || error) && (
            <p className="form-error" role="alert">
              {error || readError || state.error}
            </p>
          )}
          {reading && !plugins.length ? (
            <div className="applications-grid" role="status" aria-label="正在读取应用">
              <Skeleton className="h-48" />
              <Skeleton className="h-48" />
            </div>
          ) : plugins.length ? (
            <div className="applications-grid">
              {plugins.map((plugin) => {
                const pending = state.pending.includes(plugin.id)
                const available =
                  plugin.publicationStatus === "published" && inScope(plugin, child.id)
                const enableable =
                  available && plugin.operationState === "ready" && !plugin.configRequired
                return (
                  <Card key={plugin.id} className="application-card" data-plugin-id={plugin.id}>
                    <CardHeader>
                      <div className="application-card-heading">
                        <PluginIcon plugin={plugin} />
                        <CardTitle>{plugin.name}</CardTitle>
                        <Badge variant="outline">
                          {plugin.type === "page" ? "页面应用" : "后台应用"}
                        </Badge>
                      </div>
                      <CardDescription>{plugin.description || "暂无介绍"}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="application-card-status">
                        <Badge variant={plugin.effectiveEnabled ? "secondary" : "outline"}>
                          {confirmed ? pluginStatus(plugin) : "状态未确认"}
                        </Badge>
                        {plugin.version && <span>v{plugin.version}</span>}
                      </div>
                      {pluginReason(plugin) && (
                        <p className="settings-notice">{pluginReason(plugin)}</p>
                      )}
                      {!available &&
                        plugin.installed &&
                        plugin.publicationStatus === "published" && (
                          <p className="settings-notice">
                            当前儿童不在开放范围内，仅可查看配置或卸载。
                          </p>
                        )}
                    </CardContent>
                    <CardFooter className="application-card-actions">
                      {plugin.installed ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
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
                          {plugin.type === "page" && plugin.effectiveEnabled && !child.archived && (
                            <Button
                              type="button"
                              variant="outline"
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
                              {plugin.enabled && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={pending || !confirmed}
                                  data-plugin-disable={plugin.id}
                                  onClick={() => void manage(plugin, "disable")}
                                >
                                  {pending ? "处理中…" : "停用"}
                                </Button>
                              )}
                              {(!plugin.enabled || plugin.requiresReenable) && (
                                <Button
                                  type="button"
                                  disabled={pending || !confirmed || !enableable}
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
                              <Button
                                type="button"
                                variant="ghost"
                                disabled={pending || !confirmed}
                                data-plugin-uninstall={plugin.id}
                                onClick={() => setUninstall(plugin)}
                              >
                                卸载
                              </Button>
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
                            data-plugin-install={plugin.id}
                            onClick={() => void manage(plugin, "install")}
                          >
                            {pending ? "处理中…" : "安装"}
                          </Button>
                        )
                      )}
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
              <p>
                {readError
                  ? "请点击刷新重试。"
                  : query
                    ? "试试其他名称。"
                    : "可在发现应用中查看当前儿童可使用的应用。"}
              </p>
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

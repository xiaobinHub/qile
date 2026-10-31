import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowRight,
  CircleCheck,
  CircleMinus,
  Clock3,
  Puzzle,
  RefreshCw,
  Search,
  X,
} from "lucide-react"
import { errorMessage, isIgnoredError } from "@/lib/session"
import { useMounted } from "@/lib/use-mounted"
import { EmptyState } from "@shared/components/empty-state"
import { FormFeedback } from "@shared/components/form-feedback"
import { PageHeading } from "@shared/components/page-heading"
import { Button } from "@shared/components/ui/button"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@shared/components/ui/card"
import { Input } from "@shared/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@shared/components/ui/select"
import { Skeleton } from "@shared/components/ui/skeleton"
import { usePluginRequest } from "./client"
import { PluginDetail } from "./detail"
import { PluginIcon, PluginStatuses } from "./status"
import { publicationLabels, type Plugin, type PublicationStatus } from "./types"

export function PluginsPage() {
  const request = usePluginRequest()
  const mounted = useMounted()
  const [plugins, setPlugins] = useState<Plugin[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState<PublicationStatus | "all">("all")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const focusDetail = useRef(false)

  const load = useCallback(
    async (silent = false) => {
      const current = ++sequence.current
      controller.current?.abort()
      const nextController = new AbortController()
      controller.current = nextController
      if (!silent) setLoading(true)
      try {
        const result = await request<{ plugins: Plugin[] }>(
          "plugins",
          "GET",
          undefined,
          nextController.signal,
        )
        if (mounted.current && current === sequence.current) {
          setPlugins(result.plugins)
          setError("")
        }
        return result.plugins
      } catch (failure) {
        if (mounted.current && current === sequence.current && !isIgnoredError(failure))
          setError(errorMessage(failure))
        throw failure
      } finally {
        if (mounted.current && current === sequence.current) {
          controller.current = null
          setLoading(false)
        }
      }
    },
    [request, mounted],
  )
  const refresh = useCallback(() => load(), [load])

  useEffect(() => {
    void load().catch(() => {
      /* Error is displayed with a retry action. */
    })
    const poll = () => {
      if (document.visibilityState === "visible" && !controller.current)
        void load(true).catch(() => {})
    }
    const timer = window.setInterval(poll, 5000)
    window.addEventListener("focus", poll)
    document.addEventListener("visibilitychange", poll)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", poll)
      document.removeEventListener("visibilitychange", poll)
      sequence.current += 1
      controller.current?.abort()
    }
  }, [load])

  const selected = plugins?.find((plugin) => plugin.id === selectedId)
  useEffect(() => {
    if (selectedId && focusDetail.current) {
      focusDetail.current = false
      const heading = document.querySelector<HTMLElement>("#mainContent h1")
      heading?.setAttribute("tabindex", "-1")
      heading?.focus()
    }
  }, [selectedId])
  function open(plugin: Plugin) {
    focusDetail.current = true
    setSelectedId(plugin.id)
  }
  function back() {
    const previousId = selectedId
    setSelectedId(null)
    window.requestAnimationFrame(() => {
      document.getElementById(`plugin-open-${previousId}`)?.focus()
    })
  }

  const query = search.trim().toLocaleLowerCase()
  const visible = (plugins || [])
    .filter(
      (plugin) =>
        (!query || plugin.name.toLocaleLowerCase().includes(query)) &&
        (filter === "all" || plugin.publicationStatus === filter),
    )
    .sort(
      (first, second) =>
        first.sortOrder - second.sortOrder || first.name.localeCompare(second.name, "zh-CN"),
    )
  const filtered = Boolean(query) || filter !== "all"

  if (selectedId)
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {error ? <FormFeedback message={`最新状态未能读取：${error}`} /> : null}
        {selected ? (
          <PluginDetail
            key={selected.id}
            plugin={selected}
            request={request}
            refresh={refresh}
            refreshing={loading}
            onBack={back}
          />
        ) : (
          <EmptyState
            title="插件已不在当前列表中"
            description="请刷新列表后重新选择。"
            action={
              <Button type="button" variant="outline" className="min-h-11" onClick={back}>
                返回插件列表
              </Button>
            }
          />
        )}
      </div>
    )

  return (
    <div className="min-w-0 space-y-5">
      <PageHeading
        title="插件管理"
        description="维护插件资料与发布范围，查看安装情况和版本记录。"
      />
      <div
        className="overview-strip grid grid-cols-2 overflow-hidden rounded-xl border bg-card sm:grid-cols-4"
        aria-label="插件发布概况"
      >
        {(
          [
            { status: "all", icon: Puzzle, className: "text-slate-500" },
            { status: "pending", icon: Clock3, className: "text-warning" },
            { status: "published", icon: CircleCheck, className: "text-brand-ink" },
            { status: "unpublished", icon: CircleMinus, className: "text-muted-foreground" },
          ] as const
        ).map(({ status, icon: Icon, className }) => (
          <div key={status} className="overview-cell min-w-0 px-4 py-4 sm:px-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-caption text-muted-foreground">
                {status === "all" ? "全部插件" : publicationLabels[status]}
              </p>
              <Icon className={`size-4 ${className}`} strokeWidth={1.7} />
            </div>
            {plugins ? (
              <p className="text-number font-semibold tracking-tight tabular-nums">
                {status === "all"
                  ? plugins.length
                  : plugins.filter((plugin) => plugin.publicationStatus === status).length}
                <span className="ml-1.5 text-caption font-normal text-muted-foreground">个</span>
              </p>
            ) : (
              <Skeleton aria-label="正在读取数量" className="h-8 w-12" />
            )}
          </div>
        ))}
      </div>
      <Card className="gap-0 overflow-hidden rounded-xl py-0 shadow-none">
        <div
          role="search"
          aria-label="插件筛选"
          className="flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-5"
        >
          <div className="relative min-w-0 flex-[1_1_210px] sm:max-w-64">
            <Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" />
            <Input
              id="plugin-search"
              type="search"
              value={search}
              placeholder="搜索插件名称"
              aria-label="搜索插件名称"
              className="h-11 bg-card pr-11 pl-9 text-sm"
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="清除搜索"
                className="absolute top-0 right-0 size-11 text-muted-foreground"
                onClick={() => setSearch("")}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as PublicationStatus | "all")}
          >
            <SelectTrigger
              id="plugin-publication-filter"
              aria-label="筛选发布状态"
              className="h-11 w-[130px] bg-card text-sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="pending">待发布</SelectItem>
                <SelectItem value="published">已上架</SelectItem>
                <SelectItem value="unpublished">已下架</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            id="refreshPlugins"
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void refresh().catch(() => {})}
            className="ml-auto h-11 gap-2 bg-card px-3 text-sm"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
        {error ? (
          <div className="border-b p-4">
            <FormFeedback message={error} />
            <Button
              type="button"
              variant="link"
              size="sm"
              className="mt-1 h-7 px-0 text-sm"
              disabled={loading}
              onClick={() => void refresh().catch(() => {})}
            >
              重新加载
            </Button>
          </div>
        ) : null}
        <div aria-busy={loading}>
          {!plugins && loading ? (
            <div
              role="status"
              aria-label="正在载入插件"
              className="grid gap-4 p-4 sm:p-5 lg:grid-cols-2"
            >
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-60 w-full rounded-xl" />
              ))}
            </div>
          ) : visible.length ? (
            <ul className="grid min-w-0 gap-4 p-4 sm:p-5 lg:grid-cols-2">
              {visible.map((plugin) => (
                <li key={plugin.id} className="min-w-0">
                  <Card size="sm" className="h-full shadow-none">
                    <CardHeader>
                      <div className="flex min-w-0 items-start gap-3">
                        <PluginIcon icon={plugin.icon} />
                        <div className="flex min-w-0 flex-col gap-1">
                          <CardTitle className="break-words">{plugin.name || plugin.id}</CardTitle>
                          <CardDescription className="break-all">
                            {plugin.id} · {plugin.type === "page" ? "页面型" : "后台型"}
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="flex-1">
                      <PluginStatuses plugin={plugin} />
                      <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                        {plugin.description || "尚未填写介绍"}
                      </p>
                      <dl className="grid grid-cols-2 gap-3 text-caption">
                        {[
                          ["活动版本", plugin.version || "暂无"],
                          [
                            "发布范围",
                            plugin.scopeMode === "all"
                              ? "全部儿童"
                              : `${plugin.childIds.length} 位指定儿童`,
                          ],
                          ["已安装实例", String(plugin.installedCount)],
                          ["已启用实例", String(plugin.enabledCount)],
                        ].map(([label, value]) => (
                          <div key={label} className="min-w-0">
                            <dt className="text-muted-foreground">{label}</dt>
                            <dd className="mt-1 break-all">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </CardContent>
                    <CardFooter>
                      <Button
                        id={`plugin-open-${plugin.id}`}
                        type="button"
                        variant="outline"
                        className="min-h-11 w-full"
                        aria-label={`管理插件：${plugin.name || plugin.id}`}
                        onClick={() => open(plugin)}
                      >
                        管理插件
                        <ArrowRight data-icon="inline-end" />
                      </Button>
                    </CardFooter>
                  </Card>
                </li>
              ))}
            </ul>
          ) : plugins ? (
            <div
              role="status"
              className="flex min-h-[240px] flex-col items-center justify-center px-5 py-12 text-center"
            >
              <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                {filtered ? <Search className="size-5" /> : <Puzzle className="size-5" />}
              </div>
              <p className="text-sm font-medium">{filtered ? "没有匹配的插件" : "暂无插件"}</p>
              <p className="mt-2 text-caption text-muted-foreground">
                {filtered
                  ? "试试其他名称或发布状态。"
                  : "插件部署登记后会显示在这里，初始状态为待发布。"}
              </p>
              {filtered && (
                <Button
                  type="button"
                  variant="link"
                  className="mt-2 h-8 text-sm"
                  onClick={() => {
                    setSearch("")
                    setFilter("all")
                  }}
                >
                  清除筛选
                </Button>
              )}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/15 px-5 py-3 text-caption text-muted-foreground">
          <p role="status">
            {plugins
              ? `显示 ${visible.length} 个插件，共 ${plugins.length} 个`
              : "正在读取插件信息"}
          </p>
        </div>
      </Card>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowRight, Puzzle, RefreshCw } from "lucide-react"
import { errorMessage, isIgnoredError } from "@/lib/session"
import { useMounted } from "@/lib/use-mounted"
import { EmptyState } from "@shared/components/empty-state"
import { FormField } from "@shared/components/form-field"
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
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeading
        title="插件管理"
        description="维护插件资料与发布范围，查看安装情况和版本记录。"
        actions={
          <Button
            id="refreshPlugins"
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={loading}
            onClick={() => void refresh().catch(() => {})}
          >
            <RefreshCw data-icon="inline-start" />
            刷新列表
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="插件发布概况">
        {(["all", "pending", "published", "unpublished"] as const).map((status) => (
          <Card key={status} size="sm">
            <CardHeader>
              <CardDescription>
                {status === "all" ? "全部插件" : publicationLabels[status]}
              </CardDescription>
              <CardTitle>
                {plugins ? (
                  status === "all" ? (
                    plugins.length
                  ) : (
                    plugins.filter((plugin) => plugin.publicationStatus === status).length
                  )
                ) : (
                  <Skeleton aria-label="正在读取数量" className="h-6 w-10" />
                )}
              </CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>插件目录</CardTitle>
          <CardDescription>
            发布状态与运行状态分别展示；进入详情管理上架、下架与范围。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div role="search" aria-label="插件筛选" className="flex flex-wrap items-end gap-4">
            <FormField id="plugin-search" label="搜索名称" className="min-w-0 flex-[1_1_220px]">
              <Input
                type="search"
                value={search}
                placeholder="输入插件名称"
                onChange={(event) => setSearch(event.target.value)}
              />
            </FormField>
            <div className="flex flex-col gap-2">
              <label htmlFor="plugin-publication-filter" className="text-sm font-medium">
                发布状态
              </label>
              <Select
                value={filter}
                onValueChange={(value) => setFilter(value as PublicationStatus | "all")}
              >
                <SelectTrigger id="plugin-publication-filter" className="min-h-11 min-w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部发布状态</SelectItem>
                    <SelectItem value="pending">待发布</SelectItem>
                    <SelectItem value="published">已上架</SelectItem>
                    <SelectItem value="unpublished">已下架</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>
          <FormFeedback message={error} />
          {error ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 self-start"
              disabled={loading}
              onClick={() => void refresh().catch(() => {})}
            >
              重新加载
            </Button>
          ) : null}
        </CardContent>
      </Card>
      <div aria-busy={loading}>
        {!plugins && loading ? (
          <div role="status" aria-label="正在载入插件" className="grid gap-4 lg:grid-cols-2">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-60 w-full rounded-xl" />
            ))}
          </div>
        ) : visible.length ? (
          <ul className="grid min-w-0 gap-4 lg:grid-cols-2">
            {visible.map((plugin) => (
              <li key={plugin.id} className="min-w-0">
                <Card className="h-full">
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
          <Card>
            <CardContent>
              <EmptyState
                title={filtered ? "没有匹配的插件" : "暂无插件"}
                description={
                  filtered
                    ? "试试其他名称或发布状态。"
                    : "插件部署登记后会显示在这里，初始状态为待发布。"
                }
                icon={<Puzzle className="size-6" />}
                action={
                  filtered ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      onClick={() => {
                        setSearch("")
                        setFilter("all")
                      }}
                    >
                      清除筛选
                    </Button>
                  ) : undefined
                }
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
      {plugins ? (
        <p role="status" className="text-caption text-muted-foreground">
          显示 {visible.length} 个插件，共 {plugins.length} 个。
        </p>
      ) : null}
    </div>
  )
}

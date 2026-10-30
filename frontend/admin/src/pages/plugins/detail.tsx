import { useEffect, useRef, useState, type FormEvent } from "react"
import { ArrowLeft, RefreshCw } from "lucide-react"
import { errorMessage, isIgnoredError } from "@/lib/session"
import { useMounted } from "@/lib/use-mounted"
import { AsyncConfirm } from "@shared/components/async-confirm"
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
import { Textarea } from "@shared/components/ui/textarea"
import { PluginApiError, type PluginRequest } from "./client"
import { DeploymentHistory } from "./deployments"
import { ScopePicker } from "./scope-picker"
import { PluginIcon, PluginStatuses } from "./status"
import { isScopeShrink, metadataOf, sameScope, scopeOf, type Plugin } from "./types"

type Action = "publish" | "unpublish" | "scope"

export function PluginDetail({
  plugin,
  request,
  refresh,
  refreshing,
  onBack,
}: {
  plugin: Plugin
  request: PluginRequest
  refresh: () => Promise<Plugin[]>
  refreshing: boolean
  onBack: () => void
}) {
  // Keep the revision that the drafts were based on, even when polling sees another admin's edit.
  const [base, setBase] = useState(plugin)
  const [metadata, setMetadata] = useState(() => metadataOf(plugin))
  const [sortOrder, setSortOrder] = useState(String(plugin.sortOrder))
  const [scope, setScope] = useState(() => scopeOf(plugin))
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [confirmation, setConfirmation] = useState<Action | null>(null)
  const pending = useRef(false)
  const mounted = useMounted()
  const latest = useRef(plugin)
  latest.current = plugin

  const selectedIcon = metadata.icon ?? base.icon
  const packageIcons = [...new Set((plugin.icons ?? []).filter(Boolean))]
  const iconDirty = selectedIcon !== base.icon
  const iconValid = !iconDirty || selectedIcon === "" || packageIcons.includes(selectedIcon)
  const metadataDirty =
    metadata.name !== base.name ||
    metadata.description !== base.description ||
    metadata.instructions !== base.instructions ||
    iconDirty ||
    sortOrder !== String(base.sortOrder)
  const scopeDirty = !sameScope(base, scope)
  const dirty = metadataDirty || scopeDirty
  const stale = base.revision !== plugin.revision
  const updating = plugin.operationState === "updating"
  const locked = busy || refreshing || uncertain || stale
  const shrinking = isScopeShrink(base, scope)
  const emptyScope = scope.scopeMode === "children" && scope.childIds.length === 0
  const validSortOrder = sortOrder.trim() !== "" && Number.isSafeInteger(Number(sortOrder))
  const metadataValid = Boolean(metadata.name.trim() && validSortOrder && iconValid)
  const publishProblem = updating
    ? "插件更新中，请等待更新完成后上架。"
    : plugin.operationState !== "ready"
      ? "插件运行异常，恢复就绪后才能上架。"
      : !plugin.version || !plugin.releaseId
        ? "尚无可用的活动版本。"
        : !base.name.trim() || !base.description.trim() || !base.instructions.trim()
          ? "请先完善并保存名称、介绍和使用说明。"
          : base.scopeMode === "children" && !base.childIds.length
            ? "请先保存至少一位指定儿童。"
            : dirty
              ? "请先保存或重新载入未保存的修改。"
              : ""

  function adopt(next: Plugin, preserve?: "metadata" | "scope" | "all") {
    setBase(next)
    if (preserve !== "metadata" && preserve !== "all") {
      setMetadata(metadataOf(next))
      setSortOrder(String(next.sortOrder))
    }
    if (preserve !== "scope" && preserve !== "all") setScope(scopeOf(next))
    setUncertain(false)
  }

  useEffect(() => {
    if (!dirty && !busy && !uncertain && !confirmation && plugin.revision !== base.revision) {
      setBase(plugin)
      setMetadata(metadataOf(plugin))
      setSortOrder(String(plugin.sortOrder))
      setScope(scopeOf(plugin))
    }
  }, [plugin, base.revision, dirty, busy, uncertain, confirmation])

  async function reload() {
    if (pending.current) return
    setError("")
    try {
      const plugins = await refresh()
      const next = plugins.find((item) => item.id === plugin.id)
      if (mounted.current && next) {
        adopt(next)
        setConfirmation(null)
        setMessage("已载入最新资料和发布范围。")
      }
    } catch (failure) {
      if (mounted.current && !isIgnoredError(failure)) setError(errorMessage(failure))
    }
  }

  async function mutate(action: Action | "metadata") {
    if (pending.current) throw new Error("操作正在处理，请稍候。")
    if (uncertain || refreshing || latest.current.revision !== base.revision)
      throw new Error("资料已变化或尚未核对，请重新载入后再操作。")
    if (
      latest.current.operationState === "updating" &&
      action !== "unpublish" &&
      !(action === "scope" && shrinking)
    )
      throw new Error("更新期间仅允许下架或缩小发布范围。")
    if (action === "publish" && publishProblem) throw new Error(publishProblem)
    if (action === "scope" && emptyScope) throw new Error("请选择至少一位儿童。")
    if (action === "metadata" && !iconValid) throw new Error("请选择发布包提供的图标。")
    pending.current = true
    setBusy(true)
    setError("")
    setMessage("")
    const expectedRevision = base.revision
    const path = `plugins/${encodeURIComponent(plugin.id)}`
    const preserve =
      action === "metadata" && scopeDirty
        ? "scope"
        : action === "scope" && metadataDirty
          ? "metadata"
          : action === "unpublish" && dirty
            ? "all"
            : undefined
    try {
      const result = await request<{ plugin?: Plugin }>(
        action === "metadata" ? path : `${path}/${action}`,
        action === "metadata" ? "PATCH" : action === "scope" ? "PUT" : "POST",
        action === "metadata"
          ? {
              name: metadata.name.trim(),
              description: metadata.description.trim(),
              instructions: metadata.instructions.trim(),
              sortOrder: Number(sortOrder),
              ...(iconDirty ? { icon: selectedIcon } : {}),
              expectedRevision,
            }
          : action === "scope"
            ? {
                scopeMode: scope.scopeMode,
                childIds: scope.scopeMode === "all" ? [] : [...scope.childIds],
                expectedRevision,
              }
            : { expectedRevision },
      )
      if (!mounted.current) return
      if (result.plugin) adopt(result.plugin, preserve)
      setConfirmation(null)
      setMessage(
        action === "metadata"
          ? "插件资料已保存。"
          : action === "scope"
            ? "发布范围已保存，移出范围的儿童需由负责人重新启用。"
            : action === "publish"
              ? "插件已上架；儿童需自行安装并由负责人启用。"
              : "插件已下架，重新上架后仍需由负责人重新启用。",
      )
      try {
        const plugins = await refresh()
        const next = plugins.find((item) => item.id === plugin.id)
        if (mounted.current && next) {
          if (!preserve || result.plugin?.revision === next.revision) adopt(next, preserve)
          // Do not rebase remaining drafts onto an unrelated admin's edit between commit/read.
          // With a response plugin, retaining that baseline lets the usual stale banner appear.
          else if (!result.plugin) {
            setUncertain(true)
            setError("操作已提交。请重新载入并核对最新资料后继续，重新载入会放弃剩余草稿。")
          }
        }
      } catch (failure) {
        if (mounted.current && !isIgnoredError(failure)) {
          setUncertain(true)
          setError("操作已提交，但最新状态读取失败。请重新载入后继续。")
        }
      }
    } catch (failure) {
      if (!mounted.current || isIgnoredError(failure)) return
      if (failure instanceof PluginApiError && failure.status === 409) {
        setConfirmation(null)
        setUncertain(true)
        setError("插件已被其他管理员或部署操作修改，本次修改未保存。正在刷新最新资料。")
        try {
          const plugins = await refresh()
          const next = plugins.find((item) => item.id === plugin.id)
          if (mounted.current && next) {
            adopt(next)
            setError(
              "插件已被其他管理员或部署操作修改。本次修改未保存，已载入最新资料，请核对后重试。",
            )
          }
        } catch (refreshFailure) {
          if (mounted.current && !isIgnoredError(refreshFailure))
            setError("检测到版本冲突，最新资料读取失败。请重新载入后再操作。")
        }
      } else {
        // A network error may occur after the server commits. Require a read before any retry.
        if (!(failure instanceof PluginApiError)) setUncertain(true)
        setError(errorMessage(failure))
      }
      throw failure
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function saveMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!metadataValid || locked || updating) return
    void mutate("metadata").catch(() => {
      /* Displayed in the form. */
    })
  }

  const impact = `当前有 ${plugin.installedCount} 个已安装实例、${plugin.enabledCount} 个已启用实例。`
  const confirmDescription =
    confirmation === "publish"
      ? `${impact} 上架后${base.scopeMode === "all" ? "全部儿童" : `指定的 ${base.childIds.length} 位儿童`}可发现并安装；不会自动安装，已失效的实例需负责人重新启用。`
      : confirmation === "unpublish"
        ? `${impact} 下架后停止该插件的使用和后台执行，保留配置及历史数据；重新上架后需负责人重新启用。`
        : `${impact} ${shrinking ? `本次缩小范围，最多影响 ${plugin.installedCount} 个已安装实例、${plugin.enabledCount} 个已启用实例。` : "本次调整开放对象。"} 仅移出范围的儿童会失去资格，保留配置及历史；恢复范围后需负责人重新启用。新增范围不会自动安装。`

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 self-start"
        disabled={busy}
        onClick={onBack}
      >
        <ArrowLeft data-icon="inline-start" />
        返回插件列表
      </Button>
      <PageHeading
        title={plugin.name || plugin.id}
        description="维护插件资料、发布范围与上下架状态。"
        actions={
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy || refreshing}
            onClick={() => void reload()}
          >
            <RefreshCw data-icon="inline-start" />
            重新载入
          </Button>
        }
      />
      <PluginStatuses plugin={plugin} />
      <FormFeedback message={error} />
      <FormFeedback message={message} success />
      {stale ? (
        <FormFeedback message="插件已有新的修改。当前草稿仍保留；请重新载入最新资料后再编辑，重新载入会放弃草稿。" />
      ) : null}
      {dirty ? (
        <p role="status" className="text-caption text-muted-foreground">
          有未保存的修改。返回列表或重新载入会放弃草稿。
        </p>
      ) : null}
      {updating ? (
        <p role="status" className="text-sm text-muted-foreground">
          插件正在更新，暂不能修改资料、上架或扩大范围；仍可下架、缩小范围。
        </p>
      ) : null}
      {plugin.reason ? <FormFeedback message={plugin.reason} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>发布与影响</CardTitle>
          <CardDescription>{impact}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["插件 ID", plugin.id],
              ["类型", plugin.type === "page" ? "页面型" : "后台型"],
              ["活动版本", plugin.version || "暂无活动版本"],
              ["发布标识", plugin.releaseId || "暂无"],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-caption text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-all">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-caption text-muted-foreground">
            已保存范围：
            {plugin.scopeMode === "all" ? "全部儿童" : `${plugin.childIds.length} 位指定儿童`}
            。启用数量代表家长的启用选择，实际可用还取决于发布范围、配置和运行状态。
          </p>
          {plugin.publicationStatus !== "published" && publishProblem ? (
            <p id="plugin-publish-help" className="text-caption text-muted-foreground">
              {publishProblem}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="flex-wrap gap-3">
          {plugin.publicationStatus === "published" ? (
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={locked}
              onClick={() => setConfirmation("unpublish")}
            >
              下架插件
            </Button>
          ) : (
            <Button
              type="button"
              className="min-h-11"
              disabled={locked || Boolean(publishProblem)}
              aria-describedby={publishProblem ? "plugin-publish-help" : undefined}
              onClick={() => setConfirmation("publish")}
            >
              {plugin.publicationStatus === "unpublished" ? "重新上架" : "上架插件"}
            </Button>
          )}
        </CardFooter>
      </Card>
      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>插件资料</CardTitle>
            <CardDescription>对家长展示的名称、介绍和使用说明。</CardDescription>
          </CardHeader>
          <form onSubmit={saveMetadata} className="flex flex-col gap-5">
            <CardContent>
              <fieldset disabled={locked || updating} className="flex min-w-0 flex-col gap-5">
                <legend className="sr-only">编辑插件资料</legend>
                <FormField id="plugin-name" label="名称" required>
                  <Input
                    value={metadata.name}
                    required
                    onChange={(event) => setMetadata({ ...metadata, name: event.target.value })}
                  />
                </FormField>
                <FormField id="plugin-description" label="介绍" help="上架前需填写。">
                  <Textarea
                    value={metadata.description}
                    rows={3}
                    onChange={(event) =>
                      setMetadata({ ...metadata, description: event.target.value })
                    }
                  />
                </FormField>
                <FormField
                  id="plugin-instructions"
                  label="使用说明"
                  help="上架前需填写，以纯文本展示。"
                >
                  <Textarea
                    value={metadata.instructions}
                    rows={5}
                    onChange={(event) =>
                      setMetadata({ ...metadata, instructions: event.target.value })
                    }
                  />
                </FormField>
                <FormField
                  id="plugin-sort-order"
                  label="排序"
                  error={!validSortOrder ? "请输入有效整数。" : undefined}
                  help="数值越小，展示越靠前。"
                >
                  <Input
                    type="number"
                    step="1"
                    required
                    value={sortOrder}
                    onChange={(event) => setSortOrder(event.target.value)}
                  />
                </FormField>
              </fieldset>
              <fieldset disabled={locked || updating} className="flex min-w-0 flex-col gap-3">
                <legend className="mb-2 text-sm font-medium">发布包图标</legend>
                <Select
                  value={selectedIcon ? `package:${selectedIcon}` : "builtin"}
                  disabled={locked || updating}
                  onValueChange={(value) => {
                    const icon = value === "builtin" ? "" : value.slice("package:".length)
                    if (icon === "" || packageIcons.includes(icon))
                      setMetadata({ ...metadata, icon })
                  }}
                >
                  <FormField
                    id="plugin-icon"
                    label="图标"
                    help="仅可选择发布包提供的图标，或使用内置默认图标。"
                    error={!iconValid ? "所选图标已不可用，请重新选择。" : undefined}
                  >
                    <SelectTrigger className="min-h-11 w-full min-w-0">
                      <SelectValue />
                    </SelectTrigger>
                  </FormField>
                  <SelectContent position="popper">
                    <SelectGroup>
                      <SelectItem value="builtin">内置默认图标</SelectItem>
                      {selectedIcon && !packageIcons.includes(selectedIcon) ? (
                        <SelectItem value={`package:${selectedIcon}`} disabled>
                          当前图标（保留）
                        </SelectItem>
                      ) : null}
                      {packageIcons.map((icon) => (
                        <SelectItem key={icon} value={`package:${icon}`}>
                          <span className="max-w-[min(70vw,24rem)] truncate" title={icon}>
                            {icon}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="flex min-w-0 items-center gap-3">
                  <PluginIcon icon={selectedIcon} />
                  <p className="min-w-0 break-all text-caption text-muted-foreground">
                    {selectedIcon || "使用内置默认图标"}
                  </p>
                </div>
              </fieldset>
            </CardContent>
            <CardFooter>
              <Button
                type="submit"
                className="min-h-11"
                disabled={locked || updating || !metadataDirty || !metadataValid}
              >
                {busy ? "正在保存…" : "保存资料"}
              </Button>
            </CardFooter>
          </form>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>发布范围</CardTitle>
            <CardDescription>开放资格以儿童为单位，同一儿童的家庭成员共享。</CardDescription>
          </CardHeader>
          <CardContent>
            <ScopePicker
              value={scope}
              original={base}
              updating={updating}
              disabled={locked}
              request={request}
              onChange={setScope}
            />
            {scopeDirty ? (
              <p role="status" className="text-caption text-muted-foreground">
                {shrinking
                  ? `缩小范围最多影响 ${plugin.installedCount} 个已安装实例、${plugin.enabledCount} 个已启用实例；仅移出范围的儿童受影响。`
                  : "新增范围只开放发现和安装资格，不自动安装或启用。"}
              </p>
            ) : null}
          </CardContent>
          <CardFooter>
            <Button
              type="button"
              className="min-h-11"
              disabled={locked || !scopeDirty || emptyScope || (updating && !shrinking)}
              onClick={() => setConfirmation("scope")}
            >
              保存发布范围
            </Button>
          </CardFooter>
        </Card>
      </div>
      <DeploymentHistory plugin={plugin} request={request} />
      <AsyncConfirm
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
        title={
          confirmation === "publish"
            ? "确认上架插件？"
            : confirmation === "unpublish"
              ? "确认下架插件？"
              : "确认调整发布范围？"
        }
        description={confirmDescription}
        destructive={confirmation === "unpublish" || (confirmation === "scope" && shrinking)}
        confirmLabel={
          confirmation === "publish"
            ? "确认上架"
            : confirmation === "unpublish"
              ? "确认下架"
              : "确认保存范围"
        }
        onConfirm={async () => {
          if (confirmation) await mutate(confirmation)
        }}
      />
    </div>
  )
}

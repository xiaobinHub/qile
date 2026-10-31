import { useEffect, useRef, useState, type FormEvent } from "react"
import { ArrowLeft, Pencil, X } from "lucide-react"
import { errorMessage, isIgnoredError } from "@/lib/session"
import { useMounted } from "@/lib/use-mounted"
import { AsyncConfirm } from "@shared/components/async-confirm"
import { FormField } from "@shared/components/form-field"
import { FormFeedback } from "@shared/components/form-feedback"
import { Button } from "@shared/components/ui/button"
import { useToast } from "@shared/components/ui/toast"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@shared/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@shared/components/ui/dialog"
import { Input } from "@shared/components/ui/input"
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
  const { toast } = useToast()
  // Keep the revision that the drafts were based on, even when polling sees another admin's edit.
  const [editing, setEditing] = useState(false)
  const [base, setBase] = useState(plugin)
  const [metadata, setMetadata] = useState(() => metadataOf(plugin))
  const [sortOrder, setSortOrder] = useState(String(plugin.sortOrder))
  const [scope, setScope] = useState(() => scopeOf(plugin))
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState("")
  const [confirmation, setConfirmation] = useState<Action | null>(null)
  const pending = useRef(false)
  const mounted = useMounted()
  const latest = useRef(plugin)
  latest.current = plugin

  const metadataDirty =
    metadata.name !== base.name ||
    metadata.description !== base.description ||
    metadata.instructions !== base.instructions ||
    sortOrder !== String(base.sortOrder)
  const scopeDirty = !sameScope(base, scope)
  const dirty = metadataDirty || scopeDirty
  const stale = base.revision !== plugin.revision
  const updating = plugin.operationState === "updating"
  const locked = busy || refreshing || uncertain || stale
  const shrinking = isScopeShrink(base, scope)
  const emptyScope = scope.scopeMode === "children" && scope.childIds.length === 0
  const validSortOrder = sortOrder.trim() !== "" && Number.isSafeInteger(Number(sortOrder))
  const metadataValid = Boolean(metadata.name.trim() && validSortOrder)
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
              ? "请先保存未保存的修改。"
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
        toast({ title: "已载入最新资料和发布范围。" })
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
    pending.current = true
    setBusy(true)
    setError("")
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
      if (!mounted.current) return false
      let confirmed = Boolean(result.plugin)
      if (result.plugin) adopt(result.plugin, preserve)
      setConfirmation(null)
      toast({
        title:
          action === "metadata"
            ? "插件资料已保存。"
            : action === "scope"
              ? "发布范围已保存，移出范围的儿童需由负责人重新启用。"
              : action === "publish"
                ? "插件已上架；儿童需自行安装并由负责人启用。"
                : "插件已下架，重新上架后仍需由负责人重新启用。",
      })
      try {
        const plugins = await refresh()
        const next = plugins.find((item) => item.id === plugin.id)
        if (mounted.current && next) {
          confirmed = true
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
      return confirmed
    } catch (failure) {
      if (!mounted.current || isIgnoredError(failure)) return false
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
    void mutate("metadata")
      .then((confirmed) => {
        if (confirmed && mounted.current) setEditing(false)
      })
      .catch(() => {
        /* Displayed in the form. */
      })
  }

  function changeEditing(open: boolean) {
    if (pending.current) return
    if (open && (locked || updating)) return
    setEditing(open)
    setMetadata(metadataOf(base))
    setSortOrder(String(base.sortOrder))
    if (!uncertain) setError("")
  }

  const impact = `当前有 ${plugin.installedCount} 个已安装实例、${plugin.enabledCount} 个已启用实例。`
  const confirmDescription =
    confirmation === "publish"
      ? `${impact} 上架后${base.scopeMode === "all" ? "全部儿童" : `指定的 ${base.childIds.length} 位儿童`}可发现并安装；不会自动安装，已失效的实例需负责人重新启用。`
      : confirmation === "unpublish"
        ? `${impact} 下架后停止该插件的使用和后台执行，保留配置及历史数据；重新上架后需负责人重新启用。`
        : `${impact} ${shrinking ? `本次缩小范围，最多影响 ${plugin.installedCount} 个已安装实例、${plugin.enabledCount} 个已启用实例。` : "本次调整开放对象。"} 仅移出范围的儿童会失去资格，保留配置及历史；恢复范围后需负责人重新启用。新增范围不会自动安装。`

  return (
    <div className="plugin-detail-workspace">
      <header className="plugin-detail-header">
        <Button
          type="button"
          variant="ghost"
          className="self-start"
          disabled={busy}
          onClick={onBack}
        >
          <ArrowLeft data-icon="inline-start" />
          返回插件列表
        </Button>
        <div className="plugin-detail-title-row">
          <div className="plugin-detail-identity">
            <PluginIcon icon={plugin.icon} />
            <div className="min-w-0">
              <h1>{plugin.name || plugin.id}</h1>
              <PluginStatuses plugin={plugin} />
            </div>
          </div>
          <div className="plugin-detail-actions">
            {plugin.publicationStatus === "published" ? (
              <Button
                type="button"
                variant="destructive"
                disabled={locked}
                onClick={() => setConfirmation("unpublish")}
              >
                下架插件
              </Button>
            ) : (
              <Button
                type="button"
                disabled={locked || Boolean(publishProblem)}
                aria-describedby={publishProblem ? "plugin-publish-help" : undefined}
                onClick={() => setConfirmation("publish")}
              >
                {plugin.publicationStatus === "unpublished" ? "重新上架" : "上架插件"}
              </Button>
            )}
          </div>
        </div>
        <FormFeedback message={editing ? "" : error} />
        {stale && !editing && (
          <FormFeedback message="插件已有新的修改。当前草稿仍保留；请重新载入并核对后再编辑，重新载入会放弃草稿。" />
        )}
        {(uncertain || stale) && !editing && (
          <Button
            id="pluginRecoverDetails"
            type="button"
            variant="outline"
            className="self-start"
            disabled={busy || refreshing}
            onClick={() => void reload()}
          >
            核对最新状态
          </Button>
        )}
        {dirty && !editing && (
          <p role="status" className="text-caption text-muted-foreground">
            有未保存的修改。返回列表会放弃草稿。
          </p>
        )}
        {updating && (
          <p role="status" className="text-caption text-muted-foreground">
            插件正在更新，暂不能修改资料、上架或扩大范围；仍可下架、缩小范围。
          </p>
        )}
        {plugin.reason && <FormFeedback message={plugin.reason} />}
        {plugin.publicationStatus !== "published" && publishProblem && (
          <p id="plugin-publish-help" className="text-caption text-muted-foreground">
            {publishProblem}
          </p>
        )}
      </header>
      <Card className="plugin-detail-card" aria-labelledby="pluginDetailsTitle">
        <CardHeader className="plugin-card-heading">
          <CardTitle id="pluginDetailsTitle">插件详情</CardTitle>
          <Button
            id="editPluginMetadata"
            type="button"
            size="sm"
            className="h-8 min-h-8"
            variant="outline"
            disabled={locked || updating}
            onClick={() => changeEditing(true)}
          >
            <Pencil data-icon="inline-start" />
            编辑
          </Button>
        </CardHeader>
        <CardContent>
          <dl className="plugin-details-grid">
            {[
              ["名称", plugin.name || plugin.id],
              ["插件 ID", plugin.id],
              ["类型", plugin.type === "page" ? "页面型" : "后台型"],
              ["排序", String(plugin.sortOrder)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            <div className="plugin-details-wide">
              <dt>介绍</dt>
              <dd>{plugin.description || "尚未填写"}</dd>
            </div>
            <div className="plugin-details-wide">
              <dt>使用说明</dt>
              <dd>{plugin.instructions || "尚未填写"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card className="plugin-detail-card" aria-labelledby="pluginScopeTitle">
        <CardHeader className="plugin-scope-heading">
          <CardTitle id="pluginScopeTitle">发布范围</CardTitle>
          <CardDescription className="text-caption">{impact}</CardDescription>
        </CardHeader>
        <CardContent>
          <ScopePicker
            value={scope}
            original={base}
            selectedChildren={plugin.scopeChildren}
            updating={updating}
            disabled={locked}
            request={request}
            onChange={setScope}
          />
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            type="button"
            disabled={locked || !scopeDirty || emptyScope || (updating && !shrinking)}
            onClick={() => setConfirmation("scope")}
          >
            保存发布范围
          </Button>
        </CardFooter>
      </Card>
      <DeploymentHistory plugin={plugin} request={request} />
      <Dialog open={editing} onOpenChange={changeEditing}>
        <DialogContent
          className="ui-modal-frame admin-dialog plugin-metadata-dialog"
          showCloseButton={false}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            document.getElementById("plugin-name")?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const edit = document.getElementById("editPluginMetadata") as HTMLButtonElement | null
            const target =
              edit && !edit.disabled ? edit : document.getElementById("pluginRecoverDetails")
            target?.focus()
          }}
          onEscapeKeyDown={(event) => {
            if (pending.current) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (pending.current) event.preventDefault()
          }}
        >
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="关闭"
              className="absolute top-4 right-4"
              disabled={busy}
            >
              <X aria-hidden />
            </Button>
          </DialogClose>
          <DialogHeader className="ui-modal-header pr-16 text-left">
            <DialogTitle>编辑插件详情</DialogTitle>
            <DialogDescription>修改家长端展示的名称、介绍、使用说明和排序。</DialogDescription>
          </DialogHeader>
          <form
            id="pluginMetadataForm"
            onSubmit={saveMetadata}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="ui-modal-body flex flex-col gap-5">
              <FormFeedback message={error} />
              {stale && (
                <FormFeedback message="插件已有新的修改。请重新载入并核对后再编辑，重新载入会放弃当前草稿。" />
              )}
              {uncertain && !error && (
                <FormFeedback message="保存结果尚未确认，请重新载入并核对后再操作。" />
              )}
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
                  help="数值越大，展示越靠前。"
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
            </div>
            <DialogFooter className="ui-modal-footer">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => changeEditing(false)}
              >
                取消
              </Button>
              {(uncertain || stale) && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || refreshing}
                  onClick={() => void reload()}
                >
                  读取最新资料
                </Button>
              )}
              <Button
                type="submit"
                className="min-h-10"
                disabled={locked || updating || !metadataDirty || !metadataValid}
              >
                {busy ? "正在保存…" : "保存资料"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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

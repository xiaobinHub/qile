import { operationId as newOperationId } from "./operation-id"
import { lazy, Suspense, useEffect, useState } from "react"
import { Download, Play, Star } from "lucide-react"
import { Skeleton } from "@shared/components/ui/skeleton"
import { Badge } from "@shared/components/ui/badge"
import { Switch } from "@shared/components/ui/switch"
import { getCourseSync, previewCourseSync, saveCourseSync, courseSyncChanged, request } from "./api"
import type { CourseSyncSettings, CourseSyncSummary } from "./api"
import { Avatar, Button, DatePicker, Empty, Notice, NumberPicker, Overlay, teacherName } from "./ui"
import type { Connection, PluginContext, Resource, Teacher, TeacherProfile } from "./types"
const PdfPreview = lazy(() => import("@shared/components/pdf-preview"))
export function ProfileDrawer({
  context,
  teacher,
  onClose,
  onBook,
  onFavorite,
  favoriteBusy = false,
}: {
  context: PluginContext
  teacher: Teacher
  onClose(): void
  onBook(): void
  onFavorite(): void
  favoriteBusy?: boolean
}) {
  const [videoState, setVideoState] = useState<"loading" | "ready" | "failed">("loading")
  const [profile, setProfile] = useState<TeacherProfile | null>(null),
    [error, setError] = useState("")
  useEffect(() => {
    let alive = true
    request<TeacherProfile>(context, `teachers/${encodeURIComponent(teacher.id)}`)
      .then((r) => {
        if (alive) setProfile(r)
      })
      .catch((e) => {
        if (alive) setError(e.message)
      })
    return () => {
      alive = false
    }
  }, [context, teacher.id])
  const info = profile ?? teacher
  const video = profile?.introVideo
  return (
    <Overlay
      title="教师档案"
      drawer
      onClose={onClose}
      footer={<Button onClick={onBook}>查看档期</Button>}
    >
      <div className="mison-profile-heading">
        <Avatar name={info.name} url={info.avatarUrl} large />
        <div>
          <h3>{teacherName(info.name)}</h3>
          <div className="mison-tags">
            {info.labels.map((l) => (
              <Badge variant="secondary" key={l.id}>
                {l.name}
              </Badge>
            ))}
          </div>
        </div>
        <Button
          className="mison-star mison-profile-favorite"
          variant="ghost"
          size="icon"
          aria-label={teacher.favorite ? "取消收藏老师" : "收藏老师"}
          aria-pressed={teacher.favorite}
          disabled={favoriteBusy || teacher.favoriteAvailable === false}
          onClick={onFavorite}
        >
          <Star fill={teacher.favorite ? "currentColor" : "none"} />
        </Button>
      </div>
      {error ? <Notice error>{error}</Notice> : null}
      <section className="mison-profile-section">
        <h3>老师介绍</h3>
        <p>{info.intro || "老师暂未提供介绍。"}</p>
      </section>
      <section className="mison-profile-section">
        <h3>介绍视频</h3>
        <div className="mison-intro-media">
          {video?.action === "inline" && video.url && videoState !== "failed" ? (
            <>
              <video
                controls
                preload="metadata"
                playsInline
                onLoadedData={() => setVideoState("ready")}
                onError={() => setVideoState("failed")}
                src={safeResourceUrl(video)}
                aria-label="教师介绍视频"
              />
              {videoState === "loading" ? (
                <Skeleton className="mison-video-loading" role="status">
                  <Play />
                  <span>视频加载中…</span>
                </Skeleton>
              ) : null}
            </>
          ) : !profile && !error ? (
            <Skeleton className="mison-video-loading" role="status">
              <Play />
              <span>视频加载中…</span>
            </Skeleton>
          ) : (
            <Empty
              title={
                videoState === "failed"
                  ? "视频暂时无法播放，请稍后重新打开档案。"
                  : (video?.instructions ?? video?.reason ?? "老师暂未提供介绍视频")
              }
              icon={<Play />}
            />
          )}
        </div>
      </section>
    </Overlay>
  )
}
export function safeResourceUrl(resource: Resource) {
  if (!resource.url) return undefined
  try {
    const url = new URL(resource.url, location.origin)
    return url.protocol === "https:" || (url.origin === location.origin && url.protocol === "http:")
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}
function pdfFilename(title: string) {
  const name =
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "课件"
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`
}
function downloadResource(url: string, title: string) {
  const filename = pdfFilename(title)
  const target = new URL(url, location.origin)
  target.searchParams.set("filename", filename)
  const link = document.createElement("a")
  link.href = target.href
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
}
export function ResourceViewer({ resource, onClose }: { resource: Resource; onClose(): void }) {
  const url = safeResourceUrl(resource)
  const pdf = resource.action === "inline" && resource.mimeType === "application/pdf" && !!url
  const [pages, setPages] = useState<number | null>(null)
  useEffect(() => setPages(null), [url])
  return (
    <Overlay
      wide
      preview={pdf}
      contained={pdf}
      title={resource.title}
      titleMeta={pdf && pages ? `共 ${pages} 页` : undefined}
      actions={
        pdf && url ? (
          <Button variant="outline" size="sm" onClick={() => downloadResource(url, resource.title)}>
            <Download data-icon="inline-start" />
            下载
          </Button>
        ) : null
      }
      onClose={onClose}
    >
      {resource.action === "inline" && url ? (
        resource.mimeType?.startsWith("video/") ? (
          <video controls autoPlay={false} src={url} />
        ) : pdf ? (
          <Suspense fallback={<p role="status">正在打开 PDF…</p>}>
            <PdfPreview key={url} url={url} title={resource.title} onPages={setPages} />
          </Suspense>
        ) : (
          <iframe title={resource.title} src={url} />
        )
      ) : url && ["external", "download"].includes(resource.action) ? (
        <Button asChild variant="outline">
          <a href={url} target="_blank" rel="noopener noreferrer">
            {resource.action === "download" ? "下载资料" : "打开官方页面"}
          </a>
        </Button>
      ) : (
        <Notice>{resource.instructions ?? resource.reason ?? "该资源暂不可用。"}</Notice>
      )}
    </Overlay>
  )
}
export function AccountDialog({
  context,
  connection,
  onClose,
  onChanged,
}: {
  context: PluginContext
  connection: Connection
  onClose(): void
  onChanged(connection: Connection): void
}) {
  const [settings, setSettings] = useState<CourseSyncSettings | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [points, setPoints] = useState(0)
  const [startDate, setStartDate] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState("")
  const [savedMessage, setSavedMessage] = useState("")
  const [confirm, setConfirm] = useState<
    null | { kind: "disable" } | { kind: "apply"; summary: CourseSyncSummary }
  >(null)
  useEffect(() => {
    let alive = true
    getCourseSync(context)
      .then((value) => {
        if (!alive || context.signal.aborted) return
        setSettings(value)
        setEnabled(value.enabled)
        setPoints(value.points ?? 0)
        setStartDate(value.startDate ?? value.serverDate)
      })
      .catch((reason) => {
        if (alive && !context.signal.aborted) setError((reason as Error).message)
      })
      .finally(() => {
        if (alive && !context.signal.aborted) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [context])
  const savedDate = settings?.startDate || settings?.serverDate || ""
  const dirty =
    !!settings &&
    (enabled !== settings.enabled ||
      (enabled && (points !== (settings.points ?? 0) || startDate !== savedDate)))
  async function disconnect() {
    if (busy || disconnecting) return
    setDisconnecting(true)
    setError("")
    try {
      const value = await request<Connection>(context, "connection", {
        method: "DELETE",
        body: {
          operationId: newOperationId(),
          bindingRevision: connection.bindingRevision,
        },
      })
      if (!context.signal.aborted) {
        onChanged(value)
        onClose()
      }
    } catch (reason) {
      if (!context.signal.aborted) setError((reason as Error).message)
    } finally {
      if (!context.signal.aborted) setDisconnecting(false)
    }
  }
  async function persist(nextEnabled: boolean) {
    if (!settings) return
    setBusy(true)
    setError("")
    try {
      const summary = await saveCourseSync(context, {
        operationId: newOperationId(),
        enabled: nextEnabled,
        points,
        startDate: startDate || settings.serverDate,
      })
      if (context.signal.aborted) return
      setSettings({
        ...settings,
        enabled: nextEnabled,
        points: nextEnabled ? points : settings.points,
        startDate: nextEnabled ? startDate : settings.startDate,
        revision: summary.revision ?? settings.revision,
      })
      setEnabled(nextEnabled)
      setConfirm(null)
      const removed = summary.removed ?? 0
      const awarded = summary.points ?? 0
      setSavedMessage(
        nextEnabled
          ? awarded || removed
            ? `已按起始日同步${awarded ? `，发放 ${awarded} 积分` : ""}${removed ? `，删除 ${removed} 节并收回 ${summary.clawback ?? 0} 积分` : ""}。`
            : "课程同步已保存。"
          : removed
            ? `已关闭同步，并删除 ${removed} 节未完成课程。`
            : "已关闭课程同步。",
      )
      if (courseSyncChanged(summary)) await context.refreshChild?.()
    } catch (reason) {
      if (!context.signal.aborted) setError((reason as Error).message)
    } finally {
      if (!context.signal.aborted) setBusy(false)
    }
  }
  async function requestSave() {
    if (!settings?.canManage || busy || !dirty) return
    setError("")
    setSavedMessage("")
    if (!enabled) {
      setConfirm({ kind: "disable" })
      return
    }
    if (!Number.isInteger(points) || points < 0 || points > 100 || points % 5 !== 0) {
      setError("奖励积分必须是 0 到 100 之间、间隔为 5 的整数。")
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      setError("请设置同步起始日。")
      return
    }
    if (settings.enabled && startDate === settings.startDate) {
      await persist(true)
      return
    }
    setBusy(true)
    try {
      const summary = await previewCourseSync(context, { points, startDate })
      if (!context.signal.aborted) setConfirm({ kind: "apply", summary })
    } catch (reason) {
      if (!context.signal.aborted) setError((reason as Error).message)
    } finally {
      if (!context.signal.aborted) setBusy(false)
    }
  }
  const summary = confirm?.kind === "apply" ? confirm.summary : null
  const previewRows = summary
    ? [
        ["新增课程", `${summary.added ?? 0} 节，其中 ${summary.addedAttended ?? 0} 节已上课`],
        ["完成并发放", `${summary.newlyCompleted ?? 0} 节，发放 ${summary.points ?? 0} 积分`],
        ["删除并收回", `${summary.removed ?? 0} 节，收回 ${summary.clawback ?? 0} 积分`],
        ...(summary.skipped ? [["已跳过", `${summary.skipped} 节缺少编号或时间无效`]] : []),
      ]
    : []
  return (
    <>
      <Overlay title="美森账号管理" onClose={onClose} busy={busy || disconnecting}>
        <div className="mison-account">
          {error ? (
            <Notice error className="mison-account-message">
              {error}
            </Notice>
          ) : null}
          {connection.maskedAccount ? (
            <div className="mison-account-session">
              <div className="mison-account-identity">
                <p className="mison-account-status">已登录</p>
                <p className="mison-account-name">{connection.maskedAccount}</p>
              </div>
              {connection.canManageConnection ? (
                <Button
                  className="mison-account-logout"
                  variant="outline"
                  disabled={busy || disconnecting}
                  onClick={() => void disconnect()}
                >
                  {disconnecting ? "正在退出…" : "退出美森登录"}
                </Button>
              ) : null}
            </div>
          ) : null}
          {!connection.canManageConnection ? (
            <Notice className="mison-account-message">请儿童负责人管理美森账号。</Notice>
          ) : (
            <section className="mison-sync-settings" aria-labelledby="mison-sync-title">
              <div className="mison-sync-heading">
                <div className="mison-sync-copy">
                  <label
                    id="mison-sync-title"
                    className="mison-sync-title"
                    htmlFor="mison-course-sync"
                  >
                    自动同步课程到任务
                  </label>
                </div>
                <Switch
                  id="mison-course-sync"
                  className="mison-sync-toggle"
                  checked={enabled}
                  disabled={busy || loading || !settings?.canManage}
                  onCheckedChange={(checked) => {
                    const next = checked === true
                    setEnabled(next)
                    setError("")
                    setSavedMessage("")
                    if (next && !startDate && settings?.serverDate)
                      setStartDate(settings.serverDate)
                  }}
                />
              </div>
              {loading ? (
                <p className="mison-caption" role="status">
                  正在读取同步设置…
                </p>
              ) : null}
              {settings && !settings.canManage ? (
                <Notice className="mison-account-message">只有儿童负责人可以设置课程同步。</Notice>
              ) : null}
              {enabled && settings?.canManage ? (
                <div className="mison-sync-fields">
                  <div className="mison-sync-field">
                    <label htmlFor="mison-sync-points">奖励积分</label>
                    <NumberPicker
                      id="mison-sync-points"
                      label="奖励积分"
                      min={0}
                      max={100}
                      step={5}
                      loop
                      value={points}
                      disabled={busy}
                      onChange={setPoints}
                      required
                    />
                  </div>
                  <div className="mison-sync-field">
                    <label htmlFor="mison-sync-start">同步起始日</label>
                    <DatePicker
                      id="mison-sync-start"
                      openDownwards
                      value={startDate}
                      disabled={busy}
                      onChange={setStartDate}
                    />
                  </div>
                </div>
              ) : null}
              {settings?.canManage && (dirty || busy || savedMessage) ? (
                <div className="mison-sync-actions">
                  {savedMessage ? (
                    <p className="mison-sync-saved" role="status">
                      {savedMessage}
                    </p>
                  ) : null}
                  {dirty || busy ? (
                    <Button disabled={busy || loading || !dirty} onClick={() => void requestSave()}>
                      {busy ? "正在保存…" : "保存"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </section>
          )}
        </div>
      </Overlay>
      {confirm ? (
        <Overlay
          confirm
          title={confirm.kind === "disable" ? "关闭课程同步？" : "按新的起始日同步？"}
          busy={busy}
          onClose={() => {
            if (!busy) setConfirm(null)
          }}
          footer={
            <>
              <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
                取消
              </Button>
              <Button disabled={busy} onClick={() => void persist(confirm.kind === "apply")}>
                {busy ? "正在保存…" : confirm.kind === "disable" ? "关闭同步" : "确认同步"}
              </Button>
            </>
          }
        >
          {confirm.kind === "disable" ? (
            <p>尚未完成的同步课程会从日历删除。已完成的课程和已发放积分会保留。</p>
          ) : summary ? (
            <div className="mison-sync-preview">
              <p className="mison-caption">取消后不会保存，也不会发放或收回积分。</p>
              <dl>
                {previewRows.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </Overlay>
      ) : null}
    </>
  )
}

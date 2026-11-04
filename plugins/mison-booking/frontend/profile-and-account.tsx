import { operationId as newOperationId } from "./operation-id"
import { lazy, Suspense, useEffect, useState } from "react"
import { Play, Star } from "lucide-react"
import { Skeleton } from "@shared/components/ui/skeleton"
import { Badge } from "@shared/components/ui/badge"
import { request } from "./api"
import { Avatar, Button, Empty, Notice, Overlay, teacherName } from "./ui"
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
export function ResourceViewer({ resource, onClose }: { resource: Resource; onClose(): void }) {
  const url = safeResourceUrl(resource)
  const pdf = resource.action === "inline" && resource.mimeType === "application/pdf" && !!url
  return (
    <Overlay wide contained={pdf} title={resource.title} onClose={onClose}>
      {resource.action === "inline" && url ? (
        resource.mimeType?.startsWith("video/") ? (
          <video controls autoPlay={false} src={url} />
        ) : pdf ? (
          <Suspense fallback={<p role="status">正在打开 PDF…</p>}>
            <PdfPreview key={url} url={url} title={resource.title} />
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function disconnect() {
    if (busy) return
    setBusy(true)
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
    } catch (e) {
      if (!context.signal.aborted) setError((e as Error).message)
    } finally {
      if (!context.signal.aborted) setBusy(false)
    }
  }
  return (
    <Overlay title="美森账号管理" onClose={onClose} busy={busy}>
      {connection.maskedAccount ? (
        <p className="mison-connected-account">{connection.maskedAccount} · 已登录</p>
      ) : null}
      {!connection.canManageConnection ? (
        <Notice>请儿童负责人管理美森账号。</Notice>
      ) : (
        <div className="mison-account-form">
          <Button
            className="self-start"
            variant="destructive"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            {busy ? "正在退出…" : "退出美森登录"}
          </Button>
        </div>
      )}
      {error ? <Notice error>{error}</Notice> : null}
    </Overlay>
  )
}

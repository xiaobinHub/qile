import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@shared/components/ui/alert-dialog"
import { useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { request } from "./api"
import { forgetAvatar, loadAvatar, peekAvatar } from "./avatar-cache"
import type { PluginContext } from "./types"
import { X, UserRound } from "lucide-react"
import { Button as SharedButton } from "@shared/components/ui/button"
import { Avatar as SharedAvatar, AvatarImage, AvatarFallback } from "@shared/components/ui/avatar"
import { Alert, AlertDescription } from "@shared/components/ui/alert"
import {
  Empty as SharedEmpty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyContent,
} from "@shared/components/ui/empty"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from "@shared/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
} from "@shared/components/ui/sheet"
import { Separator } from "@shared/components/ui/separator"
import { DatePicker as SharedDatePicker } from "@shared/components/date-picker"
import { NumberPicker as SharedNumberPicker } from "@shared/components/number-picker"
import { PopoverContent as SharedPopoverContent } from "@shared/components/ui/popover"
import { cn } from "@shared/lib/utils"
export { Input } from "@shared/components/ui/input"

import { PortalContext, ImageContext, PageActiveContext } from "./contexts"
export { PortalContext, ImageContext } from "./contexts"
export function DatePicker(props: React.ComponentProps<typeof SharedDatePicker>) {
  return <SharedDatePicker {...props} portalContainer={useContext(PortalContext)} />
}
export function NumberPicker(props: React.ComponentProps<typeof SharedNumberPicker>) {
  return <SharedNumberPicker {...props} portalContainer={useContext(PortalContext)} />
}
export function PopoverContent(props: React.ComponentProps<typeof SharedPopoverContent>) {
  return <SharedPopoverContent {...props} portalContainer={useContext(PortalContext)} />
}
const imageLanes = new WeakMap<PluginContext, { next: number; lanes: Promise<unknown>[] }>()
function loadImage(context: PluginContext, reference: string) {
  return loadAvatar(reference, () => {
    const queue = imageLanes.get(context) ?? {
      next: 0,
      lanes: [Promise.resolve(), Promise.resolve()],
    }
    imageLanes.set(context, queue)
    const lane = queue.next++ % queue.lanes.length
    const pending = queue.lanes[lane]
      .catch(() => undefined)
      .then(() => {
        if (context.signal.aborted) throw new Error("页面已关闭")
        return fetchImage(context, reference)
      })
    queue.lanes[lane] = pending
    return pending
  })
}

type ImagePart =
  { dataUrl: string } | { chunk: string; chunkIndex: number; totalChunks: number; mimeType: string }
async function readImagePart(context: PluginContext, path: string): Promise<ImagePart> {
  try {
    return await request<ImagePart>(context, path)
  } catch (error) {
    if (
      context.signal.aborted ||
      !["RESOURCE_UNAVAILABLE", "UPSTREAM_UNAVAILABLE", "plugin_busy"].includes(
        (error as { code?: string }).code ?? "",
      )
    )
      throw error
    // One bounded retry for read-only avatar requests; never retries login/writes.
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (context.signal.aborted) throw error
    return request<ImagePart>(context, path)
  }
}
async function fetchImage(context: PluginContext, reference: string) {
  const path = `resources/images/${reference.slice(12)}`
  const first = await readImagePart(context, path)
  if ("dataUrl" in first) return first.dataUrl
  if (
    first.chunkIndex !== 0 ||
    !Number.isInteger(first.totalChunks) ||
    first.totalChunks < 1 ||
    first.totalChunks > 15 ||
    !["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"].includes(first.mimeType)
  )
    throw new Error("头像数据不正确")
  const pieces = [first.chunk]
  for (let index = 1; index < first.totalChunks; index++) {
    if (context.signal.aborted) throw new Error("页面已关闭")
    const next = await readImagePart(context, `${path}?chunk=${index}`)
    if (
      !("chunk" in next) ||
      next.chunkIndex !== index ||
      next.totalChunks !== first.totalChunks ||
      next.mimeType !== first.mimeType
    )
      throw new Error("头像数据不完整")
    pieces.push(next.chunk)
  }
  return `data:${first.mimeType};base64,${pieces.join("")}`
}

export function Button({
  className = "",
  type = "button",
  ...props
}: React.ComponentProps<typeof SharedButton>) {
  return <SharedButton type={type} className={cn("mison-button", className)} {...props} />
}
export function Avatar({
  name,
  url,
  large = false,
  compact = false,
}: {
  name: string
  url?: string | null
  large?: boolean
  compact?: boolean
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const context = useContext(ImageContext)
  const target = useRef<HTMLSpanElement>(null)
  const internal = url?.startsWith("mison-image:") ?? false
  const remembered = internal && url ? peekAvatar(url) : null
  const [loaded, setLoaded] = useState<{ reference: string; data: string } | null>(
    remembered && url ? { reference: url, data: remembered } : null,
  )
  useEffect(() => {
    if (!internal || !url || !context || !target.current) return
    let alive = true
    const accept = (data: string) => {
      if (alive && !context.signal.aborted) {
        setFailedUrl(null)
        setLoaded({ reference: url, data })
      }
    }
    const cached = peekAvatar(url)
    if (cached) {
      accept(cached)
      return () => {
        alive = false
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void loadImage(context, url)
          .then(accept)
          .catch(() => {
            if (alive) setFailedUrl(url)
          })
      },
      { rootMargin: "100px" },
    )
    observer.observe(target.current)
    return () => {
      alive = false
      observer.disconnect()
    }
  }, [context, internal, url])
  const source = internal
    ? peekAvatar(url ?? "") || (loaded && loaded.reference === url ? loaded.data : null)
    : url
  return (
    <SharedAvatar
      ref={target}
      className={cn("mison-avatar", large ? "size-20" : compact ? "size-12" : "size-16")}
      aria-hidden="true"
    >
      {source && url !== failedUrl ? (
        <AvatarImage
          src={source}
          alt=""
          onError={() => {
            if (url?.startsWith("mison-image:")) forgetAvatar(url)
            setFailedUrl(url ?? null)
          }}
        />
      ) : null}
      <AvatarFallback>
        {name ? (
          name
            .replace(/\s*老师$/, "")
            .slice(0, 1)
            .toUpperCase()
        ) : (
          <UserRound />
        )}
      </AvatarFallback>
    </SharedAvatar>
  )
}

export function Overlay({
  title,
  titleMeta,
  actions,
  children,
  footer,
  onClose,
  wide = false,
  drawer = false,
  busy = false,
  confirm = false,
  contained = false,
  preview = false,
}: {
  title: string
  titleMeta?: ReactNode
  actions?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose(): void
  wide?: boolean
  drawer?: boolean
  busy?: boolean
  confirm?: boolean
  contained?: boolean
  preview?: boolean
}) {
  const portal = useContext(PortalContext)
  const pageActive = useContext(PageActiveContext)
  const returnFocus = useRef(document.activeElement as HTMLElement | null)
  const Root = confirm ? AlertDialog : drawer ? Sheet : Dialog
  const Content = confirm ? AlertDialogContent : drawer ? SheetContent : DialogContent
  const Header = confirm ? AlertDialogHeader : drawer ? SheetHeader : DialogHeader
  const Title = confirm ? AlertDialogTitle : drawer ? SheetTitle : DialogTitle
  const Footer = confirm ? AlertDialogFooter : drawer ? SheetFooter : DialogFooter
  const preventClose = (event: { preventDefault(): void }) => {
    if (busy || !pageActive) event.preventDefault()
  }
  return (
    <Root
      open
      modal={pageActive}
      onOpenChange={(open) => {
        if (!open && (busy || !pageActive)) return
        if (!open) onClose()
      }}
    >
      <Content
        portalContainer={portal}
        onEscapeKeyDown={preventClose}
        onPointerDownOutside={preventClose}
        onInteractOutside={preventClose}
        onFocusOutside={preventClose}
        {...(!confirm ? { showCloseButton: false } : {})}
        aria-describedby={undefined}
        className={cn(
          "mison-overlay",
          drawer ? "is-drawer" : "is-modal",
          wide && "is-wide",
          contained && "is-contained",
          preview && "is-preview",
        )}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault()
            returnFocus.current.focus({ preventScroll: true })
          }
        }}
      >
        <Header className="mison-overlay-header">
          <div className="mison-overlay-heading">
            <Title className={preview || titleMeta ? "mison-overlay-title" : undefined}>
              {title}
            </Title>
            {titleMeta ? <small>{titleMeta}</small> : null}
            {actions ? <div className="mison-overlay-heading-actions">{actions}</div> : null}
          </div>
          <div className="mison-overlay-header-actions">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`关闭${title}`}
              disabled={busy}
              onClick={onClose}
            >
              <X data-icon="inline-start" />
            </Button>
          </div>
        </Header>
        <Separator />
        {contained ? (
          <div className="mison-overlay-scroll is-contained">
            <div className="mison-overlay-body is-contained">{children}</div>
          </div>
        ) : (
          <div className="mison-overlay-scroll">
            <div className="mison-overlay-body">{children}</div>
          </div>
        )}
        {footer ? (
          <>
            <Separator />
            <Footer className="mison-overlay-footer">{footer}</Footer>
          </>
        ) : null}
      </Content>
    </Root>
  )
}
export function Notice({
  children,
  error = false,
  className,
}: {
  children: ReactNode
  error?: boolean
  className?: string
}) {
  return (
    <Alert
      variant={error ? "destructive" : "default"}
      className={cn("mison-notice", className)}
      role={error ? "alert" : "status"}
    >
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}
export function Empty({
  title,
  children,
  icon = <UserRound />,
}: {
  title: string
  children?: ReactNode
  icon?: ReactNode
}) {
  return (
    <SharedEmpty className="mison-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle role="heading" aria-level={3}>
          {title}
        </EmptyTitle>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </SharedEmpty>
  )
}
export const minutes = (time: string) => {
  const [h, m] = time.split(":").map(Number)
  return h * 60 + m
}
export const weekday = (date: string) =>
  new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "Asia/Shanghai" }).format(
    new Date(`${date}T12:00:00+08:00`),
  )
export const dateLabel = (date: string) => {
  const [, m, d] = date.split("-")
  return `${Number(m)}月${Number(d)}日 ${weekday(date)}`
}
export const teacherName = (name: string) => (name.endsWith("老师") ? name : `${name} 老师`)

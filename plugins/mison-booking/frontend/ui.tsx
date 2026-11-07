import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@shared/components/ui/alert-dialog"
import { useContext, useRef, useState, type ReactNode } from "react"
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

import { PortalContext, PageActiveContext } from "./contexts"
export { PortalContext } from "./contexts"
export function DatePicker(props: React.ComponentProps<typeof SharedDatePicker>) {
  return <SharedDatePicker {...props} portalContainer={useContext(PortalContext)} />
}
export function NumberPicker(props: React.ComponentProps<typeof SharedNumberPicker>) {
  return <SharedNumberPicker {...props} portalContainer={useContext(PortalContext)} />
}
export function PopoverContent(props: React.ComponentProps<typeof SharedPopoverContent>) {
  return <SharedPopoverContent {...props} portalContainer={useContext(PortalContext)} />
}
const AVATAR_HOSTS = new Set(["mp.mison.cn", "file.mison.cn"])

function publicAvatarUrl(url?: string | null) {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (
    parsed.protocol !== "https:" ||
    !AVATAR_HOSTS.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.port
  )
    return null
  parsed.hash = ""
  return parsed.href
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
  const source = publicAvatarUrl(url)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  return (
    <SharedAvatar
      className={cn("mison-avatar", large ? "size-20" : compact ? "size-12" : "size-16")}
      aria-hidden="true"
    >
      {source && source !== failedSource ? (
        <AvatarImage
          src={source}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSource(source)}
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

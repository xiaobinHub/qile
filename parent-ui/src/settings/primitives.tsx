import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from "react"
import { Button } from "@shared/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@shared/components/ui/card"
import { Input } from "@shared/components/ui/input"
import { Label } from "@shared/components/ui/label"
import { Badge } from "@shared/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@shared/components/ui/dropdown-menu"
import { FormField } from "@shared/components/form-field"
import {
  ChevronRight,
  ClipboardList,
  History,
  KeyRound,
  LayoutGrid,
  LogOut,
  Mail,
  Ellipsis,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react"
import type { Controller } from "./types"
export {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Badge,
  FormField,
}

type RowMenuAction = {
  label: string
  onSelect: () => void
  destructive?: boolean
  selector: Record<string, string>
}
export function RowMenu({
  label,
  disabled = false,
  selector,
  actions,
}: {
  label: string
  disabled?: boolean
  selector?: Record<string, string>
  actions: RowMenuAction[]
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const pending = useRef<(() => void) | null>(null)
  const mounted = useRef(true)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          size="icon"
          className="settings-row-menu"
          aria-label={label}
          disabled={disabled}
          {...selector}
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          const action = pending.current
          if (!action) return
          event.preventDefault()
          pending.current = null
          // Let Radix release the menu's focus scope before opening a confirmation.
          queueMicrotask(() => {
            if (!mounted.current) return
            trigger.current?.focus({ preventScroll: true })
            action()
          })
        }}
      >
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            className="settings-menu-item"
            variant={action.destructive ? "destructive" : "default"}
            disabled={disabled}
            {...action.selector}
            onSelect={() => {
              pending.current = action.onSelect
            }}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const icons: Record<string, LucideIcon> = {
  child: UserRound,
  family: UsersRound,
  mail: Mail,
  task: ClipboardList,
  category: LayoutGrid,
  backup: History,
  key: KeyRound,
  logout: LogOut,
  arrow: ChevronRight,
}
export function Icon({ name }: { name: string }) {
  const Component = icons[name] || UserRound
  return <Component aria-hidden="true" strokeWidth={1.65} />
}
export const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
export const initial = (value: string) => Array.from(String(value || "").trim())[0] || "家"
export const statusNames: Record<string, string> = {
  pending: "待接受",
  accepted: "已接受",
  rejected: "已拒绝",
  revoked: "已撤销",
  expired: "已过期",
}
export function Empty({
  title,
  copy,
  type = "mail",
}: {
  title: string
  copy: string
  type?: string
}) {
  return (
    <div className="settings-empty">
      <span>
        <Icon name={type} />
      </span>
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  )
}
export const Notice = ({ children }: { children: ReactNode }) => (
  <p className="settings-notice">{children}</p>
)
export const Feedback = ({
  id,
  message = "",
  success = false,
}: {
  id: string
  message?: string
  success?: boolean
}) => (
  <p
    id={id}
    className={`settings-feedback${success ? " success" : ""}`}
    role="status"
    aria-live="polite"
  >
    {message}
  </p>
)
export function useAction(controller: Controller) {
  const live = useRef(true)
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("")
  useLayoutEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  async function run<T>(
    key: string,
    work: () => Promise<T>,
    finish?: (result: T) => void | Promise<void>,
    propagate = false,
  ) {
    if (controller.pending || !live.current) {
      if (propagate) throw new Error("请等待当前操作完成后再试。")
      return
    }
    const token = {}
    controller.pending = token
    setBusy(key)
    setError("")
    try {
      const result = await work()
      if (live.current) await finish?.(result)
    } catch (failure) {
      const issue = failure as { kind?: string; message?: string }
      if (live.current && issue.kind !== "stale" && issue.kind !== "unauthorized")
        setError(issue.message || "请求未完成，请稍后重试。")
      if (propagate) throw failure
    } finally {
      if (controller.pending === token) controller.pending = null
      if (live.current) setBusy(null)
    }
  }
  const confirm = <T,>(
    key: string,
    work: () => Promise<T>,
    finish?: (result: T) => void | Promise<void>,
  ) => run(key, work, finish, true)
  return { busy, error, setError, run, confirm, active: () => live.current }
}
export function useRead<T>(load: () => Promise<T>, refresh = 0) {
  const [value, setValue] = useState<T | null>(null),
    [error, setError] = useState("")
  useEffect(() => {
    let active = true
    setError("")
    load()
      .then((result) => {
        if (active) setValue(result)
      })
      .catch((failure) => {
        if (active && failure.kind !== "stale" && failure.kind !== "unauthorized")
          setError(failure.message)
      })
    return () => {
      active = false
    }
  }, [refresh])
  return { value, error }
}
export function ReadStatus({
  error,
  loading,
  retry,
}: {
  error: string
  loading: string
  retry: () => void
}) {
  return error ? (
    <div className="settings-empty settings-load-error">
      <strong>暂时无法读取</strong>
      <p>{error}</p>
      <Button variant="outline" type="button" id="retrySettings" onClick={retry}>
        重新加载
      </Button>
    </div>
  ) : (
    <p className="settings-loading" role="status">
      {loading}
    </p>
  )
}

import { useEffect, useRef, useState, type ReactNode, type FormEvent } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@shared/components/ui/dialog"
import { AsyncConfirm } from "@shared/components/async-confirm"
import { FormField } from "@shared/components/form-field"
import type { ReactElement } from "react"
import { runtime } from "../lib/runtime"
export { Button } from "@shared/components/ui/button"
export { Input } from "@shared/components/ui/input"
export { Label } from "@shared/components/ui/label"
export {
  Card,
  CardHeader,
  CardContent,
  CardTitle,
  CardDescription,
} from "@shared/components/ui/card"
export { DatePicker, DateRangePicker } from "@shared/components/date-picker"
export { TimePicker } from "@shared/components/time-picker"
export function ErrorText({ message, id }: { message?: string; id?: string }) {
  return message ? (
    <>
      <p id={id} role="alert" className="form-error">
        {message}
      </p>
      {runtime.getSnapshot().unconfirmed && <SaveResolution />}
    </>
  ) : null
}
export function SaveResolution() {
  const action = useAsync()
  return (
    <div className="save-resolution">
      <p className="field-help">
        本次保存结果尚未确认，请先刷新核对。确认需要重试时，选择“重试原操作”可避免重复保存。
      </p>
      <div className="flex flex-wrap gap-2">
        <ResolutionButton action={action} work={runtime.refresh}>
          刷新检查
        </ResolutionButton>
        <ResolutionButton action={action} work={runtime.retryPending}>
          重试原操作
        </ResolutionButton>
      </div>
      {action.error && (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      )}
    </div>
  )
}
import { Button as ResolutionControl } from "@shared/components/ui/button"
function ResolutionButton({
  action,
  work,
  children,
}: {
  action: ReturnType<typeof useAsync>
  work: () => Promise<unknown>
  children: ReactNode
}) {
  return (
    <ResolutionControl
      type="button"
      variant="outline"
      disabled={action.busy}
      onClick={() => void action.run(work)}
    >
      {children}
    </ResolutionControl>
  )
}
export function Modal({
  title,
  description,
  children,
  onClose,
  id,
  footer,
  size = "default",
}: {
  title: string
  description?: string
  children: ReactNode
  onClose: () => void
  id?: string
  footer?: ReactNode
  size?: "small" | "default" | "complex"
}) {
  const returnFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement)
  useEffect(() => {
    runtime.setEditing(true)
    return () => runtime.setEditing(false)
  }, [])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !runtime.getSnapshot().busy) onClose()
      }}
    >
      <DialogContent
        id={id}
        className="feature-dialog ui-modal-frame"
        data-modal-size={size}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocus.current?.isConnected) returnFocus.current.focus()
        }}
        onEscapeKeyDown={(e) => {
          if (runtime.getSnapshot().busy) e.preventDefault()
        }}
        onInteractOutside={(e) => {
          if (runtime.getSnapshot().busy) e.preventDefault()
        }}
      >
        <DialogHeader className="ui-modal-header">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={!description ? "sr-only" : ""}>
            {description || title + "，请填写以下内容。"}
          </DialogDescription>
        </DialogHeader>
        <div className="ui-modal-body">{children}</div>
        {footer && <DialogFooter className="ui-modal-footer">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}
export function Confirm({
  title,
  description,
  work,
  onClose,
  label = "确认",
  id = "confirmationDialog",
  children,
}: {
  title: string
  description: string
  work: () => Promise<unknown>
  onClose: () => void
  label?: string
  id?: string
  children?: ReactNode
}) {
  useEffect(() => {
    runtime.setEditing(true)
    return () => runtime.setEditing(false)
  }, [])
  return (
    <AsyncConfirm
      open
      id={id}
      cancelId={id === "logoutDialog" ? "cancelLogout" : undefined}
      confirmId={id === "logoutDialog" ? "confirmLogout" : undefined}
      title={title}
      description={description}
      confirmLabel={label}
      destructive={/删除|撤销/.test(label)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      onConfirm={work}
    >
      {children}
    </AsyncConfirm>
  )
}
export function useAsync() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  const live = useRef(true),
    pending = useRef(false)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  async function run(work: () => Promise<unknown>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError("")
    try {
      await work()
    } catch (e) {
      if (live.current && (e as { kind?: string }).kind !== "stale") setError((e as Error).message)
    } finally {
      pending.current = false
      if (live.current) setBusy(false)
    }
  }
  return { busy, error, setError, run }
}
export function Field({
  label,
  id,
  children,
  help,
}: {
  label: string
  id: string
  children: ReactElement<{ id?: string }>
  help?: string
}) {
  return (
    <FormField id={id} label={label} help={help} className="form-field">
      {children}
    </FormField>
  )
}
export const submit = (
  event: FormEvent,
  work: () => Promise<unknown>,
  action: ReturnType<typeof useAsync>,
) => {
  event.preventDefault()
  void action.run(work)
}
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@shared/components/ui/select"
export function Choice({
  id,
  value,
  onChange,
  options,
  label,
  disabled = false,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  label: string
  disabled?: boolean
}) {
  return (
    <Select
      value={value || "__empty"}
      onValueChange={(v) => onChange(v === "__empty" ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={label} className="w-full">
        <SelectValue placeholder="请选择" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value || "__empty"} value={o.value || "__empty"}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

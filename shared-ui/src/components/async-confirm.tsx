import { useEffect, useRef, useState, type ReactNode } from "react"
import { LoaderCircle } from "lucide-react"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog"
import { FormFeedback } from "./form-feedback"

export type AsyncConfirmProps = { id?: string; cancelId?: string; confirmId?: string; open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description: ReactNode; confirmLabel?: string; cancelLabel?: string; destructive?: boolean; onConfirm: () => Promise<unknown>; children?: ReactNode }
/** Keeps the dialog open on failure, blocks duplicate submits and dismissal while pending. */
export function AsyncConfirm({ id, cancelId, confirmId, open, onOpenChange, title, description, confirmLabel = "确认", cancelLabel = "取消", destructive, onConfirm, children }: AsyncConfirmProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (open) setError("") }, [open])
  async function confirm() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError("")
    try { await onConfirm(); if (mounted.current) onOpenChange(false) }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "操作未能完成，请稍后重试。") }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  return <AlertDialog open={open} onOpenChange={next => { if (!pending.current) onOpenChange(next) }}><AlertDialogContent id={id} onEscapeKeyDown={event => { if (pending.current) event.preventDefault() }}><AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader>{children}<FormFeedback message={error} /><AlertDialogFooter><AlertDialogCancel id={cancelId} disabled={busy}>{cancelLabel}</AlertDialogCancel><AlertDialogAction id={confirmId} variant={destructive ? "destructive" : "default"} disabled={busy} onClick={event => { event.preventDefault(); void confirm() }}>{busy ? <><LoaderCircle className="size-4 animate-spin" />正在处理…</> : confirmLabel}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
}

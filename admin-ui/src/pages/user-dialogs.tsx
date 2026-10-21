import { useRef, useState, type FormEvent } from "react"
import { KeyRound, LoaderCircle, Plus, ShieldAlert, UserPlus, X } from "lucide-react"
import { FormFeedback } from "@shared/components/form-feedback"
import { PasswordInput, passwordHelp, passwordPolicy } from "@shared/components/password-input"
import { Button } from "@shared/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@shared/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@shared/components/ui/alert-dialog"
import { Input } from "@shared/components/ui/input"
import { Label } from "@shared/components/ui/label"
import { errorMessage, isIgnoredError, useSession } from "@/lib/session"
import type { User } from "@/lib/types"
import { useMounted } from "@/lib/use-mounted"

export const loginPolicy = {
  minLength: 3,
  maxLength: 32,
  pattern: "[A-Za-z0-9][A-Za-z0-9._\\-]{2,31}",
  title: "3–32 位，以字母或数字开头，支持字母、数字、点、下划线和连字符",
}
export type DialogTarget = { user: User; trigger: HTMLButtonElement | null }
type MutationComplete = (message: string) => Promise<void>

function CloseButton({ disabled }: { disabled: boolean }) {
  return (
    <DialogClose asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-4 right-4 text-muted-foreground"
        disabled={disabled}
        aria-label="关闭弹窗"
      >
        <X className="size-4" />
      </Button>
    </DialogClose>
  )
}
function DialogNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-muted/70 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
    </div>
  )
}
function restoreFocus(target: DialogTarget) {
  const destination = target.trigger?.isConnected
    ? target.trigger
    : document.getElementById("statusFilter") || document.getElementById("search")
  destination?.focus()
}

export function CreateUserDialog({ onComplete }: { onComplete: MutationComplete }) {
  const { request } = useSession()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const submitting = useRef(false)
  const firstInput = useRef<HTMLInputElement>(null)
  const mounted = useMounted()
  function changeOpen(next: boolean) {
    if (!submitting.current) {
      setOpen(next)
      setError("")
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError("")
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      await request("admin/users", "POST", {
        loginName: data.get("loginName"),
        nickname: data.get("nickname"),
        password: data.get("password"),
      })
      form.reset()
      await onComplete("账号已开通，请将初始登录信息交给该家长。")
      if (mounted.current) setOpen(false)
    } catch (error) {
      if (mounted.current && !isIgnoredError(error)) setError(errorMessage(error))
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button id="openCreateUser" type="button" className="h-10 gap-2 shadow-xs">
          <Plus className="size-4" />
          开通账号
        </Button>
      </DialogTrigger>
      <DialogContent
        className="admin-dialog gap-5 bg-card sm:max-w-[460px]"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          firstInput.current?.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (submitting.current) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (submitting.current) event.preventDefault()
        }}
      >
        <CloseButton disabled={busy} />
        <DialogHeader className="text-left">
          <div className="dialog-icon">
            <UserPlus className="size-5" />
          </div>
          <DialogTitle>开通家长账号</DialogTitle>
          <DialogDescription className="leading-6">
            填写账号信息，家长首次登录后需修改初始密码。
          </DialogDescription>
        </DialogHeader>
        <form id="createUser" onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="createLogin">登录名</Label>
            <Input
              ref={firstInput}
              id="createLogin"
              name="loginName"
              {...loginPolicy}
              required
              autoComplete="off"
              autoCapitalize="none"
              placeholder="例如：lele.family"
              disabled={busy}
              aria-describedby="createLoginHelp"
            />
            <p id="createLoginHelp" className="field-help">
              3–32 位，以字母或数字开头，支持点、下划线和连字符。
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="createNickname">昵称</Label>
            <Input
              id="createNickname"
              name="nickname"
              required
              maxLength={40}
              autoComplete="off"
              placeholder="例如：乐乐家长"
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="createPassword">初始密码</Label>
            <PasswordInput
              id="createPassword"
              name="password"
              {...passwordPolicy}
              required
              autoComplete="new-password"
              placeholder="设置初始密码"
              disabled={busy}
              aria-describedby="createPasswordHelp"
            />
            <p id="createPasswordHelp" className="field-help">
              {passwordHelp}
            </p>
          </div>
          <FormFeedback id="createError" message={error} />
          <DialogFooter className="border-t pt-5">
            <DialogClose asChild>
              <Button id="cancelCreate" type="button" variant="outline" disabled={busy}>
                取消
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle className="animate-spin" />
                  正在开通…
                </>
              ) : (
                "开通账号"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ResetPasswordDialog({
  target,
  onClose,
  onComplete,
}: {
  target: DialogTarget
  onClose: () => void
  onComplete: MutationComplete
}) {
  const { request } = useSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const submitting = useRef(false)
  const firstInput = useRef<HTMLInputElement>(null)
  const mounted = useMounted()
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError("")
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      await request(`admin/users/${encodeURIComponent(target.user.id)}/password`, "POST", {
        password: data.get("password"),
      })
      form.reset()
      await onComplete("密码已重置，原有登录会话已撤销。")
      if (mounted.current) onClose()
    } catch (error) {
      if (mounted.current && !isIgnoredError(error)) setError(errorMessage(error))
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose()
      }}
    >
      <DialogContent
        className="admin-dialog gap-5 bg-card sm:max-w-[460px]"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          firstInput.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus(target)
        }}
        onEscapeKeyDown={(event) => {
          if (submitting.current) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (submitting.current) event.preventDefault()
        }}
      >
        <CloseButton disabled={busy} />
        <DialogHeader className="text-left">
          <div className="dialog-icon">
            <KeyRound className="size-5" />
          </div>
          <DialogTitle>重置账号密码</DialogTitle>
          <DialogDescription className="break-words leading-6">
            为 <span className="font-medium text-foreground">{target.user.nickname}</span>（
            {target.user.loginName}）设置新的初始密码。
          </DialogDescription>
        </DialogHeader>
        <DialogNotice>
          重置后，该账号的所有登录会话立即失效，下次登录需修改密码。孩子数据与授权关系保留。
        </DialogNotice>
        <form id="resetPassword" onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="resetValue">新的初始密码</Label>
            <PasswordInput
              ref={firstInput}
              id="resetValue"
              name="password"
              {...passwordPolicy}
              required
              autoComplete="new-password"
              placeholder="输入新的初始密码"
              disabled={busy}
              aria-describedby="resetPasswordHelp"
            />
            <p id="resetPasswordHelp" className="field-help">
              {passwordHelp}
            </p>
          </div>
          <FormFeedback id="resetError" message={error} />
          <DialogFooter className="border-t pt-5">
            <DialogClose asChild>
              <Button id="cancelReset" type="button" variant="outline" disabled={busy}>
                取消
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle className="animate-spin" />
                  正在重置…
                </>
              ) : (
                "确认重置"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function StatusDialog({
  target,
  onClose,
  onComplete,
}: {
  target: DialogTarget
  onClose: () => void
  onComplete: MutationComplete
}) {
  const { request } = useSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const submitting = useRef(false)
  const mounted = useMounted()
  const disabled = target.user.status === "disabled"
  async function confirm() {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError("")
    try {
      await request(`admin/users/${encodeURIComponent(target.user.id)}/status`, "PATCH", {
        status: disabled ? "active" : "disabled",
      })
      await onComplete(disabled ? "账号已启用。" : "账号已停用，原有登录会话已撤销。")
      if (mounted.current) onClose()
    } catch (error) {
      if (mounted.current && !isIgnoredError(error)) setError(errorMessage(error))
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose()
      }}
    >
      <AlertDialogContent
        className="admin-dialog gap-5 bg-card sm:max-w-[460px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus(target)
        }}
        onEscapeKeyDown={(event) => {
          if (submitting.current) event.preventDefault()
        }}
      >
        <AlertDialogHeader className="place-items-start text-left">
          <div className={`dialog-icon mb-2 ${disabled ? "" : "bg-amber-50 text-amber-700"}`}>
            <ShieldAlert className="size-5" />
          </div>
          <AlertDialogTitle>{disabled ? "启用这个账号？" : "停用这个账号？"}</AlertDialogTitle>
          <AlertDialogDescription className="break-words leading-6">
            <span className="font-medium text-foreground">{target.user.nickname}</span>（
            {target.user.loginName}）
            {disabled
              ? "启用后可重新登录，继续使用原有孩子数据与授权关系。"
              : "停用后，所有登录会话立即失效。孩子数据和管理关系会保留；如其为负责人，成员管理将暂时不可用。"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormFeedback message={error} />
        <AlertDialogFooter className="mt-1">
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            id="confirmStatus"
            variant={disabled ? "default" : "destructive"}
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              void confirm()
            }}
          >
            {busy ? (
              <>
                <LoaderCircle className="animate-spin" />
                正在处理…
              </>
            ) : disabled ? (
              "确认启用"
            ) : (
              "确认停用"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

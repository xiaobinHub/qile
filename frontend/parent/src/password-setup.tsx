import { useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from "react"
import { Button } from "@shared/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@shared/components/ui/card"
import { PasswordInput, passwordPolicy } from "@shared/components/password-input"
import { KeyRound } from "lucide-react"
import { Label } from "@shared/components/ui/label"

type PasswordSetupProps = {
  changePassword: (values: { newPassword: string }) => Promise<unknown>
  logout: () => void
}

export function PasswordField({
  id,
  label,
  placeholder,
  inputRef,
  current = false,
}: {
  id: string
  label: string
  placeholder: string
  inputRef: RefObject<HTMLInputElement | null>
  current?: boolean
}) {
  return (
    <div className="settings-field">
      <Label htmlFor={id}>{label}</Label>
      <div className="settings-password-input">
        <PasswordInput
          ref={inputRef}
          id={id}
          name={id}
          required
          minLength={current ? undefined : passwordPolicy.minLength}
          maxLength={passwordPolicy.maxLength}
          pattern={current ? undefined : passwordPolicy.pattern}
          title={current ? undefined : passwordPolicy.title}
          autoComplete={current ? "current-password" : "new-password"}
          placeholder={placeholder}
          aria-describedby={id === "passwordNew" ? "passwordHelp" : undefined}
        />
      </div>
    </div>
  )
}

export function PasswordSetup({ changePassword, logout }: PasswordSetupProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const mounted = useRef(true),
    pending = useRef(false)
  const password = useRef<HTMLInputElement>(null),
    repeat = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current) return
    if (password.current!.value !== repeat.current!.value) {
      setError("两次输入的新密码不一致。")
      repeat.current!.focus()
      return
    }
    pending.current = true
    setBusy(true)
    setError("")
    try {
      await changePassword({ newPassword: password.current!.value })
    } catch (failure) {
      const issue = failure as { kind?: string; message?: string }
      if (mounted.current && issue.kind !== "stale" && issue.kind !== "unauthorized") {
        setError(issue.message || "暂时无法保存，请稍后重试。")
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <Card id="requiredPasswordContent" className="password-setup-card settings-required-password">
      <CardHeader className="password-setup-heading">
        <span className="password-setup-icon">
          <KeyRound aria-hidden="true" strokeWidth={1.65} />
        </span>
        <CardTitle>
          <h1 id="passwordSetupTitle">设置自己的密码</h1>
        </CardTitle>
        <CardDescription>
          <p>当前使用初始或重置密码，请设置一个新密码后继续。</p>
        </CardDescription>
      </CardHeader>
      <CardContent className="password-setup-body">
        <form id="passwordForm" className="settings-form" onSubmit={submit}>
          <fieldset disabled={busy}>
            <PasswordField
              id="passwordNew"
              label="新密码"
              placeholder="设置新密码"
              inputRef={password}
            />
            <PasswordField
              id="passwordRepeat"
              label="再次输入新密码"
              placeholder="再次输入新密码"
              inputRef={repeat}
            />
            <p id="passwordHelp" className="settings-help">
              密码至少 6 位，同时包含数字和字母
            </p>
            <p id="profileError" className="settings-feedback" role="status" aria-live="polite">
              {error}
            </p>
            <div className="settings-form-footer">
              <Button variant="default" type="submit">
                {busy ? "正在处理…" : "保存新密码"}
              </Button>
            </div>
          </fieldset>
        </form>
      </CardContent>
      <CardFooter className="password-setup-footer">
        <Button
          id="accountLogout"
          type="button"
          variant="ghost"
          className="password-setup-logout"
          onClick={logout}
        >
          退出登录
        </Button>
      </CardFooter>
    </Card>
  )
}

import { useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type PasswordSetupProps = {
  changePassword: (values: { newPassword: string }) => Promise<unknown>
  logout: () => void
}

function PasswordEye({ visible }: { visible: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {visible
      ? <path d="m3 3 18 18M10.6 5.1A12 12 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-3 3.9M6.2 6.2A19 19 0 0 0 2 12s3.6 7 10 7a12 12 0 0 0 5.8-1.8M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      : <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>}
  </svg>
}

export function PasswordField({ id, label, placeholder, inputRef, current = false }: {
  id: string
  label: string
  placeholder: string
  inputRef: RefObject<HTMLInputElement | null>
  current?: boolean
}) {
  const [visible, setVisible] = useState(false)
  return <div className="settings-field">
    <Label htmlFor={id}>{label}</Label>
    <div className="settings-password-input">
      <Input ref={inputRef} id={id} name={id} type={visible ? "text" : "password"} required minLength={current ? undefined : 6} maxLength={128}
        pattern={current ? undefined : "(?=.*[A-Za-z])(?=.*[0-9]).{6,128}"} title={current ? undefined : "至少 6 位，且同时包含字母和数字"}
        autoComplete={current ? "current-password" : "new-password"} placeholder={placeholder} aria-describedby={id === "passwordNew" ? "passwordHelp" : undefined} />
      <Button type="button" variant="ghost" size="icon" className="settings-password-toggle" data-password-toggle={id}
        aria-controls={id} aria-label={`${visible ? "隐藏" : "显示"}${label}`} aria-pressed={visible} onClick={() => setVisible(value => !value)}>
        <PasswordEye visible={visible} />
      </Button>
    </div>
  </div>
}

function PasswordSetup({ changePassword, logout }: PasswordSetupProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const mounted = useRef(true), pending = useRef(false)
  const password = useRef<HTMLInputElement>(null), repeat = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => () => { mounted.current = false }, [])

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

  // Existing page classes deliberately replace default shadcn styling. No global
  // Tailwind/preflight is loaded into the calendar or other legacy parent pages.
  return <Card id="requiredPasswordContent" className="password-setup-card settings-required-password">
    <CardHeader className="password-setup-heading">
      <span className="password-setup-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="9" r="5" /><path d="m12 13 8 8m-5-5 3-3m-1 5 3-3" /></svg></span>
      <CardTitle><h1 id="passwordSetupTitle">设置自己的密码</h1></CardTitle>
      <CardDescription><p>当前使用初始或重置密码，请设置一个新密码后继续。</p></CardDescription>
    </CardHeader>
    <CardContent className="password-setup-body">
      <form id="passwordForm" className="settings-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          <PasswordField id="passwordNew" label="新密码" placeholder="设置新密码" inputRef={password} />
          <PasswordField id="passwordRepeat" label="再次输入新密码" placeholder="再次输入新密码" inputRef={repeat} />
          <p id="passwordHelp" className="settings-help">密码至少 6 位，同时包含数字和字母</p>
          <p id="profileError" className="settings-feedback" role="status" aria-live="polite">{error}</p>
          <div className="settings-form-footer"><Button className="btn primary" type="submit">{busy ? "正在处理…" : "保存新密码"}</Button></div>
        </fieldset>
      </form>
    </CardContent>
    <CardFooter className="password-setup-footer"><Button id="accountLogout" type="button" variant="ghost" className="password-setup-logout" onClick={logout}>退出登录</Button></CardFooter>
  </Card>
}

let root: Root | null = null
export function unmount() {
  root?.unmount()
  root = null
}
export function mount(container: HTMLElement, props: PasswordSetupProps) {
  unmount()
  root = createRoot(container)
  flushSync(() => root!.render(<PasswordSetup {...props} />))
}

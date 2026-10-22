import { useRef, useState, type FormEvent } from "react"
import { KeyRound, LoaderCircle, LockKeyhole, Save, ShieldCheck, UserRound } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@shared/components/ui/card"
import { Button } from "@shared/components/ui/button"
import { Input } from "@shared/components/ui/input"
import { Label } from "@shared/components/ui/label"
import { PageHeading } from "@shared/components/page-heading"
import { FormFeedback } from "@shared/components/form-feedback"
import { PasswordInput, passwordHelp, passwordPolicy } from "@shared/components/password-input"
import { errorMessage, isIgnoredError, useSession } from "@/lib/session"
import type { SessionUser } from "@/lib/types"
import { useMounted } from "@/lib/use-mounted"

function BasicProfile() {
  const { session, request, updateUser } = useSession()
  const user = session!.user
  const [nickname, setNickname] = useState(user.nickname)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [success, setSuccess] = useState(false)
  const submitting = useRef(false)
  const mounted = useMounted()
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setMessage("")
    setSuccess(false)
    try {
      const result = await request<{ user: SessionUser }>("account/profile", "PATCH", { nickname })
      if (mounted.current) {
        updateUser(result.user)
        setNickname(result.user.nickname)
        setSuccess(true)
        setMessage("账号资料已保存。")
      }
    } catch (error) {
      if (mounted.current && !isIgnoredError(error)) setMessage(errorMessage(error))
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Card className="gap-0 overflow-hidden rounded-xl py-0 shadow-none">
      <CardHeader className="border-b px-5 py-4 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="profile-icon">
            <UserRound className="size-[18px]" />
          </span>
          <div>
            <CardTitle className="text-section">基本资料</CardTitle>
            <CardDescription className="mt-1 text-caption leading-5">
              维护用于登录和识别的账号信息。
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-5 pt-5 pb-0 sm:px-6">
        <form id="profileForm" onSubmit={submit} className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="profileLogin">登录名</Label>
              <Input
                id="profileLogin"
                value={user.loginName}
                readOnly
                autoComplete="username"
                aria-describedby="profileLoginHelp"
                className="bg-muted/40 text-muted-foreground"
              />
              <p id="profileLoginHelp" className="field-help">
                登录名由管理员开通，不支持修改。
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="profileName">昵称</Label>
              <Input
                id="profileName"
                required
                maxLength={40}
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                autoComplete="nickname"
                disabled={busy}
              />
            </div>
          </div>
          <FormFeedback id="profileError" message={message} success={success} />
          <div className="-mx-5 flex justify-end border-t bg-muted/15 px-5 py-4 sm:-mx-6 sm:px-6">
            <Button type="submit" disabled={busy} className="h-11 gap-2">
              {busy ? (
                <>
                  <LoaderCircle className="animate-spin" />
                  正在保存…
                </>
              ) : (
                <>
                  <Save className="size-3.5" />
                  保存资料
                </>
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function ChangePassword({ required }: { required: boolean }) {
  const { request, passwordChanged } = useSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const submitting = useRef(false)
  const mounted = useMounted()
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    const form = event.currentTarget
    const data = new FormData(form)
    if (data.get("newPassword") !== data.get("repeatPassword")) {
      setError("两次新密码不一致。")
      return
    }
    submitting.current = true
    setBusy(true)
    setError("")
    try {
      await request("account/password", "POST", {
        currentPassword: data.get("currentPassword"),
        newPassword: data.get("newPassword"),
      })
      form.reset()
      passwordChanged()
    } catch (error) {
      if (mounted.current && !isIgnoredError(error)) setError(errorMessage(error))
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Card className="gap-0 overflow-hidden rounded-xl py-0 shadow-none">
      <CardHeader className="border-b px-5 py-4 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="profile-icon">
            <KeyRound className="size-[18px]" />
          </span>
          <div>
            <CardTitle className="text-section">
              {required ? "设置自己的密码" : "密码设置"}
            </CardTitle>
            <CardDescription className="mt-1 text-caption leading-5">
              修改后，所有已登录会话都会退出，请使用新密码重新登录。
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-5 pt-5 pb-0 sm:px-6">
        <form id="changePassword" onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="currentPassword">当前密码</Label>
            <PasswordInput
              id="currentPassword"
              name="currentPassword"
              required
              maxLength={128}
              autoComplete="current-password"
              placeholder={required ? "输入当前初始密码" : "输入当前登录密码"}
              disabled={busy}
            />
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="newPassword">新密码</Label>
              <PasswordInput
                id="newPassword"
                name="newPassword"
                {...passwordPolicy}
                required
                autoComplete="new-password"
                placeholder="设置新密码"
                disabled={busy}
                aria-describedby="newPasswordHelp"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="repeatPassword">再次输入新密码</Label>
              <PasswordInput
                id="repeatPassword"
                name="repeatPassword"
                {...passwordPolicy}
                required
                autoComplete="new-password"
                placeholder="再次输入新密码"
                disabled={busy}
              />
            </div>
          </div>
          <p id="newPasswordHelp" className="field-help !-mt-2">
            {passwordHelp}
          </p>
          <FormFeedback id="passwordError" message={error} />
          <div className="-mx-5 flex flex-wrap items-center justify-between gap-3 border-t bg-muted/15 px-5 py-4 sm:-mx-6 sm:px-6">
            <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <LockKeyhole className="size-3" />
              保存后需重新登录
            </span>
            <Button type="submit" disabled={busy} className="h-11">
              {busy ? (
                <>
                  <LoaderCircle className="animate-spin" />
                  正在修改…
                </>
              ) : (
                "修改密码并退出登录"
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

export function ProfilePage() {
  const { session } = useSession()
  const required = Boolean(session?.user.mustChangePassword)
  return (
    <div className="space-y-5">
      <PageHeading
        title={required ? "先设置一个新密码" : "我的账号"}
        description={
          required ? "完成初始密码修改后，即可进入管理工作台。" : "管理个人资料，维护账号安全。"
        }
      />
      {required && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-amber-200/70 bg-amber-50/70 px-5 py-4 text-sm text-amber-800"
        >
          <ShieldCheck className="mt-0.5 size-5 shrink-0" />
          <p>当前使用的是初始密码，请设置仅自己知道的新密码。</p>
        </div>
      )}
      {!required && <BasicProfile />}
      <ChangePassword required={required} />
    </div>
  )
}

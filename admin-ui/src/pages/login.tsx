import { useRef, useState, type FormEvent } from "react"
import { ArrowRight, LoaderCircle } from "lucide-react"
import { Brand } from "@/components/brand"
import { PageHeading } from "@shared/components/page-heading"
import { FormFeedback } from "@shared/components/form-feedback"
import { PasswordInput } from "@shared/components/password-input"
import { Button } from "@shared/components/ui/button"
import { Card, CardContent } from "@shared/components/ui/card"
import { Input } from "@shared/components/ui/input"
import { Label } from "@shared/components/ui/label"
import { errorMessage, isIgnoredError, useSession } from "@/lib/session"
import type { Session } from "@/lib/types"
import { useMounted } from "@/lib/use-mounted"

export function LoginPage() {
  const { request, signIn, notice } = useSession()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
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
      const result = await request<Session>("auth/login", "POST", {
        loginName: data.get("loginName"),
        password: data.get("password"),
      })
      form.reset()
      signIn(result)
    } catch (error) {
      if (mounted.current && !isIgnoredError(error)) setError(errorMessage(error))
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-5 py-10">
      <div className="mb-6">
        <Brand />
      </div>
      <Card className="w-full max-w-[420px] gap-0 overflow-hidden rounded-xl border-border/90 py-0 shadow-[0_12px_48px_-24px_rgba(24,56,39,0.22)]">
        <CardContent className="p-6 sm:p-7">
          <PageHeading title="管理员登录" description="登录后，开通与维护家长账号。" />
          <form id="loginForm" onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="loginName">登录名</Label>
              <Input
                id="loginName"
                name="loginName"
                autoComplete="username"
                autoFocus
                autoCapitalize="none"
                required
                maxLength={32}
                placeholder="请输入管理员登录名"
                disabled={busy}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="loginPassword">密码</Label>
              <PasswordInput
                id="loginPassword"
                name="password"
                autoComplete="current-password"
                required
                maxLength={128}
                placeholder="请输入密码"
                disabled={busy}
                className="h-11"
              />
            </div>
            <FormFeedback
              id="loginError"
              message={error || notice}
              success={!error && notice.startsWith("密码已修改")}
            />
            <Button type="submit" className="h-11 w-full" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle className="animate-spin" />
                  正在登录…
                </>
              ) : (
                <>
                  登录管理后台
                  <ArrowRight className="ml-auto size-4" />
                </>
              )}
            </Button>
          </form>
        </CardContent>
        <div className="border-t bg-muted/30 px-7 py-3.5 text-center text-xs text-muted-foreground">
          乐乐成长 · 账号管理
        </div>
      </Card>
    </main>
  )
}

import { operationId as newOperationId } from "./operation-id"
import { useEffect, useId, useRef, useState } from "react"
import { Field, FieldLabel, FieldGroup, FieldError } from "@shared/components/ui/field"
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@shared/components/ui/input-group"
import { Eye, EyeOff } from "lucide-react"
import { getBootstrap, PluginApiError, request } from "./api"
import { Button, Input, Notice } from "./ui"
import type { Connection, PluginContext } from "./types"

export function LoginForm({
  context,
  connection,
  onSuccess,
}: {
  context: PluginContext
  connection: Connection
  onSuccess(connection: Connection): void
}) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const passwordId = useId()
  const accountId = useId()
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [uncertain, setUncertain] = useState(false)
  const lock = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const active = () => alive.current && !context.signal.aborted

  async function submit() {
    if (lock.current || uncertain || !username.trim() || !password) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      const value = await request<Connection>(context, "connection/login", {
        method: "POST",
        body: {
          operationId: newOperationId(),
          bindingRevision: connection.bindingRevision,
          username: username.trim(),
          password,
        },
      })
      if (active()) {
        setPassword("")
        onSuccess(value)
      }
    } catch (e) {
      if (active()) {
        setError((e as Error).message)
        // A transport error may follow a successful upstream login. Never resend automatically.
        setUncertain(
          !(e instanceof PluginApiError) ||
            !!e.operationId ||
            ["RESULT_UNCERTAIN", "OPERATION_IN_PROGRESS", "BINDING_CHANGED"].includes(e.code),
        )
      }
    } finally {
      lock.current = false
      if (active()) {
        setBusy(false)
      }
    }
  }
  async function check() {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    try {
      const value = await getBootstrap(context)
      if (!active()) return
      if (value.connection.status === "connected") onSuccess(value.connection)
      else setError("尚未登录成功。确认后可重新尝试登录。")
    } catch (e) {
      if (active()) setError((e as Error).message)
    } finally {
      lock.current = false
      if (active()) setBusy(false)
    }
  }
  return (
    <form
      className="mison-account-form"
      aria-label="美森账号登录"
      aria-busy={busy}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={accountId}>账号</FieldLabel>
          <Input
            id={accountId}
            name="mison-username"
            autoComplete="username"
            placeholder="手机号或登录名"
            required
            maxLength={128}
            value={username}
            disabled={busy || !connection.canManageConnection}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={passwordId}>密码</FieldLabel>
          <InputGroup className="h-10">
            <InputGroupInput
              type={visible ? "text" : "password"}
              id={passwordId}
              name="mison-password"
              autoComplete="current-password"
              placeholder="请输入密码"
              required
              maxLength={256}
              value={password}
              disabled={busy || !connection.canManageConnection}
              onChange={(e) => setPassword(e.target.value)}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label={visible ? "隐藏密码" : "显示密码"}
                aria-pressed={visible}
                disabled={busy || !connection.canManageConnection}
                onClick={() => setVisible((value) => !value)}
                size="icon-sm"
              >
                {visible ? <EyeOff /> : <Eye />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
      </FieldGroup>
      <div className="mison-login-feedback">
        {error ? (
          <FieldError role="alert" title={error} className="truncate">
            {error}
          </FieldError>
        ) : null}
      </div>
      {!connection.canManageConnection ? (
        <Notice>请儿童负责人登录美森账号，登录后家人可共享使用。</Notice>
      ) : null}
      <Button
        type="submit"
        disabled={
          busy || uncertain || !connection.canManageConnection || !username.trim() || !password
        }
      >
        {busy ? "正在登录…" : "登录"}
      </Button>
      {uncertain ? (
        <div className="mison-login-recovery">
          <Button type="button" variant="outline" disabled={busy} onClick={() => void check()}>
            核对登录状态
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setUncertain(false)
              setError("")
            }}
          >
            重新尝试登录
          </Button>
        </div>
      ) : null}
    </form>
  )
}

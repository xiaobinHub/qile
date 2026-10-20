import { useRef, useState, type FormEvent } from "react"
import { PasswordField } from "../password-setup"
import { Button, Feedback, Input, Label, useAction } from "./primitives"
import type { Controller, User } from "./types"

export function AccountProfile({ controller, user }: { controller: Controller; user: User }) {
  const action = useAction(controller),
    [success, setSuccess] = useState(false)
  const nickname = useRef<HTMLInputElement>(null)
  function submit(event: FormEvent) {
    event.preventDefault()
    setSuccess(false)
    action.run(
      "save",
      () =>
        controller.deps.api<{ user: User }>("/api/account/profile", "PATCH", {
          nickname: nickname.current!.value.trim(),
        }),
      (result) => {
        controller.deps.updateUser(result.user)
        setSuccess(true)
        controller.render()
      },
    )
  }
  return (
    <form id="profileForm" className="settings-form" onSubmit={submit}>
      <fieldset disabled={!!action.busy}>
        <div className="settings-field">
          <Label htmlFor="profileLogin">登录名</Label>
          <Input
            id="profileLogin"
            value={user.loginName}
            readOnly
            autoComplete="username"
            aria-describedby="loginNameHelp"
          />
          <p id="loginNameHelp" className="settings-help">
            登录名由管理员开通，不支持修改。
          </p>
        </div>
        <div className="settings-field">
          <Label htmlFor="profileNickname">账号昵称</Label>
          <Input
            ref={nickname}
            id="profileNickname"
            defaultValue={user.nickname}
            required
            maxLength={40}
            autoComplete="nickname"
            placeholder="请输入你的昵称"
          />
          <p className="settings-help">家人会通过这个昵称识别你，最多 40 个字。</p>
        </div>
        <Feedback
          id="profileError"
          message={action.error || (success ? "账号昵称已更新。" : "")}
          success={success && !action.error}
        />
        <div className="settings-form-footer">
          <Button variant="default" type="submit">
            {action.busy ? "正在处理…" : "保存昵称"}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}

export function AccountPassword({ controller }: { controller: Controller }) {
  const action = useAction(controller)
  const current = useRef<HTMLInputElement>(null),
    password = useRef<HTMLInputElement>(null),
    repeat = useRef<HTMLInputElement>(null)
  function submit(event: FormEvent) {
    event.preventDefault()
    if (password.current!.value !== repeat.current!.value) {
      action.setError("两次输入的新密码不一致。")
      repeat.current!.focus()
      return
    }
    action.run("save", () =>
      controller.deps.changePassword({
        currentPassword: current.current!.value,
        newPassword: password.current!.value,
      }),
    )
  }
  return (
    <form id="passwordForm" className="settings-form" onSubmit={submit}>
      <fieldset disabled={!!action.busy}>
        <PasswordField
          id="passwordCurrent"
          label="当前密码"
          placeholder="输入当前登录密码"
          inputRef={current}
          current
        />
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
        <Feedback id="profileError" message={action.error} />
        <div className="settings-form-footer">
          <span>修改后，所有已登录页面需要重新登录。</span>
          <Button variant="default" type="submit">
            {action.busy ? "正在处理…" : "修改密码"}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}

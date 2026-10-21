import { useRef, useState, type FormEvent } from "react"
import { PasswordInput, passwordPolicy } from "@shared/components/password-input"
import { Button, Feedback, FormField, Input, useAction } from "./primitives"
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
        <FormField
          className="settings-field"
          id="profileLogin"
          label="登录名"
          help="登录名由管理员开通，不支持修改。"
        >
          <Input id="profileLogin" value={user.loginName} readOnly autoComplete="username" />
        </FormField>
        <FormField
          className="settings-field"
          id="profileNickname"
          label="账号昵称"
          help="家人会通过这个昵称识别你，最多 40 个字。"
        >
          <Input
            ref={nickname}
            id="profileNickname"
            defaultValue={user.nickname}
            required
            maxLength={40}
            autoComplete="nickname"
            placeholder="请输入你的昵称"
          />
        </FormField>
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
        {[
          {
            id: "passwordCurrent",
            label: "当前密码",
            placeholder: "输入当前登录密码",
            ref: current,
            current: true,
          },
          {
            id: "passwordNew",
            label: "新密码",
            placeholder: "设置新密码",
            ref: password,
            current: false,
          },
          {
            id: "passwordRepeat",
            label: "再次输入新密码",
            placeholder: "再次输入新密码",
            ref: repeat,
            current: false,
          },
        ].map((field) => (
          <FormField
            key={field.id}
            className="settings-field"
            id={field.id}
            label={field.label}
            help={field.id === "passwordNew" ? "密码至少 6 位，同时包含数字和字母" : undefined}
          >
            <PasswordInput
              ref={field.ref}
              id={field.id}
              name={field.id}
              required
              minLength={field.current ? undefined : passwordPolicy.minLength}
              maxLength={passwordPolicy.maxLength}
              pattern={field.current ? undefined : passwordPolicy.pattern}
              title={field.current ? undefined : passwordPolicy.title}
              autoComplete={field.current ? "current-password" : "new-password"}
              placeholder={field.placeholder}
            />
          </FormField>
        ))}
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

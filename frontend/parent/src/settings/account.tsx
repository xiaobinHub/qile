import { AccountAvatar, familyRoleLabel } from "../features/account-avatar"
import { AccountAvatarDialog } from "./account-avatar-dialog"
import { Pencil } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@shared/components/ui/dialog"
import { useRef, useState, type FormEvent } from "react"
import { PasswordInput, passwordPolicy } from "@shared/components/password-input"
import { Badge, Button, Feedback, FormField, Input, useAction } from "./primitives"
import type { Controller, User } from "./types"

export function AccountManagement({ controller, user }: { controller: Controller; user: User }) {
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  return (
    <div className="account-management">
      <section className="account-profile-card">
        <h2 id="settingsDetailTitle" tabIndex={-1}>
          账号管理
        </h2>
        <div className="account-profile-row">
          <button
            id="changeAccountAvatar"
            className="account-profile-avatar"
            type="button"
            title="更换角色"
            aria-label="更换角色"
            onClick={() => setAvatarOpen(true)}
          >
            <AccountAvatar id={user.avatarId} />
          </button>
          <div className="account-profile-copy">
            <div className="account-profile-name">
              <strong>{user.nickname}</strong>
              <Button
                id="editAccountNickname"
                type="button"
                variant="ghost"
                size="icon"
                aria-label="修改账号昵称"
                onClick={() => setEditing(true)}
              >
                <Pencil strokeWidth={1.5} />
              </Button>
            </div>
            <p data-account-login>账号 ID：{user.loginName}</p>
            <Badge
              asChild
              variant="secondary"
              className="account-family-role"
              data-account-family-role
            >
              <button
                id="changeAccountRole"
                type="button"
                title="更换角色"
                aria-label={`${familyRoleLabel(user.avatarId)}，更换角色`}
                aria-haspopup="dialog"
                aria-expanded={avatarOpen}
                onClick={() => setAvatarOpen(true)}
              >
                {familyRoleLabel(user.avatarId)}
              </button>
            </Badge>
          </div>
        </div>
      </section>
      <section className="account-password-card" aria-labelledby="accountPasswordTitle">
        <h3 id="accountPasswordTitle">修改密码</h3>
        <AccountPassword controller={controller} />
      </section>
      {avatarOpen && (
        <AccountAvatarDialog
          controller={controller}
          user={user}
          onClose={() => setAvatarOpen(false)}
        />
      )}
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          if (!controller.pending) setEditing(open)
        }}
      >
        <DialogContent
          id="accountNicknameDialog"
          className="child-management-dialog"
          showCloseButton={!controller.pending}
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement as HTMLElement
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (returnFocus.current?.isConnected) returnFocus.current.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>修改账号昵称</DialogTitle>
            <DialogDescription>家人会通过这个昵称识别你。</DialogDescription>
          </DialogHeader>
          {editing && (
            <AccountProfile
              controller={controller}
              user={user}
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false)
                controller.deps.toast("账号昵称已更新")
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function AccountProfile({
  controller,
  user,
  onSaved,
  onCancel,
}: {
  controller: Controller
  user: User
  onSaved?: () => void
  onCancel?: () => void
}) {
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
        onSaved?.()
      },
    )
  }
  return (
    <form id="profileForm" className="settings-form" onSubmit={submit}>
      <fieldset disabled={!!action.busy}>
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
          <Button variant="outline" type="button" onClick={onCancel}>
            取消
          </Button>
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
        <Feedback id="accountPasswordError" message={action.error} />
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

import { useRef, useState } from "react"
import { Check } from "lucide-react"
import { AvatarImage } from "@shared/components/avatar-image"
import { FAMILY_ROLES } from "@shared/family-roles"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@shared/components/ui/dialog"
import { DEFAULT_ACCOUNT_AVATAR, useAccountAvatars } from "../features/account-avatar"
import { Button, Feedback, useAction } from "./primitives"
import type { Controller, User } from "./types"

export function AccountAvatarDialog({
  controller,
  user,
  onClose,
}: {
  controller: Controller
  user: User
  onClose: () => void
}) {
  const [selected, setSelected] = useState(user.avatarId || DEFAULT_ACCOUNT_AVATAR)
  const { avatars, error, retry } = useAccountAvatars()
  const action = useAction(controller)
  const returnFocus = useRef<HTMLElement | null>(null)
  const { deps } = controller
  function save() {
    void action.run(
      "account-avatar",
      () => deps.api<{ user: User }>("/api/account/profile", "PATCH", { avatarId: selected }),
      (result) => {
        deps.updateUser(result.user)
        onClose()
        deps.toast("账号头像和角色已更新")
      },
    )
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose()
      }}
    >
      <DialogContent
        id="accountAvatarDialog"
        className="account-avatar-dialog"
        showCloseButton={!action.busy}
        onOpenAutoFocus={() => {
          returnFocus.current = document.activeElement as HTMLElement
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocus.current?.isConnected) returnFocus.current.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>更换角色</DialogTitle>
          <DialogDescription>角色和头像会同时变更。</DialogDescription>
        </DialogHeader>
        <Feedback id="accountAvatarLoadError" message={error} />
        {error && (
          <Button variant="outline" onClick={retry}>
            重新加载
          </Button>
        )}
        <fieldset className="account-avatar-grid" disabled={!!action.busy}>
          <legend className="sr-only">选择角色</legend>
          {FAMILY_ROLES.map((avatar) => (
            <div key={avatar.id}>
              <label className="child-avatar-option">
                <input
                  type="radio"
                  name="accountAvatar"
                  value={avatar.id}
                  checked={selected === avatar.id}
                  onChange={() => setSelected(avatar.id)}
                  aria-label={avatar.label}
                />
                <AvatarImage src={avatars.find((item) => item.id === avatar.id)?.url} />
                <span className="child-avatar-check" aria-hidden="true">
                  <Check />
                </span>
              </label>
              <p className="account-avatar-choice-name">{avatar.label}</p>
            </div>
          ))}
        </fieldset>
        <Feedback id="accountAvatarError" message={action.error} />
        <DialogFooter>
          <Button variant="outline" disabled={!!action.busy} onClick={onClose}>
            取消
          </Button>
          <Button id="saveAccountAvatar" disabled={!!action.busy} onClick={save}>
            {action.busy ? "正在保存…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

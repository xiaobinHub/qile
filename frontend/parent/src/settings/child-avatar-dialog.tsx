import { useRef, useState } from "react"
import { Check } from "lucide-react"
import { AvatarImage } from "@shared/components/avatar-image"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@shared/components/ui/dialog"
import { DEFAULT_AVATAR, useChildAvatars } from "../features/child-avatar"
import { Button, Feedback, useAction } from "./primitives"
import type { Child, Controller } from "./types"

export function ChildAvatarDialog({
  child,
  controller,
  onClose,
}: {
  child: Child
  controller: Controller
  onClose: () => void
}) {
  const [selected, setSelected] = useState(child.avatarId || DEFAULT_AVATAR)
  const { avatars, error, retry } = useChildAvatars()
  const action = useAction(controller)
  const returnFocus = useRef<HTMLElement | null>(null)
  const { deps } = controller
  function save() {
    if (child.role !== "owner" || child.archived) return
    void action.run(
      "avatar",
      () => deps.api(`/api/children/${child.id}`, "PATCH", { avatarId: selected }),
      async () => {
        const available = await deps.sync(true)
        if (!action.active()) return
        if (!available) {
          deps.home()
          return
        }
        onClose()
        deps.repaint()
        deps.toast("儿童头像已更新")
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
        id="childAvatarDialog"
        className="child-avatar-dialog"
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
          <DialogTitle>更换儿童头像</DialogTitle>
          <DialogDescription>选择喜欢的头像，保存后家人也能看到。</DialogDescription>
        </DialogHeader>
        <div className="child-avatar-options">
          {error ? (
            <div>
              <Feedback id="childAvatarLoadError" message={error} />
              <Button variant="outline" onClick={retry}>
                重新加载
              </Button>
            </div>
          ) : null}
          {(["boy", "girl"] as const).map((group) => (
            <fieldset key={group} disabled={!!action.busy}>
              <legend>{group === "boy" ? "男孩头像" : "女孩头像"}</legend>
              <div className="child-avatar-grid">
                {Array.from(
                  { length: 10 },
                  (_, index) => `${group}-${String(index + 1).padStart(2, "0")}`,
                ).map((id) => (
                  <label key={id} className="child-avatar-option">
                    <input
                      type="radio"
                      name="childAvatar"
                      value={id}
                      checked={selected === id}
                      onChange={() => setSelected(id)}
                      aria-label={`${group === "boy" ? "男孩" : "女孩"}头像 ${id.slice(-2)}`}
                    />
                    <AvatarImage src={avatars.find((avatar) => avatar.id === id)?.url} />
                    <span className="child-avatar-check" aria-hidden="true">
                      <Check />
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <Feedback id="childAvatarError" message={action.error} />
        <DialogFooter>
          <Button variant="outline" disabled={!!action.busy} onClick={onClose}>
            取消
          </Button>
          <Button id="saveChildAvatar" disabled={!!action.busy} onClick={save}>
            {action.busy ? "正在保存…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

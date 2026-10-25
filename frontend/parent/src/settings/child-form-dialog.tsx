import { useRef, type FormEvent } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@shared/components/ui/dialog"
import { Button, Feedback, FormField, Input, useAction } from "./primitives"
import type { Child, Controller } from "./types"

type Props = {
  kind: "rename" | "invite"
  open: boolean
  onOpenChange: (open: boolean) => void
  child: Child
  controller: Controller
  onSaved: () => void
}

export function ChildFormDialog({ kind, open, onOpenChange, child, controller, onSaved }: Props) {
  const action = useAction(controller)
  const input = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const rename = kind === "rename"
  const inputId = rename ? "renameChild" : "inviteLogin"
  const { deps } = controller
  function submit(event: FormEvent) {
    event.preventDefault()
    if (child.role !== "owner" || child.archived) return
    const value = input.current!.value.trim()
    if (!value) {
      action.setError(rename ? "请输入儿童昵称。" : "请输入家人的登录名。")
      input.current?.focus()
      return
    }
    if (rename && Array.from(value).length > 5) {
      action.setError("儿童昵称最多 5 个字。")
      input.current?.focus()
      return
    }
    void action.run(
      kind,
      () =>
        rename
          ? deps.api(`/api/children/${child.id}`, "PATCH", { name: value })
          : deps.api(`/api/children/${child.id}/invitations`, "POST", { loginName: value }),
      async () => {
        const available = await deps.sync(rename)
        if (!action.active()) return
        if (!available) {
          deps.home()
          return
        }
        onSaved()
        onOpenChange(false)
        deps.repaint()
        deps.toast(rename ? "儿童昵称已更新" : "邀请已发送")
      },
    )
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!action.busy) onOpenChange(next)
      }}
    >
      <DialogContent
        id={rename ? "childNicknameDialog" : "inviteFamilyDialog"}
        className="child-management-dialog"
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
          <DialogTitle>{rename ? "修改儿童昵称" : "邀请家人"}</DialogTitle>
          <DialogDescription>
            {rename
              ? "修改后，儿童卡片和日历中的昵称会同步更新。"
              : "邀请家人一起管理当前儿童的任务、积分和礼品。"}
          </DialogDescription>
        </DialogHeader>
        <form id={rename ? "renameChildForm" : "inviteParentForm"} onSubmit={submit}>
          <fieldset disabled={!!action.busy}>
            <FormField
              id={inputId}
              label={rename ? "儿童昵称" : "家人的登录名"}
              required
              help={
                rename ? "最多 5 个字。" : "家人需要先由管理员开通账号，接受邀请后即可共同管理。"
              }
            >
              <Input
                ref={input}
                id={inputId}
                defaultValue={rename ? child.name : ""}
                required
                minLength={rename ? undefined : 3}
                maxLength={rename ? 5 : 32}
                autoComplete="off"
                autoCapitalize="none"
                placeholder={rename ? "请输入儿童昵称" : "输入已开通账号的登录名"}
              />
            </FormField>
            <Feedback
              id={rename ? "renameChildError" : "inviteFamilyError"}
              message={action.error}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button type="submit">
                {action.busy ? "正在处理…" : rename ? "保存" : "发送邀请"}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  )
}

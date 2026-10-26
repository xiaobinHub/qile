import { useRef, useState, type FormEvent } from "react"
import { ChildGenderPicker, type ChildGender } from "../features/child-gender-picker"
import { useChildCreation } from "../features/use-child-creation"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@shared/components/ui/dialog"
import { Button, Feedback, FormField, Input, useAction } from "./primitives"
import type { Controller } from "./types"

export function ChildCreateDialog({
  controller,
  onClose,
}: {
  controller: Controller
  onClose: () => void
}) {
  const action = useAction(controller)
  const [gender, setGender] = useState<ChildGender | "">("")
  const input = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const { deps } = controller
  const creation = useChildCreation(deps)
  function submit(event: FormEvent) {
    event.preventDefault()
    const name = input.current!.value.trim()
    if (!name || Array.from(name).length > 5) {
      action.setError("儿童昵称请输入 1 至 5 个字。")
      input.current?.focus()
      return
    }
    if (!gender) {
      action.setError("请选择儿童性别。")
      return
    }
    void action.run(
      "create-child",
      async () => {
        const child = await creation.save(name, gender)
        await creation.refresh()
        return child
      },
      async (child) => {
        if (!action.active()) return
        onClose()
        await deps.selectChild(child.id)
        deps.toast("儿童已添加")
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
        id="createChildDialog"
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
          <DialogTitle>新增儿童</DialogTitle>
          <DialogDescription>为儿童创建独立的任务、积分和成长记录。</DialogDescription>
        </DialogHeader>
        <form id="addChildForm" onSubmit={submit}>
          <fieldset disabled={!!action.busy}>
            <FormField id="addChildName" label="儿童昵称" help="最多 5 个字。" required>
              <Input
                ref={input}
                id="addChildName"
                required
                disabled={creation.locked}
                maxLength={5}
                autoComplete="off"
                placeholder="请输入儿童昵称"
              />
            </FormField>
            <ChildGenderPicker value={gender} onChange={setGender} disabled={creation.locked} />
            <Feedback id="addChildError" message={action.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button type="submit">
                {creation.created
                  ? action.busy
                    ? "正在刷新…"
                    : "重试刷新"
                  : action.busy
                    ? "正在添加…"
                    : "添加儿童"}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  )
}

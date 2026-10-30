import "./calendar-quick-edit.css"
import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { GripVertical, Plus } from "lucide-react"
import { CalendarTrash } from "./calendar-trash"
import type { TrashDrop } from "./calendar-trash"
import { Button } from "./ui"
import { ApiError, operationId, runtime } from "../lib/runtime"
import { fmtFull, isDone } from "../domain/calendar"
import {
  addDraftTask,
  calendarDraftOperations,
  calendarDraftSummary,
  emptyCalendarDraft,
  editDraftTask,
  draftOccurrences,
  placeDraftTask,
  deletedDraftTasks,
  restoreDraftTask,
} from "../domain/calendar-draft"
import type { CalendarDraft } from "../domain/calendar-draft"
import type { BusinessData, Occurrence, Task } from "../domain/types"
import { dragItemKey, dragItemTitle, useCalendarQuickDrag } from "./calendar-quick-drag"
import type { CalendarDragItem, CalendarDragOrigin } from "./calendar-quick-drag"

export function useCalendarQuickEdit(data: BusinessData) {
  const [session, setSession] = useState<{ data: BusinessData; revision: number } | null>(null)
  const [draft, setDraft] = useState<CalendarDraft>(emptyCalendarDraft)
  const [selected, setSelected] = useState<CalendarDragItem | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [announcement, setAnnouncement] = useState("")
  const [trashDrop, setTrashDrop] = useState<TrashDrop | null>(null)
  const [editingOccurrence, setEditingOccurrence] = useState<Occurrence | null>(null)
  const mounted = useRef(true)
  const summary = calendarDraftSummary(draft)
  const snapshot = runtime.getSnapshot()
  const frozen = saving || snapshot.busy || snapshot.unconfirmed
  const active = !!session
  const place = (item: CalendarDragItem, target: string, origin?: CalendarDragOrigin) => {
    if (!session || frozen) return
    if (target === "delete" && item.kind === "preset") {
      setAnnouncement("常用任务不会被删除，请将卡片拖到日期中。")
      return
    }
    if (item.kind === "occurrence" && isDone(session.data, item.occurrence)) {
      setError("已完成任务已冻结，请先退出快捷编辑并撤销完成。")
      return
    }
    const next =
      item.kind === "preset"
        ? addDraftTask(draft, item.preset, target, `draft:${operationId()}`)
        : placeDraftTask(draft, item.occurrence, target === "delete" ? null : target)
    if (calendarDraftSummary(next).total > 200) {
      setError("每次最多保存 200 项调整，请先保存当前改动。")
      return
    }
    setDraft(next)
    setSelected(null)
    setError("")
    if (target === "delete" && item.kind === "occurrence")
      setTrashDrop({
        id: operationId(),
        title: item.occurrence.title,
        startTime: item.occurrence.startTime,
        origin,
      })
    setAnnouncement(
      target === "delete"
        ? `已暂存删除「${dragItemTitle(item)}」，保存后生效。`
        : `已将「${dragItemTitle(item)}」暂存于${fmtFull(target)}，保存后生效。`,
    )
  }
  const drag = useCalendarQuickDrag(active && !frozen, place)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!active) return
    runtime.setEditing(true)
    runtime.patch({ quickEditing: true })
    const unguard = runtime.guardNavigation(() => {
      runtime.patch({ message: "请先保存或取消快捷编辑，再切换页面或孩子。" })
      return false
    })
    return () => {
      unguard()
      runtime.setEditing(false)
      runtime.patch({ quickEditing: false })
    }
  }, [active])
  useEffect(() => {
    if (!active || !summary.total) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [active, summary.total])
  useEffect(() => {
    if (!active) return
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null)
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selected?.kind === "occurrence" &&
        (event.target as HTMLElement).closest<HTMLElement>("[data-month-occ]")?.dataset.monthOcc ===
          selected.occurrence.occurrenceKey
      ) {
        event.preventDefault()
        place(selected, "delete")
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [active, selected, draft, frozen])
  const finish = () => {
    drag.cancelDrag()
    setSession(null)
    setDraft(emptyCalendarDraft())
    setSelected(null)
    setError("")
    setAnnouncement("")
    setTrashDrop(null)
    setEditingOccurrence(null)
    requestAnimationFrame(() =>
      document.getElementById("quickEditBtn")?.focus({ preventScroll: true }),
    )
  }
  return {
    active,
    baseData: session?.data || data,
    revision: session?.revision,
    presetSaved: () => {
      const latest = runtime.getSnapshot()
      if (!session || !latest.data) return
      // An idempotent retry may return a newer snapshot than the preset's own write.
      // Only its single revision increment is safe to accept with existing task sources.
      if (latest.revision === session.revision + 1) {
        setSession({ data: latest.data, revision: latest.revision })
        setError("")
      } else {
        setSession({ ...session, data: { ...session.data, taskPresets: latest.data.taskPresets } })
        setError("常用任务已添加，但日程已更新；日程草稿仍保留，请取消后重新编排。")
      }
    },
    draft,
    selected,
    summary,
    saving,
    frozen,
    error,
    announcement,
    trashDrop,
    deletedTasks: deletedDraftTasks(draft),
    undoDelete: (key: string) => {
      if (!session || frozen) return
      const occurrence = deletedDraftTasks(draft).find((item) => item.occurrenceKey === key)
      if (!occurrence) return
      setDraft((current) => restoreDraftTask(current, key))
      setSelected(null)
      setError("")
      setAnnouncement(`已撤销删除「${occurrence.title}」。`)
    },
    editingOccurrence,
    openEditor: (occurrence: Occurrence) => {
      if (frozen || drag.suppressClick()) return
      drag.cancelDrag()
      setSelected(null)
      setEditingOccurrence(occurrence)
    },
    closeEditor: () => setEditingOccurrence(null),
    occurrencesForDate: (date: string) =>
      draftOccurrences(session?.data || data, date, date, draft),
    saveTask: (task: Task) => {
      if (!session || frozen || !editingOccurrence || isDone(session.data, editingOccurrence))
        throw Error("当前任务不可修改。")
      const next = editDraftTask(draft, editingOccurrence, task)
      if (calendarDraftSummary(next).total > 200)
        throw Error("每次最多保存 200 项调整，请先保存当前改动。")
      setDraft(next)
      setError("")
      setAnnouncement(`已暂存「${task.title}」的修改，保存日程后生效。`)
    },
    deleteEditingTask: () => {
      if (editingOccurrence) place({ kind: "occurrence", occurrence: editingOccurrence }, "delete")
    },
    drag,
    begin: () => {
      if (snapshot.busy || snapshot.unconfirmed) return
      setSession({ data, revision: snapshot.revision })
      setDraft(emptyCalendarDraft())
      setError("")
      setAnnouncement("已进入快捷编辑。拖动手柄，或选择任务后点击日期；已完成任务不可调整。")
    },
    choose: (item: CalendarDragItem) => {
      if (frozen || drag.suppressClick()) return
      setSelected((current) =>
        current && dragItemKey(current) === dragItemKey(item) ? null : item,
      )
      setAnnouncement(`已选择「${dragItemTitle(item)}」，请选择目标日期或删除区。`)
    },
    placeSelected: (target: string) => {
      if (selected) place(selected, target)
      else setAnnouncement("请先选择任务，再选择日期。")
    },
    cancel: () => {
      if (frozen) return
      finish()
    },
    save: async () => {
      if (!session || saving || snapshot.busy || !summary.total) return
      setSaving(true)
      setError("")
      try {
        await runtime.command(
          "task.batch",
          { operations: calendarDraftOperations(draft) },
          session.revision,
        )
        if (mounted.current) {
          finish()
          runtime.patch({ message: "日程调整已保存。" })
        }
      } catch (failure) {
        if (mounted.current && (failure as ApiError).kind !== "stale") {
          const message = (failure as Error).message
          setError(
            runtime.getSnapshot().unconfirmed
              ? `${message} 请重试保存以确认原操作，确认前不能取消。`
              : (failure as ApiError).code === "revision_conflict"
                ? "日程已被其他操作更新，本次调整未保存。请取消后刷新，再重新编排。"
                : message,
          )
        }
      } finally {
        if (mounted.current) setSaving(false)
      }
    },
  }
}
export type CalendarQuickEdit = ReturnType<typeof useCalendarQuickEdit>

export function QuickEditShelf({
  edit,
  onAddPreset,
}: {
  edit: CalendarQuickEdit
  onAddPreset: () => void
}) {
  const fallbackCategory = edit.baseData.categories.find((category) => category.active)?.id || ""
  const presets = edit.baseData.taskPresets
    .map((preset) => (preset.categoryId ? preset : { ...preset, categoryId: fallbackCategory }))
    .filter((preset) =>
      edit.baseData.categories.some(
        (category) => category.id === preset.categoryId && category.active,
      ),
    )
  return (
    <div className="quick-edit-shelf" aria-label="快捷编辑常用任务">
      <div className="quick-edit-shelf-heading">
        <strong>常用任务</strong>
        <span>拖到日期即可添加</span>
        <Button
          id="quickAddPresetBtn"
          variant="default"
          disabled={edit.frozen}
          onClick={onAddPreset}
        >
          <Plus aria-hidden />
          添加常用任务
        </Button>
      </div>
      <div className="quick-edit-presets">
        {presets.length ? (
          presets.map((preset) => {
            const item: CalendarDragItem = { kind: "preset", preset }
            return (
              <Button
                key={preset.id}
                variant="outline"
                className="quick-edit-preset"
                data-quick-preset={preset.id}
                style={
                  {
                    "--preset-cat":
                      edit.baseData.categories.find((category) => category.id === preset.categoryId)
                        ?.color || "#9ba59e",
                  } as CSSProperties
                }
                aria-label={`拖动常用任务：${preset.title}`}
                aria-pressed={
                  edit.selected?.kind === "preset" && edit.selected.preset.id === preset.id
                }
                disabled={edit.frozen}
                onPointerDown={(event) => edit.drag.begin(event, item)}
                onClick={() => edit.choose(item)}
              >
                <span className="quick-edit-preset-grip">
                  <GripVertical aria-hidden />
                </span>
                <span>
                  <strong>{preset.title}</strong>
                  <small>
                    {preset.startTime}–{preset.endTime} · +{preset.points}分
                  </small>
                </span>
              </Button>
            )
          })
        ) : (
          <p className="quick-edit-empty">请先在右上角添加常用任务卡片。</p>
        )}
      </div>
      <p id="quickEditHelp" className="sr-only">
        可拖动常用任务卡片或任务手柄，也可点击手柄后点击目标日期。点击任务标题打开编辑弹窗。
        触屏横划浏览常用任务，长按卡片后可向任意方向拖动。 选中日历任务后按 Delete 可删除。按 Escape
        取消选择，不影响正在进行的拖动。所有调整保存后生效。
      </p>
    </div>
  )
}

export function QuickEditTask({
  edit,
  occurrence: o,
}: {
  edit: CalendarQuickEdit
  occurrence: Occurrence
}) {
  const locked = isDone(edit.baseData, o)
  const item: CalendarDragItem = { kind: "occurrence", occurrence: o }
  const selected =
    edit.selected?.kind === "occurrence" &&
    edit.selected.occurrence.occurrenceKey === o.occurrenceKey
  const label = locked
    ? `已完成任务不可调整：${o.title}`
    : `拖动任务：${o.title}，${fmtFull(o.date)} ${o.startTime}`
  const change = edit.draft.added.some((task) => task.occurrenceKey === o.occurrenceKey)
    ? "added"
    : edit.draft.changes[o.occurrenceKey]
      ? "adjusted"
      : null
  const changeLabel = change === "added" ? "新增" : change === "adjusted" ? "已调整" : ""
  return (
    <>
      {change && <span className="quick-task-marker" data-change={change} aria-hidden />}
      <Button
        variant="ghost"
        size="icon"
        className="calendar-task-toggle quick-task-grip"
        data-quick-task={o.occurrenceKey}
        aria-label={label}
        aria-describedby="quickEditHelp"
        aria-pressed={selected}
        title={
          locked
            ? "已完成任务已冻结，请先退出快捷编辑并撤销完成"
            : "拖动调整日期；也可点击后选择日期"
        }
        disabled={locked || edit.frozen}
        onPointerDown={(event) => edit.drag.begin(event, item)}
        onClick={() => edit.choose(item)}
      >
        <GripVertical aria-hidden />
      </Button>
      <Button
        variant="ghost"
        className="calendar-task-edit"
        aria-label={`${locked ? "查看" : "编辑"}任务：${o.title}，${o.startTime}至${o.endTime}${changeLabel ? `，${changeLabel}` : ""}`}
        title={`${o.startTime}–${o.endTime} ${o.title}${changeLabel ? `（${changeLabel}）` : ""}`}
        aria-pressed={selected}
        disabled={edit.frozen}
        onClick={() => edit.openEditor(o)}
      >
        <span>
          {o.startTime} <span className="calendar-task-title">{o.title}</span>
        </span>
      </Button>
    </>
  )
}

export function QuickEditFooter({ edit }: { edit: CalendarQuickEdit }) {
  const { total, added, moved, deleted } = edit.summary
  return (
    <>
      {edit.error && (
        <p className="form-error quick-edit-error" role="alert">
          {edit.error}
        </p>
      )}
      <div className="quick-edit-footer">
        <CalendarTrash
          receiving={edit.drag.hover === "delete" && edit.drag.dragging?.item.kind === "occurrence"}
          disabled={edit.frozen}
          drop={edit.trashDrop}
          deletedTasks={edit.deletedTasks}
          onUndo={edit.undoDelete}
          suppressClick={edit.drag.suppressClick}
        />
        <div className="quick-edit-summary" role="status" aria-label="本次变动">
          {[
            ["新增", added],
            ["修改", moved],
            ["删除", deleted],
          ].map(([label, count]) => (
            <span className="quick-edit-stat" key={label}>
              <span>{label}</span>{" "}
              <span>
                <strong>{count}</strong>
                <span className="quick-edit-stat-unit"> 项</span>
              </span>
            </span>
          ))}
        </div>
        <div className="quick-edit-actions">
          <Button
            id="cancelQuickEditBtn"
            variant="outline"
            disabled={edit.frozen}
            onClick={edit.cancel}
          >
            取消
          </Button>
          <Button
            id="saveQuickEditBtn"
            disabled={edit.saving || !total}
            onClick={() => void edit.save()}
          >
            {edit.saving ? "正在保存…" : "保存"}
          </Button>
        </div>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {edit.announcement}
      </span>
      {edit.drag.dragging && (
        <div
          ref={edit.drag.ghost}
          className="quick-edit-drag-ghost"
          aria-hidden
          style={{
            transform: `translate(${edit.drag.dragging.x + 12}px, ${edit.drag.dragging.y + 12}px)`,
          }}
        >
          <GripVertical />
          {edit.drag.dragging.item.kind === "occurrence" &&
            `${edit.drag.dragging.item.occurrence.startTime} `}
          {dragItemTitle(edit.drag.dragging.item)}
        </div>
      )}
    </>
  )
}

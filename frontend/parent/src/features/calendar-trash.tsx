import "./calendar-trash.css"
import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { createPortal } from "react-dom"
import { GripVertical, X } from "lucide-react"
import { Button } from "./ui"
import { Popover, PopoverContent, PopoverTrigger } from "@shared/components/ui/popover"
import { fmtFull } from "../domain/calendar"
import type { Occurrence } from "../domain/types"
import type { CalendarDragOrigin } from "./calendar-quick-drag"
import trashBody from "../assets/quick-trash/body.png"
import trashLid from "../assets/quick-trash/lid.png"

export type TrashDrop = {
  id: string
  title: string
  startTime: string
  origin?: CalendarDragOrigin
}
type Flight = TrashDrop & { style: CSSProperties }

/** Animation is feedback for an already-staged deletion; it never writes data. */
export function CalendarTrash({
  receiving,
  disabled,
  drop,
  deletedTasks,
  onUndo,
  suppressClick,
}: {
  receiving: boolean
  disabled: boolean
  drop: TrashDrop | null
  deletedTasks: Occurrence[]
  onUndo: (key: string) => void
  suppressClick: () => boolean
}) {
  const stage = useRef<HTMLSpanElement>(null)
  const [phase, setPhase] = useState<"idle" | "dropping" | "closing">("idle")
  const [flight, setFlight] = useState<Flight | null>(null)
  const [listOpen, setListOpen] = useState(false)
  useEffect(() => {
    if (!drop || !stage.current) return
    const rect = stage.current.getBoundingClientRect()
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const source = drop.origin || {
      x: rect.right,
      y: rect.top - 40,
      width: 184,
      height: 36,
    }
    setPhase(reduced ? "closing" : "dropping")
    setFlight(
      reduced
        ? null
        : {
            ...drop,
            style: {
              width: source.width,
              height: source.height,
              "--trash-from-x": `${source.x}px`,
              "--trash-from-y": `${source.y}px`,
              "--trash-mouth-x": `${rect.left + rect.width / 2 - source.width / 2}px`,
              "--trash-mouth-y": `${rect.top + rect.height * (5 / 52) - source.height / 2}px`,
              "--trash-sink-y": `${rect.top + rect.height * (28 / 52) - source.height / 2}px`,
            } as CSSProperties,
          },
    )
    const close = window.setTimeout(
      () => {
        setFlight(null)
        setPhase("closing")
      },
      reduced ? 0 : 440,
    )
    const settle = window.setTimeout(() => setPhase("idle"), reduced ? 120 : 660)
    return () => {
      clearTimeout(close)
      clearTimeout(settle)
    }
  }, [drop])
  const open = phase === "dropping" || (!disabled && receiving)
  const state = phase !== "idle" ? phase : open ? "receiving" : "idle"
  return (
    <>
      <div className="quick-edit-delete quick-trash" data-quick-delete data-trash-state={state}>
        <Popover open={listOpen} onOpenChange={setListOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className="quick-trash-button"
              aria-label={`查看待删除任务，${deletedTasks.length}项`}
              title="查看待删除任务"
              disabled={disabled}
              onClick={(event) => {
                if (suppressClick()) event.preventDefault()
              }}
            >
              {!listOpen && (
                <span className="quick-trash-hint" aria-hidden>
                  {open ? "松手删除" : "任务拖到此处可删除"}
                </span>
              )}
              <span ref={stage} className="quick-trash-stage" data-lid-open={open} aria-hidden>
                <img className="quick-trash-body" src={trashBody} alt="" draggable={false} />
                <img className="quick-trash-lid" src={trashLid} alt="" draggable={false} />
                {!listOpen && deletedTasks.length > 0 && (
                  <span className="quick-trash-count">{deletedTasks.length}</span>
                )}
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            id="quickTrashList"
            className="quick-trash-popover"
            side="top"
            sideOffset={72}
            align="start"
            collisionPadding={12}
            aria-labelledby="quickTrashTitle"
          >
            <div className="quick-trash-header">
              <h2 id="quickTrashTitle">
                待删除 <span className="quick-trash-total">{deletedTasks.length}</span>
              </h2>
              <Button
                variant="ghost"
                size="icon"
                className="quick-trash-close"
                aria-label="关闭待删除列表"
                onClick={() => setListOpen(false)}
              >
                <X aria-hidden />
              </Button>
            </div>
            {deletedTasks.length ? (
              <ul className="quick-trash-list">
                {deletedTasks.map((item) => (
                  <li key={item.occurrenceKey} data-trash-key={item.occurrenceKey}>
                    <div className="quick-trash-item-text">
                      <strong title={item.title}>{item.title}</strong>
                      <time dateTime={`${item.date}T${item.startTime}`}>
                        {Number(item.date.slice(5, 7))}月{Number(item.date.slice(8))}日{" "}
                        {item.startTime}–{item.endTime}
                      </time>
                    </div>
                    <Button
                      variant="ghost"
                      className="quick-trash-undo"
                      disabled={disabled}
                      aria-label={`撤销删除：${item.title}，${fmtFull(item.date)} ${item.startTime}`}
                      onClick={(event) => {
                        const list = event.currentTarget.closest<HTMLElement>(".quick-trash-list")
                        const top = list?.scrollTop || 0
                        const row = event.currentTarget.closest("li")
                        const neighbor = (
                          row?.nextElementSibling || row?.previousElementSibling
                        )?.querySelector<HTMLButtonElement>(".quick-trash-undo:not(:disabled)")
                        onUndo(item.occurrenceKey)
                        requestAnimationFrame(() => {
                          const target = neighbor?.isConnected
                            ? neighbor
                            : document
                                .getElementById("quickTrashList")
                                ?.querySelector<HTMLButtonElement>(".quick-trash-close")
                          target?.focus({ preventScroll: true })
                          if (list?.isConnected) list.scrollTop = top
                        })
                      }}
                    >
                      撤销
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="quick-trash-empty">暂无待删除任务</p>
            )}
          </PopoverContent>
        </Popover>
      </div>
      {flight &&
        createPortal(
          <div key={flight.id} className="quick-trash-flight" aria-hidden style={flight.style}>
            <GripVertical />{" "}
            <span>
              {flight.startTime} {flight.title}
            </span>
          </div>,
          document.body,
        )}
    </>
  )
}

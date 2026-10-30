import { useEffect, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
import type { Occurrence, Preset } from "../domain/types"

export type CalendarDragItem =
  { kind: "preset"; preset: Preset } | { kind: "occurrence"; occurrence: Occurrence }
export type CalendarDragOrigin = { x: number; y: number; width: number; height: number }
export const dragItemTitle = (item: CalendarDragItem) =>
  item.kind === "preset" ? item.preset.title : item.occurrence.title
export const dragItemKey = (item: CalendarDragItem) =>
  item.kind === "preset" ? `preset:${item.preset.id}` : item.occurrence.occurrenceKey

function dropTarget(x: number, y: number) {
  const element = document.elementFromPoint(x, y)
  if (element?.closest("[data-quick-delete]")) return "delete"
  return element?.closest<HTMLElement>("[data-cell-day]")?.dataset.cellDay || null
}

/** Presets drag from the whole card; calendar tasks use grips to preserve native scrolling. */
export function useCalendarQuickDrag(
  enabled: boolean,
  onDrop: (item: CalendarDragItem, target: string, origin?: CalendarDragOrigin) => void,
) {
  const [dragging, setDragging] = useState<{
    item: CalendarDragItem
    x: number
    y: number
  } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const drop = useRef(onDrop)
  drop.current = onDrop
  const suppressClickUntil = useRef(0)
  const session = useRef<{
    item: CalendarDragItem
    pointer: number
    element: HTMLElement
    startX: number
    startY: number
    x: number
    y: number
    active: boolean
    shelf: HTMLElement | null
    shelfLeft: number
    startedAt: number
    panning: boolean
  } | null>(null)
  const stop = useRef(() => {})
  useEffect(() => {
    if (!enabled) return
    let frame = 0
    const clear = () => {
      const current = session.current
      session.current = null
      if (current?.active || current?.panning) suppressClickUntil.current = performance.now() + 250
      if (current?.element.hasPointerCapture(current.pointer))
        current.element.releasePointerCapture(current.pointer)
      cancelAnimationFrame(frame)
      frame = 0
      setDragging(null)
      setHover(null)
    }
    stop.current = clear
    const tick = () => {
      const current = session.current
      if (!current?.active) return
      const { x, y } = current
      const target = dropTarget(x, y)
      setHover((previous) => (previous === target ? previous : target))
      if (ghost.current) {
        const bin =
          target === "delete" && current.item.kind === "occurrence"
            ? document.querySelector(".quick-trash-stage")?.getBoundingClientRect()
            : null
        ghost.current.style.transform = bin
          ? `translate(${bin.right + 8}px, ${bin.top - 12}px)`
          : `translate(${x + 12}px, ${y + 12}px)`
      }
      frame = requestAnimationFrame(tick)
    }
    const move = (event: PointerEvent) => {
      const current = session.current
      if (!current || current.pointer !== event.pointerId) return
      current.x = event.clientX
      current.y = event.clientY
      const dx = current.x - current.startX,
        dy = current.y - current.startY,
        distance = Math.hypot(dx, dy)
      // Quick horizontal swipes browse the shelf; a held card can drag in any direction.
      // Handle this pan ourselves because native pan-x can cancel even a long-press drag.
      if (
        !current.active &&
        current.shelf &&
        (current.panning ||
          (distance >= 5 &&
            performance.now() - current.startedAt < 200 &&
            Math.abs(dx) >= Math.abs(dy)))
      ) {
        current.panning = true
        current.shelf.scrollLeft = current.shelfLeft - dx
        event.preventDefault()
        return
      }
      if (!current.active && distance >= 5) {
        current.active = true
        setDragging({ item: current.item, x: current.x, y: current.y })
        frame = requestAnimationFrame(tick)
      }
      if (current.active) event.preventDefault()
    }
    const up = (event: PointerEvent) => {
      const current = session.current
      if (!current || current.pointer !== event.pointerId) return
      const target = dropTarget(event.clientX, event.clientY)
      const rect = ghost.current?.getBoundingClientRect()
      const origin = rect
        ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        : undefined
      clear()
      if (current.active && target) drop.current(current.item, target, origin)
    }
    const cancel = (event: PointerEvent) => {
      if (session.current?.pointer === event.pointerId) clear()
    }
    window.addEventListener("pointermove", move, { passive: false })
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", cancel)
    window.addEventListener("blur", clear)
    return () => {
      clear()
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", cancel)
      window.removeEventListener("blur", clear)
    }
  }, [enabled])
  return {
    dragging,
    hover,
    ghost,
    cancelDrag: () => stop.current(),
    suppressClick: () => performance.now() < suppressClickUntil.current,
    begin: (event: ReactPointerEvent<HTMLElement>, item: CalendarDragItem) => {
      if (!enabled || !event.isPrimary || event.button !== 0) return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      event.currentTarget.setPointerCapture(event.pointerId)
      const shelf =
        event.pointerType === "touch" &&
        item.kind === "preset" &&
        !(event.target as Element).closest(".quick-edit-preset-grip")
          ? event.currentTarget.closest<HTMLElement>(".quick-edit-presets")
          : null
      session.current = {
        item,
        pointer: event.pointerId,
        element: event.currentTarget,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        shelf,
        shelfLeft: shelf?.scrollLeft || 0,
        startedAt: performance.now(),
        panning: false,
      }
    },
  }
}

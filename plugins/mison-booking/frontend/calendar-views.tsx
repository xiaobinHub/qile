import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { addDays, shiftMonth, startWeek } from "./calendar-date"
import "./calendar-views.css"

export type CalendarPosition = { date: string; offset?: number }
export const monthWindow = (date: string) => ({
  start: shiftMonth(date, -2),
  end: shiftMonth(date, 3),
})
export const monthWindowDates = (range: { start: string; end: string }) => ({
  from: startWeek(range.start + "-01"),
  to: addDays(startWeek(addDays(shiftMonth(range.end, 1) + "-01", -1)), 6),
})

/** Plugin-owned continuous month viewport, independent of task/booking data. */
export function ContinuousMonthCalendar({
  id,
  target,
  navigation,
  onMonth,
  savedPosition,
  onPosition,
  onRangeChange,
  children,
  active = true,
}: {
  id?: string
  target: string
  navigation: number
  onMonth(month: string, date: string): void
  savedPosition?: CalendarPosition
  onPosition?(position: { date: string; offset: number }): void
  onRangeChange?(from: string, to: string): void
  children(from: string, to: string): ReactNode
  active?: boolean
}) {
  const [windowRange, setWindowRange] = useState(() => monthWindow(target))
  const scroll = useRef<HTMLDivElement>(null)
  const position = useRef<CalendarPosition | null>(savedPosition || { date: target })
  const anchor = useRef<CalendarPosition>(savedPosition || { date: target, offset: 56 })
  const dimensions = useRef({ width: 0, height: 0 })
  const prepend = useRef<{ top: number; height: number } | null>(null)
  const frame = useRef(0)
  const [touch, setTouch] = useState(() => window.matchMedia("(pointer: coarse)").matches)
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)")
    const sync = () => setTouch(query.matches)
    query.addEventListener("change", sync)
    return () => query.removeEventListener("change", sync)
  }, [])
  const { from, to } = monthWindowDates(windowRange)
  useEffect(() => {
    onRangeChange?.(from, to)
  }, [from, to, onRangeChange])
  useLayoutEffect(() => {
    position.current = savedPosition?.date === target ? savedPosition : { date: target }
    anchor.current = { ...position.current, offset: position.current.offset ?? 56 }
    setWindowRange(monthWindow(target))
  }, [target, navigation])
  useLayoutEffect(() => {
    const el = scroll.current
    if (!el || !active) return
    if (position.current) {
      const cell = el.querySelector<HTMLElement>(`[data-cell-day="${position.current.date}"]`)
      if (cell) {
        const top = cell.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
        el.scrollTop = Math.max(0, top - (position.current.offset ?? 56))
        position.current = null
      }
    } else if (prepend.current) {
      el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height
      prepend.current = null
    }
  }, [windowRange, target, active])
  useLayoutEffect(() => {
    const el = scroll.current
    const grid = el?.querySelector<HTMLElement>(".mison-calendar-month-grid")
    if (!el || !grid || !active) return
    const observer = new ResizeObserver(() => {
      // Preserve a date, rather than a pixel offset, when cards wrap or data arrives.
      if (!position.current && !prepend.current) {
        const cell = el.querySelector<HTMLElement>(`[data-cell-day="${anchor.current.date}"]`)
        if (cell)
          el.scrollTop = Math.max(
            0,
            cell.getBoundingClientRect().top -
              el.getBoundingClientRect().top +
              el.scrollTop -
              (anchor.current.offset ?? 56),
          )
      }
      dimensions.current = { width: el.clientWidth, height: grid.offsetHeight }
    })
    observer.observe(el)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [active])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  function onScroll() {
    if (frame.current || !active) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const el = scroll.current
      if (!el || position.current || !el.clientHeight) return
      const grid = el.querySelector<HTMLElement>(".mison-calendar-month-grid")
      if (
        dimensions.current.width !== el.clientWidth ||
        dimensions.current.height !== grid?.offsetHeight
      )
        return
      const line = el.getBoundingClientRect().top + Math.min(el.clientHeight * 0.22, 130)
      const row = Array.from(el.querySelectorAll<HTMLElement>("[data-cell-day]")).filter((cell) => {
        const rect = cell.getBoundingClientRect()
        return rect.top <= line && rect.bottom > line
      })
      const cell = row.find((c) => c.dataset.cellDay?.endsWith("-01")) || row[0]
      if (cell) {
        const date = cell.dataset.cellDay!
        anchor.current = {
          date,
          offset: cell.getBoundingClientRect().top - el.getBoundingClientRect().top,
        }
        onMonth(date.slice(0, 7), date)
        onPosition?.({
          date,
          offset: cell.getBoundingClientRect().top - el.getBoundingClientRect().top,
        })
      }
      if (el.scrollTop < 360) {
        prepend.current = { top: el.scrollTop, height: el.scrollHeight }
        setWindowRange((range) => ({ ...range, start: shiftMonth(range.start, -1) }))
      } else if (el.scrollHeight - el.scrollTop - el.clientHeight < 360) {
        setWindowRange((range) => ({ ...range, end: shiftMonth(range.end, 1) }))
      }
    })
  }
  return (
    <div
      className={`mison-calendar-view mison-calendar-month-scroll ${touch ? "mison-calendar-touch-month" : "mison-calendar-pointer-month"}`}
      id={id}
      ref={scroll}
      onScroll={onScroll}
      tabIndex={0}
      aria-label="连续月历，滚动查看前后月份"
    >
      <div className="mison-calendar-weekday-row">
        {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((day) => (
          <div key={day}>{day}</div>
        ))}
      </div>
      <div className="mison-calendar-month-grid">{children(from, to)}</div>
    </div>
  )
}

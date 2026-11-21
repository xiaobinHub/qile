import type { AutoBookingConfig } from "./types"

export type CheckWindow = { start: number; end: number }
type QuietHours = AutoBookingConfig["sleep"]
export const DAY_MINUTES = 24 * 60

export function axisTime(position: number): string {
  const minutes = (Math.round(position) + DAY_MINUTES / 2) % DAY_MINUTES
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

function timeAxis(time: string, boundary: "start" | "end"): number {
  const [hour, minute] = time.split(":").map(Number)
  const position = (hour * 60 + minute + DAY_MINUTES / 2) % DAY_MINUTES
  return position === 0 && boundary === "end" ? DAY_MINUTES : position
}

export function checkWindow(quiet: QuietHours): CheckWindow {
  return quiet.enabled
    ? { start: timeAxis(quiet.end, "start"), end: timeAxis(quiet.start, "end") }
    : { start: 0, end: DAY_MINUTES }
}

export function isFullDay(window: CheckWindow): boolean {
  return window.start === 0 && window.end === DAY_MINUTES
}

export function checkWindowLabel(quiet: QuietHours): string {
  if (!quiet.enabled) return "全天执行"
  return `${quiet.end}～${quiet.end > quiet.start ? "次日 " : ""}${quiet.start}`
}

export function quietHours(quiet: QuietHours, window: CheckWindow): QuietHours {
  if (isFullDay(window)) return { ...quiet, enabled: false }
  const start = axisTime(window.end)
  const end = axisTime(window.start)
  // Equal clock times would be an empty range, except for the full noon-to-noon span.
  return start === end ? quiet : { enabled: true, start, end }
}

export function moveCheckBoundary(
  window: CheckWindow,
  boundary: "start" | "end",
  position: number,
): CheckWindow {
  let next = Math.max(0, Math.min(DAY_MINUTES, Math.round(position)))
  // Noon has two aliases on this circular axis; neither should lose a minute.
  if (boundary === "start" && next === DAY_MINUTES) next = 0
  if (boundary === "end" && next === 0) next = DAY_MINUTES
  const other = window[boundary === "start" ? "end" : "start"]
  if (next === other) {
    next = Math.max(0, Math.min(DAY_MINUTES, next + Math.sign(next - window[boundary])))
  }
  return { ...window, [boundary]: next }
}

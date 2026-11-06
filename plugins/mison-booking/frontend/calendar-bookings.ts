import { request } from "./api"
import type { Booking, BookingQuery, PluginContext } from "./types"

export type CalendarStatus = "upcoming" | "completed"
export async function readCalendarBookings(
  context: PluginContext,
  status: CalendarStatus,
  from: string,
  to: string,
  current: () => boolean,
) {
  const items = new Map<string, Booking>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    if (!current()) return []
    const query = new URLSearchParams({ status, from, to, pageSize: "50" })
    if (cursor) query.set("cursor", cursor)
    const response: BookingQuery = await request(context, `bookings?${query}`)
    if (!current()) return []
    if (response.state === "ready") {
      for (const item of response.items) {
        const date = item.startsAt?.slice(0, 10)
        if (item.status === status && date && date >= from && date <= to) items.set(item.key, item)
      }
    }
    cursor = response.nextCursor
    if (response.state === "building" && !cursor) throw Error("课程记录仍在同步，请重试。")
    if (cursor && cursors.has(cursor)) throw Error("课程分页未推进，请重试。")
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return [...items.values()].sort(
    (a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? "") || a.key.localeCompare(b.key),
  )
}

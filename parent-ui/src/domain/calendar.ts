import type { BusinessData, Occurrence, Rule, Series, Revision } from "./types"
export const pad = (n: number) => String(n).padStart(2, "0")
export function parseDate(s: string) {
  const [y, m, d] = s.split("-").map(Number)
  return new Date(y, m - 1, d, 12)
}
export function dateStr(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export function addDays(s: string, n: number) {
  const d = parseDate(s)
  d.setDate(d.getDate() + n)
  return dateStr(d)
}
export function startWeek(s: string) {
  const d = parseDate(s)
  return addDays(s, -((d.getDay() + 6) % 7))
}
export const today = () => dateStr(new Date())
export const monthStart = (s: string) => s.slice(0, 7) + "-01"
export function shiftMonth(s: string, n: number) {
  const d = parseDate(monthStart(s))
  d.setMonth(d.getMonth() + n)
  return dateStr(d).slice(0, 7)
}
export function daysInMonth(y: number, m: number) {
  return new Date(y, m, 0, 12).getDate()
}
export function rangeDates(a: string, b: string) {
  const out: string[] = []
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d)
  return out
}
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
export const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))
export const timeAt = (n: number) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`
export const fmtDate = (s: string) => `${parseDate(s).getMonth() + 1}月${parseDate(s).getDate()}日`
export const fmtFull = (s: string) =>
  `${s.slice(0, 4)}年${fmtDate(s)} 周${"日一二三四五六"[parseDate(s).getDay()]}`
export function seriesRevisions(s: Series): Revision[] {
  return s.revisions?.length
    ? s.revisions.slice().sort((a, b) => cmp(a.effectiveFrom, b.effectiveFrom))
    : [{ ...s, id: `${s.id}:v1`, effectiveFrom: s.startDate }]
}
export function revisionForDate(s: Series, date: string) {
  const revisions = seriesRevisions(s)
  return (
    revisions
      .slice()
      .reverse()
      .find((r) => r.effectiveFrom <= date) || revisions[0]
  )
}
export function makeOcc(s: Series, date: string, originalDate = date): Occurrence {
  return {
    seriesId: s.id,
    occurrenceKey: `${s.id}@${originalDate}`,
    date,
    originalDate,
    title: s.title,
    note: s.note || "",
    startTime: s.startTime,
    endTime: s.endTime,
    categoryId: s.categoryId,
    points: Number(s.points) || 0,
    recurring: !!s.recurrence,
  }
}
function endAllows(r: Rule, d: string, index: number) {
  return !((r.endType === "until" && d > r.until!) || (r.endType === "count" && index >= r.count!))
}
export function expandRevision(task: Series, from: string, to: string): Occurrence[] {
  if (!task.recurrence)
    return task.startDate >= from && task.startDate <= to ? [makeOcc(task, task.startDate)] : []
  const r = task.recurrence,
    out: Occurrence[] = [],
    limit = r.endType === "until" && r.until! < to ? r.until! : to,
    maxCount = r.endType === "count" ? Number(r.count) : 5000
  let generated = 0
  if (r.freq === "daily") {
    for (
      let d = task.startDate;
      d <= limit && generated < maxCount;
      d = addDays(d, Number(r.interval))
    ) {
      if (endAllows(r, d, generated) && d >= from) out.push(makeOcc(task, d))
      generated++
    }
  }
  if (r.freq === "weekly") {
    const anchor = startWeek(task.startDate),
      days = (r.weekdays || []).map(Number).sort((a, b) => a - b)
    for (let w = 0; generated < maxCount; w += Number(r.interval)) {
      const ws = addDays(anchor, w * 7)
      if (ws > limit) break
      for (const wd of days) {
        const d = addDays(ws, wd)
        if (d < task.startDate || d > limit) continue
        if (!endAllows(r, d, generated)) break
        if (d >= from) out.push(makeOcc(task, d))
        generated++
        if (generated >= maxCount) break
      }
    }
  }
  if (r.freq === "monthly") {
    const a = parseDate(task.startDate),
      anchor = r.monthDay || a.getDate()
    for (let i = 0; generated < maxCount; i += Number(r.interval)) {
      const raw = a.getMonth() + i,
        y = a.getFullYear() + Math.floor(raw / 12),
        m = (raw % 12) + 1,
        d = `${y}-${pad(m)}-${pad(Math.min(anchor, daysInMonth(y, m)))}`
      if (d > limit || !endAllows(r, d, generated)) break
      if (d >= task.startDate && d >= from) out.push(makeOcc(task, d))
      generated++
    }
  }
  return out
}
export function baseOccurrences(s: Series, from: string, to: string) {
  if (!s.recurrence) return expandRevision(s, from, to)
  const revisions = seriesRevisions(s),
    out: Occurrence[] = []
  for (let i = 0; i < revisions.length; i++) {
    const rev = revisions[i],
      next = revisions[i + 1],
      end = next ? addDays(next.effectiveFrom, -1) : to
    if (end < from || rev.effectiveFrom > to) continue
    out.push(
      ...expandRevision(
        { ...s, ...rev, id: s.id, startDate: rev.effectiveFrom },
        from,
        end < to ? end : to,
      ),
    )
  }
  return [...new Map(out.map((o) => [o.occurrenceKey, o])).values()]
}
export function occurrences(data: BusinessData, from: string, to: string) {
  const byKey = new Map(
    data.series.flatMap((s) => baseOccurrences(s, from, to)).map((o) => [o.occurrenceKey, o]),
  )
  for (const ex of data.exceptions) {
    const key = `${ex.seriesId}@${ex.originalDate}`
    byKey.delete(key)
    if (ex.action === "override" && ex.data && ex.data.date >= from && ex.data.date <= to)
      byKey.set(key, {
        ...ex.data,
        seriesId: ex.seriesId,
        originalDate: ex.originalDate,
        occurrenceKey: key,
        recurring: true,
      })
  }
  for (const c of data.completions.filter((c) => c.completed)) {
    if (c.snapshot.date >= from && c.snapshot.date <= to)
      byKey.set(c.occurrenceKey, { ...c.snapshot, occurrenceKey: c.occurrenceKey })
  }
  return [...byKey.values()].sort(
    (a, b) => cmp(a.date, b.date) || cmp(a.startTime, b.startTime) || cmp(a.title, b.title),
  )
}
export const isDone = (data: BusinessData, o: Occurrence) =>
  !!data.completions.find((c) => c.occurrenceKey === o.occurrenceKey)?.completed
export const balance = (data: BusinessData) => data.ledger.reduce((n, x) => n + Number(x.amount), 0)
export function layoutWeekEvents(events: Occurrence[]) {
  const sorted = events
      .map((event, index) => ({
        event,
        index,
        start: minutes(event.startTime),
        end: minutes(event.endTime),
      }))
      .sort(
        (a, b) =>
          a.start - b.start ||
          b.end - a.end ||
          a.event.occurrenceKey.localeCompare(b.event.occurrenceKey),
      ),
    result: {
      event: Occurrence
      index: number
      start: number
      end: number
      depth: number
      stacked: boolean
    }[] = []
  let group: typeof sorted = [],
    groupEnd = -1
  const place = () => {
    const active: { end: number; depth: number }[] = [],
      placed: typeof result = []
    for (const x of group) {
      for (let i = active.length - 1; i >= 0; i--) if (active[i].end <= x.start) active.splice(i, 1)
      let depth = 0
      while (active.some((a) => a.depth === depth)) depth++
      active.push({ ...x, depth })
      placed.push({ ...x, depth, stacked: group.length > 1 })
    }
    result.push(...placed)
    group = []
    groupEnd = -1
  }
  for (const x of sorted) {
    if (group.length && x.start >= groupEnd) place()
    group.push(x)
    groupEnd = Math.max(groupEnd, x.end)
  }
  place()
  return result.sort((a, b) => a.index - b.index)
}

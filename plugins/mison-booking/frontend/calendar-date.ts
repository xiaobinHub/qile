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
export const monthStart = (s: string) => s.slice(0, 7) + "-01"
export function shiftMonth(s: string, n: number) {
  const d = parseDate(monthStart(s))
  d.setMonth(d.getMonth() + n)
  return dateStr(d).slice(0, 7)
}
export function rangeDates(a: string, b: string) {
  const out: string[] = []
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d)
  return out
}
export const fmtDate = (s: string) => `${parseDate(s).getMonth() + 1}月${parseDate(s).getDate()}日`
export const fmtFull = (s: string) =>
  `${s.slice(0, 4)}年${fmtDate(s)} 周${"日一二三四五六"[parseDate(s).getDay()]}`

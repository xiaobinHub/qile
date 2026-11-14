import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Badge } from "@shared/components/ui/badge"
import { Popover, PopoverTrigger } from "@shared/components/ui/popover"
import { Skeleton } from "@shared/components/ui/skeleton"
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react"
import { getAutoBookingSchedules } from "./api"
import { addDays, parseDate, rangeDates } from "./calendar-date"
import { Button, DatePicker, Notice, PopoverContent, dateLabel, teacherName } from "./ui"
import type { AutoBookingScheduleDay, AutoBookingTeacher, PluginContext } from "./types"

type SchedulePage = {
  days: AutoBookingScheduleDay[]
  cursor: string | null
  complete: boolean
  seen: Set<string>
  updatedAt: string | null
  refreshToken: string
}
const slotLabels = {
  available: "可约",
  mine: "本人已约",
  occupied: "被占",
  unscheduled: "未排班",
}

export function autoBookingTime(at: string | null, timeOnly = false) {
  if (!at) return "—"
  const date = new Date(at)
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        ...(timeOnly ? {} : { month: "numeric", day: "numeric" }),
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
}

export function AutoBookingSchedule({
  context,
  teacher,
  serverDate,
  revision,
  active,
  refreshToken,
  teacherNavigation,
  onAvailability,
}: {
  context: PluginContext
  teacher: AutoBookingTeacher
  serverDate: string
  revision: number
  active: boolean
  refreshToken: string
  teacherNavigation: ReactNode
  onAvailability: (id: string, count: number | null) => void
}) {
  const [from, setFrom] = useState(serverDate)
  const to = addDays(from, 13)
  const key = `${teacher.id}:${from}:${to}:${revision}`
  const cache = useRef(new Map<string, SchedulePage>())
  const [snapshot, setSnapshot] = useState<{ key: string; page: SchedulePage | null }>({
    key,
    page: null,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  const [manualRefresh, setManualRefresh] = useState(0)
  const [filter, setFilter] = useState("all")
  const scroll = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, number>())
  const token = `${refreshToken}:${manualRefresh}`
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = positions.current.get(key) ?? 0
  }, [key])
  useEffect(() => {
    let cancelled = false
    if (!active || context.signal.aborted) {
      setLoading(false)
      return
    }
    const current = () => !cancelled && !context.signal.aborted
    let page = cache.current.get(key)
    if (!page || page.refreshToken !== token) {
      page = {
        days: page?.days ?? [],
        cursor: null,
        complete: false,
        seen: new Set(),
        updatedAt: page?.updatedAt ?? null,
        refreshToken: token,
      }
      cache.current.set(key, page)
    }
    setSnapshot({ key, page })
    setError("")
    if (page.complete) {
      setLoading(false)
      return
    }
    setLoading(true)
    const initial = page
    async function load() {
      let progress = initial
      try {
        do {
          const result = await getAutoBookingSchedules(
            context,
            teacher.id,
            from,
            to,
            progress.cursor,
          )
          if (!current()) return
          if (result.teacherId !== teacher.id) throw new Error("排班老师不匹配，请刷新重试。")
          const days = new Map(progress.days.map((day) => [day.date, day]))
          result.days.forEach((day) => {
            if (day.date >= from && day.date <= to) days.set(day.date, day)
          })
          const repeated = !!result.nextCursor && progress.seen.has(result.nextCursor)
          const seen = new Set(progress.seen)
          if (result.nextCursor) seen.add(result.nextCursor)
          progress = {
            ...progress,
            days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
            cursor: repeated ? progress.cursor : result.nextCursor,
            complete: !result.nextCursor,
            seen,
            updatedAt: result.updatedAt,
          }
          cache.current.set(key, progress)
          setSnapshot({ key, page: progress })
          if (repeated) throw new Error("排班分页重复，请使用刷新重新读取。")
        } while (!progress.complete && current())
      } catch (reason) {
        if (current()) setError((reason as Error).message)
      } finally {
        if (current()) setLoading(false)
      }
    }
    void load()
    if (cache.current.size > 24) {
      const oldest = cache.current.keys().next().value
      if (oldest && oldest !== key) {
        cache.current.delete(oldest)
        positions.current.delete(oldest)
      }
    }
    return () => {
      cancelled = true
    }
  }, [context, key, teacher.id, from, to, token, active, retry])
  const page = snapshot.key === key ? snapshot.page : null
  const days = new Map(page?.days.map((day) => [day.date, day]))
  useEffect(() => {
    onAvailability(
      teacher.id,
      page?.complete
        ? page.days.reduce(
            (count, day) => count + day.slots.filter((slot) => slot.state === "available").length,
            0,
          )
        : null,
    )
  }, [teacher.id, page, onAvailability])
  return (
    <section
      className="mison-auto-schedule"
      aria-label={`${teacher.name}的排班`}
      aria-busy={loading}
    >
      <div className="mison-auto-schedule-toolbar">
        <h2>目标老师排班</h2>
        <div className="mison-auto-schedule-actions">
          <small>{autoBookingTime(page?.updatedAt ?? null, true)} 更新</small>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label="选择排班日期范围"
                title={`${from} 至 ${to}`}
              >
                <CalendarDays />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="mison-auto-range-popover" aria-label="排班日期范围">
              <div className="mison-auto-range">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="前14天"
                  onClick={() => setFrom(addDays(from, -14))}
                >
                  <ChevronLeft />
                </Button>
                <DatePicker
                  aria-label="排班起始日期"
                  value={from}
                  onChange={(date) => {
                    if (date) setFrom(date)
                  }}
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="后14天"
                  onClick={() => setFrom(addDays(from, 14))}
                >
                  <ChevronRight />
                </Button>
              </div>
              <div className="mison-auto-range-caption">
                <small>至 {dateLabel(to)} · 北京时间</small>
                <Button variant="ghost" onClick={() => setFrom(serverDate)}>
                  今天
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <select
            className="mison-auto-filter"
            aria-label="排班时段筛选"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">全部时段</option>
            <option value="available">仅看可约</option>
            <option value="matches">符合预约条件</option>
          </select>
          <Button
            variant="outline"
            aria-label="刷新排班"
            disabled={loading}
            onClick={() => setManualRefresh((value) => value + 1)}
          >
            <RefreshCw data-icon="inline-start" />
            刷新排班
          </Button>
        </div>
      </div>
      <div className="mison-auto-teacher-navigation">
        {teacherNavigation}
        <div className="mison-auto-legend" aria-label="排班状态图例">
          <span data-state="available">可约</span>
          <span data-state="occupied">被占</span>
          <span data-state="mine">本人已约</span>
        </div>
      </div>
      {error ? (
        <Notice error>
          {error} 已读取的日期仍保留。
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => setRetry((value) => value + 1)}
          >
            继续加载
          </Button>
        </Notice>
      ) : null}
      <div
        className="mison-auto-schedule-scroll"
        ref={scroll}
        onScroll={(event) => positions.current.set(key, event.currentTarget.scrollTop)}
        tabIndex={0}
        aria-label="按日期查看排班"
      >
        {rangeDates(from, to).map((date) => {
          const day = days.get(date)
          return (
            <section key={date} className="mison-auto-day" aria-label={dateLabel(date)}>
              <div className="mison-auto-day-heading">
                <h3>
                  <time dateTime={date}>
                    {new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(
                      parseDate(date),
                    )}
                  </time>
                  <span>
                    {
                      ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
                        parseDate(date).getDay()
                      ]
                    }
                  </span>
                </h3>
                <Badge
                  variant="secondary"
                  className="mison-auto-target"
                  data-target={!!day?.target}
                >
                  {day?.target ? "目标日" : "非目标日"}
                </Badge>
                {day?.booked ? <Badge variant="secondary">当天已有课程</Badge> : null}
              </div>
              {!day ? (
                page?.complete ? (
                  <p className="mison-caption">暂未返回该日排班，请刷新重试。</p>
                ) : (
                  <div className="mison-auto-day-loading">
                    <Skeleton className="h-8 w-28" />
                    <span className="mison-caption">等待加载排班…</span>
                  </div>
                )
              ) : day.state === "unopened" ? (
                <p className="mison-caption">{day.message || "尚未开放排班"}</p>
              ) : day.state === "error" ? (
                <Notice error>
                  {day.message || "该日排班读取失败"}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => setManualRefresh((value) => value + 1)}
                  >
                    重试排班
                  </Button>
                </Notice>
              ) : day.slots.length ? (
                <div className="mison-auto-slots">
                  {day.slots
                    .filter(
                      (slot) =>
                        filter === "all" ||
                        (filter === "available" ? slot.state === "available" : slot.matches),
                    )
                    .map((slot) => (
                      <Popover key={`${slot.start}:${slot.end}`}>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="mison-auto-slot"
                            data-state={slot.state}
                            data-matches={slot.matches}
                            aria-label={`${dateLabel(date)} ${slot.start} ${slotLabels[slot.state]}`}
                          >
                            <time>{slot.start}</time>
                            <span>{slotLabels[slot.state]}</span>
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-64" aria-label={`${slot.start}时段详情`}>
                          <p>
                            {teacherName(teacher.name)} · {dateLabel(date)}
                          </p>
                          <p>
                            {slot.start}–{slot.end} · {slotLabels[slot.state]}
                          </p>
                          <p className="mison-caption">
                            {slot.reason || "符合已保存的自动约课条件。"}
                          </p>
                        </PopoverContent>
                      </Popover>
                    ))}
                  {!day.slots.some(
                    (slot) =>
                      filter === "all" ||
                      (filter === "available" ? slot.state === "available" : slot.matches),
                  ) ? (
                    <p className="mison-caption">暂无符合筛选的时段</p>
                  ) : null}
                </div>
              ) : (
                <p className="mison-caption">未排班</p>
              )}
            </section>
          )
        })}
      </div>
      <div className="mison-auto-schedule-progress" role="status">
        {loading
          ? `正在逐页加载，已读取 ${days.size}/14 天…`
          : error
            ? `已读取 ${days.size}/14 天，部分排班尚未加载。`
            : page?.complete
              ? `已读取 ${days.size}/14 天`
              : "等待加载排班"}
        {page?.updatedAt ? (
          <span> · 更新于 {autoBookingTime(page.updatedAt)}（北京时间）</span>
        ) : null}
      </div>
    </section>
  )
}

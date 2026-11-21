import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { Popover, PopoverTrigger } from "@shared/components/ui/popover"
import { Skeleton } from "@shared/components/ui/skeleton"
import { Switch } from "@shared/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@shared/components/ui/tabs"
import { RefreshCw } from "lucide-react"
import { getAutoBookingSnapshot } from "./api"
import { parseDate } from "./calendar-date"
import unavailableIllustration from "./schedule-unavailable.svg?inline"
import { Avatar, Button, Empty, Notice, PopoverContent, dateLabel, teacherName } from "./ui"
import type {
  AutoBookingSnapshot,
  AutoBookingStatus,
  AutoBookingTeacher,
  PluginContext,
} from "./types"

const slotLabels = { available: "可约", mine: "本人已约", occupied: "被占", unscheduled: "未排班" }

type ScheduleEntry = { snapshotId: string } & (
  | { snapshot: AutoBookingSnapshot; count: number; error?: never }
  | { snapshot?: never; count?: never; error: string }
)
type ScheduleCache = {
  context: PluginContext
  configRevision: number
  entries: Record<string, ScheduleEntry>
}

function visibleListHeight(list: HTMLElement, dashboard: HTMLElement) {
  const viewportBottom =
    dashboard.getBoundingClientRect().top + dashboard.clientTop + dashboard.clientHeight
  return Math.max(0, Math.ceil(viewportBottom - list.getBoundingClientRect().top))
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
        second: "2-digit",
        hour12: false,
      }).format(date)
}

export function AutoBookingSchedule({
  context,
  teachers,
  snapshot,
  active,
  focusDate,
  targetDates,
  priorityTimes,
}: {
  context: PluginContext
  teachers: AutoBookingTeacher[]
  snapshot: AutoBookingStatus["snapshot"]
  active: boolean
  focusDate?: { date: string; sequence: number } | null
  targetDates: string[]
  priorityTimes(date: string): string[]
}) {
  const [targetsOnly, setTargetsOnly] = useState(targetDates.length > 0)
  const [teacherId, setTeacherId] = useState(teachers[0].id)
  const [cache, setCache] = useState<ScheduleCache | null>(null)
  const panelId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const consumedFocus = useRef(0)
  const teacher = teachers.find((item) => item.id === teacherId) ?? teachers[0]
  const snapshotId = snapshot?.id
  const configRevision = snapshot?.configRevision
  const entries =
    cache?.context === context && cache.configRevision === configRevision
      ? cache.entries
      : undefined
  const entry = entries?.[teacher.id]
  const current = entry?.snapshotId === snapshotId ? entry?.snapshot : undefined
  const error = entry?.snapshotId === snapshotId ? entry?.error : undefined
  const loading = !!snapshotId && !current && !error
  const displayed = current ?? (loading ? entry?.snapshot : undefined)
  const bookingUnavailable = displayed?.teacher.bookingUnavailable === true
  const days = (bookingUnavailable ? [] : (displayed?.teacher.days ?? [])).filter(
    (day) => !targetsOnly || targetDates.includes(day.date),
  )

  const reserveVisibleList = useCallback(() => {
    const list = listRef.current
    const dashboard = list?.closest<HTMLElement>(".mison-auto-dashboard")
    if (!list || !dashboard) return
    const height = `${visibleListHeight(list, dashboard)}px`
    if (list.style.minHeight === height) return
    list.style.minHeight = height
    void dashboard.scrollHeight
  }, [])
  useEffect(() => {
    const list = listRef.current
    const dashboard = list?.closest<HTMLElement>(".mison-auto-dashboard")
    if (!active || !list || !dashboard) return
    const releaseSpace = () => {
      const reserved = Number.parseFloat(list.style.minHeight)
      if (reserved > 0) {
        const height = visibleListHeight(list, dashboard)
        if (height < reserved) list.style.minHeight = height ? `${height}px` : ""
      }
    }
    dashboard.addEventListener("scroll", releaseSpace, { passive: true })
    return () => dashboard.removeEventListener("scroll", releaseSpace)
  }, [active])

  useEffect(() => {
    if (
      !active ||
      !loading ||
      !snapshotId ||
      configRevision === undefined ||
      context.signal.aborted
    )
      return
    let cancelled = false
    const accept = (result: ScheduleEntry) => {
      if (cancelled || context.signal.aborted) return
      reserveVisibleList()
      setCache((previous) => ({
        context,
        configRevision,
        entries: {
          ...(previous?.context === context && previous.configRevision === configRevision
            ? previous.entries
            : {}),
          [teacher.id]: result,
        },
      }))
    }
    getAutoBookingSnapshot(context, teacher.id)
      .then((result) => {
        if (
          result.snapshotId !== snapshotId ||
          result.configRevision !== configRevision ||
          result.teacher.id !== teacher.id
        )
          throw new Error("排班快照已更新，请重试。")
        const count = result.teacher.days.reduce(
          (total, day) => total + day.slots.filter((slot) => slot.state === "available").length,
          0,
        )
        accept({ snapshotId, snapshot: result, count })
      })
      .catch((reason) => {
        accept({ snapshotId, error: (reason as Error).message })
      })
    return () => {
      cancelled = true
    }
  }, [context, teacher.id, snapshotId, configRevision, active, loading, reserveVisibleList])
  useLayoutEffect(() => {
    if (!active || !focusDate || consumedFocus.current === focusDate.sequence || !current) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-date="${focusDate.date}"]`)
    row?.scrollIntoView({ block: "nearest", inline: "nearest" })
    consumedFocus.current = focusDate.sequence
  }, [focusDate, active, current])
  const checkedAt = displayed?.checkedAt ?? snapshot?.checkedAt
  return (
    <section
      className="mison-auto-schedule"
      aria-label={`${teacher.name}的排班`}
      aria-busy={loading}
      data-complete={!loading}
    >
      <div className="mison-auto-schedule-toolbar">
        <div className="mison-auto-schedule-title">
          <h2>排班详情</h2>
          <span>
            {displayed && !bookingUnavailable
              ? `今天起 ${displayed.teacher.days.length} 天`
              : snapshotId
                ? "排班快照"
                : "等待检查"}
          </span>
          <label className="mison-auto-date-scope">
            <Switch
              aria-label="仅看目标日期"
              checked={targetsOnly}
              onCheckedChange={setTargetsOnly}
            />
            仅看目标日
          </label>
        </div>
        <time className="mison-caption">
          {checkedAt ? `检查于 ${autoBookingTime(checkedAt)}` : ""}
        </time>
      </div>
      <Tabs
        className="mison-auto-teacher-switch"
        value={teacher.id}
        onValueChange={(id) => {
          if (id === teacher.id) return
          reserveVisibleList()
          consumedFocus.current = focusDate?.sequence ?? 0
          setTeacherId(id)
        }}
      >
        <div className="mison-auto-teacher-navigation">
          <TabsList aria-label="切换排班老师">
            {teachers.map((item, index) => {
              const entry = entries?.[item.id]
              const count = entry?.snapshotId === snapshotId ? entry?.count : undefined
              return (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  id={`${panelId}-${item.id}`}
                  aria-controls={panelId}
                  aria-label={`${index + 1}. ${teacherName(item.name)}`}
                >
                  <Avatar name={item.name} url={item.avatarUrl} compact />
                  <span>{item.name.replace(/\s*老师$/, "")}</span>
                  <span className="mison-auto-teacher-count">{count ?? "—"}</span>
                  {loading && item.id === teacher.id ? (
                    <RefreshCw className="mison-auto-teacher-loading animate-spin" aria-hidden />
                  ) : null}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </div>
        <div
          className="mison-auto-schedule-scroll"
          ref={listRef}
          id={panelId}
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`${panelId}-${teacher.id}`}
          data-unavailable={bookingUnavailable || undefined}
        >
          {error ? (
            <Notice error>
              {error}
              <Button
                variant="outline"
                onClick={() => {
                  reserveVisibleList()
                  setCache((previous) => {
                    if (!previous) return previous
                    const entries = { ...previous.entries }
                    delete entries[teacher.id]
                    return { ...previous, entries }
                  })
                }}
              >
                重试读取
              </Button>
            </Notice>
          ) : null}
          {loading && !displayed
            ? Array.from({ length: 4 }, (_, index) => (
                <section key={index} className="mison-auto-day mison-auto-day-skeleton" aria-hidden>
                  <div className="mison-auto-day-heading">
                    <Skeleton className="h-6 w-28" />
                  </div>
                  <div className="mison-auto-slots">
                    <Skeleton className="h-8 w-24 rounded-full" />
                    <Skeleton className="h-8 w-24 rounded-full" />
                    <Skeleton className="h-8 w-24 rounded-full" />
                  </div>
                </section>
              ))
            : null}
          {days.map((day) => {
            const visibleSlots = day.slots.filter((slot) => slot.state !== "unscheduled")
            const priorities = new Set(priorityTimes(day.date))
            const weekday = parseDate(day.date).getDay()
            const weekdayName = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][weekday]
            const target = targetDates.includes(day.date)
            return (
              <section
                key={day.date}
                className="mison-auto-day"
                data-date={day.date}
                data-focused={focusDate?.date === day.date}
                data-target={target}
                aria-label={dateLabel(day.date)}
              >
                <div className="mison-auto-day-heading">
                  <h3>
                    <time dateTime={day.date}>
                      {new Intl.DateTimeFormat("sv-SE", {
                        timeZone: "Asia/Shanghai",
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                      }).format(parseDate(day.date))}
                    </time>
                  </h3>
                  <div className="mison-auto-day-meta">
                    <span
                      className="mison-auto-weekday"
                      data-weekend={weekday === 0 || weekday === 6 || undefined}
                    >
                      {weekdayName}
                    </span>
                    {!targetsOnly ? (
                      <span className="mison-auto-target">{target ? "目标日" : "非目标日"}</span>
                    ) : null}
                  </div>
                </div>
                {day.state === "unopened" || !visibleSlots.length ? (
                  <p className="mison-caption">{day.state === "unopened" ? "未开放" : "无排班"}</p>
                ) : (
                  <div className="mison-auto-slots">
                    {visibleSlots.map((slot) => (
                      <Popover key={`${teacher.id}:${slot.start}`}>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="mison-auto-slot"
                            data-state={slot.state}
                            data-matches={slot.state === "available" && priorities.has(slot.start)}
                            aria-label={`${dateLabel(day.date)} ${slot.start} ${slotLabels[slot.state]}`}
                          >
                            <time>{slot.start}</time>
                            <span>{slotLabels[slot.state]}</span>
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-64" aria-label={`${slot.start}时段详情`}>
                          <p>
                            {teacherName(teacher.name)} · {dateLabel(day.date)}
                          </p>
                          <p>
                            {slot.start}–{slot.end} · {slotLabels[slot.state]}
                          </p>
                        </PopoverContent>
                      </Popover>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
          {bookingUnavailable ? (
            <Empty title="暂时无法预约" icon={<img src={unavailableIllustration} alt="" />} />
          ) : displayed && !days.length ? (
            <p className="mison-auto-no-targets">
              {targetsOnly ? "当前快照没有目标日期。" : "当前快照没有排班日期。"}
            </p>
          ) : null}
          {!loading && !error && !current ? (
            <p className="mison-auto-no-targets">
              还没有排班快照。下一次检查完成后，这里会显示每位老师的排班。
            </p>
          ) : null}
        </div>
      </Tabs>
    </section>
  )
}

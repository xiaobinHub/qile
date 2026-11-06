import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react"
import { Avatar, Button, Notice, Overlay } from "./ui"
import { request } from "./api"
import {
  ContinuousMonthCalendar,
  monthWindow,
  monthWindowDates,
  type CalendarPosition,
} from "./calendar-views"
import { fmtFull, parseDate, rangeDates, shiftMonth } from "./calendar-date"
import { reloadBookingSource, useBookingSource } from "./booking-source"
import type { Booking, PluginContext, Resource } from "./types"

const labels = { upcoming: "已预约", completed: "已上课" }

function Lesson({
  booking,
  opening,
  blocked,
  onOpen,
}: {
  booking: Booking
  opening: boolean
  blocked: boolean
  onOpen(booking: Booking): void
}) {
  const status = booking.status === "completed" ? "completed" : "upcoming"
  const name = booking.teacher.name.replace(/\s*老师\s*$/, "").trim() || "未命名"
  const title = booking.courseware?.title || "暂无课件名称"
  return (
    <button
      type="button"
      className="mison-calendar-lesson"
      data-status={status}
      data-booking-key={booking.key}
      title={`${name} · ${booking.timeLabel} · ${title} · ${labels[status]}`}
      aria-label={`查看课程PDF：${name}，${booking.timeLabel}，${title}，${labels[status]}`}
      aria-busy={opening}
      aria-disabled={blocked}
      onClick={(event) => {
        if (!blocked) {
          event.currentTarget.focus({ preventScroll: true })
          onOpen(booking)
        }
      }}
    >
      <Avatar name={booking.teacher.name} url={booking.teacher.avatarUrl} compact />
      <span className="mison-calendar-lesson-copy">
        <strong>{name}</strong>
        <time dateTime={booking.startsAt ?? undefined}>{booking.timeLabel}</time>
        <span className="mison-calendar-courseware">{title}</span>
      </span>
    </button>
  )
}

export function CourseCalendar({
  context,
  bindingRevision,
  serverDate,
  active,
  upcomingCount,
  onBookings,
  onResource,
}: {
  context: PluginContext
  bindingRevision: number
  serverDate: string
  active: boolean
  upcomingCount: number | null
  onBookings(): void
  onResource(resource: Resource): void
}) {
  const [opening, setOpening] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState("")
  const [materials, setMaterials] = useState<Resource[] | null>(null)
  const pdfGeneration = useRef(0)
  const pdfLock = useRef(false)
  useEffect(() => {
    if (!active) {
      setOpening(null)
      setPdfError("")
      setMaterials(null)
    }
    return () => {
      pdfGeneration.current++
      pdfLock.current = false
    }
  }, [active, context])
  async function openPdf(booking: Booking) {
    if (pdfLock.current || !active) return
    setPdfError("")
    if (!booking.cid || booking.actions.materials?.allowed === false) {
      setPdfError(booking.actions.materials?.reason || "该课程暂无可用的PDF资料。")
      return
    }
    pdfLock.current = true
    const generation = ++pdfGeneration.current
    const current = () => generation === pdfGeneration.current && !context.signal.aborted
    setOpening(booking.key)
    try {
      const result = await request<{ items: Resource[] }>(
        context,
        `bookings/${encodeURIComponent(booking.key)}/resources`,
      )
      if (!current()) return
      const pdfs = result.items.filter((item) => item.mimeType === "application/pdf")
      if (pdfs.length === 1) onResource(pdfs[0])
      else if (pdfs.length > 1) setMaterials(pdfs)
      else if (
        result.items.length === 1 &&
        ["instructions", "unavailable"].includes(result.items[0].action)
      )
        onResource(result.items[0])
      else setPdfError("该课程暂无可预览的PDF。")
    } catch (error) {
      if (current()) setPdfError(`${(error as Error).message} 请点击课程卡片重试。`)
    } finally {
      if (current()) {
        pdfLock.current = false
        setOpening(null)
      }
    }
  }
  const [cursor, setCursor] = useState(serverDate)
  const [navigation, setNavigation] = useState(0)
  const [visibleMonth, setVisibleMonth] = useState(serverDate.slice(0, 7))
  const [monthRange, setMonthRange] = useState(() => monthWindowDates(monthWindow(serverDate)))
  const monthPosition = useRef<CalendarPosition | undefined>(undefined)
  const { from, to } = monthRange
  const scope = `${context.child.id}:${bindingRevision}`
  const upcoming = useBookingSource({
    context,
    scope,
    status: "upcoming",
    enabled: active,
    edge: to,
  })
  const completed = useBookingSource({
    context,
    scope,
    status: "completed",
    enabled: active,
    edge: from,
  })
  const loading = upcoming.loading || completed.loading
  const byDay = useMemo(() => {
    const result = new Map<string, Booking[]>()
    for (const item of [...upcoming.items, ...completed.items].sort((a, b) =>
      (a.startsAt ?? "").localeCompare(b.startsAt ?? ""),
    )) {
      const date = item.startsAt!.slice(0, 10)
      const items = result.get(date) ?? []
      items.push(item)
      result.set(date, items)
    }
    return result
  }, [upcoming.items, completed.items])
  const onRange = useCallback(
    (from: string, to: string) =>
      setMonthRange((old) => (old.from === from && old.to === to ? old : { from, to })),
    [],
  )
  const onMonth = useCallback((month: string) => setVisibleMonth(month), [])
  const empty =
    !loading &&
    !upcoming.error &&
    !completed.error &&
    ![...byDay.entries()].some(([date, items]) => items.length && date.startsWith(visibleMonth))
  function move(amount: number) {
    monthPosition.current = undefined
    const month = shiftMonth(visibleMonth, amount)
    setVisibleMonth(month)
    setCursor(month + "-01")
    setNavigation((value) => value + 1)
  }
  return (
    <section
      className="mison-course-calendar"
      aria-label="课程日历"
      aria-busy={loading}
      data-calendar-mode="month"
    >
      <div className="mison-calendar-toolbar">
        <h2>{`${visibleMonth.slice(0, 4)}年${Number(visibleMonth.slice(5, 7))}月`}</h2>
        <div className="mison-calendar-navigation">
          <Button variant="outline" size="icon" aria-label="上个月" onClick={() => move(-1)}>
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              monthPosition.current = undefined
              setVisibleMonth(serverDate.slice(0, 7))
              setCursor(serverDate)
              setNavigation((value) => value + 1)
            }}
          >
            今天
          </Button>
          <Button variant="outline" size="icon" aria-label="下个月" onClick={() => move(1)}>
            <ChevronRight />
          </Button>
        </div>
        <div className="mison-calendar-legend" aria-label="课程状态图例">
          <span data-status="completed">已上课</span>
          <span data-status="upcoming">已预约</span>
        </div>
        <div className="mison-calendar-actions">
          <Button variant="outline" onClick={onBookings}>
            <CalendarDays />
            我的预约{upcomingCount != null ? <b>{upcomingCount}</b> : null}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新课程"
            disabled={loading}
            onClick={() => reloadBookingSource(scope, ["upcoming", "completed"])}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      <div className="mison-calendar-feedback" aria-live="polite">
        {pdfError ? <Notice error>{pdfError}</Notice> : null}
        {(
          [
            ["upcoming", upcoming],
            ["completed", completed],
          ] as const
        ).map(([status, state]) =>
          state.error ? (
            <Notice key={status} error>
              {labels[status]}课程读取失败：{state.error}
              <Button variant="outline" onClick={() => reloadBookingSource(scope, [status])}>
                重试{labels[status]}课程
              </Button>
            </Notice>
          ) : null,
        )}
        {empty ? <p className="mison-caption">本月暂无已上课或已预约的课程。</p> : null}
      </div>
      <ContinuousMonthCalendar
        target={cursor}
        navigation={navigation}
        active={active}
        savedPosition={monthPosition.current}
        onPosition={(position) => {
          monthPosition.current = position
        }}
        onMonth={onMonth}
        onRangeChange={onRange}
      >
        {(from, to) =>
          rangeDates(from, to).map((date) => (
            <div
              key={date}
              data-cell-day={date}
              className={`mison-calendar-month-cell${parseDate(date).getDay() % 6 === 0 ? " mison-calendar-weekend" : ""}${date === serverDate ? " mison-calendar-today" : ""}`}
            >
              <div className="mison-calendar-day" aria-label={fmtFull(date)}>
                <span>
                  {date.endsWith("-01")
                    ? `${Number(date.slice(5, 7))}月1日`
                    : Number(date.slice(8))}
                </span>
              </div>
              <div className="mison-calendar-lessons">
                {(byDay.get(date) ?? []).map((booking) => (
                  <Lesson
                    key={booking.key}
                    booking={booking}
                    opening={opening === booking.key}
                    blocked={opening !== null}
                    onOpen={(booking) => void openPdf(booking)}
                  />
                ))}
              </div>
            </div>
          ))
        }
      </ContinuousMonthCalendar>
      {materials ? (
        <Overlay title="选择课程PDF" onClose={() => setMaterials(null)}>
          <div className="mison-account-form">
            {materials.map((item, index) => (
              <Button
                key={`${item.id}-${index}`}
                variant="outline"
                onClick={() => onResource(item)}
              >
                {item.title}
              </Button>
            ))}
          </div>
        </Overlay>
      ) : null}
    </section>
  )
}

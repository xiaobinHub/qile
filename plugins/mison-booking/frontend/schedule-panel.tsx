import { Check, ChevronLeft, ChevronRight, ChevronsUp, FileText, Info } from "lucide-react"
import { Switch } from "@shared/components/ui/switch"
import { Field, FieldLabel } from "@shared/components/ui/field"
import { Badge } from "@shared/components/ui/badge"
import { Separator } from "@shared/components/ui/separator"
import { Skeleton } from "@shared/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@shared/components/ui/toggle-group"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@shared/components/ui/card"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { Avatar, Button, Empty, Notice, dateLabel, teacherName, weekday } from "./ui"
import type { Draft, Teacher, TeacherSchedule, Operation } from "./types"
export type Step = "schedule" | "confirm" | "success"
export function SchedulePanel({
  teacher,
  schedule,
  selected,
  step,
  draft,
  loading,
  requestedDate,
  slotTimes,
  loadError,
  onRetry,
  busy,
  blocked,
  contiguous,
  limit,
  operation,
  onSlot,
  onDate,
  onClear,
  onNext,
  onBack,
  onSubmit,
  onCollapse,
  onProfile,
  onChange,
  onPreview,
  onContinue,
  onBookings,
  onReconcile,
}: {
  teacher: Teacher
  schedule: TeacherSchedule | null
  selected: string[]
  step: Step
  draft: Draft | null
  loading: boolean
  requestedDate?: string
  slotTimes: string[]
  loadError: string
  onRetry(): void
  busy: boolean
  blocked: boolean
  contiguous: boolean
  limit: number | null
  operation: Operation | null
  onSlot(start: string): void
  onDate(date: string): void
  onClear(): void
  onNext(): void
  onBack(): void
  onSubmit(): void
  onCollapse(): void
  onProfile(): void
  onChange(start: string): void
  onPreview(start: string): void
  onContinue(): void
  onBookings(): void
  onReconcile(): void
}) {
  const onlyAvailableId = useId()
  const [onlyAvailable, setOnlyAvailable] = useState(false)
  const [loadingVisible, setLoadingVisible] = useState(false)
  const staleTeacher = !!schedule && schedule.teacher.id !== teacher.id
  useEffect(() => {
    if (!loading) {
      if (!staleTeacher) setLoadingVisible(false)
      return
    }
    // Fast switches can replace the data directly without flashing a loader.
    const timer = setTimeout(() => setLoadingVisible(true), 120)
    return () => clearTimeout(timer)
  }, [loading, staleTeacher])
  const showSkeleton = (loading && (!schedule || loadingVisible)) || (!!loadError && staleTeacher)
  const activeDate = requestedDate ?? schedule?.date ?? ""
  const filteredDays = schedule?.days.filter((day) => !onlyAvailable || day.available) ?? []
  const slotMap = new Map(schedule?.slots.map((slot) => [slot.start, slot]) ?? [])
  const slots = Array.from(new Set([...slotTimes, ...slotMap.keys()]))
    .sort()
    .map(
      (start) =>
        slotMap.get(start) ?? {
          start,
          end: start,
          state: "unscheduled" as const,
          reason: "未排班",
        },
    )
  const [page, setPage] = useState(0)
  const [datesPerPage, setDatesPerPage] = useState(7)
  const dateStrip = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = dateStrip.current
    if (!element) return
    const measure = () =>
      setDatesPerPage(Math.max(1, Math.floor((element.clientWidth + 6) / 70) - 1))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [step])
  useEffect(() => {
    if (!schedule) return
    const index = filteredDays.findIndex((day) => day.date === activeDate)
    setPage(Math.floor(Math.max(0, index) / datesPerPage))
  }, [activeDate, schedule?.date, teacher.id, datesPerPage, onlyAvailable])
  const dates = filteredDays.slice(page * datesPerPage, (page + 1) * datesPerPage)
  const unresolved =
    operation &&
    ["prepared", "dispatching", "uncertain", "partially_succeeded", "needs_repair"].includes(
      operation.state,
    )
  const scheduleBlocked = blocked || loading || staleTeacher || !!unresolved
  const disabledReason = !selected.length
    ? "请选择时段"
    : !contiguous
      ? "请选择同一天的连续时段"
      : limit === null
        ? "预约提交暂未接入"
        : selected.length > limit
          ? `每次最多预约${limit}课时`
          : ""
  return (
    <section className="mison-stage" aria-label="约课区" aria-busy={loading || busy}>
      <header className="mison-stage-header">
        <div className="mison-person">
          <Button
            variant="ghost"
            size="icon"
            className="mison-avatar-trigger size-20 rounded-full"
            aria-label={`查看${teacherName(teacher.name)}档案`}
            onClick={onProfile}
          >
            <Avatar name={teacher.name} url={teacher.avatarUrl} large />
          </Button>
          <div>
            <h2>{teacherName(teacher.name)}</h2>
            <div className="mison-tags">
              {teacher.labels.slice(0, 2).map((l) => (
                <Badge variant="secondary" key={l.id}>
                  {l.name}
                </Badge>
              ))}
              <small>
                {teacher.lessonMinutes ? `${teacher.lessonMinutes}分钟 / 课时` : "时长待确认"}
              </small>
            </div>
          </div>
        </div>
        <div className="mison-stage-tools">
          <Button variant="outline" disabled={blocked || !!unresolved} onClick={onCollapse}>
            <ChevronsUp />
            收起约课区
          </Button>
        </div>
      </header>
      <Separator />
      {step === "success" ? (
        <div className="mison-stage-scroll" role="region" aria-label="约课内容" tabIndex={0}>
          <Empty title="预约成功" icon={<Check />}>
            <p>
              {teacherName(teacher.name)} · {schedule ? dateLabel(schedule.date) : ""}
            </p>
            <p>{draft?.lessons.map((lesson) => `${lesson.start}–${lesson.end}`).join(" · ")}</p>
            <div className="mison-actions">
              <Button variant="outline" onClick={onContinue}>
                继续预约
              </Button>
              <Button onClick={onBookings}>查看我的预约</Button>
            </div>
          </Empty>
        </div>
      ) : step === "confirm" ? (
        <>
          <div className="mison-stage-scroll" role="region" aria-label="约课内容" tabIndex={0}>
            <div className="mison-stage-body">
              <div className="mison-section-heading">
                <h3>{draft ? dateLabel(draft.date) : "确认课件"}</h3>
                <small>共 {selected.length} 课时</small>
              </div>
              {draft?.lastLearned ? (
                <Notice className="mison-learning-progress">
                  <Info size={18} />
                  <div>
                    上次学到：{draft.lastLearned.title}
                    <small>已根据学习记录推荐后续课件</small>
                  </div>
                </Notice>
              ) : null}
              {draft?.lessons.map((lesson, i) => (
                <Card size="sm" className="mison-course-row" key={lesson.start}>
                  <CardHeader className="mison-course-time">
                    <CardTitle>
                      {lesson.start}–{lesson.end}
                    </CardTitle>
                    <CardDescription>第{i + 1}课时</CardDescription>
                  </CardHeader>
                  <div className="mison-document">
                    <FileText />
                  </div>
                  <CardContent className="mison-course-copy">
                    <CardTitle>{lesson.courseware?.title ?? "待补选课件"}</CardTitle>
                    <CardDescription>
                      {lesson.courseware?.categoryName ?? "请选择本课时的学习内容"}
                    </CardDescription>
                  </CardContent>
                  <CardFooter className="mison-course-tools">
                    <Button
                      variant="outline"
                      disabled={blocked}
                      onClick={() => onChange(lesson.start)}
                    >
                      更换课件
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={blocked || !lesson.courseware?.previewAvailable}
                      onClick={() => onPreview(lesson.start)}
                    >
                      预览
                    </Button>
                  </CardFooter>
                </Card>
              ))}
              {draft?.issues.map((issue, i) => (
                <Notice error key={i}>
                  {issue.message}
                </Notice>
              ))}
              {unresolved ? (
                <Notice>
                  {operation?.message || "预约结果待核对，请勿重复提交。"}
                  {operation?.result?.lessons?.map((item) => (
                    <span key={item.start}>
                      {item.start} · {item.coursewareTitle} ·{" "}
                      {item.state === "succeeded" ? "已预约" : "待核对"}
                    </span>
                  ))}
                  <Button variant="outline" disabled={busy} onClick={onReconcile}>
                    核对预约结果
                  </Button>
                </Notice>
              ) : null}
            </div>
          </div>
          <Separator />
          <footer className="mison-stage-footer">
            <span>
              本次预约 <strong>{selected.length}</strong> 课时
            </span>
            <div className="mison-actions">
              <Button variant="outline" onClick={onBack} disabled={blocked || !!unresolved}>
                返回选时段
              </Button>
              <Button disabled={blocked || !draft?.valid || !!unresolved} onClick={onSubmit}>
                {busy ? "处理中…" : "确认预约"}
              </Button>
            </div>
          </footer>
        </>
      ) : (
        <>
          <div className="mison-stage-scroll" role="region" aria-label="约课内容" tabIndex={0}>
            <div className="mison-stage-body" data-schedule-loading={showSkeleton || undefined}>
              <div className="mison-section-heading">
                <div className="mison-date-heading">
                  <h3 className="mison-schedule-month">
                    <span>
                      {activeDate
                        ? `${activeDate.slice(0, 4)}年${Number(activeDate.slice(5, 7))}月`
                        : "选择上课日期"}
                    </span>
                    {showSkeleton ? (
                      <Skeleton className="mison-schedule-cell-skeleton" aria-hidden="true" />
                    ) : null}
                  </h3>
                  <Field
                    orientation="horizontal"
                    className="mison-available-dates"
                    data-disabled={scheduleBlocked || undefined}
                  >
                    <Switch
                      id={onlyAvailableId}
                      className="after:-inset-y-3.5"
                      checked={onlyAvailable}
                      disabled={scheduleBlocked}
                      onCheckedChange={(checked) => {
                        setOnlyAvailable(checked === true)
                        if (
                          checked === true &&
                          !filteredDays.find((day) => day.date === activeDate)?.available
                        ) {
                          const first = schedule?.days.find((day) => day.available)
                          if (first) onDate(first.date)
                        }
                      }}
                    />
                    <FieldLabel htmlFor={onlyAvailableId}>只看可约日期</FieldLabel>
                  </Field>
                </div>
                <div className="mison-actions">
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="上一组日期"
                    disabled={scheduleBlocked || page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="下一组日期"
                    disabled={
                      scheduleBlocked ||
                      !schedule ||
                      (page + 1) * datesPerPage >= filteredDays.length
                    }
                    onClick={() => setPage(page + 1)}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
              <ToggleGroup
                type="single"
                value={activeDate}
                onValueChange={(date) => {
                  if (date) onDate(date)
                }}
                variant="outline"
                className="mison-dates"
                ref={dateStrip}
                style={{
                  gridTemplateColumns: `repeat(${datesPerPage}, 64px)`,
                }}
                disabled={scheduleBlocked}
                aria-label="上课日期"
              >
                {onlyAvailable && !dates.length && !loading && !showSkeleton ? (
                  <small className="mison-no-dates">暂无可约日期</small>
                ) : null}
                {showSkeleton && !dates.length
                  ? Array.from({ length: datesPerPage }, (_, index) => (
                      <Skeleton key={index} className="mison-date-skeleton" aria-hidden="true" />
                    ))
                  : null}
                {dates.map((day) => (
                  <ToggleGroupItem
                    key={day.date}
                    value={day.date}
                    className="mison-date-option"
                    disabled={!day.available}
                    data-unavailable={!day.available}
                    aria-label={dateLabel(day.date)}
                  >
                    <span>{weekday(day.date)}</span>
                    <strong>{Number(day.date.slice(8))}</strong>
                    {showSkeleton ? (
                      <Skeleton className="mison-schedule-cell-skeleton" aria-hidden="true" />
                    ) : null}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <div className="mison-slots-region" aria-busy={loading}>
                {slots.length ? (
                  <ToggleGroup
                    type="multiple"
                    variant="outline"
                    className="mison-slots"
                    value={selected}
                    aria-label="可选课时"
                    disabled={scheduleBlocked || !!loadError}
                    onValueChange={(next) => {
                      const changed =
                        next.find((value) => !selected.includes(value)) ??
                        selected.find((value) => !next.includes(value))
                      if (changed) onSlot(changed)
                    }}
                  >
                    {slots.map((slot) => (
                      <ToggleGroupItem
                        key={slot.start}
                        value={slot.start}
                        aria-label={`${slot.start}${slot.state === "mine" ? " 本人已约" : ""}`}
                        disabled={slot.state !== "available" || scheduleBlocked || !!loadError}
                        data-unavailable={slot.state !== "available"}
                        title={slot.reason ?? undefined}
                      >
                        <span>{slot.start}</span>
                        {slot.state === "mine" ? <small>本人已约</small> : null}
                        {showSkeleton ? (
                          <Skeleton className="mison-schedule-cell-skeleton" aria-hidden="true" />
                        ) : null}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                ) : loading ? (
                  <div className="mison-slots" aria-hidden="true">
                    {Array.from({ length: 12 }, (_, index) => (
                      <Skeleton key={index} className="mison-slot-skeleton" />
                    ))}
                  </div>
                ) : (
                  <Empty title="当天暂无可约时段">
                    <p>试试其他日期，或选择另一位老师。</p>
                  </Empty>
                )}
                {loading ? (
                  <span className="sr-only" role="status">
                    正在加载时段…
                  </span>
                ) : loadError ? (
                  <div className="mison-slots-overlay" role="alert">
                    <span>{loadError}</span>
                    <Button variant="outline" onClick={onRetry}>
                      重试
                    </Button>
                  </div>
                ) : null}
              </div>
              {disabledReason && selected.length && contiguous ? (
                <Notice error>{disabledReason}</Notice>
              ) : null}
            </div>
          </div>
          <Separator />
          <footer className="mison-stage-footer">
            <div>
              已选 <strong>{selected.length}</strong> 课时
            </div>
            <div className="mison-actions">
              <Button variant="ghost" disabled={!selected.length || blocked} onClick={onClear}>
                清空
              </Button>
              <Button
                disabled={!!disabledReason || scheduleBlocked || !!loadError}
                onClick={onNext}
              >
                {busy ? "正在推荐课件…" : "下一步：确认课件"}
              </Button>
            </div>
          </footer>
        </>
      )}
    </section>
  )
}

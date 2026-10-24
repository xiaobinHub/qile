import "./calendar.css"
import { TaskTitle } from "./task-title"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Printer,
  Circle,
  CircleCheck,
  LoaderCircle,
  ArrowUp,
  ArrowDown,
} from "lucide-react"
import { Checkbox } from "@shared/components/ui/checkbox"
import { Switch } from "@shared/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@shared/components/ui/toggle-group"
import { Textarea } from "@shared/components/ui/textarea"
import {
  Button,
  Input,
  DatePicker,
  TimePicker,
  NumberPicker,
  MonthDayPicker,
  Choice,
  Field,
  Modal,
  Confirm,
  ErrorText,
  useAsync,
} from "./ui"
import { runtime } from "../lib/runtime"
import {
  addDays,
  dateStr,
  fmtDate,
  fmtFull,
  isDone,
  layoutWeekEvents,
  minutes,
  monthStart,
  occurrences,
  parseDate,
  rangeDates,
  revisionForDate,
  shiftMonth,
  startWeek,
  timeAt,
  today,
} from "../domain/calendar"
import type { BusinessData, Child, Occurrence, Task } from "../domain/types"
type CalendarPreferences = {
  mode: string
  cursor: string
  monthPosition?: { date: string; offset: number }
  weekPosition?: { first: string; top: number; left: number }
}
type Options = { date?: string; startTime?: string; endTime?: string; occurrence?: Occurrence }
export function CalendarPage({
  data,
  child,
  openTask,
  openPrint,
  prefs,
}: {
  prefs: CalendarPreferences
  data: BusinessData
  child: Child
  openTask: (o: Options) => void
  openPrint: (trigger: HTMLButtonElement) => void
}) {
  const [mode, setMode] = useState(prefs.mode),
    [cursor, setCursor] = useState(prefs.cursor),
    [navigation, setNavigation] = useState(0),
    [visibleMonth, setVisibleMonth] = useState(prefs.cursor.slice(0, 7)),
    [completionError, setCompletionError] = useState("")
  const weekRef = useRef<HTMLDivElement>(null),
    visibleDate = useRef(prefs.cursor),
    weekNavigation = useRef(navigation),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    prefs.mode = mode
    prefs.cursor = cursor
    visibleDate.current = cursor
  }, [mode, cursor])
  const first = mode === "month" ? startWeek(monthStart(cursor)) : startWeek(cursor),
    end =
      mode === "month"
        ? addDays(startWeek(addDays(shiftMonth(cursor, 1) + "-01", -1)), 6)
        : addDays(first, 6),
    items = useMemo(() => occurrences(data, first, end), [data, first, end])
  useEffect(() => {
    if (mode === "week" && weekRef.current) {
      const saved = prefs.weekPosition
      const focusDate = today() >= first && today() <= end ? today() : cursor
      const relevant = items.filter((o) => o.date === focusDate)
      const earliest = (relevant.length ? relevant : items).reduce(
        (n, o) => Math.min(n, minutes(o.startTime)),
        Infinity,
      )
      weekRef.current.scrollTop =
        saved?.first === first && weekNavigation.current === navigation
          ? saved.top
          : Number.isFinite(earliest)
            ? Math.max(0, earliest - 30)
            : 540
      weekRef.current.scrollLeft = saved?.first === first ? saved.left : 0
      weekNavigation.current = navigation
    }
  }, [mode, cursor, navigation])
  const category = (id: string) =>
    data.categories.find((c) => c.id === id) || { color: "#68716c", name: "已停用类型" }
  const move = (n: number) => {
    prefs.monthPosition = undefined
    setCursor(mode === "month" ? shiftMonth(visibleMonth, n) + "-01" : addDays(cursor, n * 7))
    setNavigation((v) => v + 1)
  }
  const snapshot = runtime.getSnapshot(),
    busy = snapshot.busy,
    pendingOccurrences = new Set(snapshot.completionPending)
  const wasUnconfirmed = useRef(snapshot.unconfirmed)
  useEffect(() => {
    if (wasUnconfirmed.current && !snapshot.unconfirmed) setCompletionError("")
    wasUnconfirmed.current = snapshot.unconfirmed
  }, [snapshot.unconfirmed])
  const toggleCompletion = (o: Occurrence) => {
    if (child.archived) return
    setCompletionError("")
    void runtime.setCompletion(o, !isDone(data, o)).catch((error) => {
      if (error.kind === "stale") return
      if (mounted.current) setCompletionError(error.message)
      else runtime.patch({ message: `${o.title}：${error.message}` })
    })
  }
  const editTask = (o: Occurrence) => {
    if (!busy) openTask({ occurrence: o })
  }
  return (
    <section className="calendar-panel" data-calendar-mode={mode}>
      <div className="calendar-toolbar">
        <h1 id="calendarTitle">
          {mode === "month"
            ? `${visibleMonth.slice(0, 4)}年${Number(visibleMonth.slice(5, 7))}月`
            : `${fmtDate(first)} — ${fmtDate(end)}`}
        </h1>
        <div className="calendar-navigation">
          <Button
            id="prevPeriod"
            variant="outline"
            size="icon"
            aria-label="上一期"
            onClick={() => move(-1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            id="todayBtn"
            variant="outline"
            onClick={() => {
              prefs.monthPosition = undefined
              setCursor(today())
              setNavigation((v) => v + 1)
            }}
          >
            今天
          </Button>
          <Button
            id="nextPeriod"
            variant="outline"
            size="icon"
            aria-label="下一期"
            onClick={() => move(1)}
          >
            <ChevronRight />
          </Button>
        </div>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(value) => {
            if (value) {
              if (value === "week") setCursor(visibleDate.current)
              else setVisibleMonth(cursor.slice(0, 7))
              setMode(value)
            }
          }}
          aria-label="日历视图"
        >
          <ToggleGroupItem value="month" data-mode="month">
            月
          </ToggleGroupItem>
          <ToggleGroupItem value="week" data-mode="week">
            周
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="calendar-toolbar-actions">
          <Button
            id="printBtn"
            variant="outline"
            onClick={(event) => openPrint(event.currentTarget)}
          >
            <Printer />
            打印
          </Button>
          {!child.archived && (
            <Button id="newTaskBtn" onClick={() => openTask({ date: today() })}>
              <Plus />
              新建任务
            </Button>
          )}
        </div>
      </div>
      {child.archived && <p className="notice">孩子已归档，当前仅可查看。</p>}
      <ErrorText message={completionError} />
      {mode === "month" ? (
        <MonthCalendar
          data={data}
          target={cursor}
          navigation={navigation}
          openTask={openTask}
          onToggle={toggleCompletion}
          onEdit={editTask}
          readOnly={child.archived}
          busy={busy}
          pendingOccurrences={pendingOccurrences}
          savedPosition={prefs.monthPosition}
          onPosition={(position) => {
            prefs.monthPosition = position
          }}
          onMonth={(month, date) => {
            setVisibleMonth(month)
            visibleDate.current = date
            prefs.cursor = date
          }}
        />
      ) : (
        <div
          id="weekCalendar"
          ref={weekRef}
          className="week-wrap"
          onScroll={(event) => {
            prefs.weekPosition = {
              first,
              top: event.currentTarget.scrollTop,
              left: event.currentTarget.scrollLeft,
            }
          }}
        >
          <div className="week-board">
            <div className="week-head" />
            {rangeDates(first, end).map((d) => (
              <Button
                key={d}
                variant="ghost"
                className={`week-head week-day-entry ${d === today() ? "today" : ""}`}
                data-week-day={d}
                aria-label={`${fmtFull(d)}，新建任务`}
                disabled={child.archived}
                onClick={() => {
                  if (!busy) openTask({ date: d })
                }}
              >
                <strong>{fmtDate(d)}</strong>
                <small>周{"日一二三四五六"[parseDate(d).getDay()]}</small>
              </Button>
            ))}
            <div className="time-axis">
              {Array.from({ length: 25 }, (_, hr) => (
                <span key={hr} style={{ top: hr * 60 }}>
                  {String(hr).padStart(2, "0")}:00
                </span>
              ))}
            </div>
            {rangeDates(first, end).map((d) => (
              <div key={d} className="week-col">
                <Button
                  className="week-create"
                  variant="ghost"
                  aria-label={`${fmtFull(d)}时间轴，新建任务`}
                  disabled={child.archived}
                  onClick={(e) => {
                    if (busy) return
                    const y = e.clientY - e.currentTarget.getBoundingClientRect().top,
                      min = Math.max(0, Math.min(1410, Math.round(y / 30) * 30))
                    openTask({
                      date: d,
                      startTime: e.detail ? timeAt(min) : "17:00",
                      endTime: e.detail ? timeAt(Math.min(1439, min + 30)) : "17:30",
                    })
                  }}
                />
                {layoutWeekEvents(items.filter((o) => o.date === d)).map((layout) => {
                  const o = layout.event
                  return (
                    <div
                      key={o.occurrenceKey}
                      className={`week-event ${layout.end - layout.start < 24 ? "short-event" : ""} ${isDone(data, o) ? "done" : ""}`}
                      data-occ={o.occurrenceKey}
                      aria-busy={pendingOccurrences.has(o.occurrenceKey) || undefined}
                      style={
                        {
                          top: layout.start,
                          height: layout.end - layout.start,
                          left: Math.min(layout.depth, 3) * 9 + 3,
                          zIndex: layout.depth + 2,
                          "--task-color": category(o.categoryId).color,
                        } as React.CSSProperties
                      }
                    >
                      <CalendarTaskActions
                        occurrence={o}
                        completed={isDone(data, o)}
                        readOnly={child.archived}
                        busy={pendingOccurrences.has(o.occurrenceKey)}
                        onToggle={toggleCompletion}
                        onEdit={editTask}
                        week
                        showTime={layout.end - layout.start >= 46}
                      />
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
function CalendarTaskActions({
  occurrence: o,
  completed,
  readOnly,
  busy,
  onToggle,
  onEdit,
  week = false,
  showTime = false,
}: {
  occurrence: Occurrence
  completed: boolean
  readOnly: boolean
  busy: boolean
  onToggle: (o: Occurrence) => void
  onEdit: (o: Occurrence) => void
  week?: boolean
  showTime?: boolean
}) {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="calendar-task-toggle"
        data-task-complete={o.occurrenceKey}
        aria-label={`${completed ? "取消完成任务" : "完成任务"}：${o.title}，${fmtFull(o.date)} ${o.startTime}`}
        aria-pressed={completed}
        aria-busy={busy || undefined}
        disabled={readOnly || busy}
        onClick={() => onToggle(o)}
      >
        {busy ? (
          <LoaderCircle aria-hidden className="animate-spin" />
        ) : completed ? (
          <CircleCheck aria-hidden />
        ) : (
          <Circle aria-hidden />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="calendar-task-edit"
        data-task-edit={o.occurrenceKey}
        aria-label={`${readOnly || completed ? "查看任务" : "编辑任务"}：${o.title}，${o.startTime}至${o.endTime}`}
        title={`${o.startTime}–${o.endTime} ${o.title}`}
        disabled={busy}
        onClick={() => onEdit(o)}
      >
        {week ? (
          <>
            <strong>{o.title}</strong>
            {showTime && (
              <small>
                {o.startTime}–{o.endTime}
              </small>
            )}
          </>
        ) : (
          <span>
            {o.startTime} {o.title}
          </span>
        )}
      </Button>
    </>
  )
}

function initialTask(data: BusinessData, options: Options): Task {
  const o = options.occurrence,
    s = o && data.series.find((s) => s.id === o.seriesId)
  return {
    title: o?.title || "",
    note: o?.note || "",
    startDate: o?.date || options.date || today(),
    startTime: o?.startTime || options.startTime || "17:00",
    endTime: o?.endTime || options.endTime || "17:30",
    categoryId: o?.categoryId || data.categories.find((c) => c.active)?.id || "",
    points: o?.points ?? 0,
    recurrence: s ? revisionForDate(s, o!.originalDate).recurrence : null,
  }
}
export function TaskEditor({
  data,
  child,
  onClose,
  onCreatePreset,
  ...options
}: {
  data: BusinessData
  child: Child
  onClose: () => void
  onCreatePreset: () => void
} & Options) {
  const [task, setTask] = useState<Task>(() => initialTask(data, options)),
    [scope, setScope] = useState(""),
    [deleting, setDeleting] = useState(false),
    [overlap, setOverlap] = useState(false),
    [notesOpen, setNotesOpen] = useState(() => !!options.occurrence?.note)
  const action = useAsync(),
    o = options.occurrence
  const readOnly = child.archived || !!(o && isDone(data, o))
  const durationMinutes = minutes(task.endTime) - minutes(task.startTime)
  const durationError =
    durationMinutes <= 0
      ? "持续时长必须大于0分钟。"
      : minutes(task.endTime) > 1439
        ? "结束时间超出当天，请缩短持续时长或提前开始时间。"
        : ""
  const update = (next: Partial<Task>) => {
    if (durationError && action.error === durationError) action.setError("")
    setTask((t) => ({
      ...t,
      ...next,
      ...(next.startTime !== undefined && next.endTime === undefined
        ? {
            endTime: timeAt(
              Math.min(1439, minutes(next.startTime) + minutes(t.endTime) - minutes(t.startTime)),
            ),
          }
        : {}),
    }))
    setOverlap(false)
  }
  const rule = task.recurrence
  async function save() {
    if (readOnly)
      throw Error(child.archived ? "当前孩子仅可查看。" : "已完成任务已冻结，请先撤销完成。")
    if (!o && !data.categories.some((c) => c.id === task.categoryId && c.active))
      throw Error("请选择可用的任务类型，配置中的类型可能已停用。")
    if (durationError) throw Error(durationError)
    if (o?.recurring && !scope) throw Error("请选择修改范围。")
    if (
      !overlap &&
      occurrences(data, task.startDate, task.startDate).some(
        (x) =>
          x.occurrenceKey !== o?.occurrenceKey &&
          x.startTime < task.endTime &&
          x.endTime > task.startTime,
      )
    ) {
      setOverlap(true)
      return
    }
    await runtime.command(
      o ? "task.edit" : "task.create",
      o ? { occurrenceKey: o.occurrenceKey, task, scope: o.recurring ? scope : "only" } : { task },
    )
    onClose()
  }
  const setRule = (next: Partial<NonNullable<Task["recurrence"]>>) =>
    update({ recurrence: { ...rule!, ...next } })
  return (
    <Modal
      title={o ? "编辑任务" : "新建任务"}
      id="taskDialog"
      size="complex"
      keyboardScroll
      onClose={onClose}
      footer={
        <>
          {o && (
            <Button
              id="deleteTaskBtn"
              type="button"
              variant="destructive"
              className="task-delete-action"
              disabled={action.busy || readOnly || deleting}
              onClick={() => setDeleting(true)}
            >
              删除任务
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={action.busy || deleting}
            onClick={onClose}
          >
            取消
          </Button>
          <Button type="submit" form="taskForm" disabled={action.busy || readOnly || deleting}>
            {action.busy ? "正在保存…" : "保存任务"}
          </Button>
        </>
      }
    >
      <form
        id="taskForm"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault()
          if (!deleting) void action.run(save)
        }}
      >
        {readOnly && (
          <p className="notice" role="status">
            {child.archived
              ? "孩子已归档，当前仅可查看任务。"
              : "已完成任务已冻结，请先点击日历中的圆圈取消完成，再进行修改。"}
          </p>
        )}
        <fieldset disabled={action.busy || readOnly || deleting} className="task-editor-fields">
          <div className="task-identity-grid">
            <Field label="任务名称" id="taskTitle">
              {o ? (
                <Input
                  id="taskTitle"
                  autoComplete="off"
                  value={task.title}
                  onChange={(e) => update({ title: e.target.value })}
                  required
                  maxLength={200}
                  autoFocus
                />
              ) : (
                <TaskTitle
                  id="taskTitle"
                  value={task.title}
                  data={data}
                  onCreatePreset={onCreatePreset}
                  onChange={(title) => update({ title })}
                  onPreset={(p) =>
                    update({
                      title: p.title,
                      categoryId: p.categoryId || task.categoryId,
                      startTime: p.startTime,
                      endTime: p.endTime,
                      points: p.points,
                    })
                  }
                />
              )}
            </Field>
            <Field label="任务类型" id="taskCategory">
              <Choice
                id="taskCategory"
                label="任务类型"
                openDownwards
                value={task.categoryId}
                onChange={(categoryId) => update({ categoryId })}
                options={data.categories
                  .filter((c) => c.active || c.id === task.categoryId)
                  .map((c) => ({
                    value: c.id,
                    label: c.name + (c.active ? "" : "（已停用）"),
                    color: c.color,
                  }))}
              />
            </Field>
            <Field label="奖励积分" id="taskPoints">
              <NumberPicker
                id="taskPoints"
                label="奖励积分"
                min={0}
                max={100}
                step={5}
                loop
                value={task.points}
                onChange={(points) => update({ points })}
                required
              />
            </Field>
          </div>
          <div className="task-schedule-grid">
            <Field label="日期" id="taskDate">
              <DatePicker
                id="taskDate"
                value={task.startDate}
                onChange={(startDate) => update({ startDate })}
              />
            </Field>
            <Field label="开始时间" id="taskStart">
              <TimePicker
                id="taskStart"
                value={task.startTime}
                onChange={(startTime) => update({ startTime })}
              />
            </Field>
            <Field label="持续时长" id="taskDuration" error={durationError || undefined}>
              <TimePicker
                id="taskDuration"
                kind="duration"
                maxDurationMinutes={1439 - minutes(task.startTime)}
                value={timeAt(Math.max(0, durationMinutes))}
                onChange={(duration) =>
                  update({ endTime: timeAt(minutes(task.startTime) + minutes(duration)) })
                }
              />
            </Field>
          </div>
          <div className="task-notes">
            <Button
              type="button"
              variant="ghost"
              className="task-notes-toggle"
              aria-expanded={notesOpen}
              aria-controls="taskNotePanel"
              onClick={() => setNotesOpen((open) => !open)}
            >
              {notesOpen ? "收起备注" : task.note ? "查看备注" : "添加备注（选填）"}
            </Button>
            <div id="taskNotePanel" hidden={!notesOpen}>
              <Field label="备注" id="taskNote">
                <Textarea
                  id="taskNote"
                  value={task.note}
                  onChange={(e) => update({ note: e.target.value })}
                  maxLength={5000}
                />
              </Field>
            </div>
          </div>
          <section
            className="recurrence-section"
            aria-labelledby="recurrenceTitle"
            data-expanded={!!rule}
          >
            <div className="switch-field">
              <div>
                <label id="recurrenceTitle" htmlFor="taskRepeat">
                  重复任务
                </label>
                <p>按固定规则自动安排后续任务</p>
              </div>
              <Switch
                id="taskRepeat"
                checked={!!rule}
                onCheckedChange={(checked) =>
                  update({
                    recurrence: checked
                      ? {
                          freq: "daily",
                          interval: 1,
                          endType: "never",
                          weekdays: [(parseDate(task.startDate).getDay() + 6) % 7],
                          monthDay: Number(task.startDate.slice(8)),
                        }
                      : null,
                  })
                }
              />
            </div>
            {rule && (
              <div className="recurrence-fields">
                <div className="form-grid">
                  <Field label="重复频率" id="repeatFreq">
                    <Choice
                      id="repeatFreq"
                      label="重复频率"
                      value={rule.freq}
                      onChange={(freq) => setRule({ freq: freq as typeof rule.freq })}
                      options={[
                        { value: "daily", label: "每天" },
                        { value: "weekly", label: "每周" },
                        { value: "monthly", label: "每月" },
                      ]}
                    />
                  </Field>
                  <Field label="间隔" id="repeatInterval">
                    <NumberPicker
                      id="repeatInterval"
                      label="间隔"
                      min={1}
                      max={15}
                      loop
                      value={rule.interval}
                      onChange={(interval) => setRule({ interval })}
                      required
                    />
                  </Field>
                </div>
                {rule.freq === "weekly" && (
                  <fieldset className="weekday-picks">
                    <legend>重复星期</legend>
                    {["一", "二", "三", "四", "五", "六", "日"].map((day, index) => (
                      <label key={day}>
                        <Checkbox
                          name="repeatWeekday"
                          value={index}
                          checked={rule.weekdays?.includes(index)}
                          onCheckedChange={(checked) =>
                            setRule({
                              weekdays: checked
                                ? [...(rule.weekdays || []), index]
                                : (rule.weekdays || []).filter((i) => i !== index),
                            })
                          }
                        />
                        周{day}
                      </label>
                    ))}
                  </fieldset>
                )}
                {rule.freq === "monthly" && (
                  <div className="form-grid">
                    <Field label="每月日期" id="repeatMonthDay">
                      <MonthDayPicker
                        id="repeatMonthDay"
                        value={rule.monthDay || Number(task.startDate.slice(8))}
                        onChange={(monthDay) => setRule({ monthDay })}
                      />
                    </Field>
                  </div>
                )}
                <div className="form-grid recurrence-end-grid">
                  <Field label="结束方式" id="repeatEndType">
                    <Choice
                      id="repeatEndType"
                      label="结束方式"
                      value={rule.endType}
                      onChange={(endType) =>
                        setRule({
                          endType: endType as typeof rule.endType,
                          until: rule.until || addDays(task.startDate, 30),
                          count: rule.count || 10,
                        })
                      }
                      options={[
                        { value: "never", label: "永不结束" },
                        { value: "until", label: "截止日期" },
                        { value: "count", label: "重复次数" },
                      ]}
                    />
                  </Field>
                  {rule.endType === "until" && (
                    <Field label="截止日期" id="repeatUntil">
                      <DatePicker
                        id="repeatUntil"
                        value={rule.until || addDays(task.startDate, 30)}
                        onChange={(until) => setRule({ until })}
                      />
                    </Field>
                  )}
                  {rule.endType === "count" && (
                    <Field
                      label="重复次数"
                      id="repeatCount"
                      help={
                        o
                          ? "选择“本次及以后”时：未修改则保留原剩余次数；修改后从本次起按新次数安排。"
                          : undefined
                      }
                    >
                      <NumberPicker
                        id="repeatCount"
                        label="重复次数"
                        min={1}
                        max={60}
                        loop
                        value={rule.count || 10}
                        required
                        onChange={(count) => setRule({ count })}
                      />
                    </Field>
                  )}
                  {rule.endType === "never" && (
                    <div className="form-field recurrence-summary">
                      <span>结束条件</span>
                      <p>持续安排</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
          {o?.recurring && (
            <Field label="修改范围" id="taskScope">
              <Choice
                id="taskScope"
                label="修改范围"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "", label: "请选择修改范围" },
                  { value: "only", label: "仅这一次" },
                  { value: "future", label: "本次及以后" },
                  { value: "all", label: "整个任务系列" },
                ]}
              />
            </Field>
          )}
          {overlap && (
            <p className="notice" id="taskNotice">
              这个时段已有其他任务。再次点击保存仍可保存。
            </p>
          )}
          <ErrorText message={action.error} id="taskError" />
        </fieldset>
      </form>
      {deleting && <DeleteTask o={o!} onClose={() => setDeleting(false)} finish={onClose} />}
    </Modal>
  )
}
function DeleteTask({
  o,
  onClose,
  finish,
}: {
  o: Occurrence
  onClose: () => void
  finish: () => void
}) {
  const [scope, setScope] = useState("only")
  return (
    <Confirm
      title="删除任务？"
      description="已完成的历史记录和积分流水会保留。"
      label="删除任务"
      work={async () => {
        await runtime.command("task.delete", {
          occurrenceKey: o.occurrenceKey,
          scope: o.recurring ? scope : "series",
        })
        finish()
      }}
      onClose={onClose}
    >
      {o.recurring && (
        <Field id="deleteTaskScope" label="删除范围">
          <Choice
            id="deleteTaskScope"
            label="删除范围"
            value={scope}
            onChange={setScope}
            options={[
              { value: "only", label: "仅这一次" },
              { value: "series", label: "整个系列的未完成安排" },
            ]}
          />
        </Field>
      )}
    </Confirm>
  )
}
export function PresetEditor({
  id,
  data,
  onClose,
}: {
  id?: string
  data: BusinessData
  onClose: () => void
}) {
  const p = data.taskPresets.find((p) => p.id === id),
    [value, setValue] = useState({
      title: p?.title || "",
      categoryId: p?.categoryId || data.categories.find((c) => c.active)?.id || "",
      startTime: p?.startTime || "17:00",
      endTime: p?.endTime || "17:30",
      points: p?.points ?? 5,
    }),
    action = useAsync()
  const update = (next: Partial<typeof value>) => setValue((v) => ({ ...v, ...next }))
  return (
    <Modal
      id="taskPresetEditorDialog"
      title={p ? "编辑常用任务" : "添加常用任务"}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" type="button" disabled={action.busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="taskPresetForm" disabled={action.busy}>
            {action.busy ? "正在保存…" : "保存配置"}
          </Button>
        </>
      }
    >
      <form
        id="taskPresetForm"
        onSubmit={(e) => {
          e.preventDefault()
          void action.run(async () => {
            if (value.endTime <= value.startTime) throw Error("结束时间必须晚于开始时间。")
            if (!data.categories.some((c) => c.id === value.categoryId && c.active))
              throw Error("请选择可用的任务类型。")
            await runtime.command("preset.save", { preset: { ...(id ? { id } : {}), ...value } })
            onClose()
          })
        }}
      >
        <fieldset disabled={action.busy}>
          <Field label="任务名称" id="presetTitle">
            <Input
              id="presetTitle"
              value={value.title}
              onChange={(e) => update({ title: e.target.value })}
              required
              maxLength={80}
            />
          </Field>
          <Field label="任务类型" id="presetCategory">
            <Choice
              id="presetCategory"
              label="任务类型"
              openDownwards
              value={value.categoryId}
              onChange={(categoryId) => update({ categoryId })}
              options={data.categories
                .filter((c) => c.active)
                .map((c) => ({ value: c.id, label: c.name, color: c.color }))}
            />
          </Field>
          <div className="form-grid">
            <Field label="开始时间" id="presetStart">
              <TimePicker
                id="presetStart"
                value={value.startTime}
                onChange={(startTime) => update({ startTime })}
              />
            </Field>
            <Field label="结束时间" id="presetEnd">
              <TimePicker
                id="presetEnd"
                value={value.endTime}
                onChange={(endTime) => update({ endTime })}
              />
            </Field>
          </div>
          <Field label="奖励积分" id="presetPoints">
            <Input
              id="presetPoints"
              type="number"
              min={0}
              max={9999}
              value={value.points}
              onChange={(e) => update({ points: Number(e.target.value) })}
              required
            />
          </Field>
          <ErrorText message={action.error} id="taskPresetEditorError" />
        </fieldset>
      </form>
    </Modal>
  )
}
export function CategoryEditor({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState(""),
    [color, setColor] = useState("#5b8def"),
    action = useAsync()
  return (
    <Modal
      id="categoryCreateDialog"
      title="添加任务类型"
      size="small"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" disabled={action.busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="categoryCreateForm" disabled={action.busy}>
            {action.busy ? "正在添加…" : "添加类型"}
          </Button>
        </>
      }
    >
      <form
        id="categoryCreateForm"
        onSubmit={(e) => {
          e.preventDefault()
          void action.run(async () => {
            await runtime.command("category.save", { category: { name: name.trim(), color } })
            onClose()
          })
        }}
      >
        <fieldset disabled={action.busy}>
          <Field id="newCategoryName" label="类型名称">
            <Input
              id="newCategoryName"
              required
              maxLength={20}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field id="newCategoryColor" label="类型颜色">
            <Input
              id="newCategoryColor"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </Field>
          <ErrorText message={action.error} />
        </fieldset>
      </form>
    </Modal>
  )
}

function MonthCalendar({
  data,
  target,
  navigation,
  openTask,
  onToggle,
  onEdit,
  readOnly,
  busy,
  pendingOccurrences,
  onMonth,
  savedPosition,
  onPosition,
}: {
  data: BusinessData
  target: string
  navigation: number
  openTask: (options: Options) => void
  onToggle: (o: Occurrence) => void
  onEdit: (o: Occurrence) => void
  readOnly: boolean
  busy: boolean
  pendingOccurrences: ReadonlySet<string>
  onMonth: (m: string, date: string) => void
  savedPosition?: { date: string; offset: number }
  onPosition: (position: { date: string; offset: number }) => void
}) {
  const windowFor = (date: string) => ({ start: shiftMonth(date, -2), end: shiftMonth(date, 3) })
  const [windowRange, setWindowRange] = useState(() => windowFor(target)),
    scroll = useRef<HTMLDivElement>(null),
    position = useRef<{ date: string; offset?: number } | null>(savedPosition || { date: target }),
    prepend = useRef<{ top: number; height: number } | null>(null),
    frame = useRef(0),
    [touch, setTouch] = useState(() => window.matchMedia("(pointer: coarse)").matches)
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)")
    const sync = () => setTouch(query.matches)
    query.addEventListener("change", sync)
    return () => query.removeEventListener("change", sync)
  }, [])
  const from = startWeek(windowRange.start + "-01"),
    to = addDays(startWeek(addDays(shiftMonth(windowRange.end, 1) + "-01", -1)), 6),
    items = useMemo(() => occurrences(data, from, to), [data, from, to]),
    byDay = new Map<string, Occurrence[]>()
  for (const o of items) byDay.set(o.date, [...(byDay.get(o.date) || []), o])
  useLayoutEffect(() => {
    position.current = savedPosition?.date === target ? savedPosition : { date: target }
    setWindowRange(windowFor(target))
  }, [target, navigation])
  useLayoutEffect(() => {
    const el = scroll.current
    if (!el) return
    if (position.current) {
      const cell = el.querySelector<HTMLElement>(`[data-cell-day="${position.current.date}"]`)
      if (cell) {
        const top = cell.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
        el.scrollTop = Math.max(
          0,
          top - (position.current.offset ?? (target === today() ? cell.offsetHeight : 45)),
        )
        position.current = null
      }
    } else if (prepend.current) {
      el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height
      prepend.current = null
    }
  }, [windowRange, target])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  function onScroll() {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const el = scroll.current
      if (!el || position.current) return
      const line = el.getBoundingClientRect().top + Math.min(el.clientHeight * 0.22, 130),
        cells = Array.from(el.querySelectorAll<HTMLElement>("[data-cell-day]")),
        row = cells.filter((c) => {
          const rect = c.getBoundingClientRect()
          return rect.top <= line && rect.bottom > line
        }),
        cell = row.find((c) => c.dataset.cellDay?.endsWith("-01")) || row[0]
      if (cell) {
        const date = cell.dataset.cellDay!
        onMonth(date.slice(0, 7), date)
        onPosition({
          date,
          offset: cell.getBoundingClientRect().top - el.getBoundingClientRect().top,
        })
      }
      if (el.scrollTop < 360) {
        prepend.current = { top: el.scrollTop, height: el.scrollHeight }
        setWindowRange((r) => ({ ...r, start: shiftMonth(r.start, -1) }))
      } else if (el.scrollHeight - el.scrollTop - el.clientHeight < 360)
        setWindowRange((r) => ({ ...r, end: shiftMonth(r.end, 1) }))
    })
  }
  return (
    <div
      className={`month-scroll ${touch ? "touch-month" : "pointer-month"}`}
      id="monthCalendar"
      ref={scroll}
      onScroll={onScroll}
      tabIndex={0}
      aria-label="连续月历，滚动查看前后月份"
    >
      <div className="weekday-row">
        {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="month-grid">
        {rangeDates(from, to).map((date) => {
          const tasks = byDay.get(date) || [],
            first = date.endsWith("-01")
          return (
            <div
              className={`month-cell month-band-${Number(date.slice(5, 7)) % 2} ${parseDate(date).getDay() % 6 === 0 ? "weekend" : ""} ${date === today() ? "today" : ""} ${first ? "month-start" : ""}`}
              key={date}
              data-cell-day={date}
            >
              <Button
                variant="ghost"
                className="day-open"
                data-day={date}
                aria-label={`${date === today() ? "今天，" : ""}${fmtFull(date)}，${tasks.length}项任务，新建任务`}
                disabled={readOnly}
                onClick={() => {
                  if (!busy) openTask({ date })
                }}
              >
                <span>{first ? `${Number(date.slice(5, 7))}月1日` : Number(date.slice(8))}</span>
              </Button>
              <div className="month-tasks">
                {tasks.map((o) => (
                  <div
                    key={o.occurrenceKey}
                    className={`month-task ${isDone(data, o) ? "done" : ""}`}
                    data-month-occ={o.occurrenceKey}
                    aria-busy={pendingOccurrences.has(o.occurrenceKey) || undefined}
                    style={
                      {
                        "--task-color":
                          data.categories.find((c) => c.id === o.categoryId)?.color || "#68716c",
                      } as React.CSSProperties
                    }
                  >
                    <CalendarTaskActions
                      occurrence={o}
                      completed={isDone(data, o)}
                      readOnly={readOnly}
                      busy={pendingOccurrences.has(o.occurrenceKey)}
                      onToggle={onToggle}
                      onEdit={onEdit}
                    />
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

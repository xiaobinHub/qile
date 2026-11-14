import { useContext, useEffect, useId, useRef, useState } from "react"
import { Calendar } from "@shared/components/ui/calendar"
import { Checkbox } from "@shared/components/ui/checkbox"
import { Badge } from "@shared/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@shared/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@shared/components/ui/field"
import { Separator } from "@shared/components/ui/separator"
import { Switch } from "@shared/components/ui/switch"
import { ChevronLeft, ChevronRight, Info, Plus, Star } from "lucide-react"
import { getTeachers } from "./api"
import { AutoBookingTimePicker, PriorityList } from "./auto-booking-controls"
import { dateStr, parseDate, shiftMonth } from "./calendar-date"
import { PageActiveContext } from "./contexts"
import { Avatar, Button, Empty, Input, Notice, NumberPicker, Overlay, teacherName } from "./ui"
import type {
  AutoBookingConfig,
  AutoBookingTeacher,
  AutoBookingWeekday,
  PluginContext,
  Teacher,
} from "./types"

export const autoBookingWeekdays: { key: AutoBookingWeekday; label: string }[] = [
  { key: "1", label: "周一" },
  { key: "2", label: "周二" },
  { key: "3", label: "周三" },
  { key: "4", label: "周四" },
  { key: "5", label: "周五" },
  { key: "6", label: "周六" },
  { key: "7", label: "周日" },
]

function FavoriteTeachers({
  context,
  selected,
  active,
  disabled,
  onChange,
  onClose,
}: {
  context: PluginContext
  selected: AutoBookingTeacher[]
  active: boolean
  disabled: boolean
  onChange(teachers: AutoBookingTeacher[]): void
  onClose(): void
}) {
  const [items, setItems] = useState<Teacher[]>([])
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  const cursor = useRef<string | null>(null)
  const complete = useRef(false)
  const seen = useRef(new Set<string>())
  useEffect(() => {
    let cancelled = false
    if (!active || context.signal.aborted || complete.current) {
      setLoading(false)
      return
    }
    const current = () => !cancelled && !context.signal.aborted
    setLoading(true)
    setError("")
    async function load() {
      try {
        do {
          const result = await getTeachers(
            context,
            new URLSearchParams({ favoritesOnly: "1" }),
            cursor.current,
          )
          if (!current()) return
          setItems((old) =>
            Array.from(new Map([...old, ...result.items].map((item) => [item.id, item])).values()),
          )
          if (result.nextCursor && seen.current.has(result.nextCursor))
            throw new Error("收藏列表分页重复，请关闭后重新打开。")
          if (result.nextCursor) seen.current.add(result.nextCursor)
          cursor.current = result.nextCursor
          complete.current = !result.nextCursor
        } while (!complete.current && current())
      } catch (reason) {
        if (current()) setError((reason as Error).message)
      } finally {
        if (current()) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [context, active, retry])
  const visible = items.filter((item) =>
    item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  )
  return (
    <Overlay
      drawer
      title="从收藏添加老师"
      onClose={onClose}
      footer={<Button onClick={onClose}>完成 · 已选 {selected.length} 位</Button>}
    >
      <Input
        aria-label="搜索收藏老师"
        type="search"
        placeholder="搜索收藏老师"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <p className="mison-caption">按添加顺序确定优先级，添加后可继续排序。</p>
      {loading ? (
        <p className="mison-caption" role="status">
          正在加载全部收藏老师，已读取 {items.length} 位…
        </p>
      ) : null}
      {error ? (
        <Notice error>
          {error}
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => setRetry((value) => value + 1)}
          >
            继续加载
          </Button>
        </Notice>
      ) : null}
      <FieldSet>
        <FieldLegend className="sr-only">收藏老师</FieldLegend>
        <FieldGroup className="mison-auto-favorites">
          {visible.map((item) => {
            const checked = selected.some((teacher) => teacher.id === item.id)
            return (
              <Field key={item.id} orientation="horizontal">
                <Checkbox
                  id={`mison-auto-favorite-${item.id}`}
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(next) =>
                    onChange(
                      next === true
                        ? [...selected, { id: item.id, name: item.name, avatarUrl: item.avatarUrl }]
                        : selected.filter((teacher) => teacher.id !== item.id),
                    )
                  }
                />
                <FieldLabel htmlFor={`mison-auto-favorite-${item.id}`}>
                  <Avatar name={item.name} url={item.avatarUrl} compact />
                  {teacherName(item.name)}
                </FieldLabel>
              </Field>
            )
          })}
        </FieldGroup>
      </FieldSet>
      {!loading && !error && !visible.length ? (
        <Empty title={search ? "没有匹配的收藏老师" : "暂无收藏老师"} icon={<Star />}>
          请先在“教师与约课”中收藏老师。
        </Empty>
      ) : null}
    </Overlay>
  )
}

function WeekdaySlots({
  weekday,
  day,
  slots,
  disabled,
  onChange,
}: {
  weekday: AutoBookingWeekday
  day: string
  slots: string[]
  disabled: boolean
  onChange(slots: string[]): void
}) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const choices = Array.from({ length: 36 }, (_, index) => {
    const minutes = 5 * 60 + index * 30
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
  })
  function close() {
    setOpen(false)
    setPicked([])
  }
  function confirm() {
    if (disabled || !picked.length) return
    onChange([...slots, ...picked.filter((time) => !slots.includes(time))])
    close()
  }
  return (
    <div
      className="mison-auto-weekday"
      data-picker={open ? "open" : "closed"}
      data-weekday={weekday}
      role="group"
      aria-label={`${day}时段优先级`}
    >
      <h3>{day}</h3>
      <div className="mison-auto-weekday-slots">
        <PriorityList
          items={slots}
          itemKey={(item) => item}
          itemLabel={(item) => `${day} ${item}`}
          render={(item) => <time>{item}</time>}
          disabled={disabled}
          onChange={onChange}
          compact
        />
        {!slots.length ? (
          <Badge variant="secondary" className="mison-auto-no-slots">
            不预约
          </Badge>
        ) : null}
        {!disabled ? (
          <>
            <Button
              variant="outline"
              size="sm"
              aria-expanded={open}
              aria-controls={`mison-auto-slot-picker-${weekday}`}
              aria-label={`${day}添加时段`}
              onClick={() => (open ? close() : setOpen(true))}
            >
              <Plus data-icon="inline-start" />
              添加时段
            </Button>
            {slots.length ? (
              <Button
                variant="outline"
                size="sm"
                aria-label={`清空${day}`}
                onClick={() => onChange([])}
              >
                清空
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {open && !disabled ? (
        <div
          id={`mison-auto-slot-picker-${weekday}`}
          className="mison-auto-slot-picker"
          role="group"
          aria-label={`${day}可添加时段`}
        >
          <p>点选要添加的时段（可多选，灰色表示已在列表）</p>
          <div className="mison-auto-slot-choices">
            {choices.map((time) => {
              const existing = slots.includes(time)
              const selected = picked.includes(time)
              return (
                <Button
                  key={time}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-pressed={existing || selected}
                  disabled={existing}
                  data-existing={existing ? "true" : "false"}
                  className={
                    selected ? "mison-auto-slot-choice is-selected" : "mison-auto-slot-choice"
                  }
                  onClick={() =>
                    setPicked((current) =>
                      current.includes(time)
                        ? current.filter((item) => item !== time)
                        : [...current, time],
                    )
                  }
                >
                  <time>{time}</time>
                </Button>
              )
            })}
          </div>
          <div className="mison-auto-slot-picker-actions">
            <Button disabled={!picked.length} onClick={confirm}>
              确认添加{picked.length ? ` · ${picked.length}` : ""}
            </Button>
            <Button variant="outline" onClick={close}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function AutoBookingSettings({
  context,
  value,
  canManage,
  busy,
  active,
  serverDate,
  bookedDates,
  running = false,
  onChange,
  onSave,
  onReload,
  dirty,
  uncertain,
}: {
  context: PluginContext
  value: AutoBookingConfig
  canManage: boolean
  busy: boolean
  active: boolean
  serverDate: string
  bookedDates: string[]
  running?: boolean
  onChange(value: AutoBookingConfig): void
  onSave(): void
  onReload(): void
  dirty: boolean
  uncertain: boolean
}) {
  const pageActive = useContext(PageActiveContext)
  const [favoritesOpen, setFavoritesOpen] = useState(false)
  const [month, setMonth] = useState(() =>
    parseDate(value.dates.find((date) => date >= serverDate) || serverDate),
  )
  const prefix = useId()
  const disabled = !canManage || busy || uncertain || !active || !pageActive
  const banner = !canManage
    ? `当前任务${running ? "运行中" : "已停止"}，仅儿童负责人可修改设置`
    : uncertain
      ? "保存结果待核对，请核对原保存后继续修改"
      : running
        ? "当前任务运行中，修改后点击保存生效"
        : dirty
          ? "当前任务已停止，修改后点击保存生效"
          : "当前任务已停止，保存设置后可开启任务"
  function moveMonth(amount: number) {
    setMonth(parseDate(`${shiftMonth(dateStr(month), amount)}-01`))
  }
  return (
    <form
      className="mison-auto-settings"
      onSubmit={(event) => {
        event.preventDefault()
        if (canManage && !busy) onSave()
      }}
      aria-label="自动约课设置"
    >
      <div className="mison-auto-settings-scroll">
        <Notice className="mison-auto-settings-notice">
          <Info aria-hidden />
          {banner}
        </Notice>
        <div className="mison-auto-settings-grid">
          <Card className="mison-auto-settings-card mison-auto-teachers-card">
            <CardHeader>
              <CardTitle>
                <h2 id={`${prefix}-teachers`}>目标老师</h2>
              </CardTitle>
              <CardDescription>从收藏中选择，越靠上越优先</CardDescription>
              {canManage ? (
                <CardAction>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="添加收藏老师"
                    disabled={disabled}
                    onClick={() => setFavoritesOpen(true)}
                  >
                    <Plus data-icon="inline-start" />
                    添加老师
                  </Button>
                </CardAction>
              ) : null}
            </CardHeader>
            <CardContent>
              <FieldSet aria-labelledby={`${prefix}-teachers`}>
                <PriorityList
                  items={value.teachers}
                  itemKey={(teacher) => teacher.id}
                  itemLabel={(teacher) => teacher.name}
                  render={(teacher) => (
                    <div className="mison-auto-teacher-copy">
                      <Avatar name={teacher.name} url={teacher.avatarUrl} compact />
                      <span>{teacherName(teacher.name)}</span>
                    </div>
                  )}
                  disabled={disabled}
                  onChange={(teachers) => onChange({ ...value, teachers })}
                />
                {!value.teachers.length ? <p className="mison-caption">尚未选择老师。</p> : null}
              </FieldSet>
              <Notice className="mison-auto-priority-hint">
                <Info aria-hidden />
                选择顺序：先老师，再时段
              </Notice>
              <p className="sr-only">之后取消收藏不会移除本策略中的老师。</p>
            </CardContent>
          </Card>
          <Card className="mison-auto-settings-card mison-auto-execution-card">
            <CardHeader>
              <CardTitle>
                <h2 id={`${prefix}-execution`}>执行设置</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup
                aria-labelledby={`${prefix}-execution`}
                className="mison-auto-execution-fields"
              >
                <Field orientation="horizontal" className="mison-auto-execution-row">
                  <FieldLabel>检查间隔</FieldLabel>
                  <span className="mison-caption">4–6 分钟随机</span>
                </Field>
                <Separator />
                <FieldGroup className="mison-auto-execution-sleep">
                  <Field orientation="horizontal" className="mison-auto-execution-row">
                    <FieldLabel htmlFor={`${prefix}-sleep`}>启用休眠</FieldLabel>
                    <Switch
                      id={`${prefix}-sleep`}
                      checked={value.sleep.enabled}
                      disabled={disabled}
                      onCheckedChange={(enabled) =>
                        onChange({ ...value, sleep: { ...value.sleep, enabled } })
                      }
                    />
                  </Field>
                  <div className="mison-auto-sleep-range">
                    <Field>
                      <FieldLabel htmlFor={`${prefix}-sleep-start`} className="sr-only">
                        休眠开始
                      </FieldLabel>
                      <AutoBookingTimePicker
                        id={`${prefix}-sleep-start`}
                        label="休眠开始"
                        value={value.sleep.start}
                        disabled={disabled || !value.sleep.enabled}
                        onChange={(start) =>
                          onChange({ ...value, sleep: { ...value.sleep, start } })
                        }
                      />
                    </Field>
                    <span aria-hidden>–</span>
                    <Field>
                      <FieldLabel htmlFor={`${prefix}-sleep-end`} className="sr-only">
                        休眠结束
                      </FieldLabel>
                      <AutoBookingTimePicker
                        id={`${prefix}-sleep-end`}
                        label="休眠结束"
                        value={value.sleep.end}
                        disabled={disabled || !value.sleep.enabled}
                        onChange={(end) => onChange({ ...value, sleep: { ...value.sleep, end } })}
                      />
                    </Field>
                  </div>
                  <FieldDescription>
                    {value.sleep.start > value.sleep.end ? "次日恢复" : "当天恢复"} · 北京时间
                  </FieldDescription>
                </FieldGroup>
                <Separator />
                <Field
                  orientation="horizontal"
                  className="mison-auto-execution-row mison-auto-advance-field"
                >
                  <FieldLabel htmlFor={`${prefix}-notice`}>最少提前预约</FieldLabel>
                  <NumberPicker
                    id={`${prefix}-notice`}
                    label="最少提前小时数"
                    value={value.minNoticeHours}
                    min={0}
                    step={1}
                    disabled={disabled}
                    onChange={(minNoticeHours) => onChange({ ...value, minNoticeHours })}
                  />
                  <span>小时</span>
                </Field>
                <Separator />
              </FieldGroup>
              <FieldSet className="mison-auto-booking-rules" aria-label="预约规则">
                <Field
                  orientation="horizontal"
                  className="mison-auto-execution-row mison-auto-advance-field"
                >
                  <FieldLabel htmlFor={`${prefix}-daily`}>每天最多预约</FieldLabel>
                  <NumberPicker
                    id={`${prefix}-daily`}
                    label="每天最多预约节数"
                    value={value.dailyLessons}
                    min={1}
                    max={4}
                    step={1}
                    disabled={disabled}
                    onChange={(dailyLessons) => onChange({ ...value, dailyLessons })}
                  />
                  <span>节</span>
                </Field>
                <FieldDescription>两节及以上只预约同一老师的连续时段。</FieldDescription>
                <Field orientation="horizontal" className="mison-auto-rule-option">
                  <Checkbox
                    id={`${prefix}-rebook`}
                    checked={value.rebookCancelled}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      onChange({ ...value, rebookCancelled: checked === true })
                    }
                  />
                  <FieldLabel htmlFor={`${prefix}-rebook`}>取消课程后自动补约</FieldLabel>
                </Field>
                <FieldDescription>未勾选时，自动预约被取消后当天不再补约。</FieldDescription>
              </FieldSet>
            </CardContent>
          </Card>
          <Card className="mison-auto-settings-card mison-auto-dates-card">
            <CardHeader>
              <CardTitle>
                <h2 id={`${prefix}-dates`}>
                  约课日期 <Badge variant="secondary">已选 {value.dates.length} 天</Badge>
                </h2>
              </CardTitle>
              <CardAction className="mison-auto-month-actions">
                <div className="mison-auto-month-navigation">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="上个月"
                    onClick={() => moveMonth(-1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <span aria-live="polite">
                    {month.getFullYear()}年{month.getMonth() + 1}月
                  </span>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="下个月"
                    onClick={() => moveMonth(1)}
                  >
                    <ChevronRight />
                  </Button>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled || !value.dates.length}
                  onClick={() => onChange({ ...value, dates: [] })}
                >
                  清空选择
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <Calendar
                mode="multiple"
                className="mison-auto-month-calendar"
                month={month}
                onMonthChange={setMonth}
                today={parseDate(serverDate)}
                selected={value.dates.map(parseDate)}
                modifiers={{ booked: bookedDates.map(parseDate) }}
                modifiersClassNames={{ booked: "mison-auto-calendar-booked" }}
                hideNavigation
                showOutsideDays={false}
                classNames={{
                  months: "mison-auto-calendar-months",
                  month: "mison-auto-calendar-month",
                  month_caption: "sr-only",
                  month_grid: "mison-auto-calendar-grid",
                  weekdays: "mison-auto-calendar-weekdays",
                  weekday: "mison-auto-calendar-weekday",
                  week: "mison-auto-calendar-week",
                  day: "mison-auto-calendar-day",
                  day_button: "mison-auto-calendar-day-button",
                  selected: "mison-auto-calendar-selected",
                  today: "mison-auto-calendar-today",
                  hidden: "mison-auto-calendar-hidden",
                }}
                disabled={(date) =>
                  disabled || (dateStr(date) < serverDate && !value.dates.includes(dateStr(date)))
                }
                onSelect={(dates) => {
                  if (!disabled) onChange({ ...value, dates: (dates ?? []).map(dateStr).sort() })
                }}
              />
              <div className="mison-auto-calendar-legend">
                <span>
                  <i className="mison-auto-selected-swatch" aria-hidden />
                  黄色为选中日期
                </span>
                <span>
                  <i className="mison-auto-booked-swatch" aria-hidden />
                  蓝点表示已有课程
                </span>
                <small>仅预约选中日期；已约日期会自动跳过</small>
              </div>
            </CardContent>
          </Card>
          <Card className="mison-auto-settings-card mison-auto-weekly-card">
            <CardHeader>
              <CardTitle>
                <h2 id={`${prefix}-weekdays`}>每周时段</h2>
              </CardTitle>
              <CardDescription>拖动时段调整优先级，左侧优先；未设置的星期不约</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldSet aria-labelledby={`${prefix}-weekdays`} className="mison-auto-weekday-rows">
                {autoBookingWeekdays.map(({ key, label }) => (
                  <WeekdaySlots
                    key={key}
                    weekday={key}
                    day={label}
                    slots={value.weekdaySlots[key]}
                    disabled={disabled}
                    onChange={(slots) =>
                      onChange({ ...value, weekdaySlots: { ...value.weekdaySlots, [key]: slots } })
                    }
                  />
                ))}
              </FieldSet>
            </CardContent>
          </Card>
        </div>
      </div>
      <Separator />
      <footer className="mison-auto-footer mison-auto-settings-footer">
        <small role="status">
          {value.dates.length} 个目标日期 · {value.teachers.length} 位老师 · 每天最多{" "}
          {value.dailyLessons} 节
          {uncertain ? " · 请核对原保存结果" : dirty ? " · 有未保存的修改" : ""}
        </small>
        {canManage ? (
          <Button
            variant="outline"
            disabled={busy || uncertain || !active || !pageActive || !dirty}
            onClick={onReload}
          >
            放弃修改
          </Button>
        ) : null}
        {canManage ? (
          <Button type="submit" disabled={busy || !active || !pageActive}>
            {busy ? "正在保存…" : uncertain ? "核对并重试原保存" : "保存设置"}
          </Button>
        ) : null}
      </footer>
      {favoritesOpen ? (
        <FavoriteTeachers
          context={context}
          selected={value.teachers}
          active={active && pageActive}
          disabled={disabled}
          onChange={(teachers) => {
            if (!disabled) onChange({ ...value, teachers })
          }}
          onClose={() => setFavoritesOpen(false)}
        />
      ) : null}
    </form>
  )
}

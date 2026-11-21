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
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@shared/components/ui/field"
import { Separator } from "@shared/components/ui/separator"
import { ChevronLeft, ChevronRight, Info, Plus, Settings, Star } from "lucide-react"
import { getTeachers } from "./api"
import {
  PriorityList,
} from "./auto-booking-controls"
import { dateStr, parseDate, shiftMonth } from "./calendar-date"
import { PageActiveContext } from "./contexts"
import { AutoBookingExecutionSettings } from "./auto-booking-execution-settings"
import { Avatar, Button, Empty, Input, Notice, Overlay, teacherName } from "./ui"
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
      title="添加老师"
      onClose={onClose}
      footer={
        <>
          <small>已选 {selected.length} 位</small>
          <Button onClick={onClose}>完成</Button>
        </>
      }
    >
      <Input
        aria-label="搜索收藏老师"
        type="search"
        placeholder="搜索收藏老师"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
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
      <FieldSet className="mison-auto-favorites-fieldset">
        <FieldLegend className="sr-only">收藏老师</FieldLegend>
        <FieldGroup className="mison-auto-favorites">
          {visible.map((item) => {
            const checked = selected.some((teacher) => teacher.id === item.id)
            return (
              <Field key={item.id} orientation="horizontal" data-selected={checked}>
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
                  <span>{teacherName(item.name)}</span>
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
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (disabled) {
      setOpen(false)
      setPicked([])
    }
  }, [disabled])
  const availableTimes = Array.from({ length: 36 }, (_, index) => {
    const minutes = 5 * 60 + index * 30
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
  })
  const choices = Array.from(new Set([...availableTimes, ...slots])).sort()
  function close() {
    setOpen(false)
    setPicked([])
    trigger.current?.focus({ preventScroll: true })
  }
  function confirm() {
    if (disabled) return
    onChange(picked)
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
          disabled={disabled || open}
          onChange={onChange}
          compact
          removable={false}
        />
        {!slots.length ? (
          <Badge variant="secondary" className="mison-auto-no-slots">
            不预约
          </Badge>
        ) : null}
        {!disabled ? (
          <div className="mison-auto-weekday-actions">
            <Button
              ref={trigger}
              variant="ghost"
              size="icon-sm"
              aria-expanded={open}
              aria-controls={`mison-auto-slot-picker-${weekday}`}
              aria-label={`${day}设置时段`}
              title={`${day}设置时段`}
              onClick={() => {
                if (open) close()
                else {
                  setPicked([...slots])
                  setOpen(true)
                }
              }}
            >
              <Settings />
            </Button>
          </div>
        ) : null}
      </div>
      {open && !disabled ? (
        <div
          id={`mison-auto-slot-picker-${weekday}`}
          className="mison-auto-slot-picker"
          role="group"
          aria-label={`${day}时段设置`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              event.stopPropagation()
              close()
            }
          }}
        >
          <h4>选择时段</h4>
          <div className="mison-auto-slot-choices">
            {choices.map((time) => {
              const selected = picked.includes(time)
              return (
                <Button
                  key={time}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-pressed={selected}
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
            <Button onClick={confirm}>
              保存
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
  const futureDates = value.dates.filter((date) => date >= serverDate)
  const missingSlots = futureDates.filter(
    (date) =>
      !value.weekdaySlots[String(parseDate(date).getDay() || 7) as AutoBookingWeekday].length,
  )
  const disabled = !canManage || busy || uncertain || !active || !pageActive
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
        <div className="mison-auto-settings-grid">
          <Card className="mison-auto-settings-card mison-auto-teachers-card">
            <CardHeader>
              <CardTitle>
                <h2 id={`${prefix}-teachers`}>目标老师</h2>
              </CardTitle>
              <CardDescription>按顺序优先预约</CardDescription>
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
                      <span title={teacher.name}>{teacher.name.replace(/\s*老师$/, "")}</span>
                    </div>
                  )}
                  disabled={disabled}
                  onChange={(teachers) => onChange({ ...value, teachers })}
                />
                {!value.teachers.length ? (
                  <p className="mison-auto-teacher-empty">
                    还没有目标老师，点击“添加老师”从收藏中选择。
                  </p>
                ) : null}
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
                showOutsideDays
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
                  outside: "mison-auto-calendar-outside",
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
                  <i className="mison-auto-booked-swatch" aria-hidden />
                  已有课程
                </span>
              </div>
              {missingSlots.length ? (
                <p className="mison-auto-date-warning" role="status">
                  <Info aria-hidden />
                  {missingSlots.length} 个目标日期未配置每周时段，暂不会预约。
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card className="mison-auto-settings-card mison-auto-weekly-card">
            <CardHeader>
              <CardTitle>
                <h2 id={`${prefix}-weekdays`}>每周时段</h2>
              </CardTitle>
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
          <AutoBookingExecutionSettings
            context={context}
            value={value}
            canManage={canManage}
            busy={busy || uncertain}
            active={active && pageActive}
            onChange={onChange}
          />
        </div>
      </div>
      <Separator />
      <footer className="mison-auto-footer mison-auto-settings-footer">
        {dirty || uncertain ? (
          <small role="status">{uncertain ? "保存结果待确认" : "有未保存的修改"}</small>
        ) : null}
        {canManage && dirty ? (
          <Button
            variant="outline"
            disabled={busy || uncertain || !active || !pageActive}
            onClick={onReload}
          >
            放弃修改
          </Button>
        ) : null}
        {canManage ? (
          <Button
            type="submit"
            disabled={
              busy || !active || !pageActive || (!dirty && value.revision > 0 && !uncertain)
            }
          >
            {busy ? "处理中…" : uncertain ? "重试保存" : "保存设置"}
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

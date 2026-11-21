import { useCallback, useContext, useEffect, useRef, useState } from "react"
import { Badge } from "@shared/components/ui/badge"
import { Separator } from "@shared/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/components/ui/tabs"
import { Calendar } from "@shared/components/ui/calendar"
import { CalendarClock, ChevronLeft, ChevronRight, Play, RefreshCw } from "lucide-react"
import {
  getAutoBookingConfig,
  getAutoBookingStatus,
  PluginApiError,
  saveAutoBookingConfig,
  startAutoBooking,
  stopAutoBooking,
} from "./api"
import { useAutoBookingLive } from "./auto-booking-controls"
import { AutoBookingLogs } from "./auto-booking-logs"
import { AutoBookingSchedule, autoBookingTime } from "./auto-booking-schedule"
import { AutoBookingSettings, autoBookingWeekdays } from "./auto-booking-settings"
import { dateStr, parseDate, shiftMonth } from "./calendar-date"
import { PageActiveContext } from "./contexts"
import { operationId } from "./operation-id"
import { checkWindowLabel } from "./check-window"
import { Button, Empty, Notice, Overlay } from "./ui"
import type {
  AutoBookingConfig,
  AutoBookingSaveRequest,
  AutoBookingStatus,
  AutoBookingWeekday,
  PluginContext,
} from "./types"

function editableKey(config: AutoBookingConfig) {
  return JSON.stringify([
    config.teachers,
    config.dates,
    config.weekdaySlots,
    config.minNoticeHours,
    config.dailyLessons,
    config.rebookCancelled,
    config.checkInterval,
    config.notifications,
    config.sleep,
  ])
}
function normalizeConfig(config: AutoBookingConfig): AutoBookingConfig {
  return {
    ...config,
    weekdaySlots: Object.fromEntries(
      autoBookingWeekdays.map(({ key }) => [key, config.weekdaySlots?.[key] ?? []]),
    ) as AutoBookingConfig["weekdaySlots"],
    minNoticeHours: config.minNoticeHours ?? 25,
    dailyLessons: config.dailyLessons ?? 1,
    rebookCancelled: config.rebookCancelled ?? true,
    checkInterval: config.checkInterval ?? { minMinutes: 4, maxMinutes: 6 },
    notifications: {
      enabled: config.notifications?.enabled ?? false,
      barkKeys: config.notifications?.barkKeys ?? [],
      barkKeyNames:
        config.notifications?.barkKeyNames ?? config.notifications?.barkKeys?.map(() => "") ?? [],
      events: config.notifications?.events ?? ["booked"],
    },
    sleep: config.sleep ?? { enabled: true, start: "23:00", end: "08:00" },
  }
}
function startIssue(config: AutoBookingConfig, today: string) {
  if (!config.teachers.length) return "请选择至少一位收藏老师。"
  const dates = config.dates.filter((date) => date >= today)
  if (!dates.length) return "请选择至少一个尚未过去的预约日期。"
  if (
    !dates.some(
      (date) =>
        config.weekdaySlots[String(parseDate(date).getDay() || 7) as AutoBookingWeekday].length,
    )
  )
    return "请为目标日期对应的星期设置至少一个开课时段。"
  return ""
}
const definitiveError = (reason: unknown) =>
  reason instanceof PluginApiError &&
  !["UPSTREAM_UNAVAILABLE", "RESULT_UNCERTAIN"].includes(reason.code)
const states = { running: "运行中", stopped: "已停止", sleeping: "等待检查时段" }

export function AutoBooking({
  context,
  bindingRevision,
  serverDate,
  active,
}: {
  context: PluginContext
  bindingRevision: number
  serverDate: string
  active: boolean
}) {
  const pageActive = useContext(PageActiveContext)
  const visible = active && pageActive
  const live = useAutoBookingLive(context)
  const [view, setView] = useState("dashboard")
  const [config, setConfig] = useState<AutoBookingConfig | null>(null)
  const [draft, setDraft] = useState<AutoBookingConfig | null>(null)
  const [base, setBase] = useState("")
  const [status, setStatus] = useState<AutoBookingStatus | null>(null)
  const [configError, setConfigError] = useState("")
  const [statusError, setStatusError] = useState("")
  const [actionError, setActionError] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<"save" | "start" | "stop" | "reload" | null>(null)
  const [saveUncertain, setSaveUncertain] = useState(false)
  const [commandUncertain, setCommandUncertain] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [logsOpen, setLogsOpen] = useState(false)
  const [focusDate, setFocusDate] = useState<{ date: string; sequence: number } | null>(null)
  const [planMonth, setPlanMonth] = useState(() => serverDate.slice(0, 7))
  const [startConfirm, setStartConfirm] = useState(false)
  const [reloadConfirm, setReloadConfirm] = useState(false)
  const pendingSave = useRef<AutoBookingSaveRequest | null>(null)
  const pendingCommand = useRef<{
    kind: "start" | "stop"
    operationId: string
    expectedRevision: number
  } | null>(null)
  const lock = useRef(false)
  const initialized = useRef(false)
  const dirty = !!draft && editableKey(draft) !== base
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const statusSequence = useRef(0)
  const applyConfig = useCallback(
    (value: AutoBookingConfig, replace = false) => {
      if (value.bindingRevision !== bindingRevision)
        throw new Error("美森账号绑定已变化，请重新打开应用。")
      const next = normalizeConfig(value)
      setConfig(next)
      if (replace || !dirtyRef.current) {
        setDraft(next)
        setBase(editableKey(next))
      }
      if (!initialized.current) {
        initialized.current = true
        if (next.revision === 0 && !next.teachers.length && !next.dates.length) setView("settings")
      }
    },
    [bindingRevision],
  )
  const applyStatus = useCallback((value: AutoBookingStatus) => {
    setStatus(value)
    const command = pendingCommand.current
    if (command && (command.kind === "start" ? value.enabled : !value.enabled)) {
      pendingCommand.current = null
      setCommandUncertain(false)
      setActionError("")
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!visible || !live()) {
      setLoading(false)
      return
    }
    const current = () => !cancelled && live()
    setLoading(true)
    const sequence = ++statusSequence.current
    async function poll() {
      if (!current()) return
      const seq = ++statusSequence.current
      try {
        const result = await getAutoBookingStatus(context)
        if (current() && seq === statusSequence.current && !lock.current) {
          applyStatus(result)
          setStatusError("")
        }
      } catch (reason) {
        if (current() && seq === statusSequence.current) setStatusError((reason as Error).message)
      } finally {
        if (current()) timer = setTimeout(() => void poll(), 15000)
      }
    }
    void Promise.allSettled([getAutoBookingConfig(context), getAutoBookingStatus(context)]).then(
      ([configuration, running]) => {
        if (!current()) return
        if (!lock.current && sequence === statusSequence.current) {
          if (configuration.status === "fulfilled") {
            try {
              applyConfig(configuration.value)
              setConfigError("")
            } catch (reason) {
              setConfigError((reason as Error).message)
            }
          } else setConfigError((configuration.reason as Error).message)
          if (running.status === "fulfilled") {
            applyStatus(running.value)
            setStatusError("")
          } else setStatusError((running.reason as Error).message)
        }
        setLoading(false)
        timer = setTimeout(() => void poll(), 15000)
      },
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [context, visible, refresh, applyConfig, applyStatus, live])
  const canManage = !!config?.canManage && status?.canManage !== false
  const reconciling = status?.phase === "reconciling"
  const issue = config ? startIssue(config, serverDate) : "请先读取设置。"
  const startDisabledReason =
    loading || !status || statusError || configError
      ? "请先读取最新状态与设置。"
      : reconciling
        ? "预约结果待核对，当前仅核对已发请求，不会提交新预约。"
        : status.enabled
          ? "自动约课已开启。"
          : saveUncertain
            ? "请先核对保存结果。"
            : dirty
              ? "请先保存设置，或重新读取以放弃修改。"
              : issue
  const snapshot =
    status?.snapshot && status.snapshot.configRevision === config?.revision ? status.snapshot : null
  const targetDates = [...new Set(status?.targetDates ?? config?.dates ?? [])].sort()
  const fulfilledDates = new Set(status?.fulfilledDates ?? [])
  const dailyLessons = config?.dailyLessons ?? 1
  const plannedLessons = targetDates.length * dailyLessons
  const planMonthDates = targetDates.filter((date) => date.startsWith(planMonth))
  const planCompleted = planMonthDates.filter((date) => fulfilledDates.has(date)).length
  const focusPlanDate = (date: string) =>
    setFocusDate((previous) => ({ date, sequence: (previous?.sequence ?? 0) + 1 }))
  async function reloadConfig() {
    if (lock.current || !visible || !live() || !context.isActive()) return
    lock.current = true
    setBusy("reload")
    setActionError("")
    statusSequence.current++
    try {
      const value = await getAutoBookingConfig(context)
      if (!live()) return
      applyConfig(value, true)
      setConfigError("")
      setReloadConfirm(false)
      context.notify("已读取最新设置。")
    } catch (reason) {
      if (live()) setActionError((reason as Error).message)
    } finally {
      lock.current = false
      if (live()) setBusy(null)
    }
  }
  async function save() {
    if (!draft || !canManage || lock.current || !visible || !live() || !context.isActive()) return
    if (!Number.isInteger(draft.minNoticeHours) || draft.minNoticeHours < 0) {
      setActionError("提前小时数必须为非负整数。")
      return
    }
    if (!Number.isInteger(draft.dailyLessons) || draft.dailyLessons < 1 || draft.dailyLessons > 4) {
      setActionError("每天预约节数应为 1 至 4 节。")
      return
    }
    const { minMinutes, maxMinutes } = draft.checkInterval
    if (
      !Number.isInteger(minMinutes) ||
      !Number.isInteger(maxMinutes) ||
      minMinutes < 1 ||
      maxMinutes > 30 ||
      minMinutes > maxMinutes
    ) {
      setActionError("检查间隔应为 1 至 30 分钟，最短间隔不能大于最长间隔。")
      return
    }
    if (draft.sleep.start === draft.sleep.end) {
      setActionError("检查时间范围不正确。")
      return
    }
    const enteredDevices = draft.notifications.barkKeys.map((key, index) => ({
      key: key.trim(),
      name: draft.notifications.barkKeyNames?.[index]?.trim() ?? "",
    }))
    const seenKeys = new Set<string>()
    const devices = draft.notifications.enabled
      ? enteredDevices
      : enteredDevices.filter(({ key }) => {
          if (!/^[A-Za-z0-9_-]{8,128}$/.test(key) || seenKeys.has(key)) return false
          seenKeys.add(key)
          return true
        })
    const barkKeys = devices.map(({ key }) => key)
    const barkKeyNames = devices.map(({ name }) => name)
    if (barkKeyNames.some((name) => Array.from(name).length > 40)) {
      setActionError("设备名称最多40个字符。")
      return
    }
    if (barkKeys.length > 10) {
      setActionError("最多可填写 10 个 Bark Key。")
      return
    }
    if (draft.notifications.enabled && !barkKeys.length) {
      setActionError("开启消息提醒需要至少一个 Bark Key。")
      return
    }
    if (barkKeys.some((key) => !/^[A-Za-z0-9_-]{8,128}$/.test(key))) {
      setActionError("Bark Key 应为 8～128 位字母、数字、下划线或连字符。")
      return
    }
    if (new Set(barkKeys).size !== barkKeys.length) {
      setActionError("Bark Key 不能重复。")
      return
    }
    if (draft.notifications.enabled && !draft.notifications.events.length) {
      setActionError("开启消息提醒需要至少选择一个通知场景。")
      return
    }
    lock.current = true
    setBusy("save")
    setActionError("")
    statusSequence.current++
    try {
      const body = (pendingSave.current ??= {
        operationId: operationId(),
        bindingRevision,
        expectedRevision: draft.revision,
        teachers: draft.teachers,
        dates: draft.dates,
        weekdaySlots: draft.weekdaySlots,
        minNoticeHours: draft.minNoticeHours,
        dailyLessons: draft.dailyLessons,
        rebookCancelled: draft.rebookCancelled,
        checkInterval: draft.checkInterval,
        notifications: {
          enabled: draft.notifications.enabled,
          barkKeys,
          barkKeyNames,
          events: draft.notifications.events,
        },
        sleep: draft.sleep,
      })
      const value = await saveAutoBookingConfig(context, body)
      if (!live()) return
      applyConfig(value, true)
      pendingSave.current = null
      setSaveUncertain(false)
      setConfigError("")
      context.notify("设置已保存。")
      setRefresh((value) => value + 1)
    } catch (reason) {
      if (!live()) return
      const definitive = definitiveError(reason)
      if (definitive) pendingSave.current = null
      setSaveUncertain(!definitive)
      setActionError(
        definitive ? (reason as Error).message : "保存结果暂未确认，请核对并重试原保存。",
      )
    } finally {
      lock.current = false
      if (live()) setBusy(null)
    }
  }
  async function command(kind: "start" | "stop") {
    if (
      !config ||
      !canManage ||
      lock.current ||
      !visible ||
      !live() ||
      !context.isActive() ||
      (kind === "start" && startDisabledReason)
    )
      return
    lock.current = true
    setBusy(kind)
    setActionError("")
    statusSequence.current++
    try {
      if (pendingCommand.current?.kind !== kind)
        pendingCommand.current = {
          kind,
          operationId: operationId(),
          expectedRevision: config.revision,
        }
      const pending = pendingCommand.current
      const body = { operationId: pending.operationId, bindingRevision }
      const value =
        kind === "start"
          ? await startAutoBooking(context, { ...body, expectedRevision: pending.expectedRevision })
          : await stopAutoBooking(context, body)
      if (!live()) return
      applyStatus(value)
      pendingCommand.current = null
      setCommandUncertain(false)
      setStartConfirm(false)
      context.notify(
        kind === "start" ? "已开启后台自动约课。" : "已停止自动约课，已发出的请求仍会继续核对。",
      )
      setRefresh((value) => value + 1)
    } catch (reason) {
      if (!live()) return
      const definitive = definitiveError(reason)
      if (definitive) pendingCommand.current = null
      setCommandUncertain(!definitive)
      setStartConfirm(false)
      setActionError(
        definitive
          ? (reason as Error).message
          : "启停结果暂未确认，请刷新状态核对；重试将使用原操作编号。",
      )
      setRefresh((value) => value + 1)
    } finally {
      lock.current = false
      if (live()) setBusy(null)
    }
  }
  return (
    <Tabs value={view} onValueChange={setView} className="mison-auto-booking">
      <div className="mison-auto-toolbar">
        <TabsList variant="line" aria-label="自动约课页面">
          <TabsTrigger value="dashboard">运行看板</TabsTrigger>
          <TabsTrigger value="settings" aria-label="预约设置">
            预约设置{" "}
            {dirty ? <span className="mison-auto-unsaved-dot" aria-label="有未保存的修改" /> : null}
          </TabsTrigger>
        </TabsList>
        {config && !canManage ? (
          <div className="mison-actions">
            <Badge variant="outline" title="仅儿童负责人可修改设置">
              只读
            </Badge>
          </div>
        ) : null}
      </div>
      <Separator />
      {configError ? (
        <Notice error>
          {configError}
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            重试读取
          </Button>
        </Notice>
      ) : null}
      {statusError ? <Notice error>运行状态暂未更新：{statusError}</Notice> : null}
      {actionError ? <Notice error>{actionError}</Notice> : null}
      {!config && loading ? (
        <p className="mison-auto-feedback" role="status">
          正在读取自动约课设置与状态…
        </p>
      ) : null}
      <TabsContent
        value="dashboard"
        forceMount
        hidden={view !== "dashboard"}
        className="mison-auto-dashboard"
      >
        <div className="mison-auto-dashboard-status">
          <div
            className="mison-auto-summary"
            aria-label="自动约课运行统计"
            data-enabled={!!status?.enabled}
          >
            <div
              className="mison-auto-state"
              data-state={reconciling ? "reconciling" : status?.state}
            >
              <div className="mison-auto-state-copy">
                <div className="mison-auto-state-heading">
                  <strong>
                    <span className="mison-auto-state-dot" />
                    {reconciling ? "核对中" : status ? states[status.state] : "状态待加载"}
                  </strong>
                  <Button variant="ghost" onClick={() => setLogsOpen(true)} aria-label="运行记录">
                    运行记录 <ChevronRight data-icon="inline-end" />
                  </Button>
                </div>
                {status?.state === "sleeping" ? (
                  <small>下次检查时段从 {config?.sleep.end ?? "设定时间"} 开始</small>
                ) : null}
              </div>
              {canManage && config ? (
                status?.enabled || (commandUncertain && pendingCommand.current?.kind === "stop") ? (
                  <Button
                    variant="outline"
                    size="icon"
                    className="mison-auto-task-control"
                    data-action="stop"
                    aria-label={busy === "stop" ? "正在停止" : "停止任务"}
                    title={busy === "stop" ? "正在停止" : "停止任务"}
                    disabled={!!busy || !visible}
                    onClick={() => void command("stop")}
                  >
                    {busy === "stop" ? (
                      <RefreshCw className="animate-spin" aria-hidden />
                    ) : (
                      <span className="mison-auto-stop-mark" aria-hidden />
                    )}
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    className="mison-auto-task-control"
                    data-action="start"
                    aria-label={busy === "start" ? "正在开启" : "开启任务"}
                    title={startDisabledReason || (busy === "start" ? "正在开启" : "开启任务")}
                    disabled={!!busy || !visible || !!startDisabledReason}
                    onClick={() => setStartConfirm(true)}
                  >
                    {busy === "start" ? (
                      <RefreshCw className="animate-spin" aria-hidden />
                    ) : (
                      <Play className="mison-auto-play-icon" aria-hidden />
                    )}
                  </Button>
                )
              ) : null}
            </div>
            <div className="mison-auto-metrics">
              <div>
                <span>计划</span>
                <strong>
                  {status ? plannedLessons : "—"}
                  <small> 节</small>
                </strong>
              </div>
              <div>
                <span>完成</span>
                <strong>
                  {status?.completedLessons ?? "—"}
                  <small> 节</small>
                </strong>
              </div>
              <div>
                <span>累计自动预约</span>
                <strong>
                  {status?.totalBooked ?? "—"}
                  <small> 节</small>
                </strong>
              </div>
              <div>
                <span>累计检查</span>
                <strong>
                  {status?.checks ?? "—"}
                  <small> 次</small>
                </strong>
              </div>
              <div>
                <span>最近检查</span>
                <strong>{autoBookingTime(status?.lastCheckAt ?? null, true)}</strong>
              </div>
              <div>
                <span>下次检查</span>
                <strong>{autoBookingTime(status?.nextCheckAt ?? null, true)}</strong>
              </div>
            </div>
            <div className="mison-auto-current-config">
              <span>当前轮询配置</span>
              <p>
                {config
                  ? `每日 ${config.dailyLessons} 节 · 提前 ${config.minNoticeHours} 小时 · 检查时间 ${checkWindowLabel(config.sleep)} · ${config.rebookCancelled ? "取消后补约" : "取消后不补约"}`
                  : "—"}
              </p>
            </div>
          </div>
          <section className="mison-auto-plan" aria-label="预约计划">
            <div className="mison-auto-plan-calendar">
              <div className="mison-auto-plan-month">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="上个月"
                  onClick={() => setPlanMonth((month) => shiftMonth(month + "-01", -1))}
                >
                  <ChevronLeft />
                </Button>
                <span aria-live="polite">
                  {planMonth.slice(0, 4)}年{Number(planMonth.slice(5))}月
                  <small>
                    {planCompleted} / {planMonthDates.length}
                  </small>
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="下个月"
                  onClick={() => setPlanMonth((month) => shiftMonth(month + "-01", 1))}
                >
                  <ChevronRight />
                </Button>
              </div>
              <Calendar
                mode="multiple"
                className="mison-auto-month-calendar mison-auto-plan-month-calendar"
                month={parseDate(planMonth + "-01")}
                onMonthChange={(month) => setPlanMonth(dateStr(month).slice(0, 7))}
                today={parseDate(serverDate)}
                selected={targetDates.map(parseDate)}
                modifiers={{
                  completed: targetDates.filter((date) => fulfilledDates.has(date)).map(parseDate),
                  expired: targetDates
                    .filter((date) => date < serverDate && !fulfilledDates.has(date))
                    .map(parseDate),
                }}
                modifiersClassNames={{
                  completed: "mison-auto-plan-completed",
                  expired: "mison-auto-plan-expired",
                }}
                hideNavigation
                showOutsideDays
                formatters={{
                  formatWeekdayName: (date) =>
                    ["日", "一", "二", "三", "四", "五", "六"][date.getDay()],
                }}
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
                disabled={(date) => !targetDates.includes(dateStr(date))}
                onSelect={(_dates, date) => {
                  const value = dateStr(date)
                  if (targetDates.includes(value)) focusPlanDate(value)
                }}
                components={{
                  DayButton: ({ day, modifiers, children, ...props }) => {
                    const value = dateStr(day.date)
                    const planned = modifiers.selected
                    const state = modifiers.completed
                      ? "已完成"
                      : modifiers.expired
                        ? "已过期"
                        : "待约"
                    const weekend = [0, 6].includes(day.date.getDay())
                    return (
                      <button
                        type="button"
                        {...props}
                        data-weekend={weekend || undefined}
                        aria-label={planned ? `${value} ${state}` : undefined}
                      >
                        <time dateTime={value}>{children}</time>
                      </button>
                    )
                  },
                }}
              />
              <div className="mison-auto-calendar-legend" aria-hidden>
                <span>
                  <i className="mison-auto-plan-swatch" data-state="planned" />
                  计划
                </span>
                <span>
                  <i className="mison-auto-plan-swatch" data-state="completed" />
                  已完成
                </span>
                <span>
                  <i className="mison-auto-plan-swatch" data-state="expired" />
                  已过期
                </span>
              </div>
            </div>
          </section>
        </div>
        {reconciling || (canManage && !status?.enabled && startDisabledReason && !dirty) ? (
          <div className="mison-auto-running-copy" role="status">
            <p>
              {reconciling
                ? status?.message || "预约结果待核对，期间不会提交新预约。"
                : startDisabledReason}
            </p>
          </div>
        ) : null}
        <div className="mison-auto-schedule-area">
          {config?.teachers.length ? (
            <AutoBookingSchedule
              context={context}
              teachers={config.teachers}
              snapshot={snapshot}
              active={visible && view === "dashboard"}
              focusDate={focusDate}
              targetDates={config.dates}
              priorityTimes={(date) =>
                config.weekdaySlots[String(parseDate(date).getDay() || 7) as AutoBookingWeekday] ??
                []
              }
            />
          ) : config ? (
            <Empty title="尚未设置自动约课老师" icon={<CalendarClock />}>
              <Button variant="outline" onClick={() => setView("settings")}>
                {canManage ? "去配置预约规则" : "查看预约设置"}
                <ChevronRight />
              </Button>
            </Empty>
          ) : null}
        </div>
      </TabsContent>
      <TabsContent
        value="settings"
        forceMount
        hidden={view !== "settings"}
        className="mison-auto-settings-panel"
      >
        {draft ? (
          <AutoBookingSettings
            context={context}
            value={draft}
            canManage={canManage}
            busy={!!busy}
            active={visible && view === "settings"}
            serverDate={serverDate}
            bookedDates={status?.fulfilledDates ?? []}
            running={!!status?.enabled}
            onChange={(value) => {
              if (canManage && !busy && !saveUncertain && visible) {
                setDraft(value)
              }
            }}
            onSave={() => void save()}
            onReload={() => (dirty ? setReloadConfirm(true) : void reloadConfig())}
            dirty={dirty}
            uncertain={saveUncertain}
          />
        ) : null}
      </TabsContent>
      {logsOpen ? (
        <AutoBookingLogs context={context} active={visible} onClose={() => setLogsOpen(false)} />
      ) : null}
      {startConfirm ? (
        <Overlay
          confirm
          title="开启自动约课"
          busy={!!busy}
          onClose={() => setStartConfirm(false)}
          footer={
            <>
              <Button variant="outline" disabled={!!busy} onClick={() => setStartConfirm(false)}>
                取消
              </Button>
              <Button
                disabled={!!busy || !canManage || !!startDisabledReason || !visible}
                onClick={() => void command("start")}
              >
                {busy === "start" ? "正在开启…" : "开启自动约课"}
              </Button>
            </>
          }
        >
          <p>开启后会按已保存的规则自动向美森提交预约，关闭页面仍会运行。</p>
          <p>停止任务不会撤销已提交的预约，已发送的请求会继续核对。</p>
        </Overlay>
      ) : null}
      {reloadConfirm ? (
        <Overlay
          confirm
          title="放弃修改？"
          busy={!!busy}
          onClose={() => setReloadConfirm(false)}
          footer={
            <>
              <Button variant="outline" disabled={!!busy} onClick={() => setReloadConfirm(false)}>
                继续编辑
              </Button>
              <Button disabled={!!busy} onClick={() => void reloadConfig()}>
                放弃修改
              </Button>
            </>
          }
        >
          <p>未保存的修改将丢失。</p>
        </Overlay>
      ) : null}
    </Tabs>
  )
}

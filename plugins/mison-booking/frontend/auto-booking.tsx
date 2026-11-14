import { useCallback, useContext, useEffect, useRef, useState } from "react"
import { Badge } from "@shared/components/ui/badge"
import { Separator } from "@shared/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/components/ui/tabs"
import { CalendarClock, ChevronRight, Play, RefreshCw } from "lucide-react"
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
import { parseDate } from "./calendar-date"
import { PageActiveContext } from "./contexts"
import { operationId } from "./operation-id"
import { Avatar, Button, Empty, Notice, Overlay, teacherName } from "./ui"
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
const states = { running: "运行中", stopped: "已停止", sleeping: "休眠中" }

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
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<"save" | "start" | "stop" | "reload" | null>(null)
  const [saveUncertain, setSaveUncertain] = useState(false)
  const [commandUncertain, setCommandUncertain] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [selectedTeacher, setSelectedTeacher] = useState("")
  const [availability, setAvailability] = useState<Record<string, number | null>>({})
  const updateAvailability = useCallback((id: string, count: number | null) => {
    setAvailability((previous) =>
      previous[id] === count ? previous : { ...previous, [id]: count },
    )
  }, [])
  const [logsOpen, setLogsOpen] = useState(false)
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
  const teacher =
    config?.teachers.find((item) => item.id === selectedTeacher) ?? config?.teachers[0]
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
      setMessage("已读取最新设置。")
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
    if (draft.sleep.start === draft.sleep.end) {
      setActionError("休眠开始和结束时间不能相同。")
      return
    }
    lock.current = true
    setBusy("save")
    setActionError("")
    setMessage("")
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
        sleep: draft.sleep,
      })
      const value = await saveAutoBookingConfig(context, body)
      if (!live()) return
      applyConfig(value, true)
      pendingSave.current = null
      setSaveUncertain(false)
      setConfigError("")
      setView("dashboard")
      setMessage("设置已保存。")
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
    setMessage("")
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
      setMessage(
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
          <TabsTrigger value="settings">预约设置</TabsTrigger>
        </TabsList>
        <div className="mison-actions">
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新自动约课状态"
            disabled={loading || !!busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw />
          </Button>
          {canManage && config ? (
            status?.enabled || (commandUncertain && pendingCommand.current?.kind === "stop") ? (
              <Button
                variant="outline"
                className="mison-auto-stop"
                disabled={!!busy || !visible}
                onClick={() => void command("stop")}
              >
                {busy === "stop" ? "正在停止…" : "停止任务"}
              </Button>
            ) : (
              <Button
                disabled={!!busy || !visible || !!startDisabledReason}
                title={startDisabledReason || undefined}
                onClick={() => setStartConfirm(true)}
              >
                <Play data-icon="inline-start" />
                开启任务
              </Button>
            )
          ) : null}
        </div>
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
      {message ? (
        <p className="mison-auto-feedback" role="status">
          {message}
        </p>
      ) : null}
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
        <div className="mison-auto-summary" aria-label="自动约课运行统计">
          <div
            className="mison-auto-state"
            data-state={reconciling ? "reconciling" : status?.state}
          >
            <strong>
              <span className="mison-auto-state-dot" />
              {reconciling ? "核对中" : status ? states[status.state] : "状态待加载"}
            </strong>
            <small>
              下次检查 {autoBookingTime(status?.nextCheckAt ?? null, true)}
              {config?.sleep.enabled
                ? ` · 休眠 ${config.sleep.start}–${config.sleep.end}`
                : " · 未启用休眠"}
            </small>
            {!canManage && config ? <Badge variant="outline">只读</Badge> : null}
          </div>
          <div className="mison-auto-metric">
            <strong>{status?.totalBooked ?? "—"}</strong>
            <span>累计自动预约</span>
          </div>
          <div className="mison-auto-metric">
            <strong>{status?.checks ?? "—"}</strong>
            <span>累计检查</span>
          </div>
          <div className="mison-auto-metric">
            <strong>
              {status
                ? new Set(status.fulfilledDates.filter((date) => status.targetDates.includes(date)))
                    .size
                : "—"}
              {" / "}
              {status?.targetDates.length ?? "—"}
            </strong>
            <span>目标日期</span>
          </div>
        </div>
        {reconciling || (canManage && !status?.enabled && startDisabledReason) ? (
          <div className="mison-auto-running-copy">
            <p>
              {status?.message ||
                (reconciling
                  ? "预约结果待核对，当前仅核对已发请求，不会提交新预约。"
                  : "后台按设置检查，每轮完成后等待约 4–6 分钟。")}
            </p>
            {canManage && !status?.enabled && startDisabledReason ? (
              <small>{startDisabledReason}</small>
            ) : null}
          </div>
        ) : null}
        {teacher && config ? (
          <Tabs
            value={teacher.id}
            onValueChange={setSelectedTeacher}
            className="mison-auto-teacher-tabs"
          >
            <TabsContent value={teacher.id} className="mison-auto-teacher-panel">
              <AutoBookingSchedule
                context={context}
                teacher={teacher}
                serverDate={serverDate}
                revision={config.revision}
                active={visible && view === "dashboard"}
                refreshToken={status?.lastCheckAt ?? ""}
                onAvailability={updateAvailability}
                teacherNavigation={
                  <TabsList aria-label="切换排班老师">
                    {config.teachers.map((item, index) => (
                      <TabsTrigger
                        key={item.id}
                        value={item.id}
                        aria-label={`${index + 1}. ${teacherName(item.name)}`}
                      >
                        <span className="mison-auto-rank">{index + 1}</span>
                        <Avatar name={item.name} url={item.avatarUrl} compact />
                        <span>{item.name}</span>
                        <span
                          className="mison-auto-teacher-count"
                          title="当前已读取日期中的可约时段数"
                        >
                          {availability[item.id] ?? "—"}
                        </span>
                      </TabsTrigger>
                    ))}
                  </TabsList>
                }
              />
            </TabsContent>
          </Tabs>
        ) : config ? (
          <Empty title="尚未设置自动约课老师" icon={<CalendarClock />}>
            在“预约设置”中选择收藏老师、预约日期及每周时段。
          </Empty>
        ) : null}
        <Separator />
        <footer className="mison-auto-footer">
          <strong>最近结果</strong>
          <time className="mison-caption">
            {autoBookingTime(status?.latestEvent?.at ?? null, true)}
          </time>
          {status?.latestEvent?.kind === "booked" ? (
            <Badge className="mison-auto-booked-result">预约成功</Badge>
          ) : null}
          <small className="mison-auto-latest">
            {status?.latestEvent?.date
              ? `${status.latestEvent.date.slice(5).replace("-", "月")}日 ${status.latestEvent.time ?? ""} ${status.latestEvent.teacherName ?? ""}`
              : status?.latestEvent?.message || "暂无运行记录"}
          </small>
          <Button variant="ghost" onClick={() => setLogsOpen(true)} aria-label="运行记录">
            查看运行记录 <ChevronRight data-icon="inline-end" />
          </Button>
        </footer>
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
                setMessage("")
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
                暂不开启
              </Button>
              <Button
                disabled={!!busy || !canManage || !!startDisabledReason || !visible}
                onClick={() => void command("start")}
              >
                {busy === "start" ? "正在开启…" : "确认开启并自动提交预约"}
              </Button>
            </>
          }
        >
          <p>
            开启后，系统会在后台自动向美森提交预约，按已保存的老师和时段优先级，为选中日期预约连续课时，并使用最新推荐课件。
          </p>
          <p>
            已有手动预约及已上课程也计入每日节数；系统不会自动取消或更换课程。关闭页面后任务仍会运行，停止任务不会撤销已经发出的请求。
          </p>
        </Overlay>
      ) : null}
      {reloadConfirm ? (
        <Overlay
          confirm
          title="重新读取预约设置"
          busy={!!busy}
          onClose={() => setReloadConfirm(false)}
          footer={
            <>
              <Button variant="outline" disabled={!!busy} onClick={() => setReloadConfirm(false)}>
                保留修改
              </Button>
              <Button disabled={!!busy} onClick={() => void reloadConfig()}>
                放弃未保存修改并读取
              </Button>
            </>
          }
        >
          <p>重新读取将用已保存的设置替换当前草稿。</p>
        </Overlay>
      ) : null}
    </Tabs>
  )
}

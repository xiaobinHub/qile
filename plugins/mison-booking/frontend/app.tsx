import { operationId as newOperationId } from "./operation-id"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Card, CardHeader, CardContent } from "@shared/components/ui/card"
import { Badge } from "@shared/components/ui/badge"
import { Separator } from "@shared/components/ui/separator"
import { CalendarDays, RefreshCw, Settings } from "lucide-react"
import {
  createDraft,
  getBootstrap,
  getSchedule,
  getTeachers,
  onConnectionExpired,
  PluginApiError,
  request,
} from "./api"
import { Button, Empty, Notice, Overlay, minutes } from "./ui"
import { TeacherFilterBar, TeacherList, emptyFilters, type Filters } from "./teacher-list"
import { SchedulePanel, type Step } from "./schedule-panel"
import { BookingsDrawer } from "./bookings-drawer"
import { CoursewarePicker } from "./courseware-picker"
import { LoginForm } from "./login-form"
import { AccountDialog, ProfileDrawer, ResourceViewer } from "./profile-and-account"
import type {
  Bootstrap,
  Connection,
  Courseware,
  Draft,
  Operation,
  PluginContext,
  Resource,
  Teacher,
  TeacherFilters,
  TeacherSchedule,
} from "./types"

type Switch = { teacher: Teacher; date?: string }
export function App({ context }: { context: PluginContext }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null),
    [bootstrapError, setBootstrapError] = useState("")
  const [teachers, setTeachers] = useState<Teacher[]>([]),
    [teacher, setTeacher] = useState<Teacher | null>(null)
  const [filters, setFilters] = useState<Filters>(emptyFilters),
    [options, setOptions] = useState<TeacherFilters | null>(null)
  const [search, setSearch] = useState(""),
    [refresh, setRefresh] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null),
    [total, setTotal] = useState<number | null>(null)
  const [listLoading, setListLoading] = useState(false),
    [error, setError] = useState("")
  const [expanded, setExpanded] = useState(false),
    [schedule, setSchedule] = useState<TeacherSchedule | null>(null)
  const [scheduleLoading, setScheduleLoading] = useState(false),
    [selected, setSelected] = useState<string[]>([])
  const [scheduleRefresh, setScheduleRefresh] = useState(0)
  const [scheduleError, setScheduleError] = useState("")
  const [selectionBeforeWarning, setSelectionBeforeWarning] = useState<string[] | null>(null)
  const [coursePending, setCoursePending] = useState<string | null>(null)
  const [date, setDate] = useState<string | undefined>(),
    [step, setStep] = useState<Step>("schedule")
  const [draft, setDraft] = useState<Draft | null>(null),
    [busy, setBusy] = useState(false),
    [operation, setOperation] = useState<Operation | null>(null)
  const [favoriteBusy, setFavoriteBusy] = useState<string | null>(null)
  const [profile, setProfile] = useState<Teacher | null>(null),
    [bookingsOpen, setBookingsOpen] = useState(false)
  const [endPending, setEndPending] = useState<Operation | null>(null)
  const [accountOpen, setAccountOpen] = useState(false),
    [courseStart, setCourseStart] = useState<string | null>(null)
  const [resource, setResource] = useState<Resource | null>(null),
    [switchTo, setSwitchTo] = useState<Switch | null>(null)
  const listGeneration = useRef(0),
    draftOperationId = useRef<string | null>(null)
  const submitId = useRef<string | null>(null),
    writeLock = useRef(false),
    galleryScroll = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    let frame = 0
    const measure = () => {
      const top = element.getBoundingClientRect().top + window.scrollY
      const main = element.closest("main") ?? element.parentElement
      const bottom = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0
      element.style.setProperty("--mison-host-bottom-padding", `${bottom}px`)
      const height = Math.max(0, (window.visualViewport?.height ?? window.innerHeight) - top)
      const value = `${height}px`
      if (element.style.getPropertyValue("--mison-viewport-height") !== value)
        element.style.setProperty("--mison-viewport-height", value)
    }
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    measure()
    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(element.parentElement ?? element)
    const main = element.closest("main")
    if (main) observer.observe(main)
    window.addEventListener("resize", scheduleMeasure)
    window.visualViewport?.addEventListener("resize", scheduleMeasure)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("resize", scheduleMeasure)
      window.visualViewport?.removeEventListener("resize", scheduleMeasure)
    }
  }, [])
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const active = () => live.current && !context.signal.aborted

  const reloadBootstrap = useCallback(async () => {
    setBootstrapError("")
    try {
      const r = await getBootstrap(context)
      if (!context.signal.aborted && live.current) setBootstrap(r)
    } catch (e) {
      if (!context.signal.aborted && live.current) setBootstrapError((e as Error).message)
    }
  }, [context])
  useEffect(() => {
    void reloadBootstrap()
  }, [reloadBootstrap])
  useEffect(
    () => onConnectionExpired(context, () => void reloadBootstrap()),
    [context, reloadBootstrap],
  )
  const connected = bootstrap?.connection.status === "connected"
  const bindingRevision = bootstrap?.connection.bindingRevision ?? 0
  const unresolvedBooking =
    !!operation &&
    ["prepared", "dispatching", "uncertain", "partially_succeeded", "needs_repair"].includes(
      operation.state,
    )
  const frozen = busy || unresolvedBooking || !!coursePending
  const query = useMemo(() => {
    const q = new URLSearchParams()
    if (search) q.set("nickname", search)
    if (filters.date) q.set("date", filters.date)
    if (filters.times.length) q.set("times", filters.times.join(","))
    if (filters.labels.length) q.set("labelIds", filters.labels.join(","))
    if (filters.favoritesOnly) q.set("favoritesOnly", "1")
    return q.toString()
  }, [search, filters.date, filters.times, filters.labels, filters.favoritesOnly])
  const loadTeachers = useCallback(
    async (cursor?: string | null) => {
      const seq = ++listGeneration.current
      setListLoading(true)
      setError("")
      try {
        const r = await getTeachers(context, new URLSearchParams(query), cursor)
        if (seq !== listGeneration.current || context.signal.aborted || !live.current) return
        setTeachers((old) =>
          cursor
            ? Array.from(new Map([...old, ...r.items].map((t) => [t.id, t])).values())
            : r.items,
        )
        setNextCursor(r.nextCursor)
        setTotal(r.total)
      } catch (e) {
        if (seq === listGeneration.current && !context.signal.aborted && live.current)
          setError((e as Error).message)
      } finally {
        if (seq === listGeneration.current && !context.signal.aborted && live.current)
          setListLoading(false)
      }
    },
    [context, query, bindingRevision],
  )
  useEffect(() => {
    if (connected) {
      setNextCursor(null)
      void loadTeachers()
    }
    return () => {
      listGeneration.current++
    }
  }, [connected, loadTeachers, refresh])
  useEffect(() => {
    let alive = true
    if (connected)
      request<TeacherFilters>(context, "teacher-filters")
        .then((r) => {
          if (alive) setOptions(r)
        })
        .catch(() => {
          if (alive) setOptions(null)
        })
    return () => {
      alive = false
    }
  }, [context, connected, bindingRevision])
  useEffect(() => {
    let alive = true
    if (!teacher || !connected) return
    setScheduleLoading(true)
    setScheduleError("")
    setSchedule((old) => (old?.teacher.id === teacher.id ? old : null))
    getSchedule(context, teacher.id, date)
      .then((r) => {
        if (alive && active()) {
          setSchedule(r)
          setTeacher((old) =>
            old?.id === r.teacher.id && old.lessonMinutes == null
              ? { ...old, lessonMinutes: r.lessonMinutes }
              : old,
          )
        }
      })
      .catch((e) => {
        if (alive && active()) setScheduleError(e.message)
      })
      .finally(() => {
        if (alive && active()) setScheduleLoading(false)
      })
    return () => {
      alive = false
    }
  }, [context, teacher?.id, date, connected, bindingRevision, scheduleRefresh])
  // Clearing a search field is immediate; typed searches are applied by Enter/search.
  function changeFilters(value: Filters) {
    setFilters(value)
    if (!value.nickname) setSearch("")
  }
  function applySwitch(next: Switch) {
    if (!expanded) galleryScroll.current = window.scrollY
    setScheduleLoading(true)
    setScheduleError("")
    setTeacher(next.teacher)
    setDate(next.date ?? (filters.date || undefined))
    setSelected([])
    setDraft(null)
    setOperation(null)
    setStep("schedule")
    setExpanded(true)
    submitId.current = null
    draftOperationId.current = null
  }
  function book(next: Teacher, nextDate?: string) {
    if (frozen) {
      setError("请先核对当前操作结果，再切换老师或日期。")
      return
    }
    if (teacher?.id === next.id && (!nextDate || nextDate === schedule?.date)) {
      if (!expanded) galleryScroll.current = window.scrollY
      setExpanded(true)
      return
    }
    if (selected.length || draft) setSwitchTo({ teacher: next, date: nextDate })
    else applySwitch({ teacher: next, date: nextDate })
  }
  function collapse() {
    setExpanded(false)
    requestAnimationFrame(() => {
      window.scrollTo({ top: galleryScroll.current })
      root.current
        ?.querySelector<HTMLButtonElement>(`[data-book-teacher="${CSS.escape(teacher?.id ?? "")}"]`)
        ?.focus({ preventScroll: true })
    })
  }
  const contiguous =
    !!schedule &&
    selected.every(
      (start, i) =>
        i === 0 || minutes(start) - minutes(selected[i - 1]) === schedule.slotStepMinutes,
    )
  function dismissSlotWarning() {
    if (selectionBeforeWarning !== null) setSelected(selectionBeforeWarning)
    setSelectionBeforeWarning(null)
  }
  const favoriteLock = useRef(false)
  async function favorite(item: Teacher) {
    if (favoriteLock.current) return
    favoriteLock.current = true
    setFavoriteBusy(item.id)
    setError("")
    try {
      const r = await request<{ teacherId: string; favorite: boolean }>(
        context,
        `teachers/${encodeURIComponent(item.id)}/favorite`,
        {
          method: "PUT",
          body: { operationId: newOperationId(), bindingRevision, favorite: !item.favorite },
        },
      )
      if (!active()) return
      const update = (t: Teacher) => (t.id === r.teacherId ? { ...t, favorite: r.favorite } : t)
      setTeachers((old) => old.map(update))
      setTeacher((t) => (t ? update(t) : null))
      setProfile((t) => (t ? update(t) : null))
      setRefresh((v) => v + 1)
    } catch (e) {
      if (active()) {
        setError((e as Error).message)
        void reloadBootstrap()
      }
    } finally {
      favoriteLock.current = false
      if (active()) setFavoriteBusy(null)
    }
  }
  async function next() {
    if (
      !teacher ||
      !schedule ||
      scheduleLoading ||
      scheduleError ||
      (date && schedule.date !== date) ||
      writeLock.current
    )
      return
    writeLock.current = true
    setBusy(true)
    setError("")
    draftOperationId.current ??= newOperationId()
    try {
      const r = draft
        ? await request<Draft>(context, `drafts/${draft.id}/slots`, {
            method: "PUT",
            body: {
              operationId: draftOperationId.current,
              bindingRevision,
              expectedRevision: draft.revision,
              slotStarts: selected,
            },
          })
        : await createDraft(context, {
            operationId: draftOperationId.current,
            bindingRevision,
            teacherId: teacher.id,
            date: schedule.date,
            slotStarts: selected,
          })
      if (active()) {
        setDraft(r)
        setStep("confirm")
        submitId.current = null
      }
    } catch (e) {
      if (active()) {
        setError((e as Error).message)
        if (e instanceof PluginApiError && ["DRAFT_EXPIRED", "DRAFT_IN_USE"].includes(e.code)) {
          setDraft(null)
          draftOperationId.current = null
        }
      }
    } finally {
      writeLock.current = false
      if (active()) setBusy(false)
    }
  }
  function acceptOperation(r: Operation) {
    setOperation(r)
    if (r.state === "failed" || r.state === "cancelled") submitId.current = null
    if (r.state === "succeeded") {
      setStep("success")
      setRefresh((v) => v + 1)
      void reloadBootstrap()
    } else {
      setError(r.message || "预约结果待核对，请勿重复提交。")
      void reloadBootstrap()
    }
  }
  async function submit() {
    if (!draft?.valid || writeLock.current || unresolvedBooking || coursePending) return
    writeLock.current = true
    setBusy(true)
    setError("")
    submitId.current ??= newOperationId()
    try {
      const r = await request<Operation>(context, "bookings", {
        method: "POST",
        body: {
          operationId: submitId.current,
          bindingRevision,
          draftId: draft.id,
          expectedRevision: draft.revision,
        },
      })
      if (active()) acceptOperation(r)
    } catch (e) {
      if (active()) {
        setError((e as Error).message)
        if (!(e instanceof PluginApiError) || e.operationId)
          setOperation({
            operationId: e instanceof PluginApiError ? e.operationId! : submitId.current!,
            state: "uncertain",
            stageVersion: 0,
            message: "结果待核对",
            result: null,
          })
      }
    } finally {
      writeLock.current = false
      if (active()) setBusy(false)
    }
  }
  async function reconcile() {
    if (!operation || busy) return
    setBusy(true)
    try {
      const r = await request<Operation>(context, `operations/${operation.operationId}`)
      if (active()) acceptOperation(r)
    } catch (e) {
      if (active()) setError((e as Error).message)
    } finally {
      if (active()) setBusy(false)
    }
  }
  useEffect(() => {
    if (
      !operation ||
      !["dispatching", "uncertain", "partially_succeeded"].includes(operation.state)
    )
      return
    let alive = true
    const id = operation.operationId
    const check = async () => {
      try {
        const value = await request<Operation>(context, `operations/${id}`)
        if (alive && active()) acceptOperation(value)
      } catch {
        // Keep the durable pending state; the user can still reconcile manually.
      }
    }
    const timers = [2000, 5000].map((delay) => window.setTimeout(() => void check(), delay))
    return () => {
      alive = false
      timers.forEach(window.clearTimeout)
    }
  }, [context, operation?.operationId, operation?.state])
  async function consumeCourseAction(path: string, body: Record<string, unknown>, change: boolean) {
    if (writeLock.current || coursePending) return
    const operationId = newOperationId()
    writeLock.current = true
    setBusy(true)
    setError("")
    try {
      const r = await request<Operation>(context, path, {
        method: change ? "PUT" : "POST",
        body: { ...body, operationId, bindingRevision },
      })
      if (!active()) return
      if (r.state !== "succeeded") {
        setError(r.message || "操作结果待核对，请勿重复操作。")
        if (r.state !== "failed" && r.state !== "cancelled") setCoursePending(r.operationId)
      } else {
        if (r.result?.draft) {
          setDraft(r.result.draft)
          setCourseStart(null)
        } else if (r.result?.quota) setDraft((d) => (d ? { ...d, quota: r.result!.quota! } : d))
        if (r.result?.resource) setResource(r.result.resource)
        else if (!change) {
          setError(r.message)
          setCoursePending(r.operationId)
        }
      }
    } catch (e) {
      if (active()) {
        setError((e as Error).message)
        if (!(e instanceof PluginApiError) || e.operationId)
          setCoursePending(e instanceof PluginApiError ? e.operationId! : operationId)
      }
    } finally {
      writeLock.current = false
      if (active()) setBusy(false)
    }
  }
  async function changeCourse(course: Courseware) {
    if (!draft || !courseStart) return
    await consumeCourseAction(
      `drafts/${draft.id}/lessons/${encodeURIComponent(courseStart)}/courseware`,
      {
        expectedRevision: draft.revision,
        coursewareId: course.id,
        source: course.source ?? "category",
      },
      true,
    )
  }
  async function previewCourse(start: string) {
    const lesson = draft?.lessons.find((l) => l.start === start)
    if (!draft || !lesson?.courseware) return
    await consumeCourseAction(
      `courseware/${lesson.courseware.id}/preview`,
      { draftId: draft.id, expectedRevision: draft.revision, slotStart: start },
      false,
    )
  }
  async function reconcileCourse() {
    if (!coursePending || busy) return
    setBusy(true)
    try {
      const r = await request<Operation>(context, `operations/${coursePending}`)
      if (!active()) return
      if (["succeeded", "failed", "cancelled"].includes(r.state)) {
        setCoursePending(
          r.state === "succeeded" && !r.result?.resource && !r.result?.draft ? r.operationId : null,
        )
        setError(
          r.state === "succeeded" && (r.result?.resource || r.result?.draft) ? "" : r.message,
        )
        if (r.result?.draft) {
          setDraft(r.result.draft)
          setCourseStart(null)
        }
        if (r.result?.resource) setResource(r.result.resource)
        if (r.result?.quota) setDraft((d) => (d ? { ...d, quota: r.result!.quota! } : d))
      } else setError(r.message || "结果尚未确认，请稍后再核对。")
    } catch (e) {
      if (active()) setError((e as Error).message)
    } finally {
      if (active()) setBusy(false)
    }
  }
  async function checkSavedOperation(pending: Operation) {
    if (busy) return
    setBusy(true)
    try {
      const value = await request<Operation>(context, `operations/${pending.operationId}`)
      if (!active()) return
      setError(value.state === "succeeded" ? "" : value.message)
      if (operation?.operationId === pending.operationId) acceptOperation(value)
      if (value.result?.resource) setResource(value.result.resource)
      if (value.state === "succeeded" && ["book", "cancel"].includes(pending.kind ?? "")) {
        setBookingsOpen(true)
        setScheduleRefresh((n) => n + 1)
      }
      if (value.state === "succeeded" && pending.kind === "favorite" && value.result?.teacherId) {
        const update = (t: Teacher) =>
          t.id === value.result!.teacherId ? { ...t, favorite: value.result!.favorite === true } : t
        setTeachers((old) => old.map(update))
        setTeacher((t) => (t ? update(t) : null))
        setProfile((t) => (t ? update(t) : null))
        setRefresh((n) => n + 1)
      }
      await reloadBootstrap()
    } catch (e) {
      if (active()) setError((e as Error).message)
    } finally {
      if (active()) setBusy(false)
    }
  }
  async function endSavedOperation() {
    if (!endPending || busy) return
    setBusy(true)
    try {
      const value = await request<Operation>(
        context,
        `operations/${endPending.operationId}/acknowledge`,
        {
          method: "POST",
          body: { bindingRevision, confirmedInApp: true },
        },
      )
      if (!active()) return
      if (operation?.operationId === value.operationId) {
        setOperation(null)
        submitId.current = null
        draftOperationId.current = null
        setDraft(null)
        setStep("schedule")
      }
      if (coursePending === value.operationId) {
        setCoursePending(null)
        setDraft(null)
        draftOperationId.current = null
        setStep("schedule")
      }
      setEndPending(null)
      setError("")
      setScheduleRefresh((n) => n + 1)
      await reloadBootstrap()
    } catch (e) {
      if (active()) setError((e as Error).message)
    } finally {
      if (active()) setBusy(false)
    }
  }
  function accountChanged(connection: Connection) {
    setBootstrap((old) => (old ? { ...old, connection } : old))
    setError("")
    setAccountOpen(false)
    setBookingsOpen(false)
    listGeneration.current++
    setTeachers([])
    setTeacher(null)
    setSchedule(null)
    setSelected([])
    setDraft(null)
    setOperation(null)
    setExpanded(false)
    void reloadBootstrap()
  }
  return (
    <Card className="mison-booking gap-0 py-0" ref={root}>
      {connected ? (
        <CardHeader className="mison-header">
          <Button variant="outline" disabled={!connected} onClick={() => setBookingsOpen(true)}>
            <CalendarDays />
            我的预约{bootstrap?.upcomingCount != null ? <b>{bootstrap.upcomingCount}</b> : null}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="账号设置"
            title="账号设置"
            onClick={() => setAccountOpen(true)}
            disabled={!bootstrap || frozen}
          >
            <Settings />
          </Button>
        </CardHeader>
      ) : null}
      {connected ? <Separator /> : null}
      {bootstrapError ? (
        <Notice error>
          {bootstrapError}
          <Button variant="outline" onClick={() => void reloadBootstrap()}>
            <RefreshCw />
            重试连接
          </Button>
        </Notice>
      ) : null}
      {connected ? (
        <>
          {bootstrap.readError ? <Notice error>{bootstrap.readError}</Notice> : null}
          {bootstrap.unresolvedOperations?.map((item) => (
            <Notice key={item.operationId}>
              {item.kind === "book"
                ? "上次预约"
                : item.kind === "cancel"
                  ? "上次取消"
                  : "上次课件操作"}
              结果待核对，请勿重复操作。
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void checkSavedOperation(item)}
              >
                核对上次操作
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setEndPending(item)}>
                结束核对
              </Button>
            </Notice>
          ))}
          <TeacherFilterBar
            value={filters}
            onChange={changeFilters}
            options={options}
            onSearch={() => {
              setSearch(filters.nickname.trim())
              setRefresh((v) => v + 1)
            }}
            onReset={() => {
              setFilters({ ...emptyFilters, favoritesOnly: filters.favoritesOnly })
              setSearch("")
            }}
          />
          <Separator />
          {error ? (
            <Notice error>
              {error}
              {coursePending ? (
                <Button variant="outline" disabled={busy} onClick={() => void reconcileCourse()}>
                  核对课件操作
                </Button>
              ) : null}
            </Notice>
          ) : null}
          <CardContent className={`mison-workspace p-0${expanded ? " is-expanded" : ""}`}>
            <TeacherList
              teachers={teachers}
              selectedId={teacher?.id ?? null}
              expanded={expanded}
              total={total}
              loading={listLoading}
              nextCursor={nextCursor}
              paginationKey={`${query}:${refresh}`}
              onMore={() => void loadTeachers(nextCursor)}
              onBook={book}
              onProfile={setProfile}
              onFavorite={(t) => void favorite(t)}
              favoriteBusy={favoriteBusy}
            />
            {expanded ? (
              <Separator orientation="vertical" className="mison-workspace-divider" />
            ) : null}
            {expanded && teacher ? (
              <SchedulePanel
                teacher={teacher}
                schedule={schedule}
                selected={selected}
                step={step}
                draft={draft}
                loading={scheduleLoading}
                requestedDate={date}
                slotTimes={options?.timeSlots ?? []}
                loadError={scheduleError}
                onRetry={() => setScheduleRefresh((n) => n + 1)}
                busy={busy}
                blocked={frozen}
                contiguous={contiguous}
                limit={bootstrap.bookingLimits.maxContiguousLessons}
                operation={operation}
                onSlot={(start) => {
                  if (frozen || scheduleLoading || scheduleError || selectionBeforeWarning !== null)
                    return
                  const nextSelected = selected.includes(start)
                    ? selected.filter((value) => value !== start)
                    : [...selected, start].sort()
                  const nextContiguous = nextSelected.every(
                    (value, index) =>
                      index === 0 ||
                      minutes(value) - minutes(nextSelected[index - 1]) ===
                        schedule?.slotStepMinutes,
                  )
                  if (!nextContiguous) setSelectionBeforeWarning(selected)
                  setSelected(nextSelected)
                  draftOperationId.current = null
                  submitId.current = null
                }}
                onDate={(value) => book(teacher, value)}
                onClear={() => {
                  if (frozen) return
                  setSelected([])
                  setDraft(null)
                  draftOperationId.current = null
                }}
                onNext={() => void next()}
                onBack={() => setStep("schedule")}
                onSubmit={() => void submit()}
                onCollapse={collapse}
                onProfile={() => setProfile(teacher)}
                onChange={(start) => {
                  if (!coursePending) setCourseStart(start)
                }}
                onPreview={(start) => void previewCourse(start)}
                onContinue={() => {
                  setError("")
                  setScheduleRefresh((v) => v + 1)
                  setSelected([])
                  setDraft(null)
                  setOperation(null)
                  setStep("schedule")
                  submitId.current = null
                  draftOperationId.current = null
                  setDate(schedule?.date)
                }}
                onBookings={() => setBookingsOpen(true)}
                onReconcile={() => void reconcile()}
              />
            ) : null}
          </CardContent>
        </>
      ) : bootstrap ? (
        <section className="mison-login" aria-labelledby="mison-login-title">
          <div className="mison-login-panel">
            <h2 id="mison-login-title">请登录美森网课账号</h2>
            {bootstrap.connection.status === "reconnect_required" ? (
              <p className="mison-caption">登录已过期，请重新登录。</p>
            ) : null}
            <LoginForm
              context={context}
              connection={bootstrap.connection}
              onSuccess={accountChanged}
            />
          </div>
        </section>
      ) : (
        <Empty title={bootstrapError ? "暂时无法连接美森约课" : "正在读取美森约课…"} />
      )}
      {profile ? (
        <ProfileDrawer
          context={context}
          teacher={profile}
          onClose={() => setProfile(null)}
          onBook={() => {
            book(profile)
            setProfile(null)
          }}
          onFavorite={() => void favorite(profile)}
          favoriteBusy={favoriteBusy !== null}
        />
      ) : null}
      {bookingsOpen && bootstrap ? (
        <BookingsDrawer
          context={context}
          bindingRevision={bindingRevision}
          onClose={() => {
            setBookingsOpen(false)
            void reloadBootstrap()
          }}
          onResource={setResource}
        />
      ) : null}
      {accountOpen && bootstrap ? (
        <AccountDialog
          context={context}
          connection={bootstrap.connection}
          onClose={() => setAccountOpen(false)}
          onChanged={accountChanged}
        />
      ) : null}
      {courseStart && draft ? (
        <CoursewarePicker
          context={context}
          draft={draft}
          start={courseStart}
          busy={busy}
          externalError={error}
          pending={!!coursePending}
          onReconcile={() => void reconcileCourse()}
          onClose={() => setCourseStart(null)}
          onUse={(course) => void changeCourse(course)}
        />
      ) : null}
      {endPending ? (
        <Overlay
          confirm
          title="结束操作核对"
          busy={busy}
          onClose={() => setEndPending(null)}
          footer={
            <>
              <Button variant="outline" disabled={busy} onClick={() => setEndPending(null)}>
                继续核对
              </Button>
              <Button disabled={busy} onClick={() => void endSavedOperation()}>
                已在美森App核实，结束核对
              </Button>
            </>
          }
        >
          <p>
            请先在美森App确认课程和预览次数的实际状态。结束核对只关闭本次跟踪，不会取消课程、退还次数或重发请求。
          </p>
        </Overlay>
      ) : null}
      {resource ? <ResourceViewer resource={resource} onClose={() => setResource(null)} /> : null}
      {selectionBeforeWarning !== null ? (
        <Overlay
          confirm
          title="时段选择提示"
          onClose={dismissSlotWarning}
          footer={<Button onClick={dismissSlotWarning}>确定</Button>}
        >
          <p>不能选择不连续的时段，请调整。</p>
        </Overlay>
      ) : null}
      {switchTo ? (
        <Overlay
          confirm
          title="切换预约对象"
          onClose={() => setSwitchTo(null)}
          footer={
            <>
              <Button variant="outline" onClick={() => setSwitchTo(null)}>
                保留当前选择
              </Button>
              <Button
                onClick={() => {
                  applySwitch(switchTo)
                  setSwitchTo(null)
                }}
              >
                清空并切换
              </Button>
            </>
          }
        >
          <p>切换老师或日期后，将清空本次已选时段与课件。</p>
        </Overlay>
      ) : null}
    </Card>
  )
}

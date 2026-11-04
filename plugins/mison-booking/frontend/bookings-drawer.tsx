import { operationId as newOperationId } from "./operation-id"
import { useEffect, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@shared/components/ui/tabs"
import { Card, CardContent, CardFooter } from "@shared/components/ui/card"
import { Badge } from "@shared/components/ui/badge"
import { request } from "./api"
import { Avatar, Button, Empty, Notice, Overlay, DatePicker, dateLabel, teacherName } from "./ui"
import type { Booking, BookingQuery, Operation, PluginContext, Resource } from "./types"
export function BookingsDrawer({
  context,
  bindingRevision,
  onClose,
  onResource,
}: {
  context: PluginContext
  bindingRevision: number
  onClose(): void
  onResource(resource: Resource): void
}) {
  const [status, setStatus] = useState("upcoming"),
    [items, setItems] = useState<Booking[]>([])
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [date, setDate] = useState("")
  const [cursor, setCursor] = useState<string | null>(null),
    [total, setTotal] = useState<number | null>(null)
  const [cancel, setCancel] = useState<Booking | null>(null),
    [cancelId, setCancelId] = useState("")
  const [busy, setBusy] = useState(false),
    [cancelMessage, setCancelMessage] = useState("")
  const [cancelUncertain, setCancelUncertain] = useState(false)
  const [materials, setMaterials] = useState<Resource[] | null>(null)
  const generation = useRef(0)
  async function load(append = false) {
    const seq = ++generation.current
    setLoading(true)
    setError("")
    let next: string | null = append ? cursor : null
    try {
      do {
        const query = new URLSearchParams({ status })
        if (date) {
          query.set("from", date)
          query.set("to", date)
        }
        if (next) query.set("cursor", next)
        const r: BookingQuery = await request(context, `bookings?${query}`)
        if (seq !== generation.current || context.signal.aborted) return
        next = r.nextCursor
        if (r.state === "ready") {
          setItems((old) => (append ? [...old, ...r.items] : r.items))
          setCursor(next)
          setTotal(r.total)
          break
        }
        if (!next) throw Error("课程记录仍在同步，请稍后刷新。")
      } while (next)
    } catch (e) {
      if (seq === generation.current) setError((e as Error).message)
    } finally {
      if (seq === generation.current) setLoading(false)
    }
  }
  useEffect(() => {
    setItems([])
    setCursor(null)
    setTotal(null)
    void load()
    return () => {
      generation.current++
    }
  }, [context, status, date])
  async function action(booking: Booking, kind: string) {
    setError("")
    setBusy(true)
    try {
      if (kind === "materials") {
        const r = await request<{ items: Resource[] }>(
          context,
          `bookings/${encodeURIComponent(booking.key)}/resources`,
        )
        if (r.items.length === 1) onResource(r.items[0])
        else if (r.items.length > 1) setMaterials(r.items)
        else setError("暂无可用课程资料。")
      } else {
        const r = await request<Operation>(
          context,
          `bookings/${encodeURIComponent(booking.key)}/actions/${kind}`,
          {
            method: "POST",
            body: {
              operationId: newOperationId(),
              bindingRevision,
              snapshotVersion: booking.snapshotVersion,
            },
          },
        )
        if (r.state === "succeeded" && r.result?.resource) onResource(r.result.resource)
        else setError(r.message || "该入口暂不可用。")
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function confirmCancel() {
    if (!cancel) return
    setBusy(true)
    setCancelMessage("")
    try {
      const r = await request<Operation>(
        context,
        `bookings/${encodeURIComponent(cancel.key)}/cancel`,
        {
          method: "POST",
          body: {
            operationId: cancelId,
            bindingRevision,
            snapshotVersion: cancel.snapshotVersion,
            adjustLessons: false,
          },
        },
      )
      if (r.state === "succeeded") {
        setCancel(null)
        void load()
      } else {
        setCancelMessage(r.message || "结果待核对，请刷新预约记录。")
        setCancelUncertain(!["failed", "cancelled"].includes(r.state))
        if (["failed", "cancelled"].includes(r.state)) setCancelId(newOperationId())
      }
    } catch (e) {
      setCancelMessage((e as Error).message)
      setCancelUncertain(true)
    } finally {
      setBusy(false)
    }
  }
  async function reconcileCancel() {
    if (busy || !cancelId) return
    setBusy(true)
    try {
      const r = await request<Operation>(context, `operations/${cancelId}`)
      if (r.state === "succeeded") {
        setCancel(null)
        void load()
      } else {
        setCancelMessage(r.message)
        if (["failed", "cancelled"].includes(r.state)) {
          setCancelUncertain(false)
          setCancelId(newOperationId())
        }
      }
    } catch (e) {
      setCancelMessage((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Overlay title="我的预约" drawer contained onClose={onClose}>
        <Tabs
          className="mison-booking-sheet"
          value={status}
          onValueChange={(next) => {
            setStatus(next)
            setItems([])
            setCursor(null)
            setTotal(null)
            setError("")
          }}
        >
          <div className="mison-booking-pinned">
          <TabsList variant="line" className="mison-booking-tabs" aria-label="预约状态">
            {[
              ["upcoming", "预约中"],
              ["completed", "已上课"],
              ["cancelled", "已取消"],
            ].map(([key, name]) => (
              <TabsTrigger key={key} value={key}>
                {name}
                {key === status && total !== null ? ` ${total}` : ""}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="mison-booking-toolbar">
            <small>{status === "upcoming" ? "按上课时间排列" : "最近课程在前"}</small>
            <div className="mison-actions">
              <DatePicker
                className="mison-date-picker"
                aria-label="预约日期筛选"
                placeholder="筛选日期"
                value={date}
                onChange={setDate}
              />
              <Button
                variant="outline"
                size="icon"
                aria-label="刷新预约"
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCw />
              </Button>
            </div>
          </div>
          {error ? <Notice error>{error}</Notice> : null}
          </div>
          <TabsContent className="mison-booking-list" value={status} aria-busy={loading}>
            {items.map((booking) => {
              const day = booking.startsAt?.slice(0, 10)
              const statusName =
                booking.status === "upcoming"
                  ? "预约中"
                  : booking.status === "completed"
                    ? "已上课"
                    : "已取消"
              const showCancel = booking.status === "upcoming" && !!booking.actions.cancel?.allowed
              const showMaterials =
                booking.status !== "cancelled" && !!booking.actions.materials?.allowed
              return (
                <Card key={booking.key} size="sm" className="mison-booking-card">
                  <CardContent className="mison-booking-body">
                    <div className="mison-booking-meta">
                      <p className="mison-booking-when">
                        {day ? <span>{dateLabel(day)}</span> : null}
                        <time dateTime={booking.startsAt ?? undefined}>{booking.timeLabel}</time>
                      </p>
                      <Badge
                        variant={
                          booking.status === "upcoming"
                            ? "default"
                            : booking.status === "cancelled"
                              ? "outline"
                              : "secondary"
                        }
                      >
                        {statusName}
                      </Badge>
                    </div>
                    <div className="mison-booking-person">
                      <Avatar name={booking.teacher.name} url={booking.teacher.avatarUrl} />
                      <div className="mison-booking-copy">
                        <h3>{teacherName(booking.teacher.name)}</h3>
                        <p>{booking.courseware?.title ?? "课程内容待同步"}</p>
                      </div>
                    </div>
                  </CardContent>
                  {showCancel || showMaterials ? (
                    <CardFooter className="mison-booking-actions">
                      {showCancel ? (
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setCancel(booking)
                            setCancelId(newOperationId())
                            setCancelMessage("")
                            setCancelUncertain(false)
                          }}
                        >
                          取消预约
                        </Button>
                      ) : null}
                      {showMaterials ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void action(booking, "materials")}
                        >
                          课程资料
                        </Button>
                      ) : null}
                    </CardFooter>
                  ) : null}
                </Card>
              )
            })}
            {!items.length ? (
              <Empty
                title={loading ? "正在加载预约…" : error ? "预约记录加载失败" : "暂无课程记录"}
              />
            ) : null}
            {cursor ? (
              <Button variant="outline" disabled={loading} onClick={() => void load(true)}>
                加载更多课程
              </Button>
            ) : null}
          </TabsContent>
        </Tabs>
      </Overlay>
      {materials ? (
        <Overlay title="课程资料" onClose={() => setMaterials(null)}>
          <div className="mison-account-form">
            {materials.map((item, i) => (
              <Button key={`${item.id}-${i}`} variant="outline" onClick={() => onResource(item)}>
                {item.title}
              </Button>
            ))}
          </div>
        </Overlay>
      ) : null}
      {cancel ? (
        <Overlay
          confirm
          title="确认取消预约"
          busy={busy}
          onClose={() => setCancel(null)}
          footer={
            <>
              <Button variant="outline" disabled={busy} onClick={() => setCancel(null)}>
                我再想想
              </Button>
              <Button
                variant="destructive"
                disabled={busy || cancelUncertain}
                onClick={() => void confirmCancel()}
              >
                {busy ? "处理中…" : "确认取消"}
              </Button>
              {cancelUncertain ? (
                <Button variant="outline" disabled={busy} onClick={() => void reconcileCancel()}>
                  核对取消结果
                </Button>
              ) : null}
            </>
          }
        >
          <p>
            {teacherName(cancel.teacher.name)} · {cancel.timeLabel}
          </p>
          <p>{cancel.courseware?.title}</p>
          <p className="mison-caption">本次仅取消所选课程，不自动顺延其他课程内容。</p>
          {cancelMessage ? <Notice error>{cancelMessage}</Notice> : null}
        </Overlay>
      ) : null}
    </>
  )
}

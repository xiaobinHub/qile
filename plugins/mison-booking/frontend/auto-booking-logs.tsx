import { useEffect, useMemo, useRef, useState } from "react"
import { Badge } from "@shared/components/ui/badge"
import { getAutoBookingLogs } from "./api"
import { autoBookingTime } from "./auto-booking-schedule"
import { Button, Empty, Notice, Overlay } from "./ui"
import type { AutoBookingEvent, PluginContext } from "./types"

type Filter = "all" | "attention"

const attention = new Set(["error", "rejected", "uncertain", "stopped"])

function label(item: AutoBookingEvent) {
  return { run: "检查", started: "开启", stopped: "停止", config: "保存", notification: "提醒", booked: "成功", rejected: "失败", error: "异常" }[item.kind] || "记录"
}

export function AutoBookingLogs({
  context,
  active,
  onClose,
}: {
  context: PluginContext
  active: boolean
  onClose(): void
}) {
  const [items, setItems] = useState<AutoBookingEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState<Filter>("all")
  const pendingLoad = useRef(true)
  const cursor = useRef<string | null>(null)
  const seen = useRef(new Set<string>())
  useEffect(() => {
    let cancelled = false
    if (!active || context.signal.aborted) {
      setLoading(false)
      return
    }
    if (!pendingLoad.current) return
    const current = () => !cancelled && !context.signal.aborted
    setLoading(true)
    setError("")
    getAutoBookingLogs(context, cursor.current)
      .then((result) => {
        if (!current()) return
        setItems((old) =>
          Array.from(new Map([...old, ...result.items].map((item) => [item.id, item])).values()),
        )
        if (result.nextCursor && seen.current.has(result.nextCursor))
          throw new Error("记录分页重复，请关闭后重新打开。")
        if (result.nextCursor) seen.current.add(result.nextCursor)
        pendingLoad.current = false
        setNextCursor(result.nextCursor)
      })
      .catch((reason) => {
        if (current()) setError((reason as Error).message)
      })
      .finally(() => {
        if (current()) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [context, active, page])
  const visible = useMemo(
    () => items.filter((item) => filter === "all" || attention.has(item.status || item.kind)),
    [filter, items],
  )
  return (
    <Overlay
      drawer
      title="自动约课记录"
      actions={
        <div className="mison-auto-log-filter" role="group" aria-label="记录筛选">
          {([["all", "全部"], ["attention", "需关注"]] as const).map(([value, name]) => (
            <Button key={value} variant={filter === value ? "secondary" : "ghost"} size="sm" aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {name}
            </Button>
          ))}
        </div>
      }
      onClose={onClose}
      footer={
        <>
          {error ? (
            <Button variant="outline" disabled={loading} onClick={() => setPage((value) => value + 1)}>重试加载</Button>
          ) : nextCursor ? (
            <Button variant="outline" disabled={loading} onClick={() => { cursor.current = nextCursor; pendingLoad.current = true; setPage((value) => value + 1) }}>加载更多</Button>
          ) : null}
        </>
      }
    >
      {error ? <Notice error>{error}</Notice> : null}
      {loading ? <p className="mison-caption" role="status">正在读取记录…</p> : null}
      {!visible.length && !loading && !error ? <Empty title={filter === "attention" ? "暂无需关注记录" : "暂无运行记录"} /> : null}
      <ol className="mison-auto-logs">
        {visible.map((item) => (
          <li key={item.id} className="mison-auto-log-summary">
            <time className="mison-caption" dateTime={item.at}>{autoBookingTime(item.at)}</time>
            <Badge variant="outline">{label(item)}</Badge>
            <p>{item.message}</p>
          </li>
        ))}
      </ol>
    </Overlay>
  )
}

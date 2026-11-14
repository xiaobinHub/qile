import { useEffect, useRef, useState } from "react"
import { Badge } from "@shared/components/ui/badge"
import { getAutoBookingLogs } from "./api"
import { autoBookingTime } from "./auto-booking-schedule"
import { Button, Empty, Notice, Overlay } from "./ui"
import type { AutoBookingEvent, PluginContext } from "./types"

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
  return (
    <Overlay
      drawer
      title="自动约课记录"
      onClose={onClose}
      footer={
        <>
          <small>北京时间 · 已读取 {items.length} 条</small>
          {error ? (
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => setPage((value) => value + 1)}
            >
              重试加载
            </Button>
          ) : nextCursor ? (
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => {
                cursor.current = nextCursor
                pendingLoad.current = true
                setPage((value) => value + 1)
              }}
            >
              加载更多
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      {error ? <Notice error>{error}</Notice> : null}
      {loading ? (
        <p className="mison-caption" role="status">
          正在读取记录…
        </p>
      ) : null}
      {!items.length && !loading && !error ? <Empty title="暂无运行记录" /> : null}
      <ol className="mison-auto-logs">
        {items.map((item) => (
          <li key={item.id}>
            <time className="mison-caption" dateTime={item.at}>
              {autoBookingTime(item.at)}
            </time>
            <p>{item.message}</p>
            {item.date || item.teacherName || item.time ? (
              <Badge variant="outline" className="mison-auto-log-meta">
                {[item.date, item.teacherName, item.time].filter(Boolean).join(" · ")}
              </Badge>
            ) : null}
          </li>
        ))}
      </ol>
    </Overlay>
  )
}

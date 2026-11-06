import { Component, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Button } from "@shared/components/ui/button"
import { Skeleton } from "@shared/components/ui/skeleton"
import { ApiError, runtime } from "../lib/runtime"
import { mountPlugin } from "./loader"
import { pluginError, pluginReason, pluginStore, usePlugins } from "./store"
import type { Child } from "../domain/types"

export class PluginBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <section className="plugin-placeholder">
        <h1>应用暂时无法显示</h1>
        <p>请稍后重新打开应用。</p>
        <Button onClick={() => runtime.setView("calendar")}>返回日历</Button>
      </section>
    ) : (
      this.props.children
    )
  }
}

export function PluginPage({
  pluginId,
  child,
  epoch,
  notify,
  active,
}: {
  pluginId: string
  child: Child
  epoch: number
  notify: (message: string) => void
  active: boolean
}) {
  const state = usePlugins()
  const plugin =
    state.childId === child.id && state.epoch === epoch
      ? state.plugins.find((item) => item.id === pluginId)
      : undefined
  const section = useRef<HTMLElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const notifyRef = useRef(notify)
  const activeRef = useRef(active)
  const session = useRef<{ setActive(active: boolean): void } | null>(null)
  const scrolls = useRef(new Map<HTMLElement, { top: number; left: number }>())
  notifyRef.current = notify
  activeRef.current = active
  const [failure, setFailure] = useState("")
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const effective =
    state.confirmed &&
    !!plugin?.installed &&
    !!plugin.effectiveEnabled &&
    plugin.type === "page" &&
    plugin.operationState === "ready" &&
    !child.archived
  useLayoutEffect(() => {
    const node = section.current
    if (!node) return
    const remember = (event: Event) => {
      const target = event.target
      if (target instanceof HTMLElement)
        scrolls.current.set(target, { top: target.scrollTop, left: target.scrollLeft })
    }
    node.addEventListener("scroll", remember, true)
    return () => node.removeEventListener("scroll", remember, true)
  }, [])
  useLayoutEffect(() => {
    session.current?.setActive(active)
    if (!active || !section.current) return
    for (const [element, position] of scrolls.current) {
      if (!section.current.contains(element)) continue
      element.scrollTop = position.top
      element.scrollLeft = position.left
    }
  }, [active])
  useLayoutEffect(() => {
    setFailure("")
    if (!effective || !plugin || !host.current) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    let dispose: (() => void) | undefined
    setLoading(true)
    void mountPlugin({
      host: host.current,
      plugin,
      child: { id: child.id, name: child.name },
      epoch,
      signal: controller.signal,
      notify: (message) => notifyRef.current(message),
      onDevelopmentChange: () => setRetry((value) => value + 1),
      onDevelopmentError: (message) => setFailure(message),
    })
      .then((handle) => {
        if (controller.signal.aborted) handle.dispose()
        else {
          dispose = handle.dispose
          session.current = handle
          handle.setActive(activeRef.current)
          setLoading(false)
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        setLoading(false)
        if (!(error instanceof ApiError && error.kind === "stale")) setFailure(pluginError(error))
        void pluginStore.refresh()
      })
    return () => {
      session.current = null
      controller.abort()
      dispose?.()
    }
  }, [
    child.id,
    child.name,
    child.archived,
    epoch,
    pluginId,
    plugin?.releaseId,
    plugin?.version,
    plugin?.configRevision,
    effective,
    retry,
  ])
  return (
    <section
      ref={section}
      className="plugin-page"
      aria-label={plugin?.name || "应用"}
      hidden={!active}
      inert={!active}
      aria-hidden={active ? undefined : true}
    >
      {!effective ? (
        <div className="plugin-placeholder" role="status">
          <h2>
            {!state.confirmed && !state.loading
              ? "应用状态未确认"
              : state.loading
                ? "正在读取应用状态…"
                : plugin?.operationState === "updating"
                  ? "应用更新中"
                  : "应用暂不可用"}
          </h2>
          <p>
            {!state.confirmed
              ? state.error || "请先刷新确认应用状态，再使用应用。"
              : plugin
                ? pluginReason(plugin) || "应用已停用或当前儿童不可使用，请在应用管理中查看。"
                : state.error || "请在应用管理中查看最新状态。"}
          </p>
          <Button variant="outline" onClick={() => void pluginStore.refresh()}>
            刷新状态
          </Button>
        </div>
      ) : failure ? (
        <div className="plugin-placeholder" role="alert">
          <h2>应用加载失败</h2>
          <p>{failure}</p>
          <Button
            variant="outline"
            onClick={() => {
              void pluginStore.refresh()
              setRetry((value) => value + 1)
            }}
          >
            重试
          </Button>
        </div>
      ) : loading ? (
        <div role="status" className="plugin-placeholder">
          <Skeleton className="h-10 w-48" />
          <p>正在加载应用…</p>
        </div>
      ) : null}
      <div
        ref={host}
        className="plugin-host"
        hidden={!effective || !!failure}
        aria-busy={loading}
      />
    </section>
  )
}

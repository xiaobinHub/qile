import { ApiError, runtime } from "../lib/runtime"
import { pluginBase, pluginClient } from "./client"
import { pluginStore } from "./store"
import type { Plugin, PluginContext, PluginModule, PluginDevelopment } from "./types"

export function pluginAssetUrl(value: string, pluginId: string, version: string) {
  const url = new URL(value, location.origin)
  const prefix = `/plugin-assets/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/`
  const rawPath = value.split(/[?#]/, 1)[0]
  if (
    url.origin !== location.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix) ||
    url.pathname === prefix ||
    /[\\\s]/.test(value) ||
    /%2f|%5c|%2e|%25/i.test(rawPath) ||
    rawPath.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("应用资源地址不受支持，请联系管理员。")
  return url.href
}

function developmentUrl(value: string, pluginId: string, dev: PluginDevelopment) {
  const prefix = `/__plugin-dev/${encodeURIComponent(pluginId)}/${dev.sessionId}/`
  if (
    !/^[a-zA-Z0-9-]{8,80}$/.test(dev.sessionId) ||
    dev.base !== prefix ||
    !Number.isSafeInteger(dev.revision) ||
    dev.revision < 0 ||
    value !== prefix + "@plugin-entry"
  )
    throw new Error("开发资源地址不正确。")
  return new URL(value, location.origin).href
}

function businessPath(path: string) {
  const relative = path.replace(/^\/(?!\/)/, "")
  if (!relative || /[:#\\\x00-\x20]/.test(relative) || path.startsWith("//"))
    throw new Error("应用请求地址不受支持。")
  const pathname = relative.split("?", 1)[0]
  for (const segment of pathname.split("/")) {
    const decoded = decodeURIComponent(segment)
    if (!decoded || decoded === "." || decoded === ".." || /[/\\%]/.test(decoded))
      throw new Error("应用请求地址不受支持。")
  }
  return relative
}

function stylesheet(href: string, signal: AbortSignal, links: HTMLLinkElement[]) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new ApiError("应用已关闭。", "stale"))
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.href = href
    links.push(link)
    const finish = (error?: Error) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      link.onload = null
      link.onerror = null
      if (error) {
        link.remove()
        reject(error)
      } else resolve()
    }
    const abort = () => finish(new ApiError("应用已关闭。", "stale"))
    const timer = window.setTimeout(() => finish(new Error("应用样式加载超时，请重试。")), 15000)
    signal.addEventListener("abort", abort, { once: true })
    link.onload = () => finish()
    link.onerror = () => finish(new Error("应用样式加载失败，请重试。"))
    document.head.append(link)
  })
}

/** Native import cannot be cancelled; every continuation checks the child and release before mounting. */
export async function mountPlugin(options: {
  host: HTMLElement
  plugin: Plugin
  child: { id: string; name: string }
  epoch: number
  signal: AbortSignal
  notify: (message: string) => void
  onDevelopmentChange?: () => void
  onDevelopmentError?: (message: string) => void
}): Promise<{ dispose(): void; setActive(active: boolean): void }> {
  const { host, plugin, child, epoch, signal, notify } = options
  const links: HTMLLinkElement[] = []
  const root = document.createElement("div")
  root.dataset.pluginRoot = plugin.id
  root.className = "plugin-mount"
  let unmount: (() => void) | undefined
  let disposed = false
  let monitor: number | undefined
  let developmentStatus: HTMLElement | undefined
  let pageActive = true
  const listeners = new Set<(active: boolean) => void>()
  const overlay = document.createElement("div")
  overlay.className = "plugin-overlay"
  overlay.dataset.pluginOverlay = plugin.id
  const setActive = (next: boolean) => {
    if (disposed || pageActive === next) return
    pageActive = next
    overlay.hidden = !next
    overlay.inert = !next
    if (
      !next &&
      document.body.style.pointerEvents === "none" &&
      !document.querySelector(".plugin-overlay:not([hidden])")
    )
      document.body.style.pointerEvents = ""
    for (const listener of listeners) {
      try {
        listener(next)
      } catch {
        /* A plugin visibility handler must not block core navigation. */
      }
    }
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    window.clearTimeout(monitor)
    developmentStatus?.remove()
    signal.removeEventListener("abort", dispose)
    listeners.clear()
    try {
      unmount?.()
    } catch {
      /* A faulty plugin disposer must not block core navigation. */
    }
    root.remove()
    overlay.remove()
    links.forEach((link) => link.remove())
  }
  const assertActive = () => {
    pluginStore.requireConfirmed(child.id, epoch)
    const current = pluginStore.getSnapshot().plugins.find((item) => item.id === plugin.id)
    if (
      signal.aborted ||
      disposed ||
      !host.isConnected ||
      !pluginStore.matches(child.id, epoch) ||
      !current?.installed ||
      !current.effectiveEnabled ||
      current.operationState !== "ready" ||
      current.type !== "page" ||
      current.releaseId !== plugin.releaseId ||
      current.version !== plugin.version
    )
      throw new ApiError("应用上下文已变化。", "stale")
  }
  signal.addEventListener("abort", dispose, { once: true })
  try {
    assertActive()
    const entry = await pluginClient.entry(child.id, plugin.id, signal)
    assertActive()
    if (entry.releaseId !== plugin.releaseId || entry.version !== plugin.version)
      throw new ApiError(
        "应用版本已更新，请刷新后重试。",
        "conflict",
        409,
        "plugin_version_changed",
      )
    if (!Array.isArray(entry.styles)) throw new Error("应用资源格式不正确。")
    const dev = entry.development
    const entryUrl = dev
      ? developmentUrl(entry.entry, plugin.id, dev)
      : pluginAssetUrl(entry.entry, plugin.id, entry.version)
    const styles = entry.styles.map((value) => pluginAssetUrl(value, plugin.id, entry.version))
    await Promise.all(styles.map((href) => stylesheet(href, signal, links)))
    assertActive()
    const module = (await import(/* @vite-ignore */ entryUrl)) as PluginModule
    assertActive()
    if (typeof module.mount !== "function") throw new Error("应用入口缺少挂载方法，请联系管理员。")
    document.body.append(overlay)
    const context: PluginContext = {
      child: { ...child },
      releaseId: entry.releaseId,
      signal,
      overlay,
      isActive: () => pageActive,
      onVisibility: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      api: async <T>(
        path: string,
        options?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
      ) => {
        assertActive()
        const relative = businessPath(path)
        const result = await runtime.api<T>(
          `${pluginBase(child.id, plugin.id)}/runtime/${relative}`,
          options?.method || "GET",
          options?.body,
          {
            "X-Plugin-Release": entry.releaseId,
            ...(dev
              ? {
                  "X-Plugin-Dev-Session": dev.sessionId,
                  "X-Plugin-Dev-Revision": String(dev.revision),
                }
              : {}),
          },
          signal,
        )
        assertActive()
        return result
      },
      notify: (message) => {
        assertActive()
        notify(message)
      },
      navigateCore: (view) => {
        assertActive()
        if (["calendar", "store", "settings"].includes(view)) runtime.setView(view)
      },
      refreshChild: () => {
        assertActive()
        return runtime.refresh(true)
      },
    }
    if (dev) {
      developmentStatus = document.createElement("p")
      developmentStatus.setAttribute("role", "status")
      developmentStatus.textContent = `开发模式 · 前端源码热更新 · 后端${dev.backend ? "源码运行" : "已安装版本"}`
      host.append(developmentStatus)
    }
    host.append(root)
    const cleanup = module.mount(root, context)
    if (typeof cleanup !== "function") throw new Error("应用未提供卸载方法，请联系管理员。")
    if (disposed) {
      try {
        cleanup()
      } catch {
        /* Already detached. */
      }
    } else unmount = cleanup
    assertActive()
    if (dev) {
      const check = async () => {
        try {
          const latest = await pluginClient.entry(child.id, plugin.id, signal)
          if (disposed || signal.aborted) return
          if (latest.development?.state === "draining") {
            if (developmentStatus)
              developmentStatus.textContent = "开发模式 · 正在等待请求完成并重载…"
            monitor = window.setTimeout(check, 1000)
            return
          }
          if (latest.development?.sessionId !== dev.sessionId) {
            dispose()
            // Session boundary: clear Vite's sockets, styles and cached modules.
            window.location.reload()
            return
          }
          if (latest.development?.revision !== dev.revision) {
            dispose()
            options.onDevelopmentChange?.()
            return
          }
          const health = await fetch(dev.base + "__dev_health", {
            signal,
            credentials: "same-origin",
            cache: "no-store",
          })
          if (!health.ok) throw new Error("插件开发服务不可用，请检查开发终端后重试。")
          monitor = window.setTimeout(check, 2000)
        } catch (error) {
          if (disposed || signal.aborted) return
          dispose()
          options.onDevelopmentError?.((error as Error).message)
        }
      }
      monitor = window.setTimeout(check, 2000)
    }
    return { dispose, setActive }
  } catch (error) {
    dispose()
    throw error
  }
}

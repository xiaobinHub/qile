import { useCallback, useEffect, useRef } from "react"
import { isIgnoredError, StaleRequest, useSession } from "@/lib/session"

type Method = "GET" | "PATCH" | "POST" | "PUT"
export type PluginRequest = <T>(
  path: string,
  method?: Method,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>

export class PluginApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Local adapter: the shared session client does not expose PUT or HTTP conflict status. */
export function usePluginRequest(): PluginRequest {
  const { session, version, request: sessionRequest } = useSession()
  const active = useRef(true)
  const controllers = useRef(new Set<AbortController>())
  useEffect(() => {
    active.current = true
    const pending = controllers.current
    return () => {
      active.current = false
      for (const controller of pending) controller.abort()
      pending.clear()
    }
  }, [version])

  return useCallback<PluginRequest>(
    async (path, method = "GET", body, signal) => {
      if (!session || !active.current) throw new StaleRequest()
      const controller = new AbortController()
      controllers.current.add(controller)
      const abort = () => controller.abort()
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) controller.abort()
      try {
        let response: Response
        try {
          response = await fetch(`/api/admin/${path}`, {
            method,
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
              ...(method === "GET" ? {} : { "X-CSRF-Token": session.csrfToken }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
          })
        } catch (error) {
          if (!active.current) throw new StaleRequest()
          if (isIgnoredError(error)) throw error
          throw new Error(
            method === "GET"
              ? "连接中断，请检查网络后重试。"
              : "连接中断，请刷新核对操作结果后再重试。",
          )
        }
        let result: unknown = {}
        try {
          result = await response.json()
        } catch (error) {
          if (isIgnoredError(error)) throw error
          if (response.ok && method === "GET") throw new Error("返回内容不完整，请重新加载。")
        }
        if (!active.current || controller.signal.aborted) throw new StaleRequest()
        if (response.status === 401) {
          // Let the owning session provider clear the session and display its normal login notice.
          await sessionRequest("auth/me")
          throw new StaleRequest()
        }
        if (!response.ok) {
          const message =
            result &&
            typeof result === "object" &&
            "error" in result &&
            typeof result.error === "string"
              ? result.error
              : "操作未能完成，请稍后重试。"
          throw new PluginApiError(response.status, message)
        }
        return result as never
      } finally {
        signal?.removeEventListener("abort", abort)
        controllers.current.delete(controller)
      }
    },
    [session, sessionRequest],
  )
}

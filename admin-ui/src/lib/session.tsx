import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { Session, SessionUser } from "@/lib/types"

type Method = "GET" | "POST" | "PATCH"
type Request = <T = Record<string, never>>(path: string, method?: Method, body?: unknown, signal?: AbortSignal) => Promise<T>

export class StaleRequest extends Error {}
export function isIgnoredError(error: unknown) {
  return error instanceof StaleRequest || (error instanceof DOMException && error.name === "AbortError")
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作未能完成，请稍后重试。"
}

type SessionContextValue = {
  session: Session | null
  phase: "loading" | "ready" | "signingOut"
  notice: string
  version: number
  request: Request
  signIn: (session: Session) => void
  signOut: () => Promise<void>
  passwordChanged: () => void
  updateUser: (user: SessionUser) => void
}
const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [phase, setPhase] = useState<SessionContextValue["phase"]>("loading")
  const [notice, setNotice] = useState("")
  const [version, setVersion] = useState(0)
  const epoch = useRef(0)
  const token = useRef("")

  const clearSession = useCallback((message: string) => {
    epoch.current += 1
    token.current = ""
    setSession(null)
    setVersion(epoch.current)
    setNotice(message)
    setPhase("ready")
  }, [])

  const request = useCallback<Request>(async (path, method = "GET", body, signal) => {
    const startedAt = epoch.current
    const headers: Record<string, string> = {}
    if (body !== undefined) headers["Content-Type"] = "application/json"
    if (method !== "GET") headers["X-CSRF-Token"] = token.current
    let response: Response
    try {
      response = await fetch(`/api/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        cache: "no-store",
        signal,
      })
    } catch (error) {
      if (epoch.current !== startedAt) throw new StaleRequest()
      if (isIgnoredError(error)) throw error
      throw new Error(method === "GET" ? "连接中断，请检查网络后重试。" : "连接中断，请刷新核对操作结果。")
    }
    let result: { error?: string } = {}
    try { result = await response.json() } catch { /* A server error may have no JSON body. */ }
    if (epoch.current !== startedAt) throw new StaleRequest()
    if (!response.ok) {
      if (response.status === 401 && path !== "auth/login") {
        clearSession("会话已失效，请重新登录。")
        throw new StaleRequest()
      }
      throw new Error(result.error || "操作未能完成，请稍后重试。")
    }
    return result as never
  }, [clearSession])

  const signIn = useCallback((nextSession: Session) => {
    epoch.current += 1
    token.current = nextSession.csrfToken
    setVersion(epoch.current)
    setSession(nextSession)
    setNotice("")
    setPhase("ready")
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    request<Session>("auth/me", "GET", undefined, controller.signal)
      .then(result => { if (active) signIn(result) })
      .catch(error => {
        if (active && !isIgnoredError(error)) {
          setNotice(errorMessage(error))
          setPhase("ready")
        }
      })
    return () => { active = false; controller.abort() }
  }, [request, signIn])

  const signOut = useCallback(async () => {
    const oldToken = token.current
    clearSession("")
    setPhase("signingOut")
    const startedAt = epoch.current
    let message = ""
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": oldToken },
        body: "{}",
        credentials: "same-origin",
        cache: "no-store",
      })
      if (!response.ok && response.status !== 401) message = "退出请求未完成，请重新登录后重试。"
    } catch { message = "退出请求未完成，请重新登录后重试。" }
    if (epoch.current === startedAt) { setNotice(message); setPhase("ready") }
  }, [clearSession])

  const updateUser = useCallback((user: SessionUser) => {
    setSession(current => current ? { ...current, user } : null)
  }, [])
  const passwordChanged = useCallback(() => clearSession("密码已修改，请重新登录。"), [clearSession])

  return <SessionContext.Provider value={{ session, phase, notice, version, request, signIn, signOut, passwordChanged, updateUser }}>{children}</SessionContext.Provider>
}

export function useSession() {
  const value = useContext(SessionContext)
  if (!value) throw new Error("SessionProvider is required")
  return value
}

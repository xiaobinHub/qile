import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import type { Controller } from "./types"
export { Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Input, Label, Badge }

const paths: Record<string, string> = {
  child: '<circle cx="12" cy="8" r="3"/><path d="M6 21v-3a6 6 0 0 1 12 0v3"/>',
  family: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a6 6 0 0 1 3 5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 7 9 6 9-6"/>',
  task: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v4H9zM9 12h6m-6 4h4"/>',
  category: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  backup: '<path d="M4 8V4m0 0h4M4 4l3 3a8 8 0 1 1-2 9M12 8v5l3 2"/>',
  key: '<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-5-5 3-3m-1 5 3-3"/>',
  logout: '<path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4m6-13 5 5-5 5M9 12h11"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
}
export function Icon({ name }: { name: string }) {
  // The paths are trusted, bundled SVG constants; business text is rendered as JSX.
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths[name] || paths.child }} />
}
export const date = (value: string) => new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
export const initial = (value: string) => Array.from(String(value || "").trim())[0] || "家"
export const statusNames: Record<string, string> = { pending: "待接受", accepted: "已接受", rejected: "已拒绝", revoked: "已撤销", expired: "已过期" }
export function Empty({ title, copy, type = "mail" }: { title: string; copy: string; type?: string }) {
  return <div className="settings-empty"><span><Icon name={type} /></span><strong>{title}</strong><p>{copy}</p></div>
}
export const Notice = ({ children }: { children: ReactNode }) => <p className="settings-notice">{children}</p>
export const Feedback = ({ id, message = "", success = false }: { id: string; message?: string; success?: boolean }) => <p id={id} className={`settings-feedback${success ? " success" : ""}`} role="status" aria-live="polite">{message}</p>
export function useAction(controller: Controller) {
  const live = useRef(true)
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState("")
  useLayoutEffect(() => () => { live.current = false }, [])
  async function run<T>(key: string, work: () => Promise<T>, finish?: (result: T) => void | Promise<void>) {
    if (controller.pending || !live.current) return
    const token = {}; controller.pending = token
    setBusy(key); setError("")
    try { const result = await work(); if (live.current) await finish?.(result) }
    catch (failure) {
      const issue = failure as { kind?: string; message?: string }
      if (live.current && issue.kind !== "stale" && issue.kind !== "unauthorized") setError(issue.message || "请求未完成，请稍后重试。")
    } finally {
      if (controller.pending === token) controller.pending = null
      if (live.current) setBusy(null)
    }
  }
  return { busy, error, setError, run, active: () => live.current }
}
export function useRead<T>(load: () => Promise<T>, refresh = 0) {
  const [value, setValue] = useState<T | null>(null), [error, setError] = useState("")
  useEffect(() => {
    let active = true
    setError("")
    load().then(result => { if (active) setValue(result) }).catch(failure => {
      if (active && failure.kind !== "stale" && failure.kind !== "unauthorized") setError(failure.message)
    })
    return () => { active = false }
  }, [refresh])
  return { value, error }
}
export function ReadStatus({ error, loading, retry }: { error: string; loading: string; retry: () => void }) {
  return error ? <div className="settings-empty settings-load-error"><strong>暂时无法读取</strong><p>{error}</p><Button className="btn" type="button" id="retrySettings" onClick={retry}>重新加载</Button></div> : <p className="settings-loading" role="status">{loading}</p>
}

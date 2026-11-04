import type { Bootstrap, BookingQuery, Draft, TeacherQuery, TeacherSchedule } from "./types"

export class PluginApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly operationId?: string,
  ) {
    super(message)
  }
}

type Result<T> =
  | { ok: true; data: T; requestId: string; serverTime: string }
  | { ok: false; error: { code: string; message: string; operationId?: string } }

const expiryListeners = new WeakMap<object, Set<() => void>>()
export function onConnectionExpired(context: object, listener: () => void) {
  const listeners = expiryListeners.get(context) ?? new Set<() => void>()
  listeners.add(listener)
  expiryListeners.set(context, listeners)
  return () => {
    listeners.delete(listener)
  }
}

export async function request<T>(
  context: { api: PluginContextLike["api"] },
  path: string,
  options?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
): Promise<T> {
  const result = await context.api<Result<T>>(path, options)
  if (!result.ok) {
    if (result.error.code === "RECONNECT_REQUIRED")
      expiryListeners.get(context)?.forEach((listener) => listener())
    throw new PluginApiError(result.error.code, result.error.message, result.error.operationId)
  }
  return result.data
}

type PluginContextLike = {
  api<T>(
    path: string,
    options?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
  ): Promise<T>
}

export const getBootstrap = (context: PluginContextLike) => request<Bootstrap>(context, "bootstrap")
export const getTeachers = (
  context: PluginContextLike,
  query: URLSearchParams,
  cursor?: string | null,
) => {
  if (cursor) query.set("cursor", cursor)
  return request<TeacherQuery>(context, `teachers?${query}`)
}
export const getSchedule = (
  context: PluginContextLike,
  teacherId: string,
  date?: string | null,
) => {
  const query = new URLSearchParams()
  if (date) query.set("date", date)
  return request<TeacherSchedule>(
    context,
    `teachers/${teacherId}/schedule${query.size ? `?${query}` : ""}`,
  )
}
export const createDraft = (context: PluginContextLike, body: unknown) =>
  request<Draft>(context, "drafts", { method: "POST", body })
export const getBookings = (context: PluginContextLike, status: string) =>
  request<BookingQuery>(context, `bookings?status=${status}`)

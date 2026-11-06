import { useEffect, useState } from "react"
import { request } from "./api"
import type { Booking, PluginContext } from "./types"

export type BookingStatus = "upcoming" | "completed" | "cancelled"
export type BookingPage = {
  status: BookingStatus
  page: number
  pageSize: number
  complete: boolean
  items: Booking[]
}
type Chain = {
  pages: Booking[][]
  complete: boolean
  error: string
  loading: boolean
  generation: number
  queue: Promise<void>
}
type Snapshot = {
  items: Booking[]
  loading: boolean
  error: string
  complete: boolean
  settled: boolean
}

const chains = new Map<string, Chain>()
const listeners = new Set<() => void>()
const orderMessage = "美森课程顺序已改变，请刷新列表。"
const stallMessage = "课程分页未推进，请刷新列表。"

const emit = () => listeners.forEach((listener) => listener())
const keyOf = (scope: string, status: BookingStatus) => `${scope}:${status}`
export const subscribeBookingSource = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function ensure(scope: string, status: BookingStatus) {
  const key = keyOf(scope, status)
  let chain = chains.get(key)
  if (!chain) {
    chain = {
      pages: [],
      complete: false,
      error: "",
      loading: false,
      generation: 0,
      queue: Promise.resolve(),
    }
    chains.set(key, chain)
  }
  return chain
}

function enqueue(chain: Chain, task: () => Promise<void>) {
  const run = chain.queue.then(task, task)
  chain.queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function boundDay(chain: Chain, status: BookingStatus) {
  let bound = ""
  for (const item of chain.pages.flat()) {
    const day = item.startsAt?.slice(0, 10) ?? ""
    if (!day) continue
    if (!bound || (status === "upcoming" ? day > bound : day < bound)) bound = day
  }
  return bound
}

function needsThrough(chain: Chain, status: BookingStatus, edge: string) {
  const bound = boundDay(chain, status)
  if (!bound) return true
  return status === "upcoming" ? edge >= bound : edge <= bound
}

function abandoned(context: PluginContext, error: unknown) {
  if (context.signal.aborted) return true
  if (!error || typeof error !== "object") return false
  const code = "code" in error ? error.code : undefined
  const kind = "kind" in error ? error.kind : undefined
  const name = "name" in error ? error.name : undefined
  return code === "stale" || kind === "stale" || name === "AbortError"
}

function rememberFailure(chain: Chain, generation: number, context: PluginContext, error: unknown) {
  if (chain.generation !== generation || abandoned(context, error)) return
  chain.error = error instanceof Error ? error.message : "课程读取失败"
}

function shouldFetch(chain: Chain, status: BookingStatus, edge: string | null) {
  if (chain.complete || chain.error) return false
  if (!chain.pages.length) return true
  return edge !== null && needsThrough(chain, status, edge)
}

function assertOrder(status: BookingStatus, previous: Booking[], items: Booking[]) {
  const stamps = [...previous.slice(-1), ...items].map((item) => item.startsAt ?? "")
  for (let index = 1; index < stamps.length; index += 1) {
    const earlier = stamps[index - 1]
    const later = stamps[index]
    if (!earlier || !later) throw Error(orderMessage)
    if (status === "upcoming" ? later < earlier : later > earlier) throw Error(orderMessage)
  }
}

async function fetchPage(
  chain: Chain,
  context: PluginContext,
  status: BookingStatus,
  page: number,
) {
  if (chain.pages.length >= page || chain.complete) return
  const generation = chain.generation
  const data = await request<BookingPage>(context, `bookings/pages?status=${status}&page=${page}`)
  if (chain.generation !== generation || context.signal.aborted) return
  if (data.status !== status || data.page !== page) throw Error(stallMessage)
  if (!data.items.length) {
    if (!data.complete) throw Error(stallMessage)
    chain.complete = true
    return
  }
  const seen = new Set(chain.pages.flat().map((item) => item.key))
  if (data.items.some((item) => seen.has(item.key))) throw Error(stallMessage)
  assertOrder(status, chain.pages.at(-1) ?? [], data.items)
  chain.pages.push(data.items)
  chain.complete = data.complete
}

export function readBookingSource(
  scope: string,
  status: BookingStatus,
  edge: string | null,
): Snapshot {
  const chain = chains.get(keyOf(scope, status))
  if (!chain) return { items: [], loading: false, error: "", complete: false, settled: false }
  const items = chain.pages.flat()
  const settled =
    !chain.error &&
    (chain.complete || (edge !== null && items.length > 0 && !needsThrough(chain, status, edge)))
  return { items, loading: chain.loading, error: chain.error, complete: chain.complete, settled }
}

export function syncBookingSource(
  context: PluginContext,
  scope: string,
  status: BookingStatus,
  edge: string | null,
) {
  const chain = ensure(scope, status)
  return enqueue(chain, async () => {
    const generation = chain.generation
    if (context.signal.aborted || !shouldFetch(chain, status, edge)) return
    chain.loading = true
    emit()
    try {
      while (
        chain.generation === generation &&
        !context.signal.aborted &&
        shouldFetch(chain, status, edge)
      ) {
        if (chain.pages.length >= 100) throw Error("课程历史过多，暂时无法完成本次查询。")
        await fetchPage(chain, context, status, chain.pages.length + 1)
      }
    } catch (error) {
      rememberFailure(chain, generation, context, error)
    } finally {
      if (chain.generation === generation) chain.loading = false
      emit()
    }
  })
}

export function loadNextBookingPage(context: PluginContext, scope: string, status: BookingStatus) {
  const chain = ensure(scope, status)
  return enqueue(chain, async () => {
    const generation = chain.generation
    if (context.signal.aborted || chain.complete || chain.error || chain.pages.length >= 100) return
    chain.loading = true
    emit()
    try {
      await fetchPage(chain, context, status, chain.pages.length + 1)
    } catch (error) {
      rememberFailure(chain, generation, context, error)
    } finally {
      if (chain.generation === generation) chain.loading = false
      emit()
    }
  })
}

export function reloadBookingSource(scope: string, statuses: BookingStatus[]) {
  for (const status of statuses) {
    const chain = chains.get(keyOf(scope, status))
    if (!chain) continue
    chain.generation += 1
    chain.pages = []
    chain.complete = false
    chain.error = ""
    chain.loading = false
  }
  emit()
}

export function clearBookingSource() {
  for (const chain of chains.values()) chain.generation += 1
  chains.clear()
  emit()
}

export function useBookingSource({
  context,
  scope,
  status,
  enabled,
  edge,
}: {
  context: PluginContext
  scope: string
  status: BookingStatus
  enabled: boolean
  edge: string | null
}) {
  const [tick, setTick] = useState(0)
  useEffect(() => subscribeBookingSource(() => setTick((value) => value + 1)), [])
  useEffect(() => {
    if (!enabled) return
    void syncBookingSource(context, scope, status, edge)
  }, [context, scope, status, edge, enabled, tick])
  const snapshot = readBookingSource(scope, status, edge)
  const loading =
    snapshot.loading || (enabled && !snapshot.items.length && !snapshot.error && !snapshot.settled)
  return { ...snapshot, loading }
}

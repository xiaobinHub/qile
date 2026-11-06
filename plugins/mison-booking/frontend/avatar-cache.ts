const LIMIT = 200
const CACHE_NAME = "mison-teacher-avatars"
const REFERENCE = /^mison-image:([a-f0-9]{64})$/
const memory = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()
const generations = new Map<string, number>()
let queue: Promise<void> = Promise.resolve()

function generation(reference: string) {
  return generations.get(reference) ?? 0
}

function isImageData(data: string) {
  return /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(data)
}

export function peekAvatar(reference: string) {
  return memory.get(reference) ?? null
}

function retain(reference: string, data: string) {
  memory.delete(reference)
  memory.set(reference, data)
  while (memory.size > LIMIT) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

function cacheAvailable() {
  return typeof caches !== "undefined" && window.isSecureContext
}

function cacheRequest(reference: string) {
  const hash = REFERENCE.exec(reference)?.[1]
  if (!hash || typeof location === "undefined") return null
  return new Request(`${location.origin}/mison-avatar-cache/v1/${hash}`)
}

function enqueue<T>(work: (cache: Cache) => Promise<T>) {
  const run = queue.then(async () => work(await caches.open(CACHE_NAME)))
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = reader.result
      if (typeof value === "string" && value.startsWith("data:image/")) resolve(value)
      else reject(new Error("头像缓存不正确"))
    }
    reader.onerror = () => reject(reader.error ?? new Error("头像缓存读取失败"))
    reader.readAsDataURL(blob)
  })
}

function dataUrlToBlob(data: string) {
  const match = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([a-z0-9+/=\s]+)$/i.exec(data)
  if (!match) return null
  const binary = atob(match[2].replace(/\s+/g, ""))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  if (!bytes.byteLength) return null
  const type = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase()
  return new Blob([bytes], { type })
}

async function readBrowser(reference: string, seen: number) {
  const request = cacheRequest(reference)
  if (!request || !cacheAvailable()) return null
  try {
    return await enqueue(async (cache) => {
      if (generation(reference) !== seen) return null
      const match = await cache.match(request)
      if (!match) return null
      const blob = await match.blob()
      if (!blob.size || !/^image\/(?:jpeg|jpg|png|webp|gif)$/.test(blob.type)) {
        await cache.delete(request)
        return null
      }
      if (generation(reference) !== seen) return null
      await cache.delete(request)
      await cache.put(request, new Response(blob, { headers: { "Content-Type": blob.type } }))
      await trim(cache)
      return blobToDataUrl(blob)
    })
  } catch {
    return null
  }
}

async function writeBrowser(reference: string, data: string, seen: number) {
  const request = cacheRequest(reference)
  if (!request || !cacheAvailable() || generation(reference) !== seen) return
  try {
    const blob = dataUrlToBlob(data)
    if (!blob || generation(reference) !== seen) return
    await enqueue(async (cache) => {
      if (generation(reference) !== seen) return
      await cache.delete(request)
      await cache.put(request, new Response(blob, { headers: { "Content-Type": blob.type } }))
      await trim(cache)
    })
  } catch {
    /* Storage can be disabled or full; the in-memory copy still serves this page. */
  }
}

async function trim(cache: Cache) {
  const requests = await cache.keys()
  if (requests.length <= LIMIT) return
  await Promise.all(
    requests.slice(0, requests.length - LIMIT).map((request) => cache.delete(request)),
  )
}

export function forgetAvatar(reference: string) {
  generations.set(reference, generation(reference) + 1)
  memory.delete(reference)
  inflight.delete(reference)
  const request = cacheRequest(reference)
  if (!request || !cacheAvailable()) return
  void enqueue((cache) => cache.delete(request)).catch(() => undefined)
}

export function loadAvatar(reference: string, fetchImage: () => Promise<string>) {
  const ready = memory.get(reference)
  if (ready) {
    retain(reference, ready)
    return Promise.resolve(ready)
  }
  const pending = inflight.get(reference)
  if (pending) return pending
  const seen = generation(reference)
  const loading = (async () => {
    const stored = await readBrowser(reference, seen)
    if (generation(reference) !== seen) throw new Error("头像已失效")
    const data = stored ?? (await fetchImage())
    if (generation(reference) !== seen || !isImageData(data)) throw new Error("头像数据不正确")
    if (!stored) void writeBrowser(reference, data, seen)
    if (generation(reference) !== seen) throw new Error("头像已失效")
    retain(reference, data)
    return data
  })().finally(() => {
    if (inflight.get(reference) === loading) inflight.delete(reference)
  })
  inflight.set(reference, loading)
  return loading
}

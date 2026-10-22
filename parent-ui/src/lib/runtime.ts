import { normalizeBusinessData } from "../domain/normalize"
import type { BusinessData, Child, DataPackage, User } from "../domain/types"
export function operationId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  }
  return "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2)
}
export class ApiError extends Error {
  constructor(
    message: string,
    public kind = "connection",
    public status = 0,
  ) {
    super(message)
  }
}
type View = "calendar" | "store" | "settings" | "onboarding"
type Snapshot = {
  user: User | null
  child: Child | null
  children: Child[]
  data: BusinessData | null
  revision: number
  updatedAt: string | null
  view: View
  loading: boolean
  error: string
  message: string
  busy: boolean
  unconfirmed: boolean
  epoch: number
}
export class Runtime {
  private state: Snapshot = {
    user: null,
    child: null,
    children: [],
    data: null,
    revision: 0,
    updatedAt: null,
    view: "calendar",
    loading: true,
    error: "",
    message: "",
    busy: false,
    unconfirmed: false,
    epoch: 0,
  }
  private listeners = new Set<() => void>()
  private generation = 0
  private requests = new Set<AbortController>()
  private csrf = ""
  private checking = false
  private editing = 0
  private pending: { signature: string; path: string; body: unknown } | null = null
  private channel =
    typeof BroadcastChannel === "function" ? new BroadcastChannel("lele-parent-auth") : null
  constructor() {
    if (this.channel)
      this.channel.onmessage = () => this.signedOut("账号已在其他页面退出或修改密码，请重新登录。")
  }
  getSnapshot = () => this.state
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  patch = (next: Partial<Snapshot>) => {
    this.state = { ...this.state, ...next }
    this.listeners.forEach((fn) => fn())
  }
  private reset(signout = false) {
    this.generation++
    for (const r of this.requests) r.abort()
    this.requests.clear()
    this.pending = null
    this.editing = 0
    this.patch({
      child: null,
      data: null,
      revision: 0,
      updatedAt: null,
      busy: false,
      unconfirmed: false,
      loading: true,
      error: "",
      epoch: this.state.epoch + 1,
      ...(signout ? { user: null, children: [] } : {}),
    })
  }
  api = async <T>(
    path: string,
    method = "GET",
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> => {
    const generation = this.generation,
      controller = new AbortController()
    this.requests.add(controller)
    try {
      let response: Response
      try {
        response = await fetch(path, {
          method,
          signal: controller.signal,
          cache: "no-store",
          headers: {
            ...(body !== undefined
              ? { "Content-Type": body instanceof Blob ? body.type : "application/json" }
              : {}),
            ...extraHeaders,
            ...(method !== "GET" ? { "X-CSRF-Token": this.csrf } : {}),
          },
          body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
        })
      } catch {
        if (generation !== this.generation) throw new ApiError("页面已切换。", "stale")
        throw new ApiError(
          method === "GET" ? "暂时无法连接服务，请重试。" : "保存结果暂未确认，请刷新检查。",
        )
      }
      const result = await response.json().catch(() => ({}))
      if (generation !== this.generation) throw new ApiError("页面已切换。", "stale")
      if (!response.ok) {
        if (response.status === 401 && this.state.user) this.signedOut("登录已失效，请重新登录。")
        if (
          response.status === 403 &&
          result.kind === "membership_revoked" &&
          this.state.child &&
          path.startsWith(`/api/children/${this.state.child.id}`)
        ) {
          this.forgetChild(this.state.child.id)
          void this.home()
          throw new ApiError("该孩子已不可访问。", "stale", 403)
        }
        throw new ApiError(
          result.error || "请求未完成，请重试。",
          response.status === 401
            ? "unauthorized"
            : response.status === 403
              ? "forbidden"
              : response.status === 409
                ? "conflict"
                : "connection",
          response.status,
        )
      }
      return result as T
    } finally {
      this.requests.delete(controller)
    }
  }
  uploadImage = async (value: string, uploadId: string, epoch: number, retry = false) => {
    const child = this.state.child
    if (!child || child.archived || epoch !== this.state.epoch)
      throw new ApiError("孩子上下文已变化。", "stale")
    type Upload = { assetId: string; imageUrl?: string; status: string }
    const base = `/api/children/${child.id}/assets`
    if (retry) {
      try {
        const status = await this.api<Upload>(`${base}/uploads/${uploadId}`)
        if (status.status === "staged" || status.status === "attached") return status
      } catch (e) {
        if ((e as ApiError).status !== 404) throw e
      }
    }
    const [header, encoded] = value.split(",")
    const mime = header.match(/^data:(image\/(?:png|jpeg|webp));base64$/)?.[1]
    if (!mime || !encoded) throw new ApiError("图片格式不正确。")
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    const result = await this.api<Upload>(base, "POST", new Blob([bytes], { type: mime }), {
      "X-Upload-Id": uploadId,
      "X-Membership-Version": child.membershipVersion,
    })
    if (!["staged", "attached"].includes(result.status))
      throw new ApiError("图片仍在上传，请稍后重试原上传。", "uploading")
    return result
  }
  bootstrap = async () => {
    try {
      const session = await this.api<{ user: User; csrfToken: string }>("/api/auth/me")
      this.csrf = session.csrfToken
      this.patch({ user: session.user })
      await this.enter()
    } catch (e) {
      const error = e as ApiError
      if (error.kind !== "stale")
        this.patch({ loading: false, error: error.status === 401 ? "" : error.message })
    }
  }
  login = async (loginName: string, password: string) => {
    const session = await this.api<{ user: User; csrfToken: string }>("/api/auth/login", "POST", {
      loginName,
      password,
    })
    this.csrf = session.csrfToken
    this.patch({ user: session.user, message: "", error: "" })
    await this.enter()
  }
  private preferred() {
    try {
      return localStorage.getItem("lele-preferred-child:" + this.state.user?.id)
    } catch {
      return null
    }
  }
  forgetChild = (id: string) => {
    try {
      if (this.preferred() === id)
        localStorage.removeItem("lele-preferred-child:" + this.state.user?.id)
    } catch {}
    const children = this.state.children.filter((c) => c.id !== id)
    if (this.state.child?.id === id) this.reset()
    this.patch({ children })
  }
  enter = async () => {
    if (this.state.busy || this.pending) {
      if (this.state.child) history.replaceState(null, "", `/children/${this.state.child.id}`)
      this.patch({ message: "请先刷新核对上一项保存结果，再切换孩子。" })
      return
    }
    this.reset()
    if (this.state.user?.mustChangePassword) {
      this.patch({ loading: false })
      return
    }
    try {
      const { children } = await this.api<{ children: Child[] }>("/api/children")
      this.patch({ children })
      const requested = location.pathname.match(/^\/children\/([^/]+)/)?.[1],
        preferred = this.preferred(),
        active = children.filter((c) => !c.archived)
      const child =
        children.find((c) => c.id === requested) ||
        active.find((c) => c.id === preferred) ||
        active[0] ||
        children[0]
      if (child) await this.selectChild(child.id, "replace")
      else {
        history.replaceState(null, "", "/")
        this.patch({ loading: false, view: "onboarding" })
      }
    } catch (e) {
      if ((e as ApiError).kind !== "stale")
        this.patch({ loading: false, error: (e as Error).message, view: "onboarding" })
    }
  }
  home = async () => {
    history.replaceState(null, "", "/")
    await this.enter()
  }
  selectChild = async (id: string, replace: boolean | "replace" = true) => {
    if (this.state.busy || this.pending)
      throw new ApiError("请先完成保存，或刷新核对上一项保存结果。", "busy")
    const child = this.state.children.find((c) => c.id === id)
    if (!child) return
    this.reset()
    this.patch({ child, view: "calendar" })
    if (replace === "replace") history.replaceState(null, "", `/children/${id}`)
    else if (replace) history.pushState(null, "", `/children/${id}`)
    try {
      this.load(await this.api<DataPackage>(`/api/children/${id}/data`))
      try {
        localStorage.setItem("lele-preferred-child:" + this.state.user?.id, id)
      } catch {}
      this.patch({ loading: false })
    } catch (e) {
      if ((e as ApiError).kind === "stale") return
      this.patch({ loading: false, error: (e as Error).message })
    }
  }
  private load(pkg: DataPackage) {
    if (!this.state.child || pkg.context?.childId !== this.state.child.id)
      throw new ApiError("孩子上下文已变化。", "stale")
    if (
      pkg.format !== "lele-task-manager-store" ||
      pkg.version !== 1 ||
      !Number.isInteger(pkg.revision)
    )
      throw new ApiError("数据包格式不正确。", "corrupt")
    if (pkg.revision < this.state.revision) return
    this.patch({
      data: normalizeBusinessData(pkg.data),
      revision: pkg.revision,
      updatedAt: pkg.updatedAt,
      child: { ...this.state.child, membershipVersion: pkg.context.membershipVersion },
    })
  }
  refresh = async () => {
    if (this.state.busy) return
    const id = this.state.child?.id
    if (!id) {
      await this.enter()
      return
    }
    this.load(await this.api<DataPackage>(`/api/children/${id}/data`))
    this.patch({
      message: this.pending
        ? "已读取最新数据，请核对保存结果。原操作编号仍保留，可安全重试原操作。"
        : "已读取最新数据",
    })
  }
  sync = async (reload: boolean) => {
    const id = this.state.child?.id
    const { children } = await this.api<{ children: Child[] }>("/api/children")
    const child = id ? children.find((c) => c.id === id) || null : null
    this.patch({ children, child })
    if (id && !child) {
      this.reset()
      await this.enter()
      return false
    }
    if (child && reload) this.load(await this.api<DataPackage>(`/api/children/${child.id}/data`))
    return true
  }
  command = async (kind: string, payload: unknown) => {
    const child = this.state.child
    if (!child || child.archived) throw new ApiError("该孩子仅可查看。", "forbidden")
    return this.write(`/api/children/${child.id}/operations`, { kind, payload }, "POST")
  }
  private async write(path: string, values: Record<string, unknown>, method: string) {
    if (this.state.busy) throw new ApiError("上一项操作正在保存，请稍候。", "busy")
    const signature = JSON.stringify({ path, ...values })
    if (this.pending && this.pending.signature !== signature)
      throw new ApiError("上一项保存结果尚未确认，请先刷新核对。")
    const body = this.pending?.body || {
      expectedRevision: this.state.revision,
      membershipVersion: this.state.child!.membershipVersion,
      operationId: operationId(),
      ...values,
    }
    this.pending = { signature, path, body }
    this.patch({ busy: true })
    const epoch = this.generation
    try {
      const pkg = await this.api<DataPackage>(path, method, body)
      this.load(pkg)
      this.pending = null
      this.patch({ unconfirmed: false })
    } catch (e) {
      if (epoch === this.generation) {
        if ((e as ApiError).status && (e as ApiError).status < 500) this.pending = null
        this.patch({ unconfirmed: !!this.pending })
      }
      throw e
    } finally {
      if (epoch === this.generation) this.patch({ busy: false })
    }
  }
  retryPending = async () => {
    const pending = this.pending
    if (!pending || this.state.busy) return
    const { expectedRevision, membershipVersion, operationId, ...values } = pending.body as Record<
      string,
      unknown
    >
    await this.write(pending.path, values, "POST")
    this.patch({ epoch: this.state.epoch + 1, message: "原操作已确认，已读取最新数据。" })
  }
  setView = (view: View) => {
    this.patch({ view })
    window.scrollTo(0, 0)
  }
  setEditing = (editing: boolean) => {
    this.editing += editing ? 1 : -1
    this.editing = Math.max(0, this.editing)
  }
  checkContext = async () => {
    if (
      document.hidden ||
      !this.state.user ||
      !this.state.child ||
      this.state.busy ||
      this.checking
    )
      return
    this.checking = true
    try {
      const old = this.state.child,
        status = await this.api<{ child: Child; revision: number }>(
          `/api/children/${old.id}/context`,
        )
      if (status.child.membershipVersion !== old.membershipVersion) {
        this.reset()
        await this.home()
        return
      }
      if (
        status.revision !== this.state.revision ||
        status.child.archived !== old.archived ||
        status.child.role !== old.role
      ) {
        this.patch({ child: status.child })
        if (this.editing || this.pending)
          this.patch({ message: "其他家长已更新数据，请完成当前编辑后刷新。" })
        else await this.refresh()
      }
    } catch {
      /* Next focus/poll retries; revoked access is cleared by api. */
    } finally {
      this.checking = false
    }
  }
  changePassword = async (values: { currentPassword?: string; newPassword: string }) => {
    await this.api("/api/account/password", "POST", values)
    this.channel?.postMessage("logout")
    this.signedOut("密码已修改，请重新登录。")
  }
  logout = async () => {
    await this.api("/api/auth/logout", "POST", {})
    this.channel?.postMessage("logout")
    this.signedOut("")
  }
  private signedOut(message: string) {
    this.reset(true)
    this.csrf = ""
    history.replaceState(null, "", "/")
    this.patch({ loading: false, message, error: "" })
  }
}
export const runtime = new Runtime()

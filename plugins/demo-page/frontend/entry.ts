import type { PluginContext } from "../../../packages/plugin-sdk/src/index"
import "./style.css"

type Entry = {
  id: string
  revision: number
  payload: { text: string; category: string; score: number; archived: boolean; createdAt: string }
}
type Activity = { id: string; payload: { kind?: string; message?: string; createdAt?: string } }
type Info = {
  pluginId: string
  childId: string
  version: string
  releaseId: string
  configRevision: number
  serverTime: string
  config: {
    title: string
    pageSize: number
    multiplier: number
    autoRefresh: boolean
    tone: string
    categories: string[]
    [key: string]: unknown
  }
}
type Write = {
  id: string
  body: { payload: Entry["payload"]; expectedRevision: number; operationId: string }
  editor: boolean
}

export function mount(container: HTMLElement, context: PluginContext) {
  const root = document.createElement("section")
  root.className = "demo-page"
  // Static markup only; child names, configuration, errors and record text use textContent.
  root.innerHTML = `
    <header class="demo-page-header">
      <div><span class="demo-page-eyebrow">插件接入实验室 · 页面型</span>
        <h1>页面能力 Demo</h1><p>在当前儿童下验证共享记录、后端接口、后台任务与事件。</p></div>
      <div class="demo-page-actions"><button type="button" data-action="notice">发送提示</button>
        <button type="button" data-action="settings">应用配置</button><button type="button" data-action="calendar">返回日历</button></div>
    </header>
    <p class="demo-page-status" role="status" data-status>正在连接插件服务…</p>
    <div class="demo-page-grid">
      <section class="demo-page-card demo-page-records" aria-label="共享记录">
        <div class="demo-page-card-heading"><div><h2>共享记录</h2><p>所有家人共享；编辑时检查记录版本，归档后仍保留数据。</p></div>
          <button type="button" data-action="refresh">刷新记录</button></div>
        <form data-editor>
          <label>记录内容<textarea aria-label="Demo 记录内容" placeholder="写一条接入测试记录" maxlength="500" required></textarea></label>
          <div class="demo-page-fields"><label>分类<select aria-label="Demo 记录分类"></select></label>
            <label>分值<input aria-label="Demo 记录分值" type="number" min="0" max="1000" step="1" value="1" required></label></div>
          <div class="demo-page-actions"><button type="submit" class="demo-page-primary" data-save>保存记录</button>
            <button type="button" data-action="cancel-edit" hidden>取消编辑</button>
            <button type="button" data-action="retry-write" hidden>重试原请求</button>
            <button type="button" data-action="resolve" hidden>读取最新记录并核对</button></div>
          <p class="demo-page-help" data-write-state>每次写入携带操作编号；同一次失败重试复用原请求。</p>
        </form>
        <div data-records aria-live="polite"></div>
        <div class="demo-page-pagination"><button type="button" data-action="previous">上一页</button>
          <span data-page>第 1 页</span><button type="button" data-action="next">下一页</button></div>
      </section>
      <div class="demo-page-side">
        <section class="demo-page-card" aria-label="接口实验">
          <h2>接口实验</h2><p>调用独立后端进程，验证配置、效果写入与失败恢复。</p>
          <label>测试消息<input aria-label="Demo 测试消息" maxlength="200" value="你好，插件平台"></label>
          <div class="demo-page-actions"><button type="button" data-action="probe">调用后端</button>
            <button type="button" data-action="retry-probe" hidden>重试接口请求</button>
            <button type="button" data-action="failure">模拟接口错误</button>
            <button type="button" data-action="slow">测试慢请求</button></div>
          <p class="demo-page-help">慢请求持续约 2 秒，可在等待时切换页面，验证请求取消与界面清理。</p>
          <pre data-response tabindex="0" role="region" aria-label="接口调用结果" aria-live="polite">尚未发起调用</pre>
        </section>
        <section class="demo-page-card" aria-label="后台活动">
          <div class="demo-page-card-heading"><h2>后台活动</h2><button type="button" data-action="activity">读取活动</button></div>
          <p>包含手动探测、每分钟心跳和任务完成事件。展示接口返回的前 50 条。</p>
          <div data-activity tabindex="0" role="region" aria-label="后台活动记录" aria-live="polite">正在读取…</div>
        </section>
      </div>
    </div>
    <details class="demo-page-card"><summary>运行上下文与配置快照</summary>
      <p>用于核对儿童隔离、活动版本和配置修订号；只显示本插件当前儿童的数据。</p>
      <pre data-info tabindex="0" role="region" aria-label="运行配置快照">正在读取…</pre></details>`
  container.append(root)
  const q = <T extends HTMLElement>(selector: string) => {
    const node = root.querySelector<T>(selector)
    if (!node) throw new Error(`Demo 元素缺失：${selector}`)
    return node
  }
  const action = (name: string) => q<HTMLButtonElement>(`[data-action="${name}"]`)
  const status = q("[data-status]")
  const editor = q<HTMLFormElement>("[data-editor]")
  const text = q<HTMLTextAreaElement>("textarea")
  const category = q<HTMLSelectElement>("select")
  const score = q<HTMLInputElement>('[aria-label="Demo 记录分值"]')
  const save = q<HTMLButtonElement>("[data-save]")
  const writeState = q("[data-write-state]")
  const message = q<HTMLInputElement>('[aria-label="Demo 测试消息"]')
  const response = q("[data-response]")
  const listeners = new AbortController()
  let disposed = false
  let info: Info | null = null
  let selected: Entry | null = null
  let pendingWrite: Write | null = null
  let writing = false
  let pendingProbe: { operationId: string; message: string; value: number } | null = null
  let probing = false
  let reading = 0
  let recordsBusy = false
  let activityReading = 0
  let infoReading = 0
  let experiment = 0
  let cursors: Array<string | null> = [null]
  let page = 0
  let next: string | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  const active = () => !disposed && !context.signal.aborted
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : "请求失败，请重试。"
  function tell(value: string, failed = false) {
    if (!active()) return
    status.textContent = value
    status.dataset.failed = String(failed)
  }
  function on(button: HTMLElement, run: () => void | Promise<void>) {
    button.addEventListener(
      "click",
      () => {
        void run()
      },
      { signal: listeners.signal },
    )
  }
  function editorState() {
    const locked = Boolean(pendingWrite)
    text.readOnly = locked
    score.readOnly = locked
    category.disabled = locked
    save.disabled = !info || locked || writing
    save.textContent = selected ? "保存修改" : "保存记录"
    action("cancel-edit").hidden = !selected
    action("cancel-edit").disabled = locked
    action("retry-write").hidden = !pendingWrite || writing
  }
  function resetEditor() {
    selected = null
    text.value = ""
    score.value = "1"
    action("resolve").hidden = true
    editorState()
  }
  function pagination() {
    action("previous").disabled = page === 0 || writing || recordsBusy
    action("next").disabled = !next || writing || recordsBusy
    q("[data-page]").textContent = `第 ${page + 1} 页 · 每页 ${info?.config.pageSize || 5} 条`
  }
  async function loadRecords(targetPage = page, cursor = cursors[targetPage]) {
    const sequence = ++reading
    recordsBusy = true
    pagination()
    const size = info?.config.pageSize || 5
    const params = new URLSearchParams({ limit: String(size) })
    if (cursor) params.set("after", cursor)
    try {
      const result = await context.api<{ records: Entry[]; nextCursor: string | null }>(
        `records/entries?${params}`,
      )
      if (!active() || sequence !== reading || size !== (info?.config.pageSize || 5)) return
      page = targetPage
      cursors[targetPage] = cursor || null
      cursors.length = targetPage + 1
      next = result.nextCursor
      const list = q("[data-records]")
      list.replaceChildren()
      if (!result.records.length) {
        const empty = document.createElement("p")
        empty.className = "demo-page-empty"
        empty.textContent = "这一页还没有记录，写下第一条测试内容吧。"
        list.append(empty)
      }
      for (const record of result.records) {
        const article = document.createElement("article")
        article.className = "demo-page-entry"
        const value = document.createElement("p")
        value.textContent = record.payload.text
        const meta = document.createElement("p")
        meta.className = "demo-page-help"
        meta.textContent = `${record.payload.category} · ${record.payload.score} 分 · 修订 ${record.revision} · ${record.payload.archived ? "已归档" : "使用中"}`
        const buttons = document.createElement("div")
        buttons.className = "demo-page-actions"
        const edit = document.createElement("button")
        edit.type = "button"
        edit.textContent = "编辑"
        edit.dataset.demoEdit = record.id
        edit.setAttribute("aria-label", `编辑记录：${record.payload.text}`)
        edit.onclick = () => {
          if (pendingWrite || writing) return tell("请先完成当前请求的重试。", true)
          selected = record
          text.value = record.payload.text
          score.value = String(record.payload.score)
          if (![...category.options].some((option) => option.value === record.payload.category))
            category.add(new Option(record.payload.category, record.payload.category))
          category.value = record.payload.category
          writeState.textContent = `正在编辑修订 ${record.revision}，其他家长同时修改会提示冲突。`
          action("resolve").hidden = true
          editorState()
          text.focus()
        }
        const archive = document.createElement("button")
        archive.type = "button"
        archive.textContent = record.payload.archived ? "恢复" : "归档"
        archive.dataset.demoArchive = record.id
        archive.onclick = () => {
          if (pendingWrite || writing) return tell("请先完成当前请求的重试。", true)
          void write({
            id: record.id,
            body: {
              payload: { ...record.payload, archived: !record.payload.archived },
              expectedRevision: record.revision,
              operationId: crypto.randomUUID(),
            },
            editor: false,
          })
        }
        buttons.append(edit, archive)
        article.append(value, meta, buttons)
        list.append(article)
      }
      pagination()
    } catch (error) {
      if (active() && sequence === reading) tell(errorText(error), true)
    } finally {
      if (active() && sequence === reading) {
        recordsBusy = false
        pagination()
      }
    }
  }
  async function loadActivity() {
    const sequence = ++activityReading
    try {
      const result = await context.api<{ records: Activity[] }>("records/activity?limit=50")
      if (!active() || sequence !== activityReading) return
      const list = q("[data-activity]")
      list.replaceChildren()
      if (!result.records.length)
        list.textContent = "尚无活动。启用后等待心跳，或完成一个日历任务。"
      for (const record of result.records.sort((a, b) =>
        (b.payload.createdAt || "").localeCompare(a.payload.createdAt || ""),
      )) {
        const row = document.createElement("p")
        row.className = "demo-page-activity"
        row.textContent = `${record.payload.kind || "活动"} · ${record.payload.message || "已执行"} · ${record.payload.createdAt || record.id}`
        list.append(row)
      }
    } catch (error) {
      if (active() && sequence === activityReading)
        q("[data-activity]").textContent = errorText(error)
    }
  }
  async function loadInfo() {
    const sequence = ++infoReading
    try {
      const result = await context.api<Info>("info")
      if (!active() || sequence !== infoReading) return
      const previousSize = info?.config.pageSize
      info = result
      q("h1").textContent = `${context.child.name}的${result.config.title}`
      root.dataset.tone = result.config.tone
      q("[data-info]").textContent = JSON.stringify({ child: context.child, ...result }, null, 2)
      const oldCategory = category.value
      category.replaceChildren(...result.config.categories.map((value) => new Option(value, value)))
      if (selected && ![...category.options].some((option) => option.value === oldCategory))
        category.add(new Option(oldCategory, oldCategory))
      if ([...category.options].some((option) => option.value === oldCategory))
        category.value = oldCategory
      if (previousSize !== result.config.pageSize) {
        cursors = [null]
        page = 0
        next = null
      }
      editorState()
      if (timer) clearInterval(timer)
      timer = result.config.autoRefresh
        ? setInterval(() => {
            if (
              active() &&
              context.isActive() &&
              document.visibilityState === "visible" &&
              !writing &&
              !recordsBusy
            ) {
              void loadInfo().then((ok) => {
                if (ok && active()) void Promise.all([loadRecords(), loadActivity()])
              })
            }
          }, 10000)
        : undefined
      return true
    } catch (error) {
      if (active() && sequence === infoReading) tell(errorText(error), true)
      return false
    }
  }
  async function write(request: Write) {
    if (!active() || writing) return
    pendingWrite = request
    writing = true
    editorState()
    action("resolve").hidden = true
    writeState.textContent = `正在写入 · 操作 ${request.body.operationId}`
    try {
      await context.api(`records/entries/${request.id}`, { method: "PUT", body: request.body })
      if (!active()) return
      pendingWrite = null
      if (request.editor) resetEditor()
      writeState.textContent = "写入成功，重复提交同一操作不会重复产生记录。"
      tell("记录已保存，家人共享状态已更新。")
      context.notify("Demo 记录已保存")
      await loadRecords()
    } catch (error) {
      if (!active()) return
      tell(errorText(error), true)
      if ((error as { code?: string })?.code === "plugin_revision_conflict") {
        pendingWrite = null
        if (request.editor) {
          writeState.textContent = "记录已被其他家人修改。草稿已保留，请读取最新记录并核对。"
          action("resolve").hidden = false
        } else {
          writeState.textContent = "记录已被其他家人修改，已重新读取列表，请核对后再操作。"
          await loadRecords()
        }
      } else {
        writeState.textContent = `结果未确认，重试会复用原操作 ${request.body.operationId} 和相同内容。`
      }
    } finally {
      if (active()) {
        writing = false
        editorState()
        pagination()
      }
    }
  }
  editor.addEventListener(
    "submit",
    (event) => {
      event.preventDefault()
      if (!info || pendingWrite || writing || !editor.reportValidity() || !text.value.trim()) return
      const id = selected?.id || crypto.randomUUID()
      void write({
        id,
        body: {
          operationId: crypto.randomUUID(),
          expectedRevision: selected?.revision || 0,
          payload: {
            text: text.value.trim(),
            category: category.value,
            score: Number(score.value),
            archived: selected?.payload.archived || false,
            createdAt: selected?.payload.createdAt || new Date().toISOString(),
          },
        },
        editor: true,
      })
    },
    { signal: listeners.signal },
  )
  on(action("retry-write"), () => {
    if (pendingWrite) return write(pendingWrite)
  })
  on(action("cancel-edit"), resetEditor)
  on(action("resolve"), async () => {
    if (!selected) return
    const editing = selected
    try {
      const result = await context.api<{ record: Entry | null }>(`records/entries/${editing.id}`)
      if (!active() || selected !== editing || writing) return
      if (!result.record) return tell("记录不存在，请刷新列表后核对。", true)
      selected = result.record
      writeState.textContent = `最新记录：${selected.payload.text}（修订 ${selected.revision}）。当前表单仍是你的草稿，核对后可再次保存。`
      action("resolve").hidden = true
      editorState()
      await loadRecords()
    } catch (error) {
      if (active()) tell(errorText(error), true)
    }
  })
  async function probe() {
    if (probing || !active()) return
    const request = ++experiment
    if (!pendingProbe && !message.value.trim()) {
      response.textContent = "请先填写测试消息。"
      message.focus()
      return
    }
    pendingProbe ??= { operationId: crypto.randomUUID(), message: message.value.trim(), value: 2 }
    probing = true
    action("probe").disabled = true
    action("retry-probe").hidden = true
    message.readOnly = true
    try {
      const result = await context.api("probe", { method: "POST", body: pendingProbe })
      if (!active()) return
      if (request === experiment) response.textContent = JSON.stringify(result, null, 2)
      pendingProbe = null
      await loadActivity()
    } catch (error) {
      if (active()) {
        if (request === experiment)
          response.textContent = `${errorText(error)}\n结果未确认，请重试原接口请求。`
        action("retry-probe").hidden = false
      }
    } finally {
      if (active()) {
        probing = false
        action("probe").disabled = Boolean(pendingProbe)
        message.readOnly = Boolean(pendingProbe)
      }
    }
  }
  on(action("probe"), probe)
  on(action("retry-probe"), probe)
  on(action("failure"), async () => {
    const request = ++experiment
    action("failure").disabled = true
    try {
      await context.api("fail", { method: "POST", body: { operationId: crypto.randomUUID() } })
      if (active() && request === experiment) response.textContent = "接口返回成功。"
    } catch (error) {
      if (active() && request === experiment)
        response.textContent = `已捕获模拟错误：${errorText(error)}\n可再次调用后端验证恢复。`
    } finally {
      if (active()) action("failure").disabled = false
    }
  })
  on(action("slow"), async () => {
    const request = ++experiment
    action("slow").disabled = true
    response.textContent = "慢请求进行中，可以切换到日历验证取消。"
    try {
      const result = await context.api("slow")
      if (active() && request === experiment) response.textContent = JSON.stringify(result, null, 2)
    } catch (error) {
      if (active() && request === experiment) response.textContent = errorText(error)
    } finally {
      if (active()) action("slow").disabled = false
    }
  })
  on(action("previous"), async () => {
    if (page > 0 && !recordsBusy) {
      await loadRecords(page - 1)
    }
  })
  on(action("next"), async () => {
    if (next && !recordsBusy) {
      await loadRecords(page + 1, next)
    }
  })
  on(action("refresh"), async () => {
    await loadInfo()
    await loadRecords()
    await loadActivity()
  })
  on(action("activity"), loadActivity)
  on(action("notice"), () => context.notify(`${context.child.name}：Demo 插件通知测试成功`))
  on(action("settings"), () => context.navigateCore("settings"))
  on(action("calendar"), () => context.navigateCore("calendar"))
  function dispose() {
    if (disposed) return
    disposed = true
    if (timer) clearInterval(timer)
    listeners.abort()
    context.signal.removeEventListener("abort", dispose)
    root.remove()
  }
  context.signal.addEventListener("abort", dispose, { once: true })
  if (context.signal.aborted) dispose()
  else {
    editorState()
    pagination()
    void loadInfo().then(async (ok) => {
      if (!ok || !active()) return
      tell("已连接。配置、记录和后台活动均由当前儿童的家人共享。")
      await Promise.all([loadRecords(), loadActivity()])
    })
  }
  return dispose
}

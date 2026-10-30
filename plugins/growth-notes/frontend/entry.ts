import type { PluginContext } from "../../../packages/plugin-sdk/src/index"
import "./style.css"
type Record = { id: string; payload: { text: string; createdAt: string } }
export function mount(container: HTMLElement, context: PluginContext) {
  const root = document.createElement("section")
  root.className = "growth-notes-plugin"
  const title = document.createElement("h1")
  title.textContent = `${context.child.name}的成长随记`
  const description = document.createElement("p")
  description.textContent = "记下值得珍藏的进步与日常，家人共同见证成长。"
  const form = document.createElement("form"),
    input = document.createElement("textarea"),
    save = document.createElement("button"),
    list = document.createElement("div"),
    status = document.createElement("p")
  input.placeholder = "今天有什么值得记下来？"
  input.setAttribute("aria-label", "成长记录内容")
  input.required = true
  input.maxLength = 2000
  save.type = "submit"
  save.textContent = "保存随记"
  status.setAttribute("role", "status")
  form.append(input, save)
  root.append(title, description, form, status, list)
  container.append(root)
  let disposed = false
  async function refresh() {
    const result = await context.api<{ records: Record[] }>("records/notes")
    if (disposed) return
    list.replaceChildren()
    if (!result.records.length) {
      const empty = document.createElement("p")
      empty.textContent = "还没有随记，从今天的小进步开始。"
      list.append(empty)
    }
    for (const item of result.records) {
      const article = document.createElement("article"),
        text = document.createElement("p"),
        time = document.createElement("time")
      text.textContent = item.payload.text
      time.textContent = new Date(item.payload.createdAt).toLocaleString("zh-CN")
      article.append(text, time)
      list.append(article)
    }
  }
  form.onsubmit = async (event) => {
    event.preventDefault()
    if (save.disabled || !input.value.trim()) return
    save.disabled = true
    status.textContent = "正在保存…"
    const id = crypto.randomUUID(),
      payload = { text: input.value.trim(), createdAt: new Date().toISOString() }
    try {
      await context.api(`records/notes/${id}`, {
        method: "PUT",
        body: { payload, operationId: id },
      })
      if (disposed) return
      input.value = ""
      status.textContent = "已保存，家人可以共同查看。"
      await refresh()
    } catch (error) {
      if (!disposed)
        status.textContent = error instanceof Error ? error.message : "保存失败，请重试。"
    } finally {
      if (!disposed) save.disabled = false
    }
  }
  void refresh().catch((error) => {
    if (!disposed)
      status.textContent = error instanceof Error ? error.message : "暂时无法读取随记。"
  })
  return () => {
    disposed = true
    form.onsubmit = null
    root.remove()
  }
}

import { useRef, useState, type CSSProperties } from "react"
import { Button, Card, Feedback, Icon, Input, Notice, date, useAction } from "./primitives"
import type { Child, Context, Controller } from "./types"

export function Presets({ controller, context }: { controller: Controller; context: Context }) {
  const action = useAction(controller), { deps } = controller
  const archived = context.child!.archived, { categories, taskPresets } = context.data!
  return <>
    {archived && <Notice>孩子已归档，常用任务配置仅可查看。</Notice>}
    <div className="settings-section-bar"><p id="settingsPresetCount">共 {taskPresets.length} 项配置</p><Button id="settingsAddPreset" type="button" className="btn primary" disabled={archived} onClick={() => deps.editPreset()}>＋ 添加常用任务</Button></div>
    <div id="settingsTaskPresetsList" className="task-preset-cards">{taskPresets.length ? taskPresets.map(preset => {
      const category = categories.find(item => item.id === preset.categoryId)
      const categoryName = category ? (category.active ? category.name : `${category.name}（已停用）`) : "未配置类型"
      return <Card className="task-preset-card" key={preset.id}><div className="task-preset-card-main"><strong>{preset.title}</strong><div className="task-preset-card-meta"><span className="task-preset-category" style={{ "--preset-cat": category?.active ? category.color : "#9ba59e" } as CSSProperties}><i aria-hidden="true" />{categoryName}</span><span className="task-preset-time"><svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" /><path d="M10 6v4l3 2" /></svg>{preset.startTime}–{preset.endTime}</span></div></div><div className="task-preset-side"><span className="task-preset-reward">+{preset.points}<small>分</small></span><div className="task-preset-actions"><Button className="btn" type="button" data-preset-edit={preset.id} disabled={archived || !!action.busy} onClick={() => deps.editPreset(preset.id)}>编辑</Button><Button className="btn danger" type="button" data-preset-delete={preset.id} disabled={archived || !!action.busy} onClick={() => action.run(preset.id, () => deps.deletePreset(preset.id))}>删除</Button></div></div></Card>
    }) : <div className="empty">暂无常用任务，点击右上角“添加”开始配置。</div>}</div><Feedback id="settingsTaskPresetsError" message={action.error} />
  </>
}

export function Categories({ controller, context }: { controller: Controller; context: Context }) {
  const action = useAction(controller), { deps } = controller, archived = context.child!.archived
  const dragged = useRef<string | null>(null), [over, setOver] = useState<string | null>(null)
  const clear = () => { dragged.current = null; setOver(null) }
  return <>
    {archived && <Notice>孩子已归档，任务类型仅可查看。</Notice>}
    <div className="settings-section-bar"><p>拖动左侧图标调整顺序</p><Button id="settingsAddCategory" type="button" className="btn primary" disabled={archived} onClick={deps.addCategory}>＋ 添加类型</Button></div>
    <div id="settingsCategoryList">{context.data!.categories.map(category => <div className={`category-row${over === category.id ? " drag-over" : ""}`} data-category-row={category.id} key={`${category.id}:${category.name}:${category.color}`} onDragOver={event => {
      if (archived || !dragged.current || dragged.current === category.id || action.busy) return
      event.preventDefault(); setOver(category.id)
    }} onDrop={event => {
      event.preventDefault(); const from = dragged.current; if (archived || !from || from === category.id) return
      const box = event.currentTarget.getBoundingClientRect(), after = event.clientY > box.top + box.height / 2
      clear(); action.run("order", () => deps.reorderCategory(from, category.id, after), () => controller.render())
    }}>
      <Button className="drag-handle" type="button" draggable={!archived && !action.busy} disabled={archived || !!action.busy} data-drag-category={category.id} aria-label={`拖动排序 ${category.name}`} title="拖动调整排序" onDragStart={event => {
        if (archived || action.busy) { event.preventDefault(); return }
        dragged.current = category.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", category.id)
      }} onDragEnd={clear}>⠿</Button>
      <Input type="color" defaultValue={category.color} data-cat-color={category.id} aria-label={`${category.name}颜色`} disabled={archived || !!action.busy} onChange={event => {
        const color = event.currentTarget.value
        action.run("color", () => deps.saveCategory({ ...category, color }), () => controller.render())
      }} />
      <Input type="text" defaultValue={category.name} maxLength={20} data-cat-name={category.id} aria-label="类型名称" disabled={archived || !!action.busy} onBlur={event => {
        const name = event.currentTarget.value.trim()
        if (!name || name === category.name) { event.currentTarget.value = category.name; return }
        action.run("name", () => deps.saveCategory({ ...category, name }), () => controller.render())
      }} />
      <Button className="text-btn" type="button" data-cat-delete={category.id} disabled={archived || !!action.busy} onClick={() => deps.deleteCategory(category.id)}>删除</Button>
    </div>)}</div><p className="settings-help">被任务或历史记录使用的类型，删除后会停用并保留历史。</p><Feedback id="settingsCategoryError" message={action.error} />
  </>
}

export function Backup({ controller, child, updatedAt }: { controller: Controller; child: Child; updatedAt: string | null }) {
  const restore = child.role === "owner" && !child.archived, { deps } = controller
  return <>
    <Card className="settings-backup-card"><span className="settings-feature-icon"><Icon name="backup" /></span><div><h3>{child.name}的成长备份</h3><p>包含当前孩子的任务、完成记录、积分流水、礼品和配置。</p><small>{updatedAt ? `最近保存：${date(updatedAt)}` : "尚无保存记录"}</small></div></Card>
    <div className="settings-backup-actions"><div><strong>导出备份</strong><p>下载完整 JSON 文件，保存一份成长记录。</p></div><Button className="btn primary" id="settingsExportBtn" type="button" onClick={deps.exportBackup}>导出备份</Button></div>
    <div className="settings-backup-actions"><div><strong>从备份恢复</strong><p>{restore ? "恢复会替换当前孩子的业务数据，孩子昵称和家长权限保持不变。" : child.archived ? "孩子已归档，恢复孩子后由负责人导入。" : "只有孩子负责人可以导入并恢复数据。"}</p></div><Button className="btn" id="settingsImportBtn" type="button" disabled={!restore} onClick={deps.importBackup}>导入并恢复</Button></div>
    <p className="settings-help">每次保存前自动保留旧版本，最多保留最近 30 份。建议定期另行导出备份。</p>
  </>
}

import type { BusinessData } from "./types"
/** Keep the existing backup compatibility repairs; never writes the source file. */
export function migrateBackupData(input: BusinessData): BusinessData {
  if (!input || typeof input !== "object") throw Error("备份内容不正确。")
  const data = JSON.parse(JSON.stringify(input)) as BusinessData
  if (data.schemaVersion === 1) {
    data.schemaVersion = 2
    data.gifts = []
  }
  if (data.schemaVersion !== 2) throw Error("数据版本不受支持。")
  const legacyIds = new Set([
    "8abda68e-b07d-4e39-9046-6257f82611ed",
    "84a95435-c539-4255-a26f-a3ffb6aceed0",
    "d5e2a558-956c-43d3-8670-dccf44a9c372",
  ])
  data.series = (data.series || []).filter((task) => !legacyIds.has(task.id))
  data.exceptions = (data.exceptions || []).filter((ex) => !legacyIds.has(ex.seriesId))
  for (const task of data.series) {
    const rule = task.recurrence
    if (rule?.endType === "until" && rule.until && rule.until < task.startDate)
      rule.until = task.startDate
    if (!task.revisions?.length)
      task.revisions = [
        {
          id: `${task.id}:v1`,
          effectiveFrom: task.startDate,
          title: task.title,
          note: task.note || "",
          startTime: task.startTime,
          endTime: task.endTime,
          categoryId: task.categoryId,
          points: Number(task.points) || 0,
          recurrence: task.recurrence ? JSON.parse(JSON.stringify(task.recurrence)) : null,
        },
      ]
  }
  if (!Array.isArray(data.operationLog)) data.operationLog = []
  if (!Object.hasOwn(data, "taskPresets")) data.taskPresets = []
  for (const key of [
    "categories",
    "series",
    "exceptions",
    "completions",
    "ledger",
    "gifts",
    "taskPresets",
    "operationLog",
  ])
    if (!Array.isArray(data[key])) throw Error(`数据项 ${key} 格式不正确。`)
  if (!data.settings || typeof data.settings !== "object") throw Error("设置数据格式不正确。")
  return data
}
export function readBackup(text: string) {
  const pkg = JSON.parse(text)
  if (
    !pkg ||
    !["lele-task-manager-backup", "lele-task-manager-store"].includes(pkg.format) ||
    pkg.version !== 1 ||
    !pkg.data
  )
    throw Error("不是有效的成长计划备份。")
  return migrateBackupData(pkg.data)
}

export type PublicationStatus = "pending" | "published" | "unpublished"
export type OperationState = "ready" | "updating" | "failed"
export type PluginScope = { scopeMode: "all" | "children"; childIds: string[] }

export type Plugin = PluginScope & {
  id: string
  name: string
  description: string
  instructions: string
  icon: string
  /** Optional inspected assets supplied by the package; never accept an arbitrary upload or URL. */
  icons?: string[]
  type: "page" | "service"
  publicationStatus: PublicationStatus
  version: string | null
  releaseId: string | null
  operationState: OperationState
  revision: number
  sortOrder: number
  installedCount: number
  enabledCount: number
  reason: string | null
}

export type PluginChild = { id: string; name: string; ownerName: string }
export type PluginMetadata = Pick<Plugin, "name" | "description" | "instructions" | "sortOrder"> & {
  icon?: string
}

// Deployment records are read-only. Fields are optional because an interrupted deployment
// may not yet have a target release or completion time.
export type Deployment = {
  id?: string
  version?: string | null
  fromVersion?: string | null
  oldVersion?: string | null
  toVersion?: string | null
  releaseId?: string | null
  operation?: string
  status?: string
  phase?: string
  startedAt?: string | null
  createdAt?: string | null
  completedAt?: string | null
  updatedAt?: string | null
  errorCode?: string | null
  error?: string | null
  message?: string | null
}

export const publicationLabels: Record<PublicationStatus, string> = {
  pending: "待发布",
  published: "已上架",
  unpublished: "已下架",
}
export const operationLabels: Record<OperationState, string> = {
  ready: "就绪",
  updating: "更新中",
  failed: "运行异常",
}

export function metadataOf(plugin: Plugin): PluginMetadata {
  return {
    name: plugin.name,
    description: plugin.description,
    instructions: plugin.instructions,
    sortOrder: plugin.sortOrder,
    icon: plugin.icon,
  }
}

export function scopeOf(plugin: Plugin): PluginScope {
  return { scopeMode: plugin.scopeMode, childIds: [...plugin.childIds] }
}

export function sameScope(first: PluginScope, second: PluginScope) {
  if (first.scopeMode !== second.scopeMode) return false
  if (first.scopeMode === "all") return true
  const ids = new Set(first.childIds)
  return ids.size === second.childIds.length && second.childIds.every((id) => ids.has(id))
}

export function isScopeShrink(current: PluginScope, next: PluginScope) {
  if (next.scopeMode !== "children" || sameScope(current, next)) return false
  if (current.scopeMode === "all") return true
  const ids = new Set(current.childIds)
  return next.childIds.every((id) => ids.has(id))
}

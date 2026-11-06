import type { CoreView } from "../lib/runtime"

export type ConfigScalar = string | number | boolean
export type ConfigValue = ConfigScalar | string[]
export type PluginConfig = Record<string, ConfigValue>
export type SchemaField = {
  type: "string" | "number" | "integer" | "boolean" | "array"
  title?: string
  description?: string
  default?: ConfigValue
  enum?: ConfigScalar[]
  items?: { type: "string"; enum: string[] }
  uniqueItems?: boolean
  minItems?: number
  maxItems?: number
  group?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  format?: string
}
export type JSONSchema = {
  type: "object"
  properties?: Record<string, SchemaField>
  required?: string[]
  additionalProperties?: boolean
}
export type Plugin = {
  id: string
  name: string
  description: string
  instructions: string
  icon: string
  type: "page" | "service"
  publicationStatus: "pending" | "published" | "unpublished"
  scopeMode: "all" | "children"
  childIds: string[]
  version: string | null
  releaseId: string | null
  operationState: "ready" | "updating" | "failed"
  revision: number
  sortOrder: number
  installed: boolean
  enabled: boolean
  effectiveEnabled: boolean
  requiresReenable: boolean
  configRequired: boolean
  configRevision: number
  reason: string | null
  configSchema: JSONSchema
}
export type PluginDevelopment = {
  state?: "ready" | "draining"
  sessionId: string
  revision: number
  base: string
  backend: boolean
}
export type PluginEntry = {
  entry: string
  styles: string[]
  releaseId: string
  version: string
  frontendApi?: { major: number; minMinor: number }
  development?: PluginDevelopment
}
export type ConfigResponse = {
  config: PluginConfig
  schema: JSONSchema
  revision: number
  plugin: Plugin
}
export type PluginContext = {
  child: { id: string; name: string }
  releaseId: string
  signal: AbortSignal
  /** Host-owned overlay. Dialogs, drawers and popovers must render here, never on document.body. */
  overlay: HTMLElement
  /** False while this page stays mounted behind a core view. Leaving does not abort `signal`. */
  isActive(): boolean
  /** Fired when the user leaves or returns. Do not close drafts or dialogs on leave. */
  onVisibility(listener: (active: boolean) => void): () => void
  api<T>(
    path: string,
    options?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
  ): Promise<T>
  notify(message: string): void
  navigateCore(view: CoreView): void
  refreshChild?(): Promise<void> | void
}
export type PluginModule = { mount(container: HTMLElement, context: PluginContext): () => void }
export type PluginAction = "install" | "enable" | "disable" | "uninstall"
export type CatalogView = "available" | "installed"

import { operationId, runtime } from "../lib/runtime"
import type {
  CatalogView,
  ConfigResponse,
  Plugin,
  PluginAction,
  PluginConfig,
  PluginEntry,
} from "./types"

export const pluginBase = (childId: string, pluginId?: string) =>
  `/api/children/${encodeURIComponent(childId)}/plugins${pluginId ? `/${encodeURIComponent(pluginId)}` : ""}`

export const pluginClient = {
  list(childId: string, view: CatalogView, query: string, signal: AbortSignal) {
    const params = new URLSearchParams({ view, q: query })
    return runtime.api<{ plugins: Plugin[] }>(
      `${pluginBase(childId)}?${params}`,
      "GET",
      undefined,
      {},
      signal,
    )
  },
  status(childId: string, signal: AbortSignal) {
    return runtime.api<{ plugins: Plugin[] }>(
      `${pluginBase(childId)}/status`,
      "GET",
      undefined,
      {},
      signal,
    )
  },
  manage(childId: string, plugin: Plugin, action: PluginAction, signal: AbortSignal) {
    return runtime.api<{ plugin: Plugin }>(
      `${pluginBase(childId, plugin.id)}/${action === "uninstall" ? "installation" : action}`,
      action === "uninstall" ? "DELETE" : "POST",
      { operationId: operationId(), expectedRevision: plugin.revision },
      {},
      signal,
    )
  },
  config(childId: string, pluginId: string, signal: AbortSignal) {
    return runtime.api<ConfigResponse>(
      `${pluginBase(childId, pluginId)}/config`,
      "GET",
      undefined,
      {},
      signal,
    )
  },
  saveConfig(
    childId: string,
    pluginId: string,
    config: PluginConfig,
    revision: number,
    signal: AbortSignal,
  ) {
    return runtime.api<ConfigResponse>(
      `${pluginBase(childId, pluginId)}/config`,
      "PUT",
      { config, expectedRevision: revision, operationId: operationId() },
      {},
      signal,
    )
  },
  entry(childId: string, pluginId: string, signal: AbortSignal) {
    return runtime.api<PluginEntry>(
      `${pluginBase(childId, pluginId)}/entry`,
      "GET",
      undefined,
      {},
      signal,
    )
  },
}

/** Protocol 1.0: host-owned child context; plugins never receive account secrets. */
export type PluginContext = {
  child: { id: string; name: string }
  releaseId: string
  signal: AbortSignal
  api<T>(
    path: string,
    options?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
  ): Promise<T>
  notify(message: string): void
  navigateCore(view: "calendar" | "store" | "settings"): void
}
export type PluginModule = { mount(container: HTMLElement, context: PluginContext): () => void }
export const FRONTEND_PROTOCOL = { major: 1, minor: 0 } as const

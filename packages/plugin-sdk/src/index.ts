/** Protocol 1.1: host-owned child context, overlays and page visibility. */
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
  navigateCore(view: "calendar" | "store" | "settings"): void
  refreshChild?(): Promise<void> | void
}
export type PluginModule = { mount(container: HTMLElement, context: PluginContext): () => void }
export const FRONTEND_PROTOCOL = { major: 1, minor: 1 } as const

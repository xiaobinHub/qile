import { Puzzle } from "lucide-react"
import { useState } from "react"
import { StatusBadge } from "@shared/components/status-badge"
import { operationLabels, publicationLabels, type Plugin } from "./types"

export function PluginStatuses({ plugin, compact = false }: { plugin: Plugin; compact?: boolean }) {
  return (
    <div className={`plugin-statuses${compact ? " plugin-statuses-compact" : ""}`}>
      <StatusBadge
        className="plugin-status-tag"
        tone={
          plugin.publicationStatus === "published"
            ? "success"
            : plugin.publicationStatus === "pending"
              ? "warning"
              : "neutral"
        }
      >
        <span className={compact ? "sr-only" : undefined}>发布：</span>
        {publicationLabels[plugin.publicationStatus]}
      </StatusBadge>
      <StatusBadge
        className="plugin-status-tag"
        tone={
          plugin.operationState === "ready"
            ? "success"
            : plugin.operationState === "updating"
              ? "brand"
              : "danger"
        }
      >
        <span className={compact ? "sr-only" : undefined}>运行：</span>
        {operationLabels[plugin.operationState]}
      </StatusBadge>
    </div>
  )
}

function packageIconUrl(icon: string) {
  // Only render same-origin, server-provided package resources. Never execute inline SVG/HTML.
  try {
    if (!icon.startsWith("/") || icon.startsWith("//")) return null
    const url = new URL(icon, window.location.origin)
    return url.origin === window.location.origin && !url.search && !url.hash ? url.href : null
  } catch {
    return null
  }
}

export function PluginIcon({ icon }: { icon: string }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const source = packageIconUrl(icon)
  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted text-muted-foreground">
      {source && failedIcon !== icon ? (
        <img
          src={source}
          alt=""
          className="size-8 object-contain"
          loading="lazy"
          onError={() => setFailedIcon(icon)}
        />
      ) : (
        <Puzzle aria-hidden="true" className="size-5" />
      )}
    </div>
  )
}

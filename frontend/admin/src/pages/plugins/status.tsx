import { Puzzle } from "lucide-react"
import { useState } from "react"
import { Badge } from "@shared/components/ui/badge"
import { operationLabels, publicationLabels, type Plugin } from "./types"

export function PluginStatuses({ plugin }: { plugin: Plugin }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant={plugin.publicationStatus === "published" ? "default" : "secondary"}>
        发布：{publicationLabels[plugin.publicationStatus]}
      </Badge>
      <Badge variant={plugin.operationState === "failed" ? "destructive" : "outline"}>
        运行：{operationLabels[plugin.operationState]}
      </Badge>
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
    <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted text-muted-foreground">
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

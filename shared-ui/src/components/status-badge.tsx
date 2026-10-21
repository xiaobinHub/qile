import type { ReactNode } from "react"
import { Badge } from "./ui/badge"
import { cn } from "@shared/lib/utils"

const tones = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/10 text-success",
  warning: "bg-warning-foreground text-warning",
  danger: "bg-destructive/10 text-destructive-ink",
  brand: "bg-primary/10 text-brand-ink",
}
export function StatusBadge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode
  tone?: keyof typeof tones
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent font-normal", tones[tone], className)}
    >
      {children}
    </Badge>
  )
}

import type { ReactNode } from "react"
import { Inbox } from "lucide-react"
import { cn } from "@shared/lib/utils"

export function EmptyState({ title = "暂无内容", description, action, icon = <Inbox className="size-6" />, className }: { title?: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col items-center justify-center gap-3 px-5 py-12 text-center", className)}><div className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">{icon}</div><p className="font-medium">{title}</p>{description && <p className="max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>}{action}</div>
}

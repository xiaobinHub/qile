import { Sprout } from "lucide-react"
import { cn } from "@shared/lib/utils"

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground",
          compact ? "size-9" : "size-10",
        )}
      >
        <Sprout className={compact ? "size-5" : "size-6"} strokeWidth={1.8} />
      </span>
      <div>
        <div className="text-[17px] leading-6 font-semibold tracking-tight">乐乐成长</div>
        <div className="mt-0.5 text-xs tracking-[0.12em] text-muted-foreground">管理工作台</div>
      </div>
    </div>
  )
}

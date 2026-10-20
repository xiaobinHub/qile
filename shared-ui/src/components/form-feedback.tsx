import { CircleAlert, CircleCheck } from "lucide-react"
import { cn } from "@shared/lib/utils"

export function FormFeedback({ message, success = false, id, className }: { message: string; success?: boolean; id?: string; className?: string }) {
  if (!message) return null
  const Icon = success ? CircleCheck : CircleAlert
  return <div id={id} role={success ? "status" : "alert"} className={cn("flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-[13px] leading-5", success ? "border-emerald-200/80 bg-emerald-50 text-emerald-800" : "border-red-200/80 bg-red-50 text-red-700", className)}><Icon className="mt-0.5 size-4 shrink-0" /><span>{message}</span></div>
}

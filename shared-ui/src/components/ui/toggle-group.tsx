import type { ComponentProps } from "react"
import { ToggleGroup as Primitive } from "radix-ui"
import { cn } from "@shared/lib/utils"

export function ToggleGroup({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      data-slot="toggle-group"
      className={cn("flex flex-wrap gap-1", className)}
      {...props}
    />
  )
}
export function ToggleGroupItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-input bg-card px-3 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=on]:border-primary data-[state=on]:bg-accent data-[state=on]:text-primary disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

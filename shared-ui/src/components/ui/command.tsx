import { Command as Primitive } from "cmdk"
import type { ComponentProps } from "react"
import { cn } from "@shared/lib/utils"
export function Command({ className, ...props }: ComponentProps<typeof Primitive>) {
  return (
    <Primitive
      data-slot="command"
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-2xl bg-popover text-popover-foreground",
        className,
      )}
      {...props}
    />
  )
}
export function CommandList({ className, ...props }: ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      data-slot="command-list"
      className={cn("max-h-64 overflow-x-hidden overflow-y-auto p-1", className)}
      {...props}
    />
  )
}
export function CommandEmpty(props: ComponentProps<typeof Primitive.Empty>) {
  return (
    <Primitive.Empty className="px-3 py-6 text-center text-sm text-muted-foreground" {...props} />
  )
}
export function CommandItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex min-h-10 cursor-default flex-col items-start gap-1 rounded-xl px-3 py-2 text-sm outline-none select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

import type { ComponentProps } from "react"
import { Switch as Primitive } from "radix-ui"
import { cn } from "@shared/lib/utils"

export function Switch({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent bg-muted-foreground outline-none before:absolute before:-inset-y-2.5 before:inset-x-0 focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <Primitive.Thumb className="pointer-events-none block size-5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
    </Primitive.Root>
  )
}

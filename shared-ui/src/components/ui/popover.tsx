import type { ComponentProps } from "react"
import { Popover as Primitive } from "radix-ui"
import { cn } from "@shared/lib/utils"

export const Popover = Primitive.Root
export const PopoverTrigger = Primitive.Trigger
export const PopoverAnchor = Primitive.Anchor
export const PopoverClose = Primitive.Close
export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-[80] w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  )
}

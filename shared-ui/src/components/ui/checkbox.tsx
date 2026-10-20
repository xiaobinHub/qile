import type { ComponentProps } from "react"
import { Checkbox as Primitive } from "radix-ui"
import { Check } from "lucide-react"
import { cn } from "@shared/lib/utils"

export function Checkbox({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      data-slot="checkbox"
      className={cn(
        "relative flex size-5 shrink-0 items-center justify-center rounded border border-input outline-none before:absolute before:-inset-3 focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    >
      <Primitive.Indicator>
        <Check className="size-4" />
      </Primitive.Indicator>
    </Primitive.Root>
  )
}

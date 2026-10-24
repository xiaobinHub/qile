import { useRef, useState, type ComponentProps } from "react"
import { ChevronsUpDown } from "lucide-react"
import { Input } from "./ui/input"
import { Button } from "./ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import { NumberWheel } from "./number-wheel"
import { TimeWheel, type TimeWheelHandle } from "./time-wheel"
import { cn } from "@shared/lib/utils"

type NumberPickerProps = Omit<
  ComponentProps<typeof Input>,
  "type" | "value" | "onChange" | "min" | "max" | "step"
> & {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  loop?: boolean
  onChange: (value: number) => void
}

export function NumberPicker({
  label,
  value,
  min = 0,
  max,
  step = 1,
  loop = false,
  onChange,
  disabled,
  readOnly,
  className,
  onKeyDown,
  ...props
}: NumberPickerProps) {
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const wheel = useRef<TimeWheelHandle>(null)
  const unavailable = disabled || readOnly
  const cyclic = loop && max !== undefined
  const count = max === undefined ? 1 : Math.floor((max - min) / step) + 1
  const index = Math.max(0, Math.min(count - 1, Math.round((value - min) / step)))
  const legacyValue = value !== min + index * step
  function finish() {
    wheel.current?.commit()
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={(next) => (next && !unavailable ? setOpen(true) : finish())}>
      <div className="relative">
        <PopoverTrigger asChild>
          <Input
            {...props}
            type="text"
            role="combobox"
            aria-autocomplete="none"
            inputMode="none"
            autoComplete="off"
            className={cn("cursor-pointer pr-10 tabular-nums caret-transparent", className)}
            disabled={unavailable}
            readOnly
            value={value}
            onKeyDown={(event) => {
              onKeyDown?.(event)
              if (!event.defaultPrevented && ["Enter", " ", "ArrowDown"].includes(event.key)) {
                event.preventDefault()
                if (!unavailable) setOpen(true)
              }
            }}
          />
        </PopoverTrigger>
        <ChevronsUpDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
      </div>
      <PopoverContent
        ref={panel}
        aria-label={`选择${label}`}
        className={cn(cyclic ? "w-36" : "w-48", "gap-0 overflow-hidden p-0")}
        align="start"
        sideOffset={6}
        collisionPadding={12}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          panel.current
            ?.querySelector<HTMLElement>("[role='spinbutton']")
            ?.focus({ preventScroll: true })
        }}
      >
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
          <output className="text-detail font-semibold tabular-nums" aria-live="polite">
            {value}
          </output>
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={finish}>
            完成
          </Button>
        </div>
        <div
          className="p-3"
          onKeyDownCapture={(event) => {
            if (!cyclic || !legacyValue) return
            if (event.key === "Home") onChange(min)
            if (event.key === "End") onChange(min + (count - 1) * step)
          }}
          onClickCapture={(event) => {
            // A legacy value stays intact until the user explicitly chooses a row,
            // including choosing the row already centered at the nearest valid value.
            if (!cyclic || !legacyValue) return
            const row = (event.target as HTMLElement).closest<HTMLElement>("[data-number-value]")
            if (row) onChange(Number(row.dataset.numberValue))
          }}
        >
          {cyclic ? (
            <TimeWheel
              ref={wheel}
              label={label}
              unit=""
              count={count}
              value={index}
              valueOffset={min}
              valueStep={step}
              onChange={(next) => onChange(min + next * step)}
              onComplete={finish}
            />
          ) : (
            <NumberWheel
              ref={wheel}
              label={label}
              value={value}
              min={min}
              max={max}
              onChange={onChange}
              onComplete={finish}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

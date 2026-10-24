import { useRef, useState, type ComponentProps } from "react"
import { Clock3 } from "lucide-react"
import { Input } from "./ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import { Button } from "./ui/button"
import { TimeWheel, type TimeWheelHandle } from "./time-wheel"
import { cn } from "@shared/lib/utils"

export type TimePickerProps = Omit<ComponentProps<typeof Input>, "type" | "value" | "onChange"> & {
  value?: string
  kind?: "time" | "duration"
  maxDurationMinutes?: number
  onChange: (value: string) => void
}
const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/** Selection-only local HH:mm; every minute remains available without text entry. */
export function TimePicker({
  value = "",
  kind = "time",
  maxDurationMinutes = 1439,
  onChange,
  "aria-label": ariaLabel,
  className,
  disabled,
  readOnly,
  onKeyDown,
  ...props
}: TimePickerProps) {
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const hourWheel = useRef<TimeWheelHandle>(null)
  const minuteWheel = useRef<TimeWheelHandle>(null)
  const unavailable = disabled || readOnly
  const time = useRef(value)
  time.current = validTime.test(value) ? value : "00:00"
  const [hour, minute] = time.current.split(":").map(Number)
  const maximum = kind === "duration" ? Math.max(0, Math.min(1439, maxDurationMinutes)) : 1439
  const maxHour = Math.floor(maximum / 60)
  const minuteCount = hour >= maxHour ? (maximum % 60) + 1 : 60
  const panelLabel = kind === "duration" ? "选择持续时长" : "选择时间"
  function changePart(part: number, next: number) {
    const parts = time.current.split(":")
    parts[part] = String(next).padStart(2, "0")
    const total = Math.min(maximum, Number(parts[0]) * 60 + Number(parts[1]))
    time.current = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
    onChange(time.current)
  }
  function finish() {
    hourWheel.current?.commit()
    minuteWheel.current?.commit()
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
            aria-label={ariaLabel || (props.id ? undefined : panelLabel)}
            inputMode="none"
            autoComplete="off"
            placeholder={props.placeholder || "选择时间"}
            className={cn("cursor-pointer pr-10 tabular-nums caret-transparent", className)}
            disabled={unavailable}
            readOnly
            value={kind === "duration" ? `${hour}小时${minute}分钟` : value}
            onKeyDown={(event) => {
              onKeyDown?.(event)
              if (!event.defaultPrevented && ["Enter", " ", "ArrowDown"].includes(event.key)) {
                event.preventDefault()
                if (!unavailable) setOpen(true)
              }
            }}
          />
        </PopoverTrigger>
        <Clock3
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
      </div>
      <PopoverContent
        ref={panel}
        aria-label={panelLabel}
        className="w-64 gap-0 overflow-hidden p-0"
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
          <Clock3 aria-hidden className="size-4 text-muted-foreground" />
          <output className="text-detail font-semibold tabular-nums" aria-live="polite">
            {kind === "duration" ? `${hour}小时${minute}分钟` : value || "--:--"}
          </output>
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={finish}>
            完成
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 p-3">
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-center text-sm font-semibold">小时</p>
            <TimeWheel
              ref={hourWheel}
              label="小时"
              unit="时"
              count={maxHour + 1}
              value={hour}
              onChange={(next) => changePart(0, next)}
              onComplete={finish}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-center text-sm font-semibold">分钟</p>
            <TimeWheel
              ref={minuteWheel}
              label="分钟"
              unit="分"
              count={minuteCount}
              value={minute}
              onChange={(next) => changePart(1, next)}
              onComplete={finish}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

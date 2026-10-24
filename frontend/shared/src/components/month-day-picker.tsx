import { useRef, useState, type AriaAttributes } from "react"
import { CalendarDays } from "lucide-react"
import { Button } from "./ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"

/** A day-of-month is independent of any displayed month: all 31 days stay selectable. */
export function MonthDayPicker({
  id,
  value,
  onChange,
  disabled,
  ...aria
}: AriaAttributes & {
  id?: string
  value: number
  onChange: (day: number) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          {...aria}
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className="w-full justify-start text-left font-normal"
        >
          <CalendarDays />
          每月 {value} 日
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={panel}
        aria-label="选择每月日期"
        className="w-auto gap-3 p-3"
        align="start"
        collisionPadding={12}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          panel.current
            ?.querySelector<HTMLElement>("[aria-checked='true']")
            ?.focus({ preventScroll: true })
        }}
      >
        <p className="text-center text-sm font-semibold">每月日期</p>
        <div
          role="radiogroup"
          aria-label="每月日期"
          className="month-day-grid grid grid-cols-7 gap-1"
          onKeyDown={(event) => {
            const current = Number((event.target as HTMLElement).dataset.monthDay)
            const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]
            const next =
              step !== undefined
                ? Math.max(1, Math.min(31, current + step))
                : event.key === "Home"
                  ? 1
                  : event.key === "End"
                    ? 31
                    : null
            if (next !== null) {
              event.preventDefault()
              panel.current?.querySelector<HTMLElement>(`[data-month-day='${next}']`)?.focus()
            }
          }}
        >
          {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
            <Button
              key={day}
              type="button"
              role="radio"
              aria-label={`${day}日`}
              aria-checked={day === value}
              tabIndex={day === value ? 0 : -1}
              data-month-day={day}
              variant={day === value ? "default" : "ghost"}
              className="size-10 p-0"
              onClick={() => {
                onChange(day)
                setOpen(false)
              }}
            >
              {day}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

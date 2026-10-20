import { useEffect, useState, type ComponentProps } from "react"
import { Clock3 } from "lucide-react"
import { Input } from "./ui/input"
import { Button } from "./ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group"
import { cn } from "@shared/lib/utils"

export type TimePickerProps = Omit<ComponentProps<typeof Input>, "type" | "value" | "onChange"> & {
  value?: string
  onChange: (value: string) => void
}
const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"))
const minutes = Array.from({ length: 12 }, (_, index) => String(index * 5).padStart(2, "0"))

/** Local 24-hour HH:mm; minute choices never round an existing custom minute. */
export function TimePicker({
  value = "",
  onChange,
  "aria-label": ariaLabel,
  className,
  disabled,
  readOnly,
  ...props
}: TimePickerProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])
  const [hour, minute] = (validTime.test(value) ? value : "00:00").split(":")
  function choose(next: string) {
    setDraft(next)
    onChange(next)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="relative">
        <Input
          {...props}
          type="text"
          inputMode="text"
          pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]"
          maxLength={5}
          placeholder={props.placeholder || "HH:mm"}
          title="请输入24小时制时间，例如 08:05 或 23:17"
          aria-label={ariaLabel || (props.id ? undefined : "时间（24小时制）")}
          className={cn("pr-12 tabular-nums", className)}
          disabled={disabled}
          readOnly={readOnly}
          value={draft}
          onChange={(event) => {
            const next = event.currentTarget.value
            setDraft(next)
            if (next === "" || validTime.test(next)) onChange(next)
          }}
        />
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-0 right-0 text-muted-foreground"
            disabled={disabled || readOnly}
            aria-label={`打开时间选择${value ? `，当前 ${value}` : ""}`}
          >
            <Clock3 className="size-4" />
          </Button>
        </PopoverTrigger>
      </div>
      <PopoverContent aria-label="选择时间（24小时制）" className="w-64">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="mb-2 text-center text-xs font-medium text-muted-foreground">
              小时（24小时制）
            </p>
            <ToggleGroup
              type="single"
              orientation="vertical"
              aria-label="小时（24小时制）"
              value={hour}
              onValueChange={(next) => {
                if (next) choose(`${next}:${minute}`)
              }}
              className="grid max-h-56 grid-cols-1 overflow-y-auto p-1"
            >
              {hours.map((option) => (
                <ToggleGroupItem
                  key={option}
                  value={option}
                  aria-label={`${option} 时`}
                  className="w-full tabular-nums"
                >
                  {option}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div>
            <p className="mb-2 text-center text-xs font-medium text-muted-foreground">
              分钟（每5分钟）
            </p>
            <ToggleGroup
              type="single"
              orientation="vertical"
              aria-label="分钟（每5分钟）"
              value={minute}
              onValueChange={(next) => {
                if (next) {
                  choose(`${hour}:${next}`)
                  setOpen(false)
                }
              }}
              className="grid max-h-56 grid-cols-1 overflow-y-auto p-1"
            >
              {minutes.map((option) => (
                <ToggleGroupItem
                  key={option}
                  value={option}
                  aria-label={`${option} 分`}
                  className="w-full tabular-nums"
                >
                  {option}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          可直接输入任意分钟；上下方向键选择，回车确认。
        </p>
        {validTime.test(value) && !minutes.includes(minute) && (
          <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
            当前分钟为 {minute}，已保留。
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}

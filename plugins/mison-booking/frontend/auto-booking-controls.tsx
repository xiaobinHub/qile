import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react"
import { ArrowDown, ArrowUp, Clock3, GripVertical, X } from "lucide-react"
import { Popover, PopoverTrigger } from "@shared/components/ui/popover"
import { TimeWheel, type TimeWheelHandle } from "@shared/components/time-wheel"
import { PageActiveContext } from "./contexts"
import { Button, Input, PopoverContent } from "./ui"
import type { PluginContext } from "./types"

export function useAutoBookingLive(context: PluginContext) {
  const live = useRef(false)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [context])
  return useCallback(() => live.current && !context.signal.aborted, [context])
}

export function AutoBookingTimePicker({
  id,
  label,
  value,
  disabled,
  onChange,
  minuteStep = 1,
  trigger,
  onConfirm,
  confirmDisabled = false,
}: {
  id: string
  label: string
  value: string
  disabled: boolean
  onChange(value: string): void
  minuteStep?: 1 | 30
  trigger?: ReactElement
  onConfirm?(value: string): void
  confirmDisabled?: boolean
}) {
  const pageActive = useContext(PageActiveContext)
  const [open, setOpen] = useState(false)
  const hours = useRef<TimeWheelHandle>(null)
  const minutes = useRef<TimeWheelHandle>(null)
  const panel = useRef<HTMLDivElement>(null)
  const current = useRef(value)
  current.current = value || "00:00"
  const [hour, minute] = current.current.split(":").map(Number)
  function finish(confirm = false) {
    hours.current?.commit()
    minutes.current?.commit()
    if (!value) onChange(current.current)
    if (confirm && !disabled && pageActive && !confirmDisabled) onConfirm?.(current.current)
    setOpen(false)
  }
  function change(part: number, next: number) {
    const parts = current.current.split(":")
    parts[part] = String(next).padStart(2, "0")
    current.current = parts.join(":")
    onChange(current.current)
  }
  return (
    <Popover
      open={open && pageActive && !disabled}
      onOpenChange={(next) => (next ? setOpen(true) : finish())}
    >
      {trigger ? (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      ) : (
        <div className="relative mison-auto-time-picker">
          <PopoverTrigger asChild>
            <Input
              id={id}
              aria-label={label}
              role="combobox"
              aria-autocomplete="none"
              inputMode="none"
              autoComplete="off"
              className="cursor-pointer pr-10 tabular-nums caret-transparent"
              readOnly
              disabled={disabled}
              value={value}
              placeholder="选择时间"
              onKeyDown={(event) => {
                if (["Enter", " ", "ArrowDown"].includes(event.key)) {
                  event.preventDefault()
                  if (!disabled) setOpen(true)
                }
              }}
            />
          </PopoverTrigger>
          <Clock3
            aria-hidden
            className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
        </div>
      )}
      <PopoverContent
        ref={panel}
        align="start"
        className="w-64 gap-0 overflow-hidden p-0"
        aria-label={label}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          panel.current
            ?.querySelector<HTMLElement>("[role=spinbutton]")
            ?.focus({ preventScroll: true })
        }}
      >
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
          <output className="tabular-nums" aria-live="polite">
            {value || "00:00"}
          </output>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={confirmDisabled}
            onClick={() => finish(true)}
          >
            {onConfirm ? "添加时段" : "完成"}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 p-3">
          <TimeWheel
            ref={hours}
            label={`${label}小时`}
            unit="时"
            count={24}
            value={hour}
            onChange={(next) => change(0, next)}
            onComplete={() => finish(true)}
          />
          <TimeWheel
            ref={minutes}
            label={`${label}分钟`}
            unit={minuteStep === 1 ? "分" : ""}
            count={60 / minuteStep}
            value={minute / minuteStep}
            valueStep={minuteStep}
            onChange={(next) => change(1, next * minuteStep)}
            onComplete={() => finish(true)}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function PriorityList<T>({
  items,
  itemKey,
  itemLabel,
  render,
  disabled,
  onChange,
  compact = false,
}: {
  items: T[]
  itemKey(item: T): string
  itemLabel(item: T): string
  render(item: T, index: number): ReactNode
  disabled: boolean
  onChange(items: T[]): void
  compact?: boolean
}) {
  const dragging = useRef<string | null>(null)
  const [announcement, setAnnouncement] = useState("")
  function move(from: number, to: number) {
    if (disabled || from < 0 || to < 0 || to >= items.length || from === to) return
    const next = [...items]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    onChange(next)
    setAnnouncement(`${itemLabel(item)}已移到第${to + 1}优先`)
  }
  return (
    <>
      <ol className={compact ? "mison-auto-priorities is-compact" : "mison-auto-priorities"}>
        {items.map((item, index) => (
          <li
            key={itemKey(item)}
            data-priority={index + 1}
            onDragOver={(event) => {
              if (!disabled && dragging.current !== null) event.preventDefault()
            }}
            onDrop={(event) => {
              event.preventDefault()
              const from = items.findIndex((value) => itemKey(value) === dragging.current)
              move(from, index)
              dragging.current = null
            }}
          >
            {!disabled ? (
              <Button
                variant="ghost"
                size="icon"
                draggable
                tabIndex={-1}
                aria-label={`拖动调整${itemLabel(item)}优先级，也可使用前移和后移按钮`}
                className="mison-auto-drag"
                onDragStart={(event) => {
                  dragging.current = itemKey(item)
                  event.dataTransfer.effectAllowed = "move"
                  event.dataTransfer.setData("text/plain", itemKey(item))
                }}
                onDragEnd={() => {
                  dragging.current = null
                }}
              >
                <GripVertical />
              </Button>
            ) : null}
            <span className="mison-auto-priority-number mison-caption">{index + 1}</span>
            {render(item, index)}
            {!disabled ? (
              <div className="mison-auto-priority-actions">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`前移${itemLabel(item)}`}
                  className="mison-auto-priority-move"
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`后移${itemLabel(item)}`}
                  className="mison-auto-priority-move"
                  disabled={index === items.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`移除${itemLabel(item)}`}
                  onClick={() => onChange(items.filter((_, at) => at !== index))}
                >
                  <X />
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </>
  )
}

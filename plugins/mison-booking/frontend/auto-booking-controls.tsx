import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react"
import { Clock3, Info, MoreHorizontal, X } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@shared/components/ui/dropdown-menu"
import { Popover, PopoverTrigger } from "@shared/components/ui/popover"
import { TimeWheel, type TimeWheelHandle } from "@shared/components/time-wheel"
import { PageActiveContext } from "./contexts"
import { Button, DropdownMenuContent, Input, PopoverContent } from "./ui"
import type { PluginContext } from "./types"

export function AutoBookingHelp({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} title={label}>
          <Info />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label={label} className="mison-auto-help">
        {children}
      </PopoverContent>
    </Popover>
  )
}

export function AutoBookingMenu({
  label,
  disabled,
  items,
}: {
  label: string
  disabled: boolean
  items: {
    label: string
    disabled?: boolean
    destructive?: boolean
    opensDialog?: boolean
    onSelect(): void
  }[]
}) {
  const pageActive = useContext(PageActiveContext)
  const [open, setOpen] = useState(false)
  const opensDialog = useRef(false)
  useEffect(() => {
    if (!pageActive || disabled) setOpen(false)
  }, [pageActive, disabled])
  return (
    <DropdownMenu open={open && pageActive && !disabled} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} title={label} disabled={disabled}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="mison-auto-menu"
        aria-label={label}
        onCloseAutoFocus={(event) => {
          if (opensDialog.current) {
            event.preventDefault()
            opensDialog.current = false
          }
        }}
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            disabled={item.disabled}
            variant={item.destructive ? "destructive" : "default"}
            onSelect={() => {
              opensDialog.current = !!item.opensDialog
              setOpen(false)
              item.onSelect()
            }}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

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
  removable = true,
}: {
  items: T[]
  itemKey(item: T): string
  itemLabel(item: T): string
  render(item: T, index: number): ReactNode
  disabled: boolean
  onChange(items: T[]): void
  compact?: boolean
  removable?: boolean
}) {
  const dragging = useRef<{ key: string; order: string[] } | null>(null)
  const [preview, setPreview] = useState<string[] | null>(null)
  const [announcement, setAnnouncement] = useState("")
  useEffect(() => {
    dragging.current = null
    setPreview(null)
  }, [items, disabled])
  function ordered(keys: string[]) {
    const positions = new Map(keys.map((key, index) => [key, index]))
    return [...items].sort(
      (a, b) => (positions.get(itemKey(a)) ?? items.length) - (positions.get(itemKey(b)) ?? items.length),
    )
  }
  const displayedItems = preview && !disabled ? ordered(preview) : items
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
      <ol
        className={compact ? "mison-auto-priorities is-compact" : "mison-auto-priorities"}
        data-sorting={!!preview && !disabled}
        onDragOver={(event) => {
          if (!disabled && dragging.current) {
            event.preventDefault()
            event.dataTransfer.dropEffect = "move"
          }
        }}
        onDrop={(event) => {
          const session = dragging.current
          if (disabled || !session) return
          event.preventDefault()
          event.stopPropagation()
          const next = ordered(session.order)
          if (next.some((item, index) => itemKey(item) !== itemKey(items[index]))) {
            onChange(next)
            const index = next.findIndex((item) => itemKey(item) === session.key)
            if (index >= 0) setAnnouncement(`${itemLabel(next[index])}已移到第${index + 1}优先`)
          }
          dragging.current = null
          setPreview(null)
        }}
      >
        {displayedItems.map((item, index) => (
          <li
            key={itemKey(item)}
            data-priority={index + 1}
            data-dragging={!!preview && dragging.current?.key === itemKey(item)}
            draggable={!disabled}
            tabIndex={disabled ? undefined : 0}
            aria-label={
              disabled ? undefined : `拖动或按上下方向键调整${itemLabel(item)}优先级`
            }
            onDragOver={(event) => {
              const session = dragging.current
              if (disabled || !session) return
              event.preventDefault()
              const from = session.order.indexOf(session.key)
              const to = session.order.indexOf(itemKey(item))
              if (from < 0 || to < 0 || from === to) return
              const source = event.currentTarget.parentElement?.querySelector<HTMLElement>(
                '[data-dragging="true"]',
              )
              if (!source) return
              const sourceRect = source.getBoundingClientRect()
              const targetRect = event.currentTarget.getBoundingClientRect()
              const sameRow = Math.abs(sourceRect.top - targetRect.top) < targetRect.height / 2
              const pointer = sameRow ? event.clientX : event.clientY
              const middle = sameRow
                ? targetRect.left + targetRect.width / 2
                : targetRect.top + targetRect.height / 2
              // Cross the target midpoint before moving so shifted neighbours do not flicker back.
              if (from < to ? pointer < middle : pointer > middle) return
              const next = [...session.order]
              const [key] = next.splice(from, 1)
              next.splice(to, 0, key)
              session.order = next
              setPreview(next)
            }}
            onDragStart={(event) => {
              if (disabled) return
              if (event.target instanceof Element && event.target.closest("button")) {
                event.preventDefault()
                return
              }
              const order = items.map(itemKey)
              dragging.current = { key: itemKey(item), order }
              setPreview(order)
              event.dataTransfer.effectAllowed = "move"
              event.dataTransfer.setData("text/plain", itemKey(item))
            }}
            onDragEnd={() => {
              dragging.current = null
              setPreview(null)
            }}
            onKeyDown={(event) => {
              if (disabled || event.currentTarget !== event.target) return
              if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                event.preventDefault()
                move(index, index - 1)
              } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                event.preventDefault()
                move(index, index + 1)
              }
            }}
          >
            {render(item, index)}
            {!disabled && removable ? (
              <div className="mison-auto-priority-actions">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`移除${itemLabel(item)}`}
                  title={`移除${itemLabel(item)}`}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
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

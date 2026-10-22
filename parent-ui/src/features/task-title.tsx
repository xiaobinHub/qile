import { useState, useRef, useLayoutEffect } from "react"
import { ChevronDown } from "lucide-react"
import { Popover, PopoverAnchor, PopoverContent } from "@shared/components/ui/popover"
import { Command, CommandList, CommandItem } from "@shared/components/ui/command"
import { Button } from "@shared/components/ui/button"
import { Input } from "@shared/components/ui/input"
import type { BusinessData, Preset } from "../domain/types"
export function TaskTitle({
  id,
  value,
  onChange,
  onPreset,
  data,
  ...aria
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  onPreset: (p: Preset) => void
  data: BusinessData
  "aria-describedby"?: string
  "aria-invalid"?: boolean | "true" | "false"
}) {
  const [open, setOpen] = useState(false),
    [showAll, setShowAll] = useState(false),
    [active, setActive] = useState(""),
    [listNode, setListNode] = useState<HTMLDivElement | null>(null),
    [activeDomId, setActiveDomId] = useState<string | undefined>()
  const composing = useRef(false),
    input = useRef<HTMLInputElement>(null)
  const query = showAll ? "" : value.normalize("NFKC").toLocaleLowerCase().trim(),
    items = data.taskPresets.filter(
      (p) => !query || p.title.normalize("NFKC").toLocaleLowerCase().includes(query),
    ),
    listId = listNode?.id
  useLayoutEffect(() => {
    const selected = Array.from(listNode?.querySelectorAll<HTMLElement>("[cmdk-item]") || []).find(
      (el) => el.dataset.value === active,
    )
    setActiveDomId(selected?.id)
    if (open && selected) selected.scrollIntoView({ block: "nearest" })
  }, [listNode, active, open, query])
  function choose(p: Preset) {
    onPreset(p)
    setOpen(false)
    setActive("")
    input.current?.focus()
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="task-title-combo relative">
          <Input
            {...aria}
            ref={input}
            id={id}
            autoComplete="off"
            value={value}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open ? activeDomId : undefined}
            required
            maxLength={200}
            autoFocus
            className="pr-12"
            placeholder="输入任务内容，或选择常用任务"
            onClick={() => {
              if (!composing.current) {
                setShowAll(false)
                setOpen(true)
              }
            }}
            onChange={(e) => {
              onChange(e.target.value)
              setShowAll(false)
              setActive("")
              if (!composing.current) setOpen(!!e.target.value)
            }}
            onCompositionStart={() => {
              composing.current = true
              setOpen(false)
            }}
            onCompositionEnd={(e) => {
              composing.current = false
              setOpen(!!e.currentTarget.value)
            }}
            onKeyDown={(e) => {
              if (composing.current || e.nativeEvent.isComposing) {
                if (e.key === "Enter") e.preventDefault()
                return
              }
              if (e.key === "Tab") setOpen(false)
              if (e.key === "Escape" && open) {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                setOpen(true)
                const index = items.findIndex((p) => p.id === active),
                  next = Math.max(
                    0,
                    Math.min(items.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)),
                  )
                setActive(items[next]?.id || "")
              } else if (e.key === "Enter" && open) {
                e.preventDefault()
                const p = items.find((p) => p.id === active)
                if (p) choose(p)
                else setOpen(false)
              }
            }}
          />
          <Button
            id="taskPresetToggle"
            className="absolute right-0 top-0"
            type="button"
            variant="ghost"
            size="icon"
            aria-label="选择常用任务"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            onClick={() => {
              setShowAll(true)
              setOpen((v) => !v)
              input.current?.focus()
            }}
          >
            <ChevronDown />
          </Button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-64 max-w-[calc(100vw-3rem)] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (e.target instanceof Node && input.current?.parentElement?.contains(e.target))
            e.preventDefault()
        }}
      >
        <Command shouldFilter={false} value={active} onValueChange={setActive}>
          <CommandList ref={setListNode} aria-label="常用任务建议">
            {items.map((p) => (
              <CommandItem
                key={p.id}
                value={p.id}
                onSelect={() => choose(p)}
                onMouseDown={(e) => e.preventDefault()}
              >
                <strong>{p.title}</strong>
                <small className="text-caption text-muted-foreground">
                  {data.categories.find((c) => c.id === p.categoryId)?.name || "创建时选择类型"} ·{" "}
                  {p.startTime}–{p.endTime} · 奖励 {p.points} 分
                </small>
              </CommandItem>
            ))}
            {!items.length && (
              <p className="p-4 text-sm text-muted-foreground">
                {data.taskPresets.length
                  ? "没有匹配的常用任务，可继续手动输入"
                  : "暂无常用任务，可在设置中配置"}
              </p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

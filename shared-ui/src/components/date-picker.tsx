import { useState, type AriaAttributes } from "react"
import { CalendarDays } from "lucide-react"
import type { Matcher } from "react-day-picker"
import { Button } from "./ui/button"
import { Calendar } from "./ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import { parseLocalDate, formatLocalDate } from "@shared/lib/local-date"
import { cn } from "@shared/lib/utils"

type PickerBase = AriaAttributes & { id?: string; name?: string; disabled?: boolean; disabledDates?: Matcher | Matcher[]; placeholder?: string; className?: string }
export type DatePickerProps = PickerBase & { value?: string; onChange: (value: string) => void }
export function DatePicker({ value, onChange, id, name, disabled, disabledDates, placeholder = "选择日期", className, ...aria }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const selected = parseLocalDate(value)
  return <Popover open={open} onOpenChange={setOpen}>{name && <input type="hidden" name={name} value={value || ""} disabled={disabled} />}<PopoverTrigger asChild><Button {...aria} id={id} type="button" variant="outline" disabled={disabled} aria-label={aria["aria-label"] || (id || aria["aria-labelledby"] ? undefined : placeholder)} className={cn("w-full justify-start text-left font-normal", !selected && "text-muted-foreground", className)}><CalendarDays className="size-4" />{selected ? formatLocalDate(selected) : placeholder}</Button></PopoverTrigger><PopoverContent className="w-auto p-0"><Calendar mode="single" selected={selected} defaultMonth={selected} disabled={disabledDates} onSelect={date => { onChange(date ? formatLocalDate(date) : ""); setOpen(false) }} /></PopoverContent></Popover>
}

export type DateRangeValue = { from?: string; to?: string }
export type DateRangePickerProps = PickerBase & { value?: DateRangeValue; onChange: (value: DateRangeValue) => void }
export function DateRangePicker({ value = {}, onChange, id, name, disabled, disabledDates, placeholder = "选择日期范围", className, ...aria }: DateRangePickerProps) {
  const [open, setOpen] = useState(false)
  const from = parseLocalDate(value.from), to = parseLocalDate(value.to)
  return <Popover open={open} onOpenChange={setOpen}>{name && <><input type="hidden" name={`${name}.from`} value={value.from || ""} disabled={disabled} /><input type="hidden" name={`${name}.to`} value={value.to || ""} disabled={disabled} /></>}<PopoverTrigger asChild><Button {...aria} id={id} type="button" variant="outline" disabled={disabled} aria-label={aria["aria-label"] || (id || aria["aria-labelledby"] ? undefined : placeholder)} className={cn("w-full justify-start text-left font-normal", !from && "text-muted-foreground", className)}><CalendarDays className="size-4" />{from ? `${formatLocalDate(from)} — ${to ? formatLocalDate(to) : "结束日期"}` : placeholder}</Button></PopoverTrigger><PopoverContent className="w-auto p-0"><Calendar mode="range" selected={from ? { from, to } : undefined} defaultMonth={from} disabled={disabledDates} onDayClick={(date, modifiers) => { if (modifiers.disabled) return; const picked = formatLocalDate(date); if (!from || to) { onChange({ from: picked }); return }; const start = formatLocalDate(from); onChange(picked < start ? { from: picked, to: start } : { from: start, to: picked }); setOpen(false) }} /><p className="px-4 pb-3 text-xs text-muted-foreground" aria-live="polite">{from && !to ? "请选择结束日期" : "依次选择开始和结束日期"}</p></PopoverContent></Popover>
}

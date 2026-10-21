import { DayPicker, getDefaultClassNames, type DayPickerProps } from "react-day-picker"
import { zhCN } from "react-day-picker/locale"
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react"
import { cn } from "@shared/lib/utils"

export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: DayPickerProps) {
  const defaults = getDefaultClassNames()
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      locale={zhCN}
      weekStartsOn={1}
      className={cn("shared-calendar w-fit max-w-full p-3 text-sm", className)}
      classNames={{
        root: cn(defaults.root, "relative"),
        months: "relative flex flex-col gap-4 sm:flex-row",
        month: "flex flex-col gap-3",
        month_caption: "flex h-10 items-center justify-center px-12 font-medium",
        caption_label: "text-sm font-medium",
        nav: "absolute inset-x-0 top-0 flex items-center justify-between",
        button_previous:
          "flex size-10 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
        button_next:
          "flex size-10 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday:
          "flex h-9 w-10 items-center justify-center text-xs font-normal text-muted-foreground",
        week: "mt-1 flex w-full",
        day: "relative size-10 p-0 text-center",
        day_button:
          "flex size-10 items-center justify-center rounded-full text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        selected: "rounded-full bg-primary text-primary-foreground [&>button]:hover:bg-primary",
        today: "rounded-full font-semibold ring-1 ring-inset ring-primary",
        outside: "text-muted-foreground",
        disabled: "opacity-40",
        hidden: "invisible",
        range_start: "rounded-r-none rounded-l-full bg-primary text-primary-foreground",
        range_middle: "rounded-none bg-accent text-accent-foreground",
        range_end: "rounded-l-none rounded-r-full bg-primary text-primary-foreground",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: iconClass }) =>
          orientation === "left" ? (
            <ChevronLeft className={cn("size-4", iconClass)} />
          ) : orientation === "right" ? (
            <ChevronRight className={cn("size-4", iconClass)} />
          ) : (
            <ChevronDown className={cn("size-4", iconClass)} />
          ),
      }}
      {...props}
    />
  )
}

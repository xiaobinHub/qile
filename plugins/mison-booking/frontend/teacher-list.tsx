import { useEffect, useId, useRef, useState } from "react"
import { Popover, PopoverTrigger } from "@shared/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@shared/components/ui/toggle-group"
import { Checkbox } from "@shared/components/ui/checkbox"
import { Field, FieldLabel, FieldSet, FieldLegend } from "@shared/components/ui/field"
import { Card, CardHeader, CardTitle, CardAction, CardFooter } from "@shared/components/ui/card"
import { Badge } from "@shared/components/ui/badge"
import { ScrollArea } from "@shared/components/ui/scroll-area"
import { Separator } from "@shared/components/ui/separator"
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@shared/components/ui/input-group"
import { Star, ArrowRight, Clock3, ChevronDown, Search, SlidersHorizontal } from "lucide-react"
import { Avatar, Button, Empty, DatePicker, PopoverContent, teacherName, dateLabel } from "./ui"
import type { Teacher, TeacherFilters } from "./types"

export type Filters = {
  nickname: string
  date: string
  times: string[]
  labels: string[]
  favoritesOnly: boolean
}
export const emptyFilters: Filters = {
  nickname: "",
  date: "",
  times: [],
  labels: [],
  favoritesOnly: false,
}

export function TeacherFilterBar({
  value,
  onChange,
  options,
  onSearch,
  onReset,
}: {
  value: Filters
  onChange(value: Filters): void
  options: TeacherFilters | null
  onSearch(): void
  onReset(): void
}) {
  const prefix = useId()
  const [labelsOpen, setLabelsOpen] = useState(false)
  return (
    <form
      className="mison-filters"
      aria-label="筛选老师"
      onSubmit={(event) => {
        event.preventDefault()
        onSearch()
      }}
    >
      <InputGroup className="mison-search h-10">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="搜索老师姓名"
          placeholder="搜索老师姓名"
          value={value.nickname}
          onChange={(event) => onChange({ ...value, nickname: event.target.value })}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton type="submit" size="icon-sm" aria-label="搜索">
            <ArrowRight />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <DatePicker
        aria-label="筛选日期"
        className="mison-date-picker"
        placeholder="筛选日期"
        value={value.date}
        onChange={(date) => onChange({ ...value, date })}
      />
      <TimeFilter
        values={value.times}
        options={options?.timeSlots ?? []}
        onChange={(times) => onChange({ ...value, times })}
      />
      <Popover open={labelsOpen} onOpenChange={setLabelsOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline">
            <SlidersHorizontal data-icon="inline-start" />
            标签{value.labels.length ? ` · ${value.labels.length}` : ""}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="mison-label-popover" align="start" aria-label="筛选教师标签">
          <div className="mison-section-heading">
            <strong>筛选教师标签</strong>
            <Button
              variant="link"
              size="sm"
              disabled={!value.labels.length}
              onClick={() => onChange({ ...value, labels: [] })}
            >
              清空
            </Button>
          </div>
          {options?.labelGroups.length ? (
            options.labelGroups.map((group) => (
              <FieldSet key={group.id}>
                <FieldLegend variant="label">{group.name}</FieldLegend>
                <div className="mison-label-options">
                  {group.labels.map((label) => (
                    <Field key={label.id} orientation="horizontal">
                      <Checkbox
                        id={`${prefix}-${label.id}`}
                        checked={value.labels.includes(label.id)}
                        onCheckedChange={(checked) =>
                          onChange({
                            ...value,
                            labels:
                              checked === true
                                ? [...value.labels, label.id]
                                : value.labels.filter((id) => id !== label.id),
                          })
                        }
                      />
                      <FieldLabel htmlFor={`${prefix}-${label.id}`}>{label.name}</FieldLabel>
                    </Field>
                  ))}
                </div>
              </FieldSet>
            ))
          ) : (
            <Empty title="暂无可用标签" />
          )}
          <Button variant="outline" onClick={() => setLabelsOpen(false)}>
            完成
          </Button>
        </PopoverContent>
      </Popover>
      <Field orientation="horizontal" className="mison-favorites-field">
        <Checkbox
          id={`${prefix}-favorites`}
          checked={value.favoritesOnly}
          onCheckedChange={(checked) => onChange({ ...value, favoritesOnly: checked === true })}
        />
        <FieldLabel htmlFor={`${prefix}-favorites`}>仅看收藏</FieldLabel>
      </Field>
      <Button className="mison-reset" variant="ghost" onClick={onReset}>
        清空筛选
      </Button>
    </form>
  )
}
function TimeFilter({
  values,
  options,
  onChange,
}: {
  values: string[]
  options: string[]
  onChange(values: string[]): void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="mison-time-trigger" aria-label="筛选时段">
          <Clock3 data-icon="inline-start" />
          {values.length ? `已选 ${values.length} 个时段` : "全部时段"}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="mison-time-popover" aria-label="选择上课时段">
        <div className="mison-section-heading">
          <strong>选择上课时段</strong>
          <Badge variant="secondary">可多选</Badge>
        </div>
        <Button
          variant={values.length ? "outline" : "secondary"}
          aria-pressed={!values.length}
          onClick={() => onChange([])}
        >
          全部时段
        </Button>
        <ScrollArea className="mison-time-scroll">
          <ToggleGroup
            type="multiple"
            variant="outline"
            value={values}
            onValueChange={(next) => onChange([...next].sort())}
            className="mison-time-grid"
            aria-label="可选时段"
          >
            {options.map((time) => (
              <ToggleGroupItem key={time} value={time} aria-label={time}>
                {time}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </ScrollArea>
        {!options.length ? <Empty title="暂无可用时段" /> : null}
        <Separator />
        <div className="mison-section-heading">
          <small>已选 {values.length} 个时段</small>
          <Button onClick={() => setOpen(false)}>完成</Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
export function TeacherList({
  teachers,
  selectedId,
  expanded,
  total,
  loading,
  nextCursor,
  paginationKey,
  onMore,
  onBook,
  onProfile,
  onFavorite,
  favoriteBusy,
}: {
  teachers: Teacher[]
  selectedId: string | null
  expanded: boolean
  total: number | null
  loading: boolean
  nextCursor: string | null
  paginationKey: string
  onMore(): void
  onBook(teacher: Teacher): void
  onProfile(teacher: Teacher): void
  onFavorite(teacher: Teacher): void
  favoriteBusy: string | null
}) {
  const sentinel = useRef<HTMLDivElement>(null)
  const attempted = useRef<string | null>(null)
  useEffect(() => {
    attempted.current = null
  }, [paginationKey])
  useEffect(() => {
    const target = sentinel.current
    if (!target || !nextCursor || loading) return
    // Use the browser viewport as root: it clips both page and sidebar scrolling.
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || attempted.current === nextCursor)
          return
        attempted.current = nextCursor
        onMore()
      },
      { rootMargin: "160px" },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [nextCursor, loading, onMore, expanded, paginationKey])
  return (
    <section
      className={`mison-teachers${expanded ? " is-sidebar" : ""}`}
      aria-label="可约老师"
      aria-busy={loading}
    >
      <div className="mison-list-heading">
        <h2>可约老师{total === null ? "" : ` · ${total}`}</h2>
        {!expanded ? <p>选择老师，查看可约时段。</p> : null}
      </div>
      <ScrollArea className="mison-teacher-scroll">
        <div className="mison-teacher-grid">
          {teachers.map((teacher) => (
            <Card
              key={teacher.id}
              size="sm"
              className="mison-teacher-card"
              data-selected={expanded && teacher.id === selectedId}
            >
              {expanded ? (
                <Button
                  className="mison-sidebar-card-trigger"
                  variant="ghost"
                  aria-label={`查看${teacherName(teacher.name)}档期`}
                  aria-pressed={teacher.id === selectedId}
                  data-book-teacher={teacher.id}
                  onClick={() => onBook(teacher)}
                />
              ) : null}
              <CardHeader className="mison-teacher-main">
                {expanded ? (
                  <Avatar name={teacher.name} url={teacher.avatarUrl} compact />
                ) : (
                  <Button
                    variant="ghost"
                    className={`mison-avatar-trigger rounded-full ${expanded ? "size-16" : "size-20"}`}
                    size="icon"
                    aria-label={`查看${teacherName(teacher.name)}档案`}
                    onClick={() => onProfile(teacher)}
                  >
                    <Avatar name={teacher.name} url={teacher.avatarUrl} large={!expanded} />
                  </Button>
                )}
                <div className="mison-teacher-copy">
                  <CardTitle>
                    {expanded ? (
                      teacher.name.replace(/\s*老师$/, "")
                    ) : (
                      <Button
                        variant="link"
                        className="h-auto p-0"
                        onClick={() => onProfile(teacher)}
                      >
                        {teacher.name.replace(/\s*老师$/, "")}
                      </Button>
                    )}
                  </CardTitle>
                  <div className="mison-tags">
                    {teacher.labels.slice(0, 3).map((label) => (
                      <Badge variant="secondary" key={label.id}>
                        {label.name}
                      </Badge>
                    ))}
                  </div>
                  <small className="mison-next-available">
                    {teacher.nextAvailable ? (
                      <>
                        最近可约：{dateLabel(teacher.nextAvailable.date)}{" "}
                        {teacher.nextAvailable.time}
                      </>
                    ) : (
                      "暂无可约时间"
                    )}
                  </small>
                </div>
                <CardAction>
                  <Button
                    variant="ghost"
                    className="mison-star"
                    size="icon-sm"
                    aria-label={`${teacher.favorite ? "取消收藏" : "收藏"}${teacher.name}`}
                    aria-pressed={teacher.favorite}
                    disabled={favoriteBusy === teacher.id || teacher.favoriteAvailable === false}
                    onClick={() => onFavorite(teacher)}
                  >
                    <Star
                      data-icon="inline-start"
                      fill={teacher.favorite ? "currentColor" : "none"}
                    />
                  </Button>
                </CardAction>
              </CardHeader>
              {!expanded ? (
                <CardFooter className="mison-card-footer">
                  <div className="mison-actions">
                    <Button
                      variant="link"
                      size="sm"
                      data-book-teacher={teacher.id}
                      onClick={() => onBook(teacher)}
                    >
                      预约
                    </Button>
                  </div>
                </CardFooter>
              ) : null}
            </Card>
          ))}
        </div>
        {nextCursor ? (
          <div ref={sentinel} className="mison-load-more" role="status">
            {loading ? "正在加载更多老师…" : "滚动继续查看老师"}
          </div>
        ) : null}
      </ScrollArea>
      {!teachers.length ? (
        <Empty
          title={loading ? "正在查找老师…" : nextCursor ? "继续查找匹配的老师" : "没有匹配的老师"}
        >
          <p>
            {loading
              ? "请稍候"
              : nextCursor
                ? "正在继续查询匹配的老师…"
                : "试试调整筛选条件或关闭仅看收藏。"}
          </p>
        </Empty>
      ) : null}
    </section>
  )
}

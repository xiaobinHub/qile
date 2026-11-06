import { useEffect, useRef, useState, useId } from "react"
import { ChevronRight, Folder, FileText } from "lucide-react"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@shared/components/ui/collapsible"
import { RadioGroup, RadioGroupItem } from "@shared/components/ui/radio-group"
import { Field, FieldLabel, FieldTitle, FieldDescription } from "@shared/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@shared/components/ui/toggle-group"
import { request } from "./api"
import { Button, Empty, Notice, Overlay } from "./ui"
import type { Category, Courseware, Draft, PluginContext } from "./types"
function CategoryBranch({
  nodes,
  selected,
  onSelect,
}: {
  nodes: Category[]
  selected: string
  onSelect(id: string): void
}) {
  return (
    <ul>
      {nodes.map((node) => (
        <li key={node.id}>
          {node.children.length ? (
            <Collapsible defaultOpen>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="mison-category-item">
                  <Folder size={15} />
                  <span>{node.name}</span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CategoryBranch nodes={node.children} selected={selected} onSelect={onSelect} />
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <Button
              variant={selected === node.id ? "secondary" : "ghost"}
              aria-pressed={selected === node.id}
              size="sm"
              className="mison-category-item"
              onClick={() => onSelect(node.id)}
            >
              <ChevronRight size={14} />
              <span>{node.name}</span>
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}
const firstLeaf = (nodes: Category[]): string => {
  for (const n of nodes) {
    if (!n.children.length) return n.id
    const id = firstLeaf(n.children)
    if (id) return id
  }
  return ""
}
export function CoursewarePicker({
  context,
  draft,
  start,
  busy,
  externalError,
  pending,
  onReconcile,
  onClose,
  onUse,
}: {
  context: PluginContext
  draft: Draft
  start: string
  busy: boolean
  externalError: string
  pending: boolean
  onReconcile(): void
  onClose(): void
  onUse(course: Courseware): void
}) {
  const [nodes, setNodes] = useState<Category[]>([]),
    [category, setCategory] = useState("")
  const [items, setItems] = useState<Courseware[]>([]),
    [cursor, setCursor] = useState<string | null>(null)
  const [choice, setChoice] = useState<Courseware | null>(null),
    [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [source, setSource] = useState<"category" | "unlearned">("category")
  const generation = useRef(0)
  const listRef = useRef<HTMLElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const attempted = useRef<string | null>(null)
  useEffect(() => {
    let alive = true
    request<{ nodes: Category[] }>(context, "courseware/categories")
      .then((r) => {
        if (alive) {
          setNodes(r.nodes)
          setCategory(firstLeaf(r.nodes))
          if (!r.nodes.length) setLoading(false)
        }
      })
      .catch((e) => {
        if (alive) {
          setError(e.message)
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [context])
  async function load(append = false) {
    const seq = ++generation.current
    setLoading(true)
    setError("")
    const query = new URLSearchParams({
      categoryId: category,
      draftId: draft.id,
      slotStart: start,
      source,
    })
    if (append && cursor) query.set("cursor", cursor)
    try {
      const r = await request<{ items: Courseware[]; nextCursor: string | null }>(
        context,
        `courseware?${query}`,
      )
      if (seq === generation.current && !context.signal.aborted) {
        setItems((old) => (append ? [...old, ...r.items] : r.items))
        setCursor(r.nextCursor)
      }
    } catch (e) {
      if (seq === generation.current) setError((e as Error).message)
    } finally {
      if (seq === generation.current) setLoading(false)
    }
  }
  useEffect(() => {
    attempted.current = null
    setChoice(null)
    setItems([])
    setCursor(null)
    if (category || source === "unlearned") void load()
    return () => {
      generation.current++
    }
  }, [category, source, context, draft.id, draft.revision, start])
  useEffect(() => {
    const target = sentinel.current
    const root = listRef.current
    if (!target || !root || !cursor || loading) return
    const page = cursor
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || attempted.current === page) return
        attempted.current = page
        void load(true)
      },
      { root, rootMargin: "160px" },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [cursor, loading, category, source])
  const fieldId = useId()
  const taken = draft.lessons.filter((l) => l.start !== start).map((l) => l.courseware?.id)
  return (
    <Overlay
      wide
      contained
      title="更换课件"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <small>选择课件和预览都不消耗预览次数</small>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            disabled={!choice || busy || pending}
            onClick={() => choice && onUse({ ...choice, source })}
          >
            {busy ? "更换中…" : "使用此课件"}
          </Button>
        </>
      }
    >
      {error || externalError ? (
        <Notice error>
          {error || externalError}
          {pending ? (
            <Button variant="outline" disabled={busy} onClick={onReconcile}>
              核对课件操作
            </Button>
          ) : null}
        </Notice>
      ) : null}
      <ToggleGroup
        className="mison-course-source"
        type="single"
        value={source}
        onValueChange={(value) => {
          if (value) setSource(value as "category" | "unlearned")
        }}
        aria-label="课件来源"
        disabled={busy || pending}
      >
        <ToggleGroupItem value="category">按分类选择</ToggleGroupItem>
        <ToggleGroupItem value="unlearned">待补学内容</ToggleGroupItem>
      </ToggleGroup>
      <div className={`mison-course-picker${source === "unlearned" ? " is-single" : ""}`}>
        {source === "category" ? (
          <nav aria-label="课件分类">
            {nodes.length ? (
              <CategoryBranch nodes={nodes} selected={category} onSelect={setCategory} />
            ) : (
              <p className="mison-caption">{loading ? "正在加载分类…" : "暂无分类"}</p>
            )}
          </nav>
        ) : null}
        <section ref={listRef} aria-label="选择课件">
          <RadioGroup
            aria-label="选择课件"
            value={choice?.id ?? ""}
            onValueChange={(id) => setChoice(items.find((item) => item.id === id) ?? null)}
            disabled={busy || pending}
          >
            {items.map((course) => {
              const disabled =
                !course.active || course.selectedElsewhere || taken.includes(course.id)
              const learned = course.learned === null ? "" : course.learned ? "已学过" : "未学"
              const detail = [
                course.categoryName,
                disabled ? "不可选择 / 本次其他课时已选" : learned,
              ]
                .filter(Boolean)
                .join(" · ")
              return (
                <Field
                  orientation="horizontal"
                  data-disabled={disabled}
                  key={course.id}
                  className="mison-course-option"
                >
                  <RadioGroupItem
                    id={`${fieldId}-${course.id}`}
                    value={course.id}
                    disabled={disabled || busy || pending}
                  />
                  <FieldLabel htmlFor={`${fieldId}-${course.id}`} className="mison-course-choice">
                    <FileText />
                    <div>
                      <FieldTitle>{course.title}</FieldTitle>
                      {detail ? <FieldDescription>{detail}</FieldDescription> : null}
                    </div>
                  </FieldLabel>
                </Field>
              )
            })}
          </RadioGroup>
          {!items.length ? <Empty title={loading ? "正在加载课件…" : "暂无课件"} /> : null}
          {cursor ? (
            <div ref={sentinel} className="mison-load-more" role="status">
              {loading ? "正在加载更多课件…" : ""}
            </div>
          ) : null}
        </section>
      </div>
    </Overlay>
  )
}

import { useEffect, useId, useState } from "react"
import { Search, X } from "lucide-react"
import { errorMessage, isIgnoredError } from "@/lib/session"
import { FormField } from "@shared/components/form-field"
import { FormFeedback } from "@shared/components/form-feedback"
import { Button } from "@shared/components/ui/button"
import { Checkbox } from "@shared/components/ui/checkbox"
import { Input } from "@shared/components/ui/input"
import { Skeleton } from "@shared/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@shared/components/ui/toggle-group"
import type { PluginRequest } from "./client"
import type { PluginChild, PluginScope } from "./types"

export function ScopePicker({
  value,
  original,
  updating,
  disabled,
  request,
  onChange,
}: {
  value: PluginScope
  original: PluginScope
  updating: boolean
  disabled: boolean
  request: PluginRequest
  onChange: (scope: PluginScope) => void
}) {
  const id = useId()
  const [search, setSearch] = useState("")
  const [children, setChildren] = useState<PluginChild[]>([])
  const [known, setKnown] = useState<Record<string, PluginChild>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (value.scopeMode !== "children") return
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setError("")
    // Clear results immediately: an earlier query must never look like results for the new query.
    setChildren([])
    const timer = window.setTimeout(() => {
      request<{ children: PluginChild[] }>(
        `plugin-children?q=${encodeURIComponent(search.trim())}`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (!active) return
          setChildren(result.children)
          setKnown((previous) => ({
            ...previous,
            ...Object.fromEntries(result.children.map((child) => [child.id, child])),
          }))
        })
        .catch((failure) => {
          if (active && !isIgnoredError(failure)) setError(errorMessage(failure))
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [request, search, retry, value.scopeMode])

  function toggle(childId: string, checked: boolean) {
    if (disabled) return
    if (
      checked &&
      updating &&
      original.scopeMode === "children" &&
      !original.childIds.includes(childId)
    )
      return
    onChange({
      scopeMode: "children",
      childIds: checked
        ? [...new Set([...value.childIds, childId])]
        : value.childIds.filter((id) => id !== childId),
    })
  }

  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4">
      <legend className="mb-3 text-sm font-medium">开放对象</legend>
      <ToggleGroup
        type="single"
        variant="outline"
        value={value.scopeMode}
        disabled={disabled}
        aria-label="发布范围"
        onValueChange={(mode) => {
          if (mode === "all" && !(updating && original.scopeMode === "children"))
            onChange({ scopeMode: "all", childIds: value.childIds })
          else if (mode === "children") onChange({ ...value, scopeMode: "children" })
        }}
      >
        <ToggleGroupItem
          value="all"
          className="min-h-11"
          disabled={updating && original.scopeMode === "children"}
        >
          全部儿童
        </ToggleGroupItem>
        <ToggleGroupItem value="children" className="min-h-11">
          指定儿童
        </ToggleGroupItem>
      </ToggleGroup>
      <p className="text-caption text-muted-foreground">
        {value.scopeMode === "all"
          ? "全部儿童可发现并安装；不会自动安装或启用。"
          : "仅选中的儿童可发现并安装；已选对象不会因搜索变化而丢失。"}
        {updating ? " 更新期间仅可缩小已保存的开放范围。" : ""}
      </p>
      {value.scopeMode === "children" ? (
        <>
          <FormField
            id={`${id}-search`}
            label="搜索儿童"
            help="可用姓名、负责人或儿童 ID 搜索；重名请核对负责人和 ID。"
          >
            <Input
              type="search"
              value={search}
              placeholder="姓名、负责人或儿童 ID"
              onChange={(event) => setSearch(event.target.value)}
            />
          </FormField>
          <FormFeedback message={error} />
          {error ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 self-start"
              onClick={() => setRetry((value) => value + 1)}
            >
              重新搜索
            </Button>
          ) : null}
          <div aria-busy={loading} className="max-h-64 overflow-y-auto rounded-lg border">
            {loading ? (
              <div role="status" aria-label="正在搜索儿童" className="flex flex-col gap-3 p-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-5 w-1/2" />
              </div>
            ) : children.length ? (
              children.map((child) => (
                <label
                  key={child.id}
                  className="flex min-h-16 cursor-pointer items-center gap-3 border-b px-4 py-3 last:border-b-0"
                >
                  <Checkbox
                    checked={value.childIds.includes(child.id)}
                    disabled={
                      disabled ||
                      (updating &&
                        original.scopeMode === "children" &&
                        !original.childIds.includes(child.id))
                    }
                    onCheckedChange={(checked) => toggle(child.id, checked === true)}
                  />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="break-words font-medium">{child.name}</span>
                    <span className="break-all text-caption text-muted-foreground">
                      负责人：{child.ownerName || "未提供"} · ID：{child.id}
                    </span>
                  </span>
                </label>
              ))
            ) : !error ? (
              <p
                role="status"
                className="flex items-center gap-2 p-4 text-sm text-muted-foreground"
              >
                <Search aria-hidden="true" className="size-4" />
                没有匹配的儿童
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <p role="status" className="text-sm font-medium">
              已选 {value.childIds.length} 位儿童
            </p>
            {value.childIds.length ? (
              <ul className="flex max-h-60 flex-col gap-2 overflow-y-auto">
                {value.childIds.map((childId) => {
                  const child = known[childId]
                  return (
                    <li
                      key={childId}
                      className="flex min-w-0 items-center justify-between gap-3 rounded-lg border p-3"
                    >
                      <span className="min-w-0 break-all text-caption">
                        {child
                          ? `${child.name} · 负责人：${child.ownerName || "未提供"} · `
                          : "已保存儿童 · "}
                        ID：{childId}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-11 shrink-0"
                        disabled={disabled}
                        aria-label={`移除${child?.name || "儿童"}（${childId}）`}
                        onClick={() => toggle(childId, false)}
                      >
                        <X />
                      </Button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-caption text-muted-foreground">请选择至少一位儿童后保存。</p>
            )}
          </div>
        </>
      ) : null}
    </fieldset>
  )
}

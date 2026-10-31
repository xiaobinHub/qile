import { useCallback, useEffect, useRef, useState } from "react"
import { Search, X } from "lucide-react"
import { errorMessage, isIgnoredError } from "@/lib/session"
import { FormFeedback } from "@shared/components/form-feedback"
import { Button } from "@shared/components/ui/button"
import { Checkbox } from "@shared/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@shared/components/ui/dialog"
import { Input } from "@shared/components/ui/input"
import { Label } from "@shared/components/ui/label"
import { Skeleton } from "@shared/components/ui/skeleton"
import { ChildScopeTable } from "./child-scope-table"
import type { PluginRequest } from "./client"
import type { PluginChild } from "./types"

type Page = { children: PluginChild[]; nextCursor: string | null }
export function ChildSelectionDialog({
  open,
  onOpenChange,
  selectedIds,
  allowedIds,
  disabled,
  request,
  onConfirm,
  returnFocusId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedIds: string[]
  allowedIds?: string[]
  disabled: boolean
  request: PluginRequest
  onConfirm: (children: PluginChild[]) => void
  returnFocusId: string
}) {
  const [search, setSearch] = useState("")
  const [data, setData] = useState<Page>({ children: [], nextCursor: null })
  const [picked, setPicked] = useState<Record<string, PluginChild>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  const read = useRef<AbortController | null>(null)
  const query = search.trim()
  const currentKey = useRef<string | null>(null)
  currentKey.current = open ? query : null
  const selected = new Set(selectedIds)
  const allowed = allowedIds ? new Set(allowedIds) : null
  const additions = Object.values(picked).filter((child) => !selected.has(child.id))
  const permitted = (id: string) => !allowed || allowed.has(id)

  const load = useCallback(
    async (cursor?: string) => {
      if (currentKey.current !== query) return
      read.current?.abort()
      const controller = new AbortController()
      read.current = controller
      setLoading(true)
      setError("")
      try {
        const params = new URLSearchParams({ q: query })
        if (cursor) params.set("cursor", cursor)
        const result = await request<Page>(
          `plugin-children?${params}`,
          "GET",
          undefined,
          controller.signal,
        )
        if (controller.signal.aborted || currentKey.current !== query) return
        if (!Array.isArray(result.children)) throw new Error("儿童列表返回格式不正确，请重试。")
        setData((previous) => ({
          children: cursor
            ? [
                ...new Map(
                  [...previous.children, ...result.children].map((child) => [child.id, child]),
                ).values(),
              ]
            : result.children,
          nextCursor: result.nextCursor,
        }))
      } catch (failure) {
        if (!controller.signal.aborted && currentKey.current === query && !isIgnoredError(failure))
          setError(errorMessage(failure))
      } finally {
        if (
          !controller.signal.aborted &&
          read.current === controller &&
          currentKey.current === query
        )
          setLoading(false)
      }
    },
    [query, request],
  )

  useEffect(() => {
    if (!open) return
    setData({ children: [], nextCursor: null })
    setLoading(true)
    const timer = window.setTimeout(() => void load(), 250)
    return () => {
      window.clearTimeout(timer)
      read.current?.abort()
    }
  }, [open, load, retry])

  function changeOpen(next: boolean) {
    read.current?.abort()
    setSearch("")
    setPicked({})
    setData({ children: [], nextCursor: null })
    setError("")
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className="ui-modal-frame admin-dialog scope-child-dialog"
        data-modal-size="complex"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          document.getElementById(returnFocusId + "-search")?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const trigger = document.getElementById(returnFocusId) as HTMLButtonElement | null
          const target =
            trigger && !trigger.disabled
              ? trigger
              : document.querySelector<HTMLElement>(".plugin-detail-header button:not(:disabled)")
          target?.focus()
        }}
      >
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-4 right-4"
            aria-label="关闭"
          >
            <X aria-hidden />
          </Button>
        </DialogClose>
        <DialogHeader className="ui-modal-header text-left">
          <DialogTitle>添加儿童</DialogTitle>
          <DialogDescription>勾选要添加的儿童，确定后加入已指定列表。</DialogDescription>
        </DialogHeader>
        <div className="scope-child-search">
          <Label htmlFor={returnFocusId + "-search"}>搜索儿童昵称</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={returnFocusId + "-search"}
              type="search"
              className="pl-9"
              placeholder="输入儿童昵称"
              value={search}
              onChange={(event) => {
                read.current?.abort()
                setSearch(event.target.value)
                setData({ children: [], nextCursor: null })
                setLoading(true)
              }}
            />
          </div>
        </div>
        <div
          className="ui-modal-body scope-child-results"
          role="region"
          aria-label="儿童搜索结果"
          tabIndex={0}
          aria-busy={loading}
        >
          <FormFeedback message={error} />
          {error && (
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() =>
                data.nextCursor ? void load(data.nextCursor) : setRetry((value) => value + 1)
              }
            >
              重试读取
            </Button>
          )}
          {loading && !data.children.length ? (
            <div role="status" aria-label="正在读取儿童列表" className="flex flex-col gap-3">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : data.children.length ? (
            <ChildScopeTable
              children={data.children}
              label="可选儿童列表"
              actionLabel="选择"
              actionPosition="first"
              emptyMessage="没有匹配的儿童"
              renderAction={(child) => {
                const existing = selected.has(child.id)
                return (
                  <Checkbox
                    aria-label={`选择${child.name}（${child.ownerName || "未提供"}，${child.id}）`}
                    title={existing ? "已在指定名单中" : `选择${child.name}`}
                    checked={existing || !!picked[child.id]}
                    disabled={disabled || existing || !permitted(child.id)}
                    onCheckedChange={(checked) => {
                      if (disabled || existing || !permitted(child.id)) return
                      setPicked((previous) => {
                        const next = { ...previous }
                        if (checked === true) next[child.id] = child
                        else delete next[child.id]
                        return next
                      })
                    }}
                  />
                )
              }}
            />
          ) : (
            !error && (
              <p role="status" className="scope-child-empty">
                没有匹配的儿童
              </p>
            )
          )}
          {data.nextCursor && (
            <Button
              type="button"
              variant="outline"
              className="mt-3 w-full"
              disabled={loading}
              onClick={() => void load(data.nextCursor!)}
            >
              {loading ? "正在加载…" : "加载更多儿童"}
            </Button>
          )}
        </div>
        <DialogFooter className="ui-modal-footer scope-child-footer">
          <p role="status" className="text-caption text-muted-foreground">
            已勾选 {additions.length} 位新儿童
          </p>
          <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={
              disabled || !additions.length || additions.some((child) => !permitted(child.id))
            }
            onClick={() => {
              if (disabled || !additions.length || additions.some((child) => !permitted(child.id)))
                return
              onConfirm(additions)
              changeOpen(false)
            }}
          >
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

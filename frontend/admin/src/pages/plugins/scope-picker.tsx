import { useEffect, useId, useState } from "react"
import { Plus, Search } from "lucide-react"
import { Button } from "@shared/components/ui/button"
import { Input } from "@shared/components/ui/input"
import { ChildScopeTable } from "./child-scope-table"
import { ChildSelectionDialog } from "./child-selection-dialog"
import type { PluginRequest } from "./client"
import type { PluginChild, PluginScope } from "./types"

export function ScopePicker({
  value,
  original,
  selectedChildren = [],
  updating,
  disabled,
  request,
  onChange,
}: {
  value: PluginScope
  original: PluginScope
  selectedChildren?: PluginChild[]
  updating: boolean
  disabled: boolean
  request: PluginRequest
  onChange: (scope: PluginScope) => void
}) {
  const id = useId()
  const [adding, setAdding] = useState(false)
  const [selectedSearch, setSelectedSearch] = useState("")
  const [known, setKnown] = useState<Record<string, PluginChild>>({})
  const saved = Object.fromEntries(selectedChildren.map((child) => [child.id, child]))
  const restricted = updating && original.scopeMode === "children"
  useEffect(() => {
    if (value.scopeMode !== "children") {
      setAdding(false)
      setSelectedSearch("")
    }
  }, [value.scopeMode])
  const allSelected = value.childIds.map(
    (childId) =>
      saved[childId] ||
      known[childId] || { id: childId, name: "儿童资料暂不可用", ownerName: "未提供" },
  )
  const selectedQuery = selectedSearch.trim().toLocaleLowerCase()
  const visibleSelected = allSelected.filter(
    (child) => !selectedQuery || child.name.toLocaleLowerCase().includes(selectedQuery),
  )
  return (
    <div className="plugin-scope-picker">
      <fieldset disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">开放范围</legend>
        <div className="plugin-scope-modes">
          <label>
            <input
              type="radio"
              name={id + "-mode"}
              value="all"
              checked={value.scopeMode === "all"}
              disabled={restricted}
              onChange={() => {
                if (!disabled && !restricted) {
                  setAdding(false)
                  onChange({ scopeMode: "all", childIds: value.childIds })
                }
              }}
            />
            全部儿童
          </label>
          <label>
            <input
              type="radio"
              name={id + "-mode"}
              value="children"
              checked={value.scopeMode === "children"}
              onChange={() => {
                if (!disabled) onChange({ ...value, scopeMode: "children" })
              }}
            />
            指定儿童
          </label>
        </div>
      </fieldset>
      {updating && (
        <p className="text-caption text-muted-foreground">更新期间仅可缩小已保存的开放范围。</p>
      )}
      {value.scopeMode === "children" && (
        <section aria-label="已指定儿童" className="scope-selected-section">
          <div className="scope-selected-heading">
            <h3>
              已指定儿童 <span>{value.childIds.length}</span>
            </h3>
            <div className="scope-selected-tools">
              <div className="scope-selected-search relative">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="search"
                  aria-label="搜索已指定儿童名称"
                  placeholder="搜索儿童名称"
                  className="pl-9"
                  maxLength={80}
                  value={selectedSearch}
                  onChange={(event) => setSelectedSearch(event.target.value)}
                />
              </div>
              <Button
                id={id + "-add"}
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => setAdding(true)}
              >
                <Plus data-icon="inline-start" />
                添加儿童
              </Button>
            </div>
          </div>
          <div
            className="scope-child-table-scroll"
            role="region"
            aria-label="已指定儿童表格"
            tabIndex={0}
          >
            <ChildScopeTable
              children={visibleSelected}
              label="已指定儿童列表"
              actionLabel="操作"
              emptyMessage={
                value.childIds.length && selectedQuery ? "没有匹配的儿童" : "未指定儿童"
              }
              renderAction={(child) => (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`移除${child.name}（${child.id}）`}
                  onClick={() => {
                    if (!disabled)
                      onChange({
                        scopeMode: "children",
                        childIds: value.childIds.filter((id) => id !== child.id),
                      })
                  }}
                >
                  移除
                </Button>
              )}
            />
          </div>
          <ChildSelectionDialog
            open={adding}
            onOpenChange={setAdding}
            selectedIds={value.childIds}
            allowedIds={restricted ? original.childIds : undefined}
            disabled={disabled}
            request={request}
            returnFocusId={id + "-add"}
            onConfirm={(children) => {
              if (disabled) return
              const permitted = children.filter(
                (child) => !restricted || original.childIds.includes(child.id),
              )
              setKnown((previous) => ({
                ...previous,
                ...Object.fromEntries(permitted.map((child) => [child.id, child])),
              }))
              onChange({
                scopeMode: "children",
                childIds: [...new Set([...value.childIds, ...permitted.map((child) => child.id)])],
              })
            }}
          />
        </section>
      )}
    </div>
  )
}

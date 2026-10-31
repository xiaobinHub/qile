import type { ReactNode } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@shared/components/ui/table"
import type { PluginChild } from "./types"

export function ChildScopeTable({
  children,
  label,
  actionLabel,
  emptyMessage,
  renderAction,
  actionPosition = "last",
}: {
  children: PluginChild[]
  label: string
  actionLabel: string
  emptyMessage: string
  renderAction: (child: PluginChild) => ReactNode
  actionPosition?: "first" | "last"
}) {
  return (
    <div className="scope-child-table">
      <Table aria-label={label} className="table-fixed">
        <TableHeader>
          <TableRow>
            {actionPosition === "first" && (
              <TableHead className="w-20 text-center">{actionLabel}</TableHead>
            )}
            <TableHead className="scope-child-name-column">儿童昵称</TableHead>
            <TableHead className="scope-child-id-column">儿童 ID</TableHead>
            <TableHead>管理员</TableHead>
            {actionPosition === "last" && (
              <TableHead className="w-20 text-center">{actionLabel}</TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {children.length ? (
            children.map((child) => (
              <TableRow key={child.id} data-child-id={child.id}>
                {actionPosition === "first" && (
                  <TableCell>
                    <div className="flex items-center justify-center">{renderAction(child)}</div>
                  </TableCell>
                )}
                <TableCell>
                  <span
                    className="block truncate font-medium"
                    data-child-name
                    title={`${child.name} · ${child.id}`}
                  >
                    {child.name}
                  </span>
                </TableCell>
                <TableCell className="scope-child-id">
                  <span>{child.id}</span>
                </TableCell>
                <TableCell>
                  <span
                    className="block truncate text-muted-foreground"
                    title={child.ownerName || "未提供"}
                  >
                    {child.ownerName || "未提供"}
                  </span>
                </TableCell>
                {actionPosition === "last" && (
                  <TableCell>
                    <div className="flex items-center justify-center">{renderAction(child)}</div>
                  </TableCell>
                )}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={4} className="scope-child-table-empty">
                <span role="status">{emptyMessage}</span>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

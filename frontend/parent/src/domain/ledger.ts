import type { Ledger } from "./types"

export const ledgerSource = (row: Ledger) =>
  row.kind.startsWith("gift-") ? "gift" : row.kind === "manual" ? "manual" : "task"

export const ledgerAction = (row: Ledger) =>
  row.kind === "manual" ? (row.amount < 0 ? "manual-minus" : "manual-plus") : row.kind

export const ledgerActionOptions = [
  { value: "task-complete", label: "完成任务", source: "task" },
  { value: "task-reversal", label: "撤销完成", source: "task" },
  { value: "gift-redeem", label: "兑换礼品", source: "gift" },
  { value: "gift-reversal", label: "撤销兑换", source: "gift" },
  { value: "manual-minus", label: "手动扣减", source: "manual" },
  { value: "manual-plus", label: "手动增加", source: "manual" },
]

export const ledgerActionsForSource = (source: string) =>
  ledgerActionOptions.filter((option) => source === "all" || option.source === source)

export const retainLedgerActions = (actions: string[], source: string) =>
  ledgerActionsForSource(source)
    .filter((option) => actions.includes(option.value))
    .map((option) => option.value)

export const ledgerActionLabel = (row: Ledger) =>
  ledgerActionOptions.find((option) => option.value === ledgerAction(row))!.label

export type LedgerFilters = {
  from?: string
  to?: string
  source?: string
  actions?: string[]
}

export function ledgerView(ledger: Ledger[], filters: LedgerFilters = {}) {
  const chronological = [...ledger].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const earnings = new Map<string, number>()
  const completions = new Map<string, Ledger[]>()
  // Cancel the original earning even when its reversal is outside the current filters.
  for (const row of chronological) {
    if (row.kind === "task-complete") {
      earnings.set(row.id, Math.max(0, row.amount))
      if (row.occurrenceKey) {
        const stack = completions.get(row.occurrenceKey) || []
        stack.push(row)
        completions.set(row.occurrenceKey, stack)
      }
    } else if (row.kind === "task-reversal") {
      let remaining = Math.max(0, -row.amount)
      const stack = row.occurrenceKey ? completions.get(row.occurrenceKey) : undefined
      while (stack?.length && remaining > 0) {
        const original = stack[stack.length - 1]
        const amount = earnings.get(original.id) || 0
        const cancelled = Math.min(amount, remaining)
        earnings.set(original.id, amount - cancelled)
        remaining -= cancelled
        if (amount === cancelled) stack.pop()
      }
    }
  }
  let running = 0
  const rows = chronological
    .map((row) => ({ ...row, balanceAfter: (running += row.amount) }))
    .filter(
      (row) =>
        (!filters.from || row.date >= filters.from) &&
        (!filters.to || row.date <= filters.to) &&
        (!filters.source || filters.source === "all" || ledgerSource(row) === filters.source) &&
        (!filters.actions?.length || filters.actions.includes(ledgerAction(row))),
    )
    .reverse()
  return {
    rows,
    earned: rows.reduce((sum, row) => sum + (earnings.get(row.id) || 0), 0),
    deducted: rows.reduce(
      (sum, row) =>
        sum +
        ((row.kind === "manual" || row.kind === "gift-redeem") && row.amount < 0 ? row.amount : 0),
      0,
    ),
  }
}

/** Only show a task date explicitly returned from the database. */
export function ledgerTaskDate(row: Ledger): string | null {
  if (row.kind !== "task-complete" && row.kind !== "task-reversal") return null
  const candidate = row.taskDate
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null
  const date = new Date(candidate + "T12:00:00Z")
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === candidate
    ? candidate
    : null
}

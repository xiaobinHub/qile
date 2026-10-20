export type Rule = {
  freq: "daily" | "weekly" | "monthly"
  interval: number
  weekdays?: number[]
  monthDay?: number
  endType: "never" | "until" | "count"
  until?: string
  count?: number
}
export type Task = {
  title: string
  note: string
  startDate: string
  startTime: string
  endTime: string
  categoryId: string
  points: number
  recurrence: Rule | null
}
export type Revision = Omit<Task, "startDate"> & { id: string; effectiveFrom: string }
export type Series = Task & {
  id: string
  revisions?: Revision[] | null
  createdAt?: string
  updatedAt?: string
}
export type Occurrence = {
  seriesId: string
  occurrenceKey: string
  date: string
  originalDate: string
  title: string
  note: string
  startTime: string
  endTime: string
  categoryId: string
  points: number
  recurring: boolean
}
export type Category = { id: string; name: string; color: string; active: boolean }
export type Preset = Omit<Task, "note" | "startDate" | "recurrence"> & { id: string }
export type Gift = {
  id: string
  name: string
  points: number
  imageData?: string | null
  status: "available" | "redeemed"
  createdAt: string
  updatedAt: string
  redeemedAt?: string | null
  redemptionLedgerId?: string | null
}
export type Ledger = {
  id: string
  kind: "task-complete" | "task-reversal" | "manual" | "gift-redeem" | "gift-reversal"
  amount: number
  date: string
  createdAt: string
  occurrenceKey?: string
  giftId?: string
  relatedLedgerId?: string
  giftSnapshot?: { name: string; points: number }
  reason?: string
  source?: string
}
export type BusinessData = {
  schemaVersion: number
  settings: { childName: string; weekStartsOn: number; [key: string]: unknown }
  categories: Category[]
  series: Series[]
  exceptions: {
    id?: string
    seriesId: string
    originalDate: string
    action: "cancel" | "override"
    data?: Occurrence
  }[]
  completions: {
    occurrenceKey: string
    completed: boolean
    snapshot: Occurrence
    updatedAt?: string
  }[]
  ledger: Ledger[]
  gifts: Gift[]
  taskPresets: Preset[]
  operationLog: unknown[]
  [key: string]: unknown
}
export type User = {
  id: string
  nickname: string
  loginName: string
  role?: string
  mustChangePassword?: boolean
}
export type Child = {
  id: string
  name: string
  role: "owner" | "parent"
  archived: boolean
  membershipVersion: number
}
export type DataPackage = {
  format: string
  version: number
  revision: number
  updatedAt: string | null
  context: { childId: string; membershipVersion: number }
  data: BusinessData
}

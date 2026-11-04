export type PluginContext = {
  child: { id: string; name: string }
  releaseId: string
  signal: AbortSignal
  api<T>(
    path: string,
    options?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
  ): Promise<T>
  notify(message: string): void
  navigateCore(view: "calendar" | "store" | "settings"): void
}

export type Connection = {
  status: "unbound" | "connected" | "reconnect_required" | "unavailable"
  bindingRevision: number
  maskedAccount: string | null
  contract: null | { id: string; name: string; courseName: string }
  canManageConnection: boolean
  lastCheckedAt: string | null
}

export type Teacher = {
  id: string
  name: string
  intro: string
  avatarUrl: string | null
  labels: { id: string; name: string }[]
  favorite: boolean
  favoriteAvailable?: boolean
  recommended: boolean
  nextAvailable: null | { date: string; time: string }
  lessonMinutes: number | null
}

export type TeacherQuery = {
  queryId: string
  items: Teacher[]
  nextCursor: string | null
  complete: boolean
  total: number | null
  fetchedAt: string
}

export type TeacherSchedule = {
  teacher: Teacher
  date: string
  baseDate: string
  days: { date: string; available: boolean }[]
  lessonMinutes: number
  slotStepMinutes: number
  slots: {
    start: string
    end: string
    state: "available" | "mine" | "occupied" | "unscheduled"
    reason: string | null
  }[]
}

export type Courseware = {
  source?: "category" | "unlearned"
  id: string
  title: string
  categoryName: string
  learned: boolean | null
  active: boolean
  selectedElsewhere: boolean
  previewAvailable: boolean
}

export type Draft = {
  id: string
  revision: number
  teacher: Pick<Teacher, "id" | "name" | "avatarUrl">
  date: string
  lastLearned: null | { id: string; title: string; categoryName: string }
  lessons: {
    start: string
    end: string
    courseware: Courseware | null
    origin: "recommended" | "manual" | "unlearned"
  }[]
  quota: null | { remaining: number; total: number }
  valid: boolean
  issues: { code: string; slotStart?: string; message: string }[]
  expiresAt: string | null
}

export type Booking = {
  key: string
  cid: string | null
  teacher: { id: string | null; name: string; avatarUrl: string | null }
  courseware: { id: string; title: string; categoryName: string } | null
  status: "upcoming" | "completed" | "cancelled"
  startsAt: string | null
  timeLabel: string
  snapshotVersion: string
  actions: Record<string, { allowed: boolean; mode: string; reason: string | null }>
}

export type BookingQuery = {
  queryId: string
  state: "building" | "ready"
  items: Booking[]
  nextCursor: string | null
  total: number | null
  sourceComplete: boolean
}

export type Bootstrap = {
  unresolvedOperations?: Operation[]
  connection: Connection
  serverDate: string
  upcomingCount: number | null
  readError?: string | null
  bookingLimits: { maxContiguousLessons: number | null }
  features: Record<string, { mode: string; reason: string | null }>
}

export type TeacherFilters = {
  labelGroups: { id: string; name: string; labels: { id: string; name: string }[] }[]
  timeSlots: string[]
}
export type Resource = {
  id: string
  title: string
  action: "inline" | "download" | "external" | "instructions" | "unavailable"
  url: string | null
  mimeType: string | null
  instructions: string | null
  reason: string | null
}
export type TeacherProfile = Teacher & { introVideo: Resource | null }
export type Category = { id: string; name: string; children: Category[] }
export type Operation = {
  operationId: string
  kind?: "book" | "preview" | "cancel" | "change-draft" | "favorite"
  state:
    | "prepared"
    | "dispatching"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "partially_succeeded"
    | "needs_repair"
    | "cancelled"
  message: string
  stageVersion: number
  canReconcile?: boolean
  canRepair?: boolean
  result: null | {
    teacherId?: string
    favorite?: boolean
    draft?: Draft
    resource?: Resource
    quota?: Draft["quota"]
    bookingKeys?: string[]
    pendingRecordSync?: boolean
    lessons?: { start: string; coursewareTitle: string; state: string }[]
  }
}
export type PendingConnection = {
  pendingConnectionId: string
  state: "discovering" | "choose-contract"
  candidates: {
    key: string
    name: string
    courseName: string
    eligible: boolean
    reason: string | null
  }[]
}

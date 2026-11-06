// Test-only Mison HTTP fixtures. Loaded by the browser acceptance runner, never by the plugin.
import type {
  Booking,
  Bootstrap,
  Courseware,
  Draft,
  Operation,
  PluginContext,
  Teacher,
} from "../../../plugins/mison-booking/frontend/types"
export function createFixtureContext(): PluginContext {
  const names = ["Jenyy", "Lewis", "Rina", "Sarah", "David", "Emma"]
  const intros = [
    "擅长通过情境对话激发孩子开口，课堂轻松有趣，注重表达自信。",
    "课堂氛围轻松，善于引导孩子用英语思考。",
    "耐心细致，擅长根据孩子兴趣设计互动内容，帮助提升英语应用能力。",
    "课堂生动有趣，善于用游戏和话题引导孩子开口。",
    "注重发音练习与情境表达，引导孩子在真实语境中自信交流。",
    "善于结合绘本和生活场景开展教学，鼓励孩子积极表达。",
  ]
  const teachers: Teacher[] = names.map((name, i) => ({
    id: `demo-${i}`,
    name,
    intro: intros[i],
    avatarUrl: i === 0 ? "mison-image:" + "a".repeat(64) : null,
    labels: [
      { id: "kids", name: "少儿" },
      { id: i % 2 ? "reading" : "speaking", name: i % 2 ? "阅读引导" : "口语互动" },
    ],
    favorite: i === 0 || i === 3,
    recommended: false,
    nextAvailable: { date: "2026-11-04", time: "10:00" },
    lessonMinutes: 25,
  }))
  const courses: Courseware[] = Array.from({ length: 24 }, (_, i) => ({
    id: `course-${i}`,
    title: `PU${String(27 + i).padStart(3, "0")} U3 ${i < 2 ? "Food shopping" : "At home"} L${7 + i} ${i % 2 ? "复习" : "故事"}`,
    categoryName: "剑桥英语 / Power up starter",
    learned: i === 0,
    active: true,
    selectedElsewhere: false,
    previewAvailable: true,
  }))
  const drafts = new Map<string, Draft>(),
    operations = new Map<string, Operation>()
  const bookings: Booking[] = [0, 1, 2].map((i) => ({
    key: `booking-${i}`,
    cid: String(i),
    teacher: teachers[i === 2 ? 2 : 0],
    courseware: courses[i],
    status: "upcoming",
    startsAt: `2026-11-${i === 2 ? "06" : "04"}T${i === 2 ? "18:00" : i === 1 ? "10:30" : "10:00"}:00+08:00`,
    timeLabel: i === 2 ? "18:00–18:25" : i === 1 ? "10:30–10:55" : "10:00–10:25",
    snapshotVersion: "1",
    actions: Object.fromEntries(
      ["cancel", "materials", "classroom", "homework", "replay"].map((name) => [
        name,
        { allowed: name !== "homework" && name !== "replay", mode: "native", reason: null },
      ]),
    ),
  }))
  bookings.push({
    ...bookings[0],
    key: "past",
    status: "completed",
    startsAt: "2026-11-01T10:00:00+08:00",
    actions: {
      materials: { allowed: true, mode: "native", reason: null },
      replay: { allowed: true, mode: "official-app", reason: null },
      homework: { allowed: true, mode: "official-app", reason: null },
    },
  })
  bookings.push({
    ...bookings[0],
    key: "cancelled",
    status: "cancelled",
    startsAt: "2026-10-28T10:00:00+08:00",
    actions: {},
  })
  const quota = { remaining: 0, total: 5 }
  const controller = new AbortController()
  const bootstrap: Bootstrap = {
    connection: {
      status: "connected",
      bindingRevision: 1,
      maskedAccount: "138****0000",
      contract: { id: "demo", name: "少儿英语一对一", courseName: "少儿英语" },
      canManageConnection: true,
      lastCheckedAt: null,
    },
    serverDate: "2026-11-02",
    upcomingCount: 3,
    bookingLimits: { maxContiguousLessons: 6 },
    features: Object.fromEntries(
      ["book", "preview", "changeCourseware"].map((name) => [
        name,
        { mode: "native", reason: null },
      ]),
    ),
  }
  function lesson(start: string, i: number) {
    const n = Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) + 25
    return {
      start,
      end: `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`,
      courseware: courses[i],
      origin: "recommended" as const,
    }
  }
  const resource = {
    id: "demo-resource",
    title: "课程资料",
    action: "instructions" as const,
    url: null,
    mimeType: null,
    instructions: "这是独立的界面演示。实际资料由美森接口提供，此处不会打开真实课堂或扣除额度。",
    reason: null,
  }
  function successOperation(id: string, result: Operation["result"]) {
    const old = operations.get(id)
    if (old) return old
    const operation: Operation = {
      operationId: id,
      state: "succeeded",
      stageVersion: 1,
      message: "演示操作完成",
      result,
    }
    operations.set(id, operation)
    return operation
  }
  const context: PluginContext = {
    child: { id: "demo-child", name: "乐乐" },
    releaseId: "design-preview",
    signal: controller.signal,
    overlay: (globalThis.document?.createElement("div") ?? {}) as HTMLElement,
    isActive: () => true,
    onVisibility: () => () => {},
    notify() {},
    navigateCore() {},
    async api<T>(relative: string, options?: { method?: string; body?: unknown }): Promise<T> {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const url = new URL(relative, "https://preview.invalid/")
      const path = decodeURIComponent(url.pathname.slice(1)),
        method = options?.method ?? "GET"
      const body = (options?.body ?? {}) as Record<string, any>
      let data: unknown
      if (body.operationId && operations.has(body.operationId))
        return { ok: true, data: operations.get(body.operationId) } as T
      if (path === "bootstrap")
        data = {
          ...bootstrap,
          upcomingCount: bookings.filter((b) => b.status === "upcoming").length,
        }
      else if (path.startsWith("resources/images/"))
        data = {
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        }
      else if (path === "teacher-filters")
        data = {
          labelGroups: [
            {
              id: "style",
              name: "授课风格",
              labels: [
                { id: "speaking", name: "口语互动" },
                { id: "reading", name: "阅读引导" },
              ],
            },
          ],
          timeSlots: Array.from(
            { length: 24 },
            (_, i) => `${String(9 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
          ),
        }
      else if (path === "teachers") {
        const items = teachers.filter(
          (t) =>
            (!url.searchParams.get("favoritesOnly") || t.favorite) &&
            t.name.toLowerCase().includes((url.searchParams.get("nickname") ?? "").toLowerCase()) &&
            (!url.searchParams.get("labelIds") ||
              url.searchParams
                .get("labelIds")!
                .split(",")
                .every((id) => t.labels.some((l) => l.id === id))),
        )
        data = {
          queryId: "demo-query",
          items,
          total: items.length,
          complete: true,
          nextCursor: null,
        }
      } else if (/^teachers\/[^/]+\/favorite$/.test(path)) {
        const t = teachers.find((t) => t.id === path.split("/")[1])!
        t.favorite = body.favorite
        data = { teacherId: t.id, favorite: t.favorite }
      } else if (/^teachers\/[^/]+\/schedule$/.test(path)) {
        const t = teachers.find((t) => t.id === path.split("/")[1])!,
          date = url.searchParams.get("date") ?? "2026-11-04"
        data = {
          teacher: t,
          date,
          baseDate: "2026-11-02",
          days: Array.from({ length: 17 }, (_, i) => ({
            date: `2026-11-${String(i + 2).padStart(2, "0")}`,
            available: i !== 3,
          })),
          lessonMinutes: 25,
          slotStepMinutes: 30,
          slots: Array.from({ length: 24 }, (_, i) => {
            const start = `${String(9 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`
            return {
              ...lesson(start, i),
              state:
                i === 18
                  ? "mine"
                  : [0, 5, 8, 12, 17, 20].includes(i) || date === "2026-11-05"
                    ? "occupied"
                    : "available",
              reason: null,
            }
          }),
        }
      } else if (/^teachers\/[^/]+$/.test(path))
        data = {
          ...teachers.find((t) => t.id === path.split("/")[1]),
          introVideo: {
            id: "fixture-intro",
            title: "老师介绍视频",
            action: "inline",
            url: "/api/children/a/plugins/mison-booking/media/fixture-video",
            mimeType: "video/mp4",
            instructions: null,
            reason: null,
          },
        }
      else if (path === "drafts" || /^drafts\/[^/]+\/slots$/.test(path)) {
        const old = drafts.get(path.split("/")[1]),
          id = old?.id ?? crypto.randomUUID()
        const draft: Draft = {
          id,
          revision: (old?.revision ?? 0) + 1,
          teacher: old?.teacher ?? teachers.find((t) => t.id === body.teacherId)!,
          date: old?.date ?? body.date,
          lastLearned: {
            id: "last",
            title: "PU026 U3 Food shopping L6",
            categoryName: "Power up starter",
          },
          lessons: body.slotStarts.map(
            (start: string, i: number) =>
              old?.lessons.find((l) => l.start === start) ?? lesson(start, i),
          ),
          quota: { ...quota },
          valid: true,
          issues: [],
          expiresAt: "2099-01-01T00:00:00+08:00",
        }
        drafts.set(id, draft)
        data = draft
      } else if (path === "courseware/categories")
        data = {
          nodes: [
            {
              id: "cambridge",
              name: "剑桥英语",
              children: [
                { id: "starter", name: "Power up starter", children: [] },
                { id: "power1", name: "Power up 1", children: [] },
              ],
            },
          ],
        }
      else if (path === "courseware")
        data = { items: courses, total: courses.length, nextCursor: null }
      else if (/^drafts\/[^/]+\/lessons\//.test(path)) {
        const d = drafts.get(path.split("/")[1])!
        const course = courses.find((c) => c.id === body.coursewareId)!
        const next = {
          ...d,
          revision: d.revision + 1,
          quota: { ...quota },
          lessons: d.lessons.map((l) =>
            l.start === path.split("/")[3]
              ? { ...l, courseware: course, origin: "manual" as const }
              : l,
          ),
        }
        drafts.set(d.id, next)
        data = successOperation(body.operationId, { draft: next, quota: next.quota })
      } else if (/^courseware\/[^/]+\/preview$/.test(path)) {
        data = successOperation(body.operationId, {
          resource: { ...resource, title: "课件预览" },
        })
      } else if (path === "bookings" && method === "POST") {
        const d = drafts.get(body.draftId)!
        const keys = d.lessons.map((l, i) => {
          const key = `new-${body.operationId}-${i}`
          bookings.push({
            ...bookings[0],
            key,
            teacher: d.teacher,
            courseware: l.courseware,
            startsAt: `${d.date}T${l.start}:00+08:00`,
            timeLabel: `${l.start}–${l.end}`,
          })
          return key
        })
        data = successOperation(body.operationId, { bookingKeys: keys })
      } else if (path === "bookings") {
        const items = bookings
          .filter(
            (b) =>
              b.status === url.searchParams.get("status") &&
              (!url.searchParams.get("from") ||
                b.startsAt?.slice(0, 10) === url.searchParams.get("from")),
          )
          .sort((a, b) =>
            url.searchParams.get("status") === "upcoming"
              ? (a.startsAt ?? "").localeCompare(b.startsAt ?? "")
              : (b.startsAt ?? "").localeCompare(a.startsAt ?? ""),
          )
        data = {
          queryId: "bookings",
          state: "ready",
          items,
          total: items.length,
          sourceComplete: true,
          nextCursor: null,
        }
      } else if (/^bookings\/[^/]+\/cancel$/.test(path)) {
        const b = bookings.find((b) => b.key === path.split("/")[1])!
        b.status = "cancelled"
        data = successOperation(body.operationId, { bookingKeys: [b.key] })
      } else if (path.endsWith("/resources")) data = { items: [resource] }
      else if (path.includes("/actions/")) data = successOperation(body.operationId, { resource })
      else if (path.startsWith("operations/")) data = operations.get(path.split("/")[1])
      else
        return {
          ok: false,
          error: { code: "ACTION_UNAVAILABLE", message: "演示环境不连接真实账号。" },
        } as T
      return structuredClone({
        ok: true,
        data,
        requestId: "preview",
        serverTime: "2026-11-02T10:00:00+08:00",
      }) as T
    },
  }
  return context
}

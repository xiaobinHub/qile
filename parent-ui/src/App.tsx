import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { RefreshCw, ChevronDown, Sprout } from "lucide-react"
import { ToastProvider, useToast } from "@shared/components/ui/toast"
import { Button, Confirm, ErrorText, SaveResolution, Modal } from "./features/ui"
import { Skeleton } from "@shared/components/ui/skeleton"
import { Login, Onboarding, ChildSwitcher } from "./features/account"
import { PasswordSetup } from "./password-setup"
import { SettingsPage } from "./settings"
import type { Controller, User as SettingsUser } from "./settings/types"
import { runtime } from "./lib/runtime"
import type { BusinessData, Occurrence } from "./domain/types"
import { CalendarPage, TaskEditor, PresetEditor, CategoryEditor } from "./features/calendar"
const StorePage = lazy(() => import("./features/store").then((m) => ({ default: m.StorePage })))
const PrintDialog = lazy(() => import("./features/print").then((m) => ({ default: m.PrintDialog })))
import { today } from "./domain/calendar"

type Editor =
  | { type: "task"; date?: string; startTime?: string; endTime?: string; occurrence?: Occurrence }
  | { type: "preset"; id?: string }
  | { type: "category" }
  | { type: "print" }
function Application() {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot),
    { user, child, data } = snapshot
  const { toast } = useToast()
  const [editor, setEditor] = useState<Editor | null>(null),
    [switcher, setSwitcher] = useState(false),
    [logout, setLogout] = useState(false),
    [confirmation, setConfirmation] = useState<{
      title: string
      description: string
      work: () => Promise<unknown>
    } | null>(null)
  const calendarPrefs = useRef({ mode: "month", cursor: today() })
  const printReturnFocus = useRef<HTMLElement | null>(null)
  const notify = (message: string) => toast({ title: message })
  useEffect(() => {
    void runtime.bootstrap()
    const focus = () => {
        void runtime.checkContext()
      },
      pop = () => {
        void runtime.enter()
      },
      timer = setInterval(focus, 30000)
    window.addEventListener("focus", focus)
    document.addEventListener("visibilitychange", focus)
    window.addEventListener("popstate", pop)
    return () => {
      clearInterval(timer)
      window.removeEventListener("focus", focus)
      document.removeEventListener("visibilitychange", focus)
      window.removeEventListener("popstate", pop)
    }
  }, [])
  useEffect(() => {
    setEditor(null)
    setSwitcher(false)
    setConfirmation(null)
    setLogout(false)
    calendarPrefs.current = { mode: "month", cursor: today() }
  }, [snapshot.epoch])
  useEffect(() => {
    if (snapshot.message) notify(snapshot.message)
  }, [snapshot.message])
  const controller = useMemo(() => {
    const controller: Controller = {
      pending: null,
      deps: {
        context: () => {
          const s = runtime.getSnapshot()
          return { child: s.child, user: s.user!, data: s.data, updatedAt: s.updatedAt }
        },
        api: runtime.api,
        show: () => runtime.setView("settings"),
        home: () => {
          void runtime.home()
        },
        forgetChild: runtime.forgetChild,
        selectChild: runtime.selectChild,
        sync: runtime.sync,
        repaint: () => runtime.patch({}),
        updateUser: (u: SettingsUser) =>
          runtime.patch({ user: { ...runtime.getSnapshot().user!, ...u } }),
        toast: notify,
        editPreset: (id) => setEditor({ type: "preset", id }),
        deletePreset: async (id) => {
          setConfirmation({
            title: "删除常用配置？",
            description: "已创建的任务不受影响。",
            work: () => runtime.command("preset.delete", { id }),
          })
        },
        addCategory: () => setEditor({ type: "category" }),
        deleteCategory: (id) =>
          setConfirmation({
            title: "删除任务类型？",
            description: "被任务或历史记录引用的类型将转为停用，历史记录保留。",
            work: () => runtime.command("category.delete", { id }),
          }),
        saveCategory: async (c) => {
          await runtime.command("category.save", {
            category: { id: c.id, name: c.name, color: c.color },
          })
        },
        reorderCategory: async (from, target, after) => {
          const ids = runtime.getSnapshot().data!.categories.map((c) => c.id),
            source = ids.indexOf(from)
          if (source < 0) return
          const [id] = ids.splice(source, 1),
            index = ids.indexOf(target)
          if (index < 0) return
          ids.splice(index + (after ? 1 : 0), 0, id)
          await runtime.command("category.reorder", { ids })
        },
        logout: () => setLogout(true),
        changePassword: runtime.changePassword,
      },
      render: () => {},
      refresh: () => true,
      invalidate: () => {},
      reset: () => {},
      open: () => {},
    }
    return controller
  }, [])
  return (
    <>
      {snapshot.loading ? (
        <div className="app-loading" role="status">
          正在读取成长记录…
        </div>
      ) : !user ? (
        <Login message={snapshot.error || snapshot.message} />
      ) : user.mustChangePassword ? (
        <section className="password-setup-screen">
          <PasswordSetup changePassword={runtime.changePassword} logout={() => setLogout(true)} />
        </section>
      ) : (
        <div className="app">
          <header className="topbar">
            <div className="brand">
              <span className="brand-mark">
                <Sprout aria-hidden />
              </span>
              <div>
                <strong>成长计划</strong>
                <small>今天也向前一小步</small>
              </div>
            </div>
            <nav className="nav" aria-label="主导航">
              {(child ? ["calendar", "store", "settings"] : ["settings"]).map((view) => (
                <Button
                  key={view}
                  data-view={view}
                  variant="navigation"
                  size="navigation"
                  aria-current={snapshot.view === view ? "page" : undefined}
                  onClick={() => runtime.setView(view as "calendar" | "store" | "settings")}
                >
                  {
                    (
                      { calendar: "日历", store: "积分商城", settings: "设置" } as Record<
                        string,
                        string
                      >
                    )[view]
                  }
                </Button>
              ))}
            </nav>
            {child && (
              <>
                <Button
                  id="refreshData"
                  variant="ghost"
                  size="icon"
                  aria-label="刷新数据"
                  disabled={snapshot.busy}
                  onClick={() => {
                    void runtime.refresh().catch((e) => {
                      if (e.kind !== "stale") notify(e.message)
                    })
                  }}
                >
                  <RefreshCw aria-hidden />
                </Button>
                <Button
                  id="openChildrenDialog"
                  disabled={snapshot.busy}
                  variant="ghost"
                  className="child-profile"
                  aria-haspopup="dialog"
                  aria-expanded={switcher}
                  aria-controls="childrenDialog"
                  aria-label={`${child.name}，打开我的孩子`}
                  onClick={() => setSwitcher(true)}
                >
                  <span className="child-avatar" aria-hidden>
                    {Array.from(child.name)[0]}
                  </span>
                  <span className="child-profile-copy">
                    <strong>{child.name}</strong>
                    {child.archived && <small>已归档 · 只读</small>}
                  </span>
                  <ChevronDown aria-hidden />
                </Button>
              </>
            )}
          </header>
          <main id="main">
            {snapshot.unconfirmed && <SaveResolution />}
            {snapshot.error ? (
              <div className="empty-state">
                <h1>暂时无法读取成长记录</h1>
                <ErrorText message={snapshot.error} />
                <Button onClick={() => void runtime.enter()}>重新加载</Button>
              </div>
            ) : snapshot.view === "settings" ? (
              <SettingsPage
                key={`${child?.id || "account"}:${snapshot.epoch}`}
                controller={controller}
              />
            ) : !child ? (
              <Onboarding user={user} controller={controller} />
            ) : (
              data && (
                <>
                  {snapshot.view === "calendar" ? (
                    <CalendarPage
                      key={`${child.id}:${snapshot.epoch}`}
                      prefs={calendarPrefs.current}
                      data={data}
                      child={child}
                      openTask={(options) => setEditor({ type: "task", ...options })}
                      openPrint={(trigger) => {
                        printReturnFocus.current = trigger
                        setEditor({ type: "print" })
                      }}
                    />
                  ) : (
                    <Suspense
                      fallback={
                        <section
                          role="status"
                          aria-label="正在读取积分商城"
                          className="store-loading"
                        >
                          <Skeleton className="h-10 w-48" />
                          <div className="gift-grid">
                            {[0, 1, 2].map((n) => (
                              <Skeleton key={n} className="h-64" />
                            ))}
                          </div>
                        </section>
                      }
                    >
                      <StorePage
                        key={`${child.id}:${snapshot.epoch}`}
                        data={data}
                        child={child}
                        notify={notify}
                      />
                    </Suspense>
                  )}
                </>
              )
            )}
          </main>
        </div>
      )}
      {editor && data && child && (
        <>
          {editor.type === "task" ? (
            <TaskEditor
              key={editor.occurrence?.occurrenceKey || editor.date || "new"}
              data={data}
              child={child}
              {...editor}
              onClose={() => setEditor(null)}
            />
          ) : editor.type === "preset" ? (
            <PresetEditor id={editor.id} data={data} onClose={() => setEditor(null)} />
          ) : editor.type === "category" ? (
            <CategoryEditor onClose={() => setEditor(null)} />
          ) : (
            <Suspense
              fallback={
                <Modal
                  id="printLoadingDialog"
                  title="打印成长计划"
                  returnFocusTo={false}
                  onClose={() => {
                    setEditor(null)
                    requestAnimationFrame(() => printReturnFocus.current?.focus())
                  }}
                >
                  <div role="status" className="print-loading">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-20 w-full" />
                    <p>正在准备打印配置…</p>
                  </div>
                </Modal>
              }
            >
              <PrintDialog
                data={data}
                returnFocusTo={printReturnFocus.current}
                onClose={() => setEditor(null)}
              />
            </Suspense>
          )}
        </>
      )}
      {switcher && child && (
        <ChildSwitcher
          child={child}
          children={snapshot.children}
          onClose={() => setSwitcher(false)}
        />
      )}
      {logout && (
        <Confirm
          title="退出登录？"
          description="退出后需要重新登录才能查看成长记录。"
          label="退出登录"
          id="logoutDialog"
          work={runtime.logout}
          onClose={() => setLogout(false)}
        />
      )}
      {confirmation && <Confirm {...confirmation} onClose={() => setConfirmation(null)} />}
    </>
  )
}
export default function App() {
  return (
    <ToastProvider>
      <Application />
    </ToastProvider>
  )
}

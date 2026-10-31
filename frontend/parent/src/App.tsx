import { ChildAvatar } from "./features/child-avatar"
import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { Menu, Sprout } from "lucide-react"
import { ToastProvider, useToast } from "@shared/components/ui/toast"
import { Button, Confirm, ErrorText, SaveResolution, Modal } from "./features/ui"
import { Skeleton } from "@shared/components/ui/skeleton"
import { Login, Onboarding, ChildSwitcher } from "./features/account"
import { PasswordSetup } from "./password-setup"
import { SettingsPage } from "./settings"
import type { Controller, User as SettingsUser } from "./settings/types"
import { runtime, type View } from "./lib/runtime"
import { hasPageTab, pluginStore, usePlugins } from "./plugins/store"
import { PluginBoundary, PluginPage } from "./plugins/plugin-page"
import type { BusinessData, Occurrence } from "./domain/types"
import { CalendarPage, TaskEditor, PresetEditor, CategoryEditor } from "./features/calendar"
const StorePage = lazy(() => import("./features/store").then((m) => ({ default: m.StorePage })))
const PrintDialog = lazy(() => import("./features/print").then((m) => ({ default: m.PrintDialog })))
import { today } from "./domain/calendar"

type Editor =
  | { type: "task"; date?: string; startTime?: string; endTime?: string; occurrence?: Occurrence }
  | { type: "preset"; id?: string; fromTask?: boolean }
  | { type: "category" }
  | { type: "print" }
function Application() {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot),
    { user, child, data } = snapshot
  const { toast } = useToast()
  const plugins = usePlugins()
  const pluginTabs =
    child && !child.archived && plugins.childId === child.id && plugins.epoch === snapshot.epoch
      ? plugins.plugins
          .filter((plugin) => hasPageTab(plugin, child.id))
          .sort((a, b) => b.sortOrder - a.sortOrder || a.id.localeCompare(b.id))
      : []
  const navigation: { key: string; label: string; view: View }[] = child
    ? [
        { key: "calendar", label: "日历", view: "calendar" },
        { key: "store", label: "积分商城", view: "store" },
        ...pluginTabs.map((plugin) => ({
          key: `plugin:${plugin.id}`,
          label: plugin.name,
          view: { kind: "plugin" as const, pluginId: plugin.id },
        })),
        { key: "settings", label: "设置", view: "settings" },
      ]
    : [{ key: "settings", label: "设置", view: "settings" }]
  const activeViewKey =
    typeof snapshot.view === "object" ? `plugin:${snapshot.view.pluginId}` : snapshot.view
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  useEffect(() => setSettingsMenuOpen(false), [activeViewKey, child?.id])
  const [editor, setEditor] = useState<Editor | null>(null),
    [switcher, setSwitcher] = useState(false),
    [logout, setLogout] = useState(false),
    [quickEditNotice, setQuickEditNotice] = useState(false),
    [confirmation, setConfirmation] = useState<{
      title: string
      description: string
      work: () => Promise<unknown>
    } | null>(null)
  const calendarPrefs = useRef({ mode: "month", cursor: today() })
  const printReturnFocus = useRef<HTMLElement | null>(null)
  const settingsInitialPage = useRef<string | undefined>(undefined)
  const notify = (message: string) => toast({ title: message })
  useEffect(() => pluginStore.start(), [])
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
    setQuickEditNotice(false)
    settingsInitialPage.current = undefined
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
          return {
            child: s.child,
            children: s.children,
            user: s.user!,
            data: s.data,
            updatedAt: s.updatedAt,
          }
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
            {snapshot.view === "settings" && (
              <Button
                id="openSettingsMenu"
                type="button"
                variant="ghost"
                size="icon"
                className="settings-menu-trigger"
                aria-label="打开设置菜单"
                aria-haspopup="dialog"
                aria-controls="settingsMobileNavigation"
                aria-expanded={settingsMenuOpen}
                onClick={() => setSettingsMenuOpen(true)}
              >
                <Menu aria-hidden />
              </Button>
            )}
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
              {navigation.map(({ key, view, label }) => (
                <Button
                  key={key}
                  data-view={key}
                  variant="navigation"
                  size="navigation"
                  aria-current={activeViewKey === key ? "page" : undefined}
                  disabled={typeof view === "object" && !plugins.confirmed}
                  onClick={() => {
                    if (snapshot.quickEditing) {
                      setQuickEditNotice(true)
                      return
                    }
                    settingsInitialPage.current = undefined
                    runtime.setView(view)
                  }}
                >
                  {label}
                </Button>
              ))}
            </nav>
            {child && (
              <>
                <Button
                  id="openChildrenDialog"
                  disabled={snapshot.busy}
                  variant="ghost"
                  className="child-profile"
                  aria-haspopup="dialog"
                  aria-expanded={switcher}
                  aria-controls="childrenDialog"
                  aria-label={`${child.name}，打开我的孩子`}
                  onClick={() => {
                    if (snapshot.quickEditing) {
                      setQuickEditNotice(true)
                      return
                    }
                    setSwitcher(true)
                  }}
                >
                  <span className="child-avatar" aria-hidden>
                    <ChildAvatar id={child.avatarId} />
                  </span>
                  <span className="child-profile-copy">
                    <strong>{child.name}</strong>
                    {child.archived && <small>已归档 · 只读</small>}
                  </span>
                </Button>
              </>
            )}
          </header>
          <main id="main">
            {child && !plugins.confirmed && plugins.error && (
              <div className="plugin-status-notice" role="status">
                <p>应用状态暂未确认，插件操作已暂停。</p>
                <Button variant="outline" onClick={() => void pluginStore.refresh()}>
                  刷新应用状态
                </Button>
              </div>
            )}
            {snapshot.unconfirmed && !snapshot.quickEditing && <SaveResolution />}
            {snapshot.error ? (
              <div className="empty-state">
                <h1>暂时无法读取成长记录</h1>
                <ErrorText message={snapshot.error} />
                <Button onClick={() => void runtime.enter()}>重新加载</Button>
              </div>
            ) : snapshot.view === "settings" ? (
              <SettingsPage
                menuOpen={settingsMenuOpen}
                onMenuOpenChange={setSettingsMenuOpen}
                key={`${child?.id || "account"}:${snapshot.epoch}`}
                controller={controller}
                initialPage={settingsInitialPage.current}
              />
            ) : !child ? (
              <Onboarding user={user} controller={controller} />
            ) : typeof snapshot.view === "object" ? (
              <PluginBoundary key={`${child.id}:${snapshot.epoch}:${snapshot.view.pluginId}`}>
                <PluginPage
                  child={child}
                  epoch={snapshot.epoch}
                  pluginId={snapshot.view.pluginId}
                  notify={notify}
                  openSettings={() => {
                    settingsInitialPage.current = "applications"
                    runtime.setView("settings")
                  }}
                />
              </PluginBoundary>
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
      {quickEditNotice && (
        <Modal
          id="quickEditNoticeDialog"
          title="快捷编辑中"
          description="请先退出快捷编辑模式，点击底部的保存或取消按钮。"
          size="small"
          onClose={() => setQuickEditNotice(false)}
          footer={
            <Button type="button" onClick={() => setQuickEditNotice(false)}>
              知道了
            </Button>
          }
        >
        </Modal>
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
              onCreatePreset={() => {
                settingsInitialPage.current = "tasks/presets"
                runtime.setView("settings")
                setEditor({ type: "preset", fromTask: true })
              }}
            />
          ) : editor.type === "preset" ? (
            <PresetEditor
              id={editor.id}
              data={data}
              onClose={() => {
                setEditor(null)
                if (editor.fromTask)
                  requestAnimationFrame(() =>
                    document.getElementById("settingsAddPreset")?.focus({ preventScroll: true }),
                  )
              }}
            />
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

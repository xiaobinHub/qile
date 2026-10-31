import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { ChevronRight, LogOut, Menu, Puzzle, UserRound, UsersRound } from "lucide-react"
import { Brand } from "@/components/brand"
import { Button } from "@shared/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@shared/components/ui/sheet"
import { useSession } from "@/lib/session"
import { cn } from "@shared/lib/utils"

export type Page = "users" | "plugins" | "profile"
const navigation = [
  {
    title: "工作空间",
    items: [
      { page: "users" as const, label: "账号管理", icon: UsersRound, id: "UsersNav" },
      { page: "plugins" as const, label: "插件管理", icon: Puzzle, id: "PluginsNav" },
    ],
  },
  {
    title: "账号管理",
    items: [{ page: "profile" as const, label: "我的账号", icon: UserRound, id: "ProfileNav" }],
  },
]
export function AdminLayout({
  page,
  onNavigate,
  children,
}: {
  page: Page
  onNavigate: (page: Page) => void
  children: ReactNode
}) {
  const { session, signOut } = useSession()
  const [mobileOpen, setMobileOpen] = useState(false)
  const content = useRef<HTMLElement>(null)
  const locked = Boolean(session?.user.mustChangePassword)
  useLayoutEffect(() => {
    if (content.current) {
      content.current.scrollTop = 0
      content.current.scrollLeft = 0
    }
  }, [page, locked])
  if (!session) return null
  const { user } = session
  const containList = (page === "users" || page === "plugins") && !locked
  function navigate(next: Page) {
    if (!locked) {
      onNavigate(next)
      setMobileOpen(false)
    }
  }
  function sidebar(mobile = false) {
    return (
      <nav aria-label="后台导航" className="admin-navigation">
        {navigation.map((group) => (
          <div className="admin-nav-group" key={group.title}>
            <h2>{group.title}</h2>
            {group.items.map(({ page: next, label, icon: Icon, id }) => {
              const active = locked ? next === "profile" : page === next
              return (
                <Button
                  key={next}
                  id={mobile ? `mobile${id}` : id[0].toLowerCase() + id.slice(1)}
                  type="button"
                  variant="sidebar-navigation"
                  size="menu"
                  disabled={locked}
                  aria-current={active ? "page" : undefined}
                  className="admin-nav-item"
                  onClick={() => navigate(next)}
                >
                  <Icon aria-hidden />
                  <span>{label}</span>
                  {active && <ChevronRight aria-hidden className="admin-nav-arrow" />}
                </Button>
              )
            })}
            {group.title === "账号管理" && (
              <Button
                id={mobile ? "mobileLogout" : "logout"}
                type="button"
                variant="sidebar-navigation"
                size="menu"
                className="admin-nav-item"
                onClick={() => void signOut()}
              >
                <LogOut aria-hidden />
                <span>退出登录</span>
              </Button>
            )}
          </div>
        ))}
      </nav>
    )
  }
  return (
    <div className={cn("admin-shell", containList && "admin-list-layout")}>
      <header className="admin-topbar">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="打开导航"
              className="admin-menu-trigger"
            >
              <Menu aria-hidden />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="admin-mobile-sidebar">
            <SheetTitle>管理后台</SheetTitle>
            <SheetDescription className="sr-only">
              账号管理、插件管理和个人账号设置
            </SheetDescription>
            {sidebar(true)}
          </SheetContent>
        </Sheet>
        <Brand className="admin-workspace-brand" />
        <Button
          type="button"
          variant="ghost"
          className="admin-user-entry"
          aria-label={`${user.nickname || user.loginName}，我的账号`}
          disabled={locked}
          onClick={() => navigate("profile")}
        >
          <span className="admin-user-avatar" aria-hidden>
            {Array.from(user.nickname || user.loginName)[0]}
          </span>
          <span className="admin-user-copy">
            <strong>{user.nickname || user.loginName}</strong>
            <small>管理员</small>
          </span>
        </Button>
      </header>
      <div className="admin-columns">
        <aside className="admin-sidebar" aria-label="管理菜单">
          {sidebar()}
        </aside>
        <main
          ref={content}
          id="mainContent"
          className={cn("admin-content", containList && "admin-content-list")}
        >
          {children}
        </main>
      </div>
      <footer className="admin-footer">乐乐成长 · 管理后台</footer>
    </div>
  )
}

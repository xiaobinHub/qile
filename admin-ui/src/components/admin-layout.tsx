import { useState, type ReactNode } from "react"
import {
  ChevronRight,
  LayoutGrid,
  LogOut,
  Menu,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react"
import { Brand } from "@/components/brand"
import { Button } from "@shared/components/ui/button"
import { Separator } from "@shared/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@shared/components/ui/sheet"
import { useSession } from "@/lib/session"
import { cn } from "@shared/lib/utils"

export type Page = "users" | "profile"
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
  if (!session) return null
  const { user } = session
  const locked = user.mustChangePassword
  function navigate(next: Page) {
    if (!locked) {
      onNavigate(next)
      setMobileOpen(false)
    }
  }
  function sidebar(mobile = false) {
    return (
      <div className="flex h-full flex-col">
        <div className="px-5 pt-6 pb-7">
          <Brand compact />
        </div>
        <div className="px-5 pb-3 text-xs font-medium tracking-[0.14em] text-muted-foreground">
          工作空间
        </div>
        <nav aria-label="后台导航" className="space-y-1.5 px-3">
          <Button
            id={mobile ? "mobileUsersNav" : "usersNav"}
            type="button"
            variant="ghost"
            disabled={locked}
            aria-current={page === "users" && !locked ? "page" : undefined}
            className={cn(
              "h-11 w-full justify-start gap-3 rounded-lg px-3 text-[13px] font-normal text-muted-foreground [&_svg]:size-[18px]",
              page === "users" && !locked && "bg-accent font-medium text-brand-ink hover:bg-accent",
            )}
            onClick={() => navigate("users")}
          >
            <UsersRound />
            <span>账号管理</span>
            {page === "users" && !locked && (
              <span className="ml-auto size-1.5 rounded-full bg-primary" />
            )}
          </Button>
          <Button
            id={mobile ? "mobileProfileNav" : "profileNav"}
            type="button"
            variant="ghost"
            disabled={locked}
            aria-current={page === "profile" || locked ? "page" : undefined}
            className={cn(
              "h-11 w-full justify-start gap-3 rounded-lg px-3 text-[13px] font-normal text-muted-foreground [&_svg]:size-[18px]",
              (page === "profile" || locked) &&
                "bg-accent font-medium text-brand-ink hover:bg-accent",
            )}
            onClick={() => navigate("profile")}
          >
            <UserRound />
            <span>我的账号</span>
          </Button>
        </nav>
        <div className="mt-auto px-4 pb-5">
          <Separator className="mb-4" />
          <div className="mb-3 flex min-w-0 items-center gap-2.5 px-1">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted/70 text-sm font-medium text-muted-foreground">
              {Array.from(user.nickname || user.loginName)[0]}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium" title={user.nickname}>
                {user.nickname}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">管理员</p>
            </div>
            <ShieldCheck className="ml-auto size-4 shrink-0 text-brand-ink/70" />
          </div>
          <Button
            id={mobile ? "mobileLogout" : "logout"}
            type="button"
            variant="ghost"
            className="h-11 w-full justify-start gap-2.5 px-2.5 text-[13px] text-muted-foreground"
            onClick={() => void signOut()}
          >
            <LogOut className="size-4" />
            退出登录
          </Button>
        </div>
      </div>
    )
  }
  const title = locked ? "密码设置" : page === "users" ? "账号管理" : "我的账号"
  return (
    <div className="min-h-svh bg-background">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[200px] border-r bg-card md:block">
        {sidebar()}
      </aside>
      <div className="min-w-0 md:ml-[200px]">
        <header className="flex h-14 items-center justify-between gap-4 border-b bg-card/90 px-5 sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="打开导航"
                  className="-ml-2 size-11 md:hidden"
                >
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[264px] gap-0 p-0">
                <SheetTitle className="sr-only">后台导航</SheetTitle>
                <SheetDescription className="sr-only">账号管理和个人账号设置</SheetDescription>
                {sidebar(true)}
              </SheetContent>
            </Sheet>
            <LayoutGrid className="hidden size-4 text-muted-foreground sm:block" />
            <div className="flex items-center gap-2 text-xs sm:gap-3">
              <span className="text-muted-foreground">管理后台</span>
              <ChevronRight className="size-3 text-muted-foreground/60" />
              <span className="font-medium">{title}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/80 bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            <span>管理员工作台</span>
          </div>
        </header>
        <main id="mainContent" className="mx-auto w-full max-w-[1360px] px-5 py-6 sm:px-7 sm:py-6">
          {children}
        </main>
        <footer className="px-5 pt-2 pb-6 text-center text-xs tracking-wide text-muted-foreground sm:px-8">
          乐乐成长 · 管理后台
        </footer>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowUpRight,
  CircleCheck,
  Clock3,
  Ellipsis,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
  UsersRound,
  UserX,
  X,
} from "lucide-react"
import { PageHeading } from "@shared/components/page-heading"
import { StatusBadge } from "@shared/components/status-badge"
import { Button } from "@shared/components/ui/button"
import { Card } from "@shared/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@shared/components/ui/dropdown-menu"
import { Input } from "@shared/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@shared/components/ui/select"
import { Skeleton } from "@shared/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@shared/components/ui/table"
import { FormFeedback } from "@shared/components/form-feedback"
import { errorMessage, isIgnoredError, useSession } from "@/lib/session"
import { accountStatus, statusLabels, type AccountStatus, type User } from "@/lib/types"
import { useMounted } from "@/lib/use-mounted"
import {
  CreateUserDialog,
  ResetPasswordDialog,
  StatusDialog,
  type DialogTarget,
} from "@/pages/user-dialogs"

function UserActions({
  user,
  onReset,
  onStatus,
}: {
  user: User
  onReset: (target: DialogTarget) => void
  onStatus: (target: DialogTarget) => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const pendingAction = useRef<"reset" | "status" | null>(null)
  const [open, setOpen] = useState(false)
  const mounted = useMounted()

  function handOff(event: Event) {
    const action = pendingAction.current
    if (!action) return
    event.preventDefault()
    pendingAction.current = null
    // Radix removes the outgoing menu's focus scope after this callback returns.
    // Open the dialog in the following microtask so the two scopes never overlap.
    queueMicrotask(() => {
      if (!mounted.current) return
      const target = { user, trigger: trigger.current }
      if (action === "reset") onReset(target)
      else onStatus(target)
    })
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (!next || !pendingAction.current) setOpen(next)
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          size="icon-sm"
          data-actions={user.id}
          aria-label={`管理 ${user.nickname} 的账号`}
          disabled={Boolean(pendingAction.current)}
          className="size-11 text-muted-foreground"
        >
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40" onCloseAutoFocus={handOff}>
        <DropdownMenuLabel className="text-caption font-normal text-muted-foreground">
          账号操作
        </DropdownMenuLabel>
        <DropdownMenuItem
          data-reset={user.id}
          onSelect={() => {
            pendingAction.current = "reset"
          }}
        >
          <KeyRound />
          重置密码
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-status={user.id}
          variant={user.status === "disabled" ? "default" : "destructive"}
          onSelect={() => {
            pendingAction.current = "status"
          }}
        >
          {user.status === "disabled" ? (
            <>
              <CircleCheck />
              启用账号
            </>
          ) : (
            <>
              <UserX />
              停用账号
            </>
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function UsersPage() {
  const { request } = useSession()
  const [users, setUsers] = useState<User[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [flash, setFlash] = useState("")
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState<AccountStatus | "all">("all")
  const [resetTarget, setResetTarget] = useState<DialogTarget | null>(null)
  const [statusTarget, setStatusTarget] = useState<DialogTarget | null>(null)
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const mounted = useMounted()

  const loadUsers = useCallback(async () => {
    const current = ++sequence.current
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    setLoading(true)
    setError("")
    try {
      const result = await request<{ users: User[] }>(
        "admin/users",
        "GET",
        undefined,
        nextController.signal,
      )
      if (mounted.current && current === sequence.current) setUsers(result.users)
    } catch (error) {
      if (mounted.current && current === sequence.current && !isIgnoredError(error))
        setError(errorMessage(error))
    } finally {
      if (mounted.current && current === sequence.current) setLoading(false)
    }
  }, [request, mounted])
  useEffect(() => {
    void loadUsers()
    return () => {
      sequence.current += 1
      controller.current?.abort()
    }
  }, [loadUsers])
  const complete = async (message: string) => {
    if (mounted.current) {
      setFlash(message)
      await loadUsers()
    }
  }
  const query = search.trim().toLocaleLowerCase()
  const visible = (users || []).filter(
    (user) =>
      (!query ||
        [user.loginName, user.nickname].some((value) =>
          value.toLocaleLowerCase().includes(query),
        )) &&
      (filter === "all" || accountStatus(user) === filter),
  )
  const activeCount = users?.filter((user) => accountStatus(user) === "active").length
  const pendingCount = users?.filter((user) => accountStatus(user) === "pending").length
  const disabledCount = users?.filter((user) => accountStatus(user) === "disabled").length
  const hasFilter = Boolean(query) || filter !== "all"

  return (
    <div className="space-y-5">
      <PageHeading
        title="账号管理"
        description="开通与维护家长账号，管理账号的访问状态。"
        actions={<CreateUserDialog onComplete={complete} />}
      />
      <div className="overview-strip grid grid-cols-2 sm:grid-cols-4 overflow-hidden rounded-xl border bg-card">
        {[
          {
            label: "全部账号",
            value: users?.length,
            icon: UsersRound,
            className: "text-slate-500",
          },
          { label: "已启用", value: activeCount, icon: CircleCheck, className: "text-brand-ink" },
          { label: "待改密", value: pendingCount, icon: Clock3, className: "text-warning" },
          {
            label: "已停用",
            value: disabledCount,
            icon: UserX,
            className: "text-muted-foreground",
          },
        ].map(({ label, value, icon: Icon, className }) => (
          <div key={label} className="overview-cell min-w-0 px-4 py-4 sm:px-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-caption text-muted-foreground">{label}</p>
              <Icon className={`size-4 ${className}`} strokeWidth={1.7} />
            </div>
            {value === undefined ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              <p className="text-number font-semibold tracking-tight tabular-nums">
                {value}
                <span className="ml-1.5 text-caption font-normal text-muted-foreground">个</span>
              </p>
            )}
          </div>
        ))}
      </div>
      <FormFeedback message={flash} success />
      <Card className="gap-0 overflow-hidden rounded-xl py-0 shadow-none">
        <div
          role="search"
          aria-label="账号筛选"
          className="flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-5"
        >
          <div className="relative min-w-0 flex-[1_1_210px] sm:max-w-[300px]">
            <Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" />
            <Input
              id="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索昵称或登录名"
              aria-label="搜索账号"
              className="h-11 bg-card pr-11 pl-9 text-sm"
            />
            {search && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="清除搜索"
                className="absolute top-0 right-0 size-11 text-muted-foreground"
                onClick={() => setSearch("")}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as AccountStatus | "all")}
          >
            <SelectTrigger
              id="statusFilter"
              aria-label="筛选账号状态"
              className="h-11 w-[130px] bg-card text-sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="active">已启用</SelectItem>
              <SelectItem value="pending">待改密</SelectItem>
              <SelectItem value="disabled">已停用</SelectItem>
            </SelectContent>
          </Select>
          <Button
            id="refreshUsers"
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => {
              setFlash("")
              void loadUsers()
            }}
            className="ml-auto h-11 gap-2 bg-card px-3 text-sm"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
        {error && (
          <div className="border-b p-4">
            <FormFeedback id="listError" message={error} />
            <Button
              type="button"
              variant="link"
              size="sm"
              className="mt-1 h-7 px-0 text-sm"
              onClick={() => void loadUsers()}
            >
              重新加载
              <ArrowUpRight className="size-3" />
            </Button>
          </div>
        )}
        <div className="admin-user-table min-w-0" aria-busy={loading}>
          <Table className="w-full table-fixed">
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="h-11 w-[34%] pl-3 text-caption font-normal text-muted-foreground sm:pl-5 xl:w-[30%]">
                  昵称
                </TableHead>
                <TableHead className="w-[27%] text-caption font-normal text-muted-foreground xl:w-[24%]">
                  登录名
                </TableHead>
                <TableHead className="hidden w-[18%] text-caption font-normal text-muted-foreground xl:table-cell">
                  账号类型
                </TableHead>
                <TableHead className="text-caption font-normal text-muted-foreground">
                  账号状态
                </TableHead>
                <TableHead className="w-14 pr-3 pl-0">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody id="userRows">
              {!users && loading
                ? Array.from({ length: 4 }, (_, index) => (
                    <TableRow key={index}>
                      <TableCell className="py-4 pl-3 sm:pl-5">
                        <div className="flex items-center gap-3">
                          <Skeleton className="hidden size-9 shrink-0 rounded-full sm:block" />
                          <Skeleton className="h-3 w-20 max-w-full" />
                        </div>
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-3 w-24 max-w-full" />
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        <Skeleton className="h-3 w-16 max-w-full" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-5 w-16 max-w-full rounded-full" />
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  ))
                : visible.map((user) => (
                    <TableRow key={user.id} data-user-id={user.id} className="h-16">
                      <TableCell className="py-2 pl-3 sm:pl-5">
                        <div className="flex min-w-0 items-center gap-3">
                          <div
                            className={`hidden size-9 shrink-0 sm:flex items-center justify-center rounded-full text-sm font-medium ${user.role === "admin" ? "bg-primary/10 text-brand-ink" : "bg-muted text-muted-foreground"}`}
                          >
                            {Array.from(user.nickname || user.loginName)[0]}
                          </div>
                          <div className="min-w-0">
                            <span
                              className="block truncate text-sm font-medium"
                              title={user.nickname}
                            >
                              {user.nickname}
                            </span>
                            <span className="mt-0.5 block text-caption text-muted-foreground xl:hidden">
                              {user.role === "admin" ? "管理员" : "成员"}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <span className="block truncate" title={user.loginName}>
                          {user.loginName}
                        </span>
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        <span
                          className={`inline-flex items-center gap-1.5 text-sm ${user.role === "admin" ? "text-foreground/75" : "text-muted-foreground"}`}
                        >
                          {user.role === "admin" ? (
                            <ShieldCheck className="size-3.5 text-brand-ink/70" />
                          ) : (
                            <UserRound className="size-3.5" />
                          )}
                          {user.role === "admin" ? "管理员" : "成员"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          tone={
                            accountStatus(user) === "active"
                              ? "success"
                              : accountStatus(user) === "pending"
                                ? "warning"
                                : "neutral"
                          }
                          className="gap-1 px-1.5"
                        >
                          <span className="size-1.5 rounded-full bg-current opacity-80" />
                          {statusLabels[accountStatus(user)]}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="pr-3 pl-0 text-right">
                        {user.role === "parent" ? (
                          <UserActions
                            user={user}
                            onReset={setResetTarget}
                            onStatus={setStatusTarget}
                          />
                        ) : (
                          <span
                            className="inline-flex size-11 items-center justify-center text-muted-foreground/40"
                            title="管理员账号由本人维护"
                          >
                            <LockKeyhole className="size-3.5" aria-label="管理员账号由本人维护" />
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
          {users && !visible.length && (
            <div
              role="status"
              className="flex min-h-[240px] flex-col items-center justify-center px-5 py-12 text-center"
            >
              <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                {hasFilter ? <Search className="size-5" /> : <UsersRound className="size-5" />}
              </div>
              <p className="text-sm font-medium">{hasFilter ? "没有匹配的账号" : "暂无账号"}</p>
              <p className="mt-2 text-caption text-muted-foreground">
                {hasFilter
                  ? "试试其他关键词，或调整账号状态。"
                  : "点击“开通账号”，添加第一个家长账号。"}
              </p>
              {hasFilter && (
                <Button
                  type="button"
                  variant="link"
                  className="mt-2 h-8 text-sm"
                  onClick={() => {
                    setSearch("")
                    setFilter("all")
                  }}
                >
                  清除筛选
                </Button>
              )}
            </div>
          )}
          {!users && !loading && error && (
            <div className="py-14 text-center text-caption text-muted-foreground">
              账号列表暂时无法载入
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/15 px-5 py-3 text-caption text-muted-foreground">
          <p>
            {users ? `显示 ${visible.length} 个账号，共 ${users.length} 个` : "正在读取账号信息"}
          </p>
        </div>
      </Card>
      <p className="flex items-start gap-2 px-1 text-caption leading-5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        新开通或重置密码的账号，首次登录时需设置自己的密码。
      </p>
      {resetTarget && (
        <ResetPasswordDialog
          target={resetTarget}
          onClose={() => setResetTarget(null)}
          onComplete={complete}
        />
      )}
      {statusTarget && (
        <StatusDialog
          target={statusTarget}
          onClose={() => setStatusTarget(null)}
          onComplete={complete}
        />
      )}
    </div>
  )
}

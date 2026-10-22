export type SessionUser = {
  id: string
  loginName: string
  nickname: string
  role: "admin" | "parent"
  mustChangePassword: boolean
}

export type User = SessionUser & { status: "active" | "pending" | "disabled" }
export type Session = { user: SessionUser; csrfToken: string }
export type AccountStatus = "active" | "pending" | "disabled"

export function accountStatus(user: User): AccountStatus {
  if (user.status === "disabled") return "disabled"
  return user.mustChangePassword || user.status === "pending" ? "pending" : "active"
}

export const statusLabels: Record<AccountStatus, string> = {
  active: "已启用",
  pending: "待改密",
  disabled: "已停用",
}

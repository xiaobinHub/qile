export type FamilyRole = "father" | "mother" | "grandfather" | "grandmother"

export type SessionUser = {
  id: string
  loginName: string
  nickname: string
  familyRole?: FamilyRole | null
  avatarId?: string
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

export const familyRoleLabels: Record<FamilyRole, string> = {
  father: "爸爸",
  mother: "妈妈",
  grandfather: "爷爷",
  grandmother: "奶奶",
}

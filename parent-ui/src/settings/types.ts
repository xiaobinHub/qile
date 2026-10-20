export type Child = { id: string; name: string; role: "owner" | "parent"; archived: boolean }
export type User = { id: string; nickname: string; loginName: string }
export type Category = { id: string; name: string; color: string; active: boolean }
export type Preset = { id: string; title: string; categoryId: string; startTime: string; endTime: string; points: number }
export type Context = { child: Child | null; user: User; data: { categories: Category[]; taskPresets: Preset[] } | null; updatedAt: string | null }
export type Invitation = { id: string; childId: string; childName: string; userId: string; nickname: string; loginName: string; status: string; createdAt: string; expiresAt: string }
export type Member = Omit<User, "id"> & { userId: string; role: "owner" | "parent" }
export type Dependencies = {
  context: () => Context
  api: <T>(path: string, method?: string, body?: unknown) => Promise<T>
  show: () => void
  home: () => void
  forgetChild: (id: string) => void
  selectChild: (id: string) => Promise<void>
  sync: (reload: boolean) => Promise<boolean>
  repaint: () => void
  updateUser: (user: User) => void
  toast: (message: string) => void
  editPreset: (id?: string) => void
  deletePreset: (id: string) => Promise<void>
  addCategory: () => void
  deleteCategory: (id: string) => void
  saveCategory: (category: Category) => Promise<void>
  reorderCategory: (from: string, target: string, after: boolean) => Promise<void>
  exportBackup: () => void
  importBackup: () => void
  logout: () => void
  changePassword: (values: { currentPassword: string; newPassword: string }) => Promise<void>
}
export type Controller = {
  deps: Dependencies
  pending: object | null
  render: () => void
  open: (page: string) => void
  invalidate: () => void
  reset: () => void
  refresh: () => boolean
}

import { useState } from "react"
import { LoaderCircle } from "lucide-react"
import { Brand } from "@/components/brand"
import { AdminLayout, type Page } from "@/components/admin-layout"
import { LoginPage } from "@/pages/login"
import { UsersPage } from "@/pages/users"
import { ProfilePage } from "@/pages/profile"
import { SessionProvider, useSession } from "@/lib/session"

function Workspace() {
  const { session } = useSession()
  const [page, setPage] = useState<Page>("users")
  return (
    <AdminLayout page={session?.user.mustChangePassword ? "profile" : page} onNavigate={setPage}>
      {page === "profile" || session?.user.mustChangePassword ? <ProfilePage /> : <UsersPage />}
    </AdminLayout>
  )
}
function SessionScreen() {
  const { session, phase, version } = useSession()
  if (phase !== "ready")
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-7 p-6">
        <Brand />
        <div role="status" className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          {phase === "signingOut" ? "正在退出登录…" : "正在载入工作台…"}
        </div>
      </main>
    )
  return session ? <Workspace key={version} /> : <LoginPage key={version} />
}
export default function App() {
  return (
    <SessionProvider>
      <SessionScreen />
    </SessionProvider>
  )
}

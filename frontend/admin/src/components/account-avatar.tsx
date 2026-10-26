import { useEffect, useState } from "react"
import { AvatarImage } from "@shared/components/avatar-image"
import { useSession } from "@/lib/session"

type Avatar = { id: string; url: string }

export function useAccountAvatars() {
  const { request } = useSession()
  const [avatars, setAvatars] = useState<Avatar[]>([])
  useEffect(() => {
    const abort = new AbortController()
    async function load() {
      try {
        const result = await request<{ avatars: Avatar[] }>(
          "admin/account-avatars",
          "GET",
          undefined,
          abort.signal,
        )
        if (!abort.signal.aborted) setAvatars(result.avatars)
      } catch {
        // Account management stays available when avatar storage is unavailable.
      }
    }
    void load()
    const timer = window.setInterval(load, 50 * 60 * 1000)
    return () => {
      abort.abort()
      window.clearInterval(timer)
    }
  }, [request])
  return avatars
}

export function AccountAvatar({ id = "father", avatars }: { id?: string; avatars: Avatar[] }) {
  const url = avatars.find((avatar) => avatar.id === id)?.url
  return (
    <span className="admin-account-avatar" aria-hidden="true">
      <AvatarImage src={url} />
    </span>
  )
}

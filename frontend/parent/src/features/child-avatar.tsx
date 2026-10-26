import { useEffect, useState } from "react"
import { AvatarImage } from "@shared/components/avatar-image"
import { runtime } from "../lib/runtime"

export const DEFAULT_AVATAR = "boy-04"
export type Avatar = { id: string; url: string }
type Catalog = { avatars: Avatar[]; expiresIn: number }
let cached: { value: Catalog; until: number } | undefined
let pending: Promise<Catalog> | undefined
function readCatalog() {
  if (cached && cached.until > Date.now()) return Promise.resolve(cached.value)
  if (!pending) {
    pending = runtime
      .api<Catalog>("/api/child-avatars")
      .then((value) => {
        cached = { value, until: Date.now() + Math.min(value.expiresIn - 60, 3000) * 1000 }
        return value
      })
      .finally(() => {
        pending = undefined
      })
  }
  return pending
}
export function useChildAvatars() {
  const [avatars, setAvatars] = useState<Avatar[]>([])
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    function load() {
      setError("")
      void readCatalog()
        .then((value) => {
          if (active) setAvatars(value.avatars)
        })
        .catch((e: Error) => {
          if (active) setError(e.message)
        })
    }
    load()
    const timer = window.setInterval(load, 3000000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [retry])
  return { avatars, error, retry: () => setRetry((value) => value + 1) }
}
export function ChildAvatar({ id = DEFAULT_AVATAR }: { id?: string }) {
  const { avatars } = useChildAvatars()
  const url = avatars.find((avatar) => avatar.id === id)?.url
  return <AvatarImage className="child-avatar-image" src={url} />
}

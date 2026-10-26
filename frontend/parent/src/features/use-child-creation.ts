import { useRef, useState } from "react"
import type { Child } from "../domain/types"
import { operationId } from "../lib/runtime"
import type { ChildGender } from "./child-gender-picker"

type Dependencies = {
  api: <T>(path: string, method?: string, body?: unknown) => Promise<T>
  sync: (reload: boolean) => Promise<boolean>
}
type Attempt = { requestId: string; name: string; gender: ChildGender; child?: Child }

export function useChildCreation(deps: Dependencies) {
  const attempt = useRef<Attempt | null>(null)
  const [created, setCreated] = useState(false)
  const [locked, setLocked] = useState(false)

  async function save(name: string, gender: ChildGender) {
    const current = (attempt.current ??= { requestId: operationId(), name, gender })
    if (current.child) return current.child
    setLocked(true)
    try {
      const { child } = await deps.api<{ child: Child }>("/api/children", "POST", {
        requestId: current.requestId,
        name: current.name,
        gender: current.gender,
      })
      current.child = child
      setCreated(true)
      return child
    } catch (error) {
      // Validation failures did not commit. An unknown result retains its exact payload and ID.
      if ((error as { status?: number }).status === 400) {
        attempt.current = null
        setLocked(false)
      }
      throw error
    }
  }

  async function refresh() {
    try {
      await deps.sync(false)
    } catch (error) {
      if (["stale", "unauthorized"].includes((error as { kind?: string }).kind || "")) throw error
      throw new Error("儿童已添加，列表刷新失败，请重试刷新。")
    }
  }

  return { save, refresh, created, locked }
}

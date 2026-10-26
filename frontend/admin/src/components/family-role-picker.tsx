import { useEffect, useState } from "react"
import { Check } from "lucide-react"
import { Button } from "@shared/components/ui/button"
import { FormFeedback } from "@shared/components/form-feedback"
import { errorMessage, isIgnoredError, useSession } from "@/lib/session"
import { AvatarImage } from "@shared/components/avatar-image"
import { FAMILY_ROLES } from "@shared/family-roles"
import type { FamilyRole } from "@/lib/types"

type Avatar = { id: FamilyRole; label: string; url: string }

export function FamilyRolePicker({ disabled }: { disabled: boolean }) {
  const { request } = useSession()
  const [avatars, setAvatars] = useState<Avatar[]>([])
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setError("")
    void request<{ avatars: Avatar[] }>("admin/account-avatars", "GET", undefined, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return
        setAvatars(result.avatars)
      })
      .catch((error) => {
        if (!abort.signal.aborted && !isIgnoredError(error)) setError(errorMessage(error))
      })
    return () => abort.abort()
  }, [request, attempt])
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-2 text-sm font-medium">角色</legend>
      {error && (
        <div>
          <FormFeedback id="createFamilyRoleError" message={error} />
          <Button type="button" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            重新加载
          </Button>
        </div>
      )}
      <div className="family-role-grid">
        {FAMILY_ROLES.map((avatar) => (
          <label key={avatar.id} className="family-role-option">
            <input
              type="radio"
              name="familyRole"
              value={avatar.id}
              aria-label={avatar.label}
              defaultChecked={avatar.id === "father"}
              required
            />
            <span className="family-role-image">
              <AvatarImage src={avatars.find((item) => item.id === avatar.id)?.url} />
              <span className="family-role-check" aria-hidden="true">
                <Check />
              </span>
            </span>
            <span>{avatar.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

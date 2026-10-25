import { useState } from "react"

const EMPTY_AVATAR =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="500" height="500"/%3E'

/** Image availability never changes the selected business value. */
export function AvatarImage({ src, className }: { src?: string; className?: string }) {
  const [failed, setFailed] = useState<string>()
  const placeholder = !src || failed === src
  return (
    <img
      src={placeholder ? EMPTY_AVATAR : src}
      className={className}
      alt=""
      width={500}
      height={500}
      data-avatar-placeholder={placeholder || undefined}
      onError={() => setFailed(src)}
    />
  )
}

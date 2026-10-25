import { Check } from "lucide-react"
import { AvatarImage } from "@shared/components/avatar-image"
import { useChildAvatars } from "./child-avatar"

export type ChildGender = "boy" | "girl"
const options = [
  { value: "boy", label: "男孩", avatarId: "boy-04" },
  { value: "girl", label: "女孩", avatarId: "girl-10" },
] as const

export function childGenderLabel(value?: ChildGender | null) {
  return options.find((option) => option.value === value)?.label || "未设置"
}

export function ChildGenderPicker({
  value,
  onChange,
}: {
  value: ChildGender | ""
  onChange: (value: ChildGender) => void
}) {
  const { avatars } = useChildAvatars()
  return (
    <fieldset className="child-gender-picker">
      <legend>
        性别 <span aria-hidden="true">*</span>
        <span className="sr-only">（必填）</span>
      </legend>
      <div className="child-gender-options">
        {options.map((option) => (
          <div key={option.value}>
            <label className="child-avatar-option">
              <input
                type="radio"
                name="childGender"
                value={option.value}
                aria-label={option.label}
                required
                checked={value === option.value}
                onChange={() => onChange(option.value)}
              />
              <AvatarImage src={avatars.find((avatar) => avatar.id === option.avatarId)?.url} />
              <span className="child-avatar-check" aria-hidden="true">
                <Check />
              </span>
            </label>
            <p className="account-avatar-choice-name">{option.label}</p>
          </div>
        ))}
      </div>
    </fieldset>
  )
}

import { forwardRef, useState, type ComponentProps } from "react"
import { Eye, EyeOff } from "lucide-react"
import { Button } from "@shared/components/ui/button"
import { Input } from "@shared/components/ui/input"

export const passwordPolicy = {
  minLength: 6,
  maxLength: 128,
  pattern: "(?=.*[A-Za-z])(?=.*[0-9]).{6,128}",
  title: "6–128 位，且同时包含英文字母和数字",
}
export const passwordHelp = "6–128 位，包含英文字母和数字，可使用符号。"

export const PasswordInput = forwardRef<HTMLInputElement, ComponentProps<typeof Input>>(function PasswordInput(props, ref) {
  const [visible, setVisible] = useState(false)
  return <div className="relative"><Input {...props} ref={ref} type={visible ? "text" : "password"} className={`pr-11 ${props.className || ""}`} /><Button type="button" variant="ghost" size="icon-sm" className="absolute top-0 right-0 text-muted-foreground hover:bg-transparent hover:text-foreground" aria-label={visible ? "隐藏密码" : "显示密码"} aria-pressed={visible} onClick={() => setVisible(value => !value)} disabled={props.disabled}>{visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button></div>
})

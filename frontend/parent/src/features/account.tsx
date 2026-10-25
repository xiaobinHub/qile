import { ChildAvatar } from "./child-avatar"
import { ChildGenderPicker, type ChildGender } from "./child-gender-picker"
import { useEffect, useRef, useState } from "react"
import { UserRound, ShieldCheck, Baby, Mail, ArrowRight } from "lucide-react"
import { PasswordInput } from "@shared/components/password-input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@shared/components/ui/dialog"
import { Button, Input, Card, ErrorText, Field, useAsync } from "./ui"
import { runtime } from "../lib/runtime"
import type { Child, User } from "../domain/types"
import { Invitations } from "../settings/children"
import type { Controller } from "../settings/types"
export function Login({ message }: { message: string }) {
  const action = useAsync()
  const [name, setName] = useState(""),
    [password, setPassword] = useState("")
  return (
    <section className="auth-screen parent-login" aria-labelledby="loginTitle">
      <Card className="login-card">
        <div className="login-card-body">
          <header className="login-heading">
            <h1 id="loginTitle">欢迎回来</h1>
            <p>陪伴成长，记录每一份努力</p>
          </header>
          <form
            id="loginForm"
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault()
              void action.run(() => runtime.login(name, password))
            }}
          >
            <fieldset disabled={action.busy}>
              <Field label="登录名" id="loginName">
                <Input
                  id="loginName"
                  name="loginName"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={32}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="请输入登录名"
                />
              </Field>
              <Field label="密码" id="loginPassword">
                <PasswordInput
                  id="loginPassword"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  placeholder="请输入密码"
                />
              </Field>
              <div id="loginError" aria-live="polite">
                <ErrorText message={action.error} />
                {!action.error && message && <p className="field-help">{message}</p>}
              </div>
              <Button
                id="loginSubmit"
                type="submit"
                className="login-submit"
                aria-busy={action.busy}
              >
                {action.busy ? "正在登录…" : "登录"}
                <ArrowRight aria-hidden />
              </Button>
            </fieldset>
          </form>
        </div>
        <footer className="login-help">
          <ShieldCheck aria-hidden />
          <p>
            账号由管理员开通。
            <br />
            忘记密码？请联系管理员协助重置。
          </p>
        </footer>
      </Card>
    </section>
  )
}
export function Onboarding({ user, controller }: { user: User; controller: Controller }) {
  const action = useAsync(),
    [name, setName] = useState("")
  const [gender, setGender] = useState<ChildGender | "">("")
  return (
    <section id="onboarding" className="onboarding">
      <header className="onboarding-heading">
        <span className="onboarding-greeting">你好，{user.nickname}</span>
        <h1>从陪伴的第一步开始</h1>
      </header>
      <div className="onboarding-columns">
        <Card className="onboarding-card">
          <header>
            <span className="onboarding-icon">
              <Baby aria-hidden />
            </span>
            <h2>创建孩子</h2>
            <p>为孩子安排任务，记录努力，积累成长的点滴。</p>
          </header>
          <form
            id="createChildForm"
            onSubmit={(e) => {
              e.preventDefault()
              void action.run(async () => {
                if (!gender) throw Error("请选择儿童性别。")
                const result = await runtime.api<{ child: Child }>("/api/children", "POST", {
                  name: name.trim(),
                  gender,
                })
                await runtime.sync(false)
                await runtime.selectChild(result.child.id)
              })
            }}
          >
            <fieldset disabled={action.busy}>
              <Field
                label="孩子昵称"
                id="newChildName"
                help="昵称最多 5 个字，每个孩子都有独立的任务、积分和礼品。"
              >
                <Input
                  id="newChildName"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={5}
                  placeholder="请输入孩子昵称"
                />
              </Field>
              <ChildGenderPicker value={gender} onChange={setGender} />
              <ErrorText message={action.error} id="childrenError" />
              <div className="form-actions">
                <Button type="submit">{action.busy ? "正在创建…" : "创建孩子"}</Button>
              </div>
            </fieldset>
          </form>
        </Card>
        <Card className="onboarding-card">
          <header>
            <span className="onboarding-icon">
              <Mail aria-hidden />
            </span>
            <h2>家人的邀请</h2>
            <p>家人已经创建了孩子？接受邀请后，就能一起管理。</p>
          </header>
          <Invitations controller={controller} />
        </Card>
      </div>
    </section>
  )
}
export function ChildSwitcher({
  child,
  children,
  onClose,
}: {
  child: Child
  children: Child[]
  onClose: () => void
}) {
  const returnFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement)
  const action = useAsync(),
    [list, setList] = useState(children)
  useEffect(() => {
    let active = true
    runtime
      .api<{ children: Child[] }>("/api/children")
      .then((r) => {
        if (active) {
          setList(r.children)
          runtime.patch({ children: r.children })
        }
      })
      .catch((e) => {
        if (active) action.setError(e.message)
      })
    return () => {
      active = false
    }
  }, [])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose()
      }}
    >
      <DialogContent
        id="childrenDialog"
        backdrop="immersive"
        className="child-switcher"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocus.current?.isConnected) returnFocus.current.focus()
        }}
        onInteractOutside={(e) => {
          if (action.busy) e.preventDefault()
        }}
      >
        <DialogHeader className="child-switcher-heading">
          <DialogTitle>我的孩子</DialogTitle>
          <DialogDescription>选择一张卡牌，进入孩子的成长计划。</DialogDescription>
        </DialogHeader>
        <ErrorText message={action.error} />
        <div
          className="children-dialog-cards"
          role="group"
          aria-label="选择孩子"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
            const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "[data-child-card]:not(:disabled)",
                ),
              ),
              index = buttons.indexOf(event.target as HTMLButtonElement)
            if (index < 0) return
            event.preventDefault()
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : Math.max(
                      0,
                      Math.min(buttons.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)),
                    )
            buttons[next]?.focus({ preventScroll: true })
            buttons[next]?.scrollIntoView({ block: "nearest", inline: "center" })
          }}
          onWheel={(e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
          }}
        >
          {list.map((c, i) => (
            <Button
              key={c.id}
              variant="ghost"
              className={`children-dialog-card ${child.id === c.id ? "is-current" : ""}`}
              style={{ "--card-hue": String([125, 32, 203, 280][i % 4]) } as React.CSSProperties}
              disabled={action.busy}
              data-child-card={c.id}
              aria-current={child.id === c.id ? "true" : undefined}
              aria-label={`${c.name}${child.id === c.id ? "，当前孩子" : ""}${c.archived ? "，只读" : ""}`}
              onClick={() => {
                if (child.id === c.id) {
                  onClose()
                  return
                }
                void action.run(async () => {
                  await runtime.selectChild(c.id)
                  onClose()
                })
              }}
            >
              <span className="portrait-decoration" aria-hidden />
              <span className="child-portrait" aria-hidden>
                <ChildAvatar id={c.avatarId} />
              </span>
              <strong>{c.name}</strong>
              <span>
                {c.role === "owner" ? "管理员" : "成员"}
                {c.archived ? " · 只读" : ""}
              </span>
              <small>{child.id === c.id ? "当前孩子 ✓" : "进入成长计划 →"}</small>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useState } from "react"
import { AccountPassword, AccountProfile } from "./account"
import { ChildProfile, Family, Invitations } from "./children"
import { Backup, Categories, Presets } from "./tasks"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icon,
  initial,
} from "./primitives"
import type { Context, Controller } from "./types"

const groups = [
  {
    title: "孩子管理",
    items: [
      ["child/profile", "孩子昵称", "child", "openChildNicknameSettings"],
      ["child/family", "邀请家人", "family", "openFamilySettings"],
      ["child/invitations", "我的邀请", "mail", "openMyInvitationsSettings"],
    ],
  },
  {
    title: "任务设置",
    items: [
      ["tasks/presets", "常用任务配置", "task", "openTaskPresetsSettings"],
      ["tasks/categories", "任务类型配置", "category", "openCategorySettings"],
      ["tasks/backup", "数据备份", "backup", "openBackupSettings"],
    ],
  },
  {
    title: "账号管理",
    items: [
      ["account/profile", "修改账号昵称", "child", "openAccountManagement"],
      ["account/password", "修改密码", "key", "openPasswordSettings"],
      ["account/logout", "退出登录", "logout", "settingsLogout"],
    ],
  },
]
const descriptions: Record<string, string> = {
  "child/profile": "为孩子设置一个熟悉的称呼，让每一步成长都属于他。",
  "child/family": "邀请家人一起陪伴，共同管理当前孩子的成长记录。",
  "child/invitations": "查看发给你的邀请，选择要一起陪伴的孩子。",
  "tasks/presets": "把经常安排的任务保存下来，下次创建更轻松。",
  "tasks/categories": "用名称和颜色区分任务，让每天的安排更清晰。",
  "tasks/backup": "导出一份当前孩子的数据，妥善保存成长记录。",
  "account/profile": "设置家人容易识别的昵称。",
  "account/password": "定期更新密码，保护账号和孩子的成长记录。",
}

function Pane({
  selected,
  context,
  controller,
}: {
  selected: string
  context: Context
  controller: Controller
}) {
  switch (selected) {
    case "child/profile":
      return <ChildProfile controller={controller} child={context.child!} />
    case "child/family":
      return <Family controller={controller} child={context.child!} />
    case "child/invitations":
      return <Invitations controller={controller} />
    case "tasks/presets":
      return <Presets controller={controller} context={context} />
    case "tasks/categories":
      return <Categories controller={controller} context={context} />
    case "tasks/backup":
      return <Backup controller={controller} child={context.child!} updatedAt={context.updatedAt} />
    case "account/password":
      return <AccountPassword controller={controller} />
    default:
      return <AccountProfile controller={controller} user={context.user} />
  }
}

function Settings({
  selected,
  version,
  controller,
  navigate,
}: {
  selected: string
  version: number
  controller: Controller
  navigate: (key: string) => void
}) {
  const context = controller.deps.context(),
    { child, user } = context
  const visible = child ? groups : groups.filter((group) => group.title === "账号管理")
  const item = visible.flatMap((group) => group.items).find((item) => item[0] === selected)!
  return (
    <section className="settings-workspace" aria-label="设置">
      {!child && (
        <div className="settings-page-actions">
          <Button
            variant="outline"
            className="settings-back-home"
            id="backToOnboarding"
            type="button"
            onClick={controller.deps.home}
          >
            返回开始页
          </Button>
        </div>
      )}
      <div className="settings-columns">
        <Card className="settings-sidebar">
          <nav aria-label="设置导航">
            {visible.map((group) => (
              <div className="settings-nav-group" key={group.title}>
                <h2>{group.title}</h2>
                {group.items.map(([key, label, icon, id]) => (
                  <Button
                    variant="ghost"
                    type="button"
                    id={id}
                    data-settings-page={key}
                    key={`${key}:${selected}`}
                    className={`settings-nav-item ${key === selected ? "is-active" : ""} ${key === "account/logout" ? "settings-signout" : ""}`}
                    aria-current={key === selected ? "page" : undefined}
                    onClick={() =>
                      key === "account/logout" ? controller.deps.logout() : navigate(key)
                    }
                  >
                    <Icon name={icon} />
                    <span>{label}</span>
                    {key === selected && <Icon name="arrow" />}
                  </Button>
                ))}
              </div>
            ))}
          </nav>
          <div className="settings-sidebar-account">
            <span className="settings-mini-avatar">{initial(user.nickname)}</span>
            <div>
              <strong>{user.nickname}</strong>
              <small>{user.loginName}</small>
            </div>
          </div>
        </Card>
        <Card className="settings-detail" role="region" aria-labelledby="settingsDetailTitle">
          <CardHeader className="settings-detail-heading">
            <CardTitle>
              <h2 id="settingsDetailTitle" tabIndex={-1}>
                {item[1]}
              </h2>
            </CardTitle>
            <CardDescription className="settings-detail-description">
              {descriptions[selected]}
            </CardDescription>
          </CardHeader>
          <CardContent id="settingsContent" className="settings-detail-body">
            <Pane
              key={`${selected}:${child?.id}:${version}`}
              selected={selected}
              context={context}
              controller={controller}
            />
          </CardContent>
        </Card>
      </div>
    </section>
  )
}

export function SettingsPage({ controller }: { controller: Controller }) {
  const [selected, select] = useState(
    controller.deps.context().child ? "child/profile" : "account/profile",
  )
  const [version, update] = useState(0)
  controller.render = () => update((v) => v + 1)
  controller.refresh = () => {
    update((v) => v + 1)
    return true
  }
  const childId = controller.deps.context().child?.id
  useEffect(() => {
    window.scrollTo(0, 0)
    document.getElementById("settingsDetailTitle")?.focus({ preventScroll: true })
  }, [selected, childId])
  return (
    <Settings
      selected={selected}
      version={version}
      controller={controller}
      navigate={(page) => {
        select(page)
        update((v) => v + 1)
      }}
    />
  )
}

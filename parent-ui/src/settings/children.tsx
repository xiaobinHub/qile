import { useRef, useState, type FormEvent } from "react"
import {
  Badge,
  Button,
  Card,
  Empty,
  Feedback,
  FormField,
  Icon,
  Input,
  Label,
  Notice,
  ReadStatus,
  RowMenu,
  date,
  initial,
  statusNames,
  useAction,
  useRead,
} from "./primitives"
import type { Child, Controller, Invitation, Member } from "./types"
import { AsyncConfirm } from "@shared/components/async-confirm"

export function ChildProfile({ controller, child }: { controller: Controller; child: Child }) {
  const { deps } = controller,
    action = useAction(controller),
    nickname = useRef<HTMLInputElement>(null)
  const [deleting, setDeleting] = useState(false),
    [leaving, setLeaving] = useState(false)
  const owner = child.role === "owner",
    editable = owner && !child.archived
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!editable) return
    action.run(
      "nickname",
      () =>
        deps.api(`/api/children/${child.id}`, "PATCH", { name: nickname.current!.value.trim() }),
      async () => {
        if ((await deps.sync(true)) && action.active()) {
          deps.repaint()
          deps.toast("孩子昵称已更新")
        }
      },
    )
  }
  async function leave() {
    await action.confirm(
      "manage",
      () => deps.api(`/api/children/${child.id}/members/${deps.context().user.id}`, "DELETE"),
      async () => {
        const available = await deps.sync(true)
        if (!action.active()) return
        if (!available) deps.home()
        else deps.repaint()
      },
    )
  }
  async function remove() {
    await action.confirm(
      "delete",
      () => deps.api(`/api/children/${child.id}`, "DELETE"),
      () => {
        deps.forgetChild(child.id)
        deps.home()
      },
    )
  }
  return (
    <>
      <div className="settings-child-summary">
        <span className="settings-large-avatar">{initial(child.name)}</span>
        <div>
          <strong>{child.name}</strong>
          <p>
            {owner ? "我是管理员" : "成员"}
            {child.archived ? " · 已归档" : ""}
          </p>
        </div>
      </div>
      {!editable && (
        <Notice>
          {child.archived
            ? "孩子已归档，当前仅可查看和导出。"
            : "孩子昵称由管理员修改，你可以共同管理任务、积分和礼品。"}
        </Notice>
      )}
      <form id="renameChildForm" className="settings-form" onSubmit={submit}>
        <fieldset disabled={!editable || !!action.busy}>
          <FormField
            className="settings-field"
            id="renameChild"
            label="孩子昵称"
            help="用于孩子卡片、日历和导出记录，最多 40 个字。"
          >
            <Input
              ref={nickname}
              id="renameChild"
              defaultValue={child.name}
              required
              maxLength={40}
              placeholder="请输入孩子昵称"
              autoComplete="off"
            />
          </FormField>
          <Feedback id="childManageError" message={action.error} />
          <div className="settings-form-footer">
            <Button variant="default" type="submit">
              {action.busy === "nickname" ? "正在处理…" : "保存昵称"}
            </Button>
          </div>
        </fieldset>
      </form>
      <details className="settings-more">
        <summary>更多孩子管理</summary>
        <div>
          <p>
            {owner
              ? "删除后，所有成员将无法使用这个孩子的成长记录，不支持恢复。"
              : "退出管理后，你将无法查看这个孩子的成长记录。其他家长的数据会保留。"}
          </p>
          <Button
            variant="destructive"
            type="button"
            id={owner ? "deleteChild" : "leaveChild"}
            disabled={!!action.busy}
            onClick={() => {
              action.setError("")
              if (owner) setDeleting(true)
              else setLeaving(true)
            }}
          >
            {action.busy === "manage" ? "正在处理…" : owner ? "删除孩子" : "退出管理该孩子"}
          </Button>
        </div>
      </details>
      <AsyncConfirm
        open={leaving}
        onOpenChange={setLeaving}
        title={`退出管理「${child.name}」？`}
        description="退出后，你将失去这个孩子的数据访问权限。其他家长的成长记录会保留。"
        confirmLabel="退出管理"
        destructive
        onConfirm={leave}
      />
      <AsyncConfirm
        id="deleteChildDialog"
        cancelId="cancelDeleteChild"
        confirmId="confirmDeleteChild"
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除「${child.name}」？`}
        description="删除后，你和其他成员将无法查看或使用这个孩子的成长记录，不支持恢复。"
        confirmLabel="删除孩子"
        destructive
        onConfirm={remove}
      />
    </>
  )
}

export function Family({ controller, child }: { controller: Controller; child: Child }) {
  const { deps } = controller,
    action = useAction(controller),
    login = useRef<HTMLInputElement>(null)
  const owner = child.role === "owner",
    editable = owner && !child.archived
  const [memberAction, setMemberAction] = useState<{
    type: "transfer" | "remove"
    member: Member
  } | null>(null)
  const [reload, setReload] = useState(0)
  const read = useRead(async () => {
    const [members, sent] = await Promise.all([
      deps.api<{ members: Member[] }>(`/api/children/${child.id}/members`),
      owner
        ? deps.api<{ invitations: Invitation[] }>(`/api/children/${child.id}/invitations`)
        : Promise.resolve({ invitations: [] as Invitation[] }),
    ])
    return {
      members: members.members,
      sent: sent.invitations.filter((inv) => !["revoked", "accepted"].includes(inv.status)),
    }
  }, reload)
  if (!read.value)
    return (
      <ReadStatus
        error={read.error}
        loading="正在读取家人信息…"
        retry={() => setReload((value) => value + 1)}
      />
    )
  const { members, sent } = read.value
  function change(key: string, path: string, method: string, body?: unknown) {
    if (!editable) return
    action.run(
      key,
      () => deps.api(path, method, body),
      async () => {
        const available = await deps.sync(false)
        if (!action.active()) return
        if (!available) deps.home()
        else controller.refresh()
      },
    )
  }
  async function confirmMemberAction() {
    if (!editable || !memberAction) throw new Error("当前无法修改成员权限，请刷新后重试。")
    const { type, member } = memberAction
    await action.confirm(
      member.userId,
      () =>
        type === "transfer"
          ? deps.api(`/api/children/${child.id}/transfer`, "POST", { userId: member.userId })
          : deps.api(`/api/children/${child.id}/members/${member.userId}`, "DELETE"),
      async () => {
        const available = await deps.sync(false)
        if (!action.active()) return
        if (!available) deps.home()
        else controller.refresh()
      },
    )
  }
  return (
    <>
      <AsyncConfirm
        open={!!memberAction}
        onOpenChange={(open) => {
          if (!open) setMemberAction(null)
        }}
        title={
          memberAction?.type === "transfer"
            ? `将管理员身份转让给「${memberAction.member.nickname}」？`
            : `移除「${memberAction?.member.nickname || "家长"}」？`
        }
        description={
          memberAction?.type === "transfer"
            ? "转让后，你将成为成员，由这位家长负责管理孩子。"
            : "移除后，该家长将无法访问这个孩子的成长记录。"
        }
        confirmLabel={memberAction?.type === "transfer" ? "确认转让" : "移除家长"}
        destructive
        onConfirm={confirmMemberAction}
      />
      {editable ? (
        <form
          id="inviteParentForm"
          className="settings-invite-form"
          onSubmit={(event) => {
            event.preventDefault()
            change("invite", `/api/children/${child.id}/invitations`, "POST", {
              loginName: login.current!.value.trim(),
            })
          }}
        >
          <fieldset disabled={action.busy === "invite"}>
            <div className="settings-field">
              <Label htmlFor="inviteLogin">家人的登录名</Label>
              <div className="settings-inline-field">
                <Input
                  ref={login}
                  id="inviteLogin"
                  required
                  minLength={3}
                  maxLength={32}
                  autoComplete="off"
                  autoCapitalize="none"
                  placeholder="输入已开通账号的登录名"
                />
                <Button type="submit" variant="default">
                  {action.busy === "invite" ? "正在处理…" : "发送邀请"}
                </Button>
              </div>
              <p className="settings-help">
                家人需要先由管理员开通账号。接受邀请后，仅共享当前孩子的任务、积分和礼品。
              </p>
            </div>
            <Feedback id="childManageError" message={action.error} />
          </fieldset>
        </form>
      ) : (
        <>
          <Notice>
            {child.archived
              ? "孩子已归档，家人管理暂不可修改。"
              : "只有孩子管理员可以邀请家人和调整共同管理权限。"}
          </Notice>
          <Feedback id="childManageError" message={action.error} />
        </>
      )}
      <section className="settings-section">
        <div className="settings-section-title">
          <h3>成员</h3>
          <span>{members.length} 人</span>
        </div>
        <Card className="settings-member-list gap-0 py-0">
          {members.map((member) => (
            <article className="settings-person-row" key={member.userId}>
              <span className="settings-mini-avatar">{initial(member.nickname)}</span>
              <div className="settings-person-copy">
                <strong>
                  {member.nickname}
                  {member.userId === deps.context().user.id && (
                    <>
                      {" "}
                      <small>我</small>
                    </>
                  )}
                </strong>
                <p>{member.loginName}</p>
              </div>
              <Badge className={`settings-status ${member.role === "owner" ? "is-owner" : ""}`}>
                {member.role === "owner" ? "管理员" : "成员"}
              </Badge>
              {editable && member.role !== "owner" && (
                <RowMenu
                  label={`管理 ${member.nickname}`}
                  disabled={!!action.busy}
                  actions={[
                    {
                      label: "转让管理员身份",
                      selector: { "data-transfer": member.userId },
                      onSelect: () => setMemberAction({ type: "transfer", member }),
                    },
                    {
                      label: "移除家长",
                      destructive: true,
                      selector: { "data-remove": member.userId },
                      onSelect: () => setMemberAction({ type: "remove", member }),
                    },
                  ]}
                />
              )}
            </article>
          ))}
        </Card>
      </section>
      {owner && (
        <section className="settings-section">
          <div className="settings-section-title">
            <h3>已发邀请</h3>
            <span>{sent.filter((inv) => inv.status === "pending").length} 份待接受</span>
          </div>
          {sent.length ? (
            <Card className="settings-member-list gap-0 py-0">
              {sent.map((inv) => (
                <article className="settings-person-row" key={inv.id}>
                  <span className="settings-mini-avatar muted-avatar">{initial(inv.nickname)}</span>
                  <div className="settings-person-copy">
                    <strong>{inv.nickname}</strong>
                    <p>
                      {inv.loginName}
                      {inv.status === "pending" && <span> · 待接受</span>}
                    </p>
                    <small className="settings-invitation-sent-at">
                      发出于 <time dateTime={inv.createdAt}>{date(inv.createdAt)}</time>
                    </small>
                  </div>
                  {inv.status === "pending" ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="settings-small-btn"
                      data-revoke={inv.id}
                      disabled={!editable || !!action.busy}
                      onClick={() =>
                        change(inv.id, `/api/children/${child.id}/invitations/${inv.id}`, "DELETE")
                      }
                    >
                      {action.busy === inv.id ? "正在处理…" : "撤销邀请"}
                    </Button>
                  ) : (
                    <>
                      <Badge className="settings-status">
                        {statusNames[inv.status] || "已处理"}
                      </Badge>
                      {inv.status === "rejected" && (
                        <Button
                          type="button"
                          variant="destructive"
                          className="settings-small-btn"
                          data-delete-invitation={inv.id}
                          disabled={!editable || !!action.busy}
                          onClick={() =>
                            change(
                              inv.id,
                              `/api/children/${child.id}/invitations/${inv.id}`,
                              "DELETE",
                            )
                          }
                        >
                          {action.busy === inv.id ? "正在处理…" : "删除"}
                        </Button>
                      )}
                    </>
                  )}
                </article>
              ))}
            </Card>
          ) : (
            <Empty title="暂无已发邀请" copy="邀请家人，共同记录孩子的成长。" />
          )}
        </section>
      )}
    </>
  )
}

export function Invitations({ controller }: { controller: Controller }) {
  const { deps } = controller,
    action = useAction(controller),
    [reload, setReload] = useState(0)
  const [notice, setNotice] = useState<{ answer: string; childId: string } | null>(null)
  const read = useRead(() => deps.api<{ invitations: Invitation[] }>("/api/invitations"), reload)
  if (!read.value)
    return (
      <ReadStatus
        error={read.error}
        loading="正在读取我的邀请…"
        retry={() => setReload((value) => value + 1)}
      />
    )
  const answer = (inv: Invitation, value: string) =>
    action.run(
      inv.id,
      () => deps.api<{ childId: string }>(`/api/invitations/${inv.id}/${value}`, "POST", {}),
      async (result) => {
        await deps.sync(false)
        if (!action.active()) return
        setNotice({ answer: value, childId: result.childId })
        setReload((value) => value + 1)
      },
    )
  return (
    <>
      {notice && (
        <div className="settings-success-banner" role="status">
          <span>
            {notice.answer === "accept" ? "已接受邀请，可以一起记录成长了。" : "已拒绝这份邀请。"}
          </span>
          {notice.answer === "accept" && (
            <Button
              type="button"
              variant="outline"
              data-enter-invited-child
              onClick={() => deps.selectChild(notice.childId)}
            >
              进入孩子
            </Button>
          )}
        </div>
      )}
      <Feedback id="invitationError" message={action.error || read.error} />
      <div className="settings-invitation-list">
        {read.value.invitations.length ? (
          read.value.invitations.map((inv) => (
            <Card className="settings-invitation-card" key={inv.id}>
              <div className="settings-person-row">
                <span className="settings-large-avatar">{initial(inv.childName)}</span>
                <div className="settings-person-copy">
                  <strong>{inv.childName}</strong>
                  <p>邀请你成为成员</p>
                </div>
                <Badge className="settings-status is-owner">待处理</Badge>
              </div>
              <p className="settings-help">接受后，可以查看和管理这个孩子的任务、积分与礼品。</p>
              <div className="settings-invitation-footer">
                <span>{date(inv.expiresAt)} 前有效</span>
                <div>
                  <Button
                    variant="outline"
                    type="button"
                    data-reject-invite={inv.id}
                    disabled={!!action.busy}
                    onClick={() => answer(inv, "reject")}
                  >
                    {action.busy === inv.id ? "正在处理…" : "拒绝邀请"}
                  </Button>
                  <Button
                    variant="default"
                    type="button"
                    data-accept-invite={inv.id}
                    disabled={!!action.busy}
                    onClick={() => answer(inv, "accept")}
                  >
                    接受邀请
                  </Button>
                </div>
              </div>
            </Card>
          ))
        ) : (
          <Empty title="暂无待处理邀请" copy="收到家人的邀请后，会在这里显示。" />
        )}
      </div>
    </>
  )
}

import { AccountAvatar, familyRoleLabel } from "../features/account-avatar"
import { ChildCreateDialog } from "./child-create-dialog"
import { ChildAvatar } from "../features/child-avatar"
import { ChildAvatarDialog } from "./child-avatar-dialog"
import { childGenderLabel } from "../features/child-gender-picker"
import { useState } from "react"
import {
  Badge,
  Button,
  Card,
  Empty,
  Feedback,
  Icon,
  Notice,
  ReadStatus,
  RowMenu,
  date,
  useAction,
  useRead,
} from "./primitives"
import type { Child, Controller, Invitation, Member } from "./types"
import { AsyncConfirm } from "@shared/components/async-confirm"
import { Pencil, Plus, UserRoundPlus } from "lucide-react"
import { ChildFormDialog } from "./child-form-dialog"

export function ChildManagement({ controller, child }: { controller: Controller; child: Child }) {
  const { deps } = controller
  const action = useAction(controller)
  const [creating, setCreating] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [reload, setReload] = useState(0)
  const [memberAction, setMemberAction] = useState<{
    type: "transfer" | "remove"
    member: Member
  } | null>(null)
  const owner = child.role === "owner"
  const editable = owner && !child.archived
  const read = useRead(async () => {
    const [members, invitations] = await Promise.all([
      deps.api<{ members: Member[] }>(`/api/children/${child.id}/members`),
      deps.api<{ invitations: Invitation[] }>(`/api/children/${child.id}/invitations`),
    ])
    return {
      members: [...members.members].sort(
        (a, b) => Number(b.role === "owner") - Number(a.role === "owner"),
      ),
      invitations: invitations.invitations
        .filter((inv) => inv.status === "pending")
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    }
  }, reload)
  async function refresh() {
    const available = await deps.sync(false)
    if (!action.active()) return
    if (!available) deps.home()
    else {
      setReload((value) => value + 1)
      deps.repaint()
    }
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
      refresh,
    )
  }
  async function leave() {
    await action.confirm(
      "leave",
      () => deps.api(`/api/children/${child.id}/members/${deps.context().user.id}`, "DELETE"),
      async () => {
        if (!(await deps.sync(true))) deps.home()
        else if (action.active()) deps.repaint()
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
    <div className="child-management">
      <div className="child-management-profile-card">
        <h2 id="settingsDetailTitle" tabIndex={-1}>
          儿童管理
        </h2>
        <div className="child-management-profile">
          <button
            type="button"
            id="changeChildAvatar"
            className="child-management-avatar"
            aria-label="修改头像和性别"
            title={editable ? "修改头像和性别" : "儿童头像和性别由管理员修改"}
            disabled={!editable || !!action.busy}
            onClick={() => setAvatarOpen(true)}
          >
            <ChildAvatar id={child.avatarId} />
          </button>
          <div className="child-management-profile-copy">
            <div className="child-management-profile-name">
              <strong>{child.name}</strong>
              {editable && (
                <Button
                  id="editChildNickname"
                  variant="ghost"
                  size="icon"
                  type="button"
                  aria-label="修改儿童昵称"
                  disabled={!!action.busy}
                  onClick={() => setEditing(true)}
                >
                  <Pencil aria-hidden="true" strokeWidth={1.5} />
                </Button>
              )}
            </div>
            <Badge asChild variant="secondary" className="child-gender-tag" data-child-gender>
              <button
                id="changeChildGender"
                data-gender={child.gender || undefined}
                type="button"
                disabled={!editable || !!action.busy}
                aria-label={`${childGenderLabel(child.gender)}，修改头像和性别`}
                aria-haspopup="dialog"
                aria-expanded={avatarOpen}
                onClick={() => setAvatarOpen(true)}
              >
                {childGenderLabel(child.gender)}
              </button>
            </Badge>
            {!child.archived && (
              <p className="child-management-profile-help">
                儿童昵称、家庭邀请和成员权限由管理员管理。
              </p>
            )}
          </div>
          <Button
            id="openCreateChild"
            className="child-management-add"
            type="button"
            disabled={!!action.busy}
            onClick={() => setCreating(true)}
          >
            <Plus data-icon="inline-start" />
            添加儿童
          </Button>
        </div>
      </div>
      {child.archived && <Notice>儿童已归档，当前仅可查看。</Notice>}
      <section className="child-family-section" aria-labelledby="familyMembersTitle">
        <div className="child-family-heading">
          <div>
            <h3 id="familyMembersTitle">家庭成员</h3>
          </div>
          {editable && (
            <Button
              id="openInviteFamily"
              type="button"
              disabled={!!action.busy}
              onClick={() => setInviting(true)}
            >
              <UserRoundPlus data-icon="inline-start" />
              邀请家人
            </Button>
          )}
        </div>
        <Feedback id="childManageError" message={action.error} />
        {!read.value ? (
          <ReadStatus
            error={read.error}
            loading="正在读取家庭成员…"
            retry={() => setReload((value) => value + 1)}
          />
        ) : (
          <>
            {read.error && (
              <ReadStatus
                error={read.error}
                loading=""
                retry={() => setReload((value) => value + 1)}
              />
            )}
            <ul className="child-family-list">
              {read.value.members.map((member) => (
                <li className="child-family-item" key={member.userId} data-member={member.userId}>
                  <Card className="child-family-row gap-0 py-0">
                    <div className="child-member-header">
                      <span className="settings-mini-avatar" aria-hidden="true">
                        <AccountAvatar id={member.avatarId} />
                      </span>
                      <div className="child-family-identity">
                        <div className="child-family-name">
                          <strong>{member.nickname}</strong>
                          <Badge
                            variant="secondary"
                            className={`settings-status ${member.role === "owner" ? "is-owner" : ""}`}
                          >
                            {member.role === "owner" ? "管理员" : "成员"}
                          </Badge>
                        </div>
                        <p>账号 ID：{member.loginName}</p>
                        <p data-member-family-role>角色：{familyRoleLabel(member.avatarId)}</p>
                      </div>
                    </div>
                    <div className="child-member-actions">
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
                              label: "移出家庭",
                              destructive: true,
                              selector: { "data-remove": member.userId },
                              onSelect: () => setMemberAction({ type: "remove", member }),
                            },
                          ]}
                        />
                      )}
                    </div>
                  </Card>
                </li>
              ))}
              {read.value.invitations.map((inv) => (
                <li className="child-family-item" key={inv.id} data-pending-invitation={inv.id}>
                  <Card className="child-family-row gap-0 py-0">
                    <div className="child-member-header">
                      <span className="settings-mini-avatar muted-avatar" aria-hidden="true">
                        <AccountAvatar id={inv.avatarId} />
                      </span>
                      <div className="child-family-identity">
                        <div className="child-family-name">
                          <strong>{inv.nickname}</strong>
                          <Badge variant="secondary" className="settings-status is-pending">
                            待确认
                          </Badge>
                        </div>
                        <p>账号 ID：{inv.loginName}</p>
                        <p data-member-family-role>角色：{familyRoleLabel(inv.avatarId)}</p>
                      </div>
                    </div>
                    <div className="child-member-actions">
                      {editable && (
                        <RowMenu
                          label={`管理对${inv.nickname}的邀请`}
                          selector={{ "data-invitation-menu": inv.id }}
                          disabled={!!action.busy}
                          actions={[
                            {
                              label: "撤销邀请",
                              destructive: true,
                              selector: { "data-revoke": inv.id },
                              onSelect: () => {
                                void action.run(
                                  inv.id,
                                  () =>
                                    deps.api(
                                      `/api/children/${child.id}/invitations/${inv.id}`,
                                      "DELETE",
                                    ),
                                  refresh,
                                )
                              },
                            },
                          ]}
                        />
                      )}
                    </div>
                    <small className="child-member-validity">
                      有效期至 <time dateTime={inv.expiresAt}>{date(inv.expiresAt)}</time>
                    </small>
                  </Card>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <details className="settings-more child-management-more">
        <summary>更多儿童管理</summary>
        <div>
          <Button
            variant="destructive"
            type="button"
            id={owner ? "deleteChild" : "leaveChild"}
            disabled={!!action.busy || (owner && child.archived)}
            onClick={() => (owner ? setDeleting(true) : setLeaving(true))}
          >
            {owner ? "删除儿童" : "退出管理该儿童"}
          </Button>
          <p>
            {owner
              ? "删除后，所有成员将无法使用这个儿童的成长记录，不支持恢复。"
              : "退出管理后，你将无法查看这个儿童的成长记录。其他家长的数据会保留。"}
          </p>
        </div>
      </details>
      {creating && <ChildCreateDialog controller={controller} onClose={() => setCreating(false)} />}
      {avatarOpen && (
        <ChildAvatarDialog
          child={child}
          controller={controller}
          onClose={() => setAvatarOpen(false)}
        />
      )}
      <ChildFormDialog
        key={`rename:${editing}`}
        kind="rename"
        open={editing}
        onOpenChange={setEditing}
        child={child}
        controller={controller}
        onSaved={() => setReload((value) => value + 1)}
      />
      <ChildFormDialog
        key={`invite:${inviting}`}
        kind="invite"
        open={inviting}
        onOpenChange={setInviting}
        child={child}
        controller={controller}
        onSaved={() => setReload((value) => value + 1)}
      />
      <AsyncConfirm
        open={!!memberAction}
        onOpenChange={(open) => {
          if (!open) setMemberAction(null)
        }}
        title={
          memberAction?.type === "transfer"
            ? `将管理员身份转让给「${memberAction.member.nickname}」？`
            : `将「${memberAction?.member.nickname || "家长"}」移出家庭？`
        }
        description={
          memberAction?.type === "transfer"
            ? "转让后，你将成为成员，由这位家长负责管理儿童。"
            : "移出后，该家长将无法访问这个儿童的成长记录。"
        }
        confirmLabel={memberAction?.type === "transfer" ? "确认转让" : "移出家庭"}
        destructive
        onConfirm={confirmMemberAction}
      />
      <AsyncConfirm
        open={leaving}
        onOpenChange={setLeaving}
        title={`退出管理「${child.name}」？`}
        description="退出后，你将失去这个儿童的数据访问权限。其他家长的成长记录会保留。"
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
        description="删除后，你和其他成员将无法查看或使用这个儿童的成长记录，不支持恢复。"
        confirmLabel="删除儿童"
        destructive
        onConfirm={remove}
      />
    </div>
  )
}

export function Invitations({ controller }: { controller: Controller }) {
  const { deps } = controller,
    action = useAction(controller),
    [reload, setReload] = useState(0)
  const [notice, setNotice] = useState("")
  const [accepted, setAccepted] = useState<Invitation[]>([])
  const [resolved, setResolved] = useState<string[]>([])
  const read = useRead(() => deps.api<{ invitations: Invitation[] }>("/api/invitations"), reload)
  if (!read.value)
    return (
      <ReadStatus
        error={read.error}
        loading="正在读取我的邀请…"
        retry={() => setReload((value) => value + 1)}
      />
    )
  const invitations = [
    ...accepted,
    ...read.value.invitations.filter((inv) => !resolved.includes(inv.id)),
  ]
  const enter = (inv: Invitation) =>
    action.run(inv.id, async () => {
      await deps.sync(false)
      if (action.active()) await deps.selectChild(inv.childId)
    })
  const answer = (inv: Invitation, value: string) =>
    action.run(
      inv.id,
      () => deps.api<{ childId: string }>(`/api/invitations/${inv.id}/${value}`, "POST", {}),
      async (result) => {
        setResolved((ids) => [...ids, inv.id])
        if (value === "accept") setAccepted((items) => [...items, inv])
        setNotice(value === "accept" ? "" : "已拒绝这份邀请。")
        setReload((value) => value + 1)
        await deps.sync(false)
        if (!action.active() || value !== "accept") return
        const childIds = new Set([
          ...deps.context().children.map((child) => child.id),
          ...invitations.map((item) => item.childId),
        ])
        if (childIds.size === 1) await deps.selectChild(result.childId)
      },
    )
  return (
    <>
      {notice && (
        <div className="settings-success-banner" role="status">
          {notice}
        </div>
      )}
      <Feedback id="invitationError" message={action.error || read.error} />
      <div className="settings-invitation-list">
        {invitations.length ? (
          invitations.map((inv) => {
            const joined = accepted.some((item) => item.id === inv.id)
            return (
              <Card className="settings-invitation-card" key={inv.id} data-invitation-card={inv.id}>
                <div className="settings-person-row">
                  <span className="settings-large-avatar" aria-hidden="true">
                    <ChildAvatar id={inv.childAvatarId} />
                  </span>
                  <div className="settings-person-copy">
                    <strong>{inv.childName}</strong>
                    <p>{joined ? "已成为家庭成员" : "邀请你成为成员"}</p>
                  </div>
                  <Badge className="settings-status is-owner">{joined ? "已接受" : "待处理"}</Badge>
                </div>
                <p className="settings-help">
                  {joined
                    ? "可以查看和管理这个孩子的任务、积分与礼品。"
                    : "接受后，可以查看和管理这个孩子的任务、积分与礼品。"}
                </p>
                <div className="settings-invitation-footer">
                  <span>{joined ? "已加入家庭" : `${date(inv.expiresAt)} 前有效`}</span>
                  <div>
                    {joined ? (
                      <Button
                        type="button"
                        data-enter-invited-child={inv.childId}
                        disabled={!!action.busy}
                        onClick={() => enter(inv)}
                      >
                        进入
                      </Button>
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                </div>
              </Card>
            )
          })
        ) : (
          <Empty title="暂无待处理邀请" copy="收到家人的邀请后，会在这里显示。" />
        )}
      </div>
    </>
  )
}

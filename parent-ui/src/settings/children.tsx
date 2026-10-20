import { useRef, useState, type FormEvent } from "react"
import { Badge, Button, Card, Empty, Feedback, Icon, Input, Label, Notice, ReadStatus, date, initial, statusNames, useAction, useRead } from "./primitives"
import type { Child, Controller, Invitation, Member } from "./types"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"

export function ChildProfile({ controller, child }: { controller: Controller; child: Child }) {
  const { deps } = controller, action = useAction(controller), nickname = useRef<HTMLInputElement>(null)
  const [deleting, setDeleting] = useState(false)
  const owner = child.role === "owner", editable = owner && !child.archived
  function submit(event: FormEvent) {
    event.preventDefault(); if (!editable) return
    action.run("nickname", () => deps.api(`/api/children/${child.id}`, "PATCH", { name: nickname.current!.value.trim() }), async () => {
      if (await deps.sync(true) && action.active()) { deps.repaint(); deps.toast("孩子昵称已更新") }
    })
  }
  function manage() {
    if (owner) { action.setError(""); setDeleting(true); return }
    if (!confirm("退出后将失去这个孩子的数据访问权限。确认退出管理？")) return
    action.run("manage", () => deps.api(`/api/children/${child.id}/members/${deps.context().user.id}`, "DELETE"), async () => {
      const available = await deps.sync(true); if (!action.active()) return
      if (!available) deps.home(); else deps.repaint()
    })
  }
  function remove() {
    action.run("delete", () => deps.api(`/api/children/${child.id}`, "DELETE"), () => {
      deps.forgetChild(child.id)
      deps.home()
    })
  }
  return <>
    <div className="settings-child-summary"><span className="settings-large-avatar">{initial(child.name)}</span><div><strong>{child.name}</strong><p>{owner ? "我是负责人" : "共同管理家长"}{child.archived ? " · 已归档" : ""}</p></div></div>
    {!editable && <Notice>{child.archived ? "孩子已归档，当前仅可查看和导出。" : "孩子昵称由管理员修改，你可以共同管理任务、积分和礼品。"}</Notice>}
    <form id="renameChildForm" className="settings-form" onSubmit={submit}><fieldset disabled={!editable || !!action.busy}>
      <div className="settings-field"><Label htmlFor="renameChild">孩子昵称</Label><Input ref={nickname} id="renameChild" defaultValue={child.name} required maxLength={40} placeholder="请输入孩子昵称" autoComplete="off" /><p className="settings-help">用于孩子卡片、日历和导出记录，最多 40 个字。</p></div>
      <Feedback id="childManageError" message={action.error} /><div className="settings-form-footer"><Button className="btn primary" type="submit">{action.busy === "nickname" ? "正在处理…" : "保存昵称"}</Button></div>
    </fieldset></form>
    <details className="settings-more"><summary>更多孩子管理</summary><div><p>{owner ? "删除后，所有成员将无法使用这个孩子的成长记录，不支持恢复。" : "退出管理后，你将无法查看这个孩子的成长记录。其他家长的数据会保留。"}</p><Button className="btn danger" type="button" id={owner ? "deleteChild" : "leaveChild"} disabled={!!action.busy} onClick={manage}>{action.busy === "manage" ? "正在处理…" : owner ? "删除孩子" : "退出管理该孩子"}</Button></div></details>
    <AlertDialog open={deleting} onOpenChange={open => { if (!action.busy) setDeleting(open) }}>
      <AlertDialogContent id="deleteChildDialog" className="child-delete-dialog" onEscapeKeyDown={event => { if (action.busy) event.preventDefault() }}>
        <AlertDialogHeader className="child-delete-heading"><AlertDialogTitle>删除「{child.name}」？</AlertDialogTitle><AlertDialogDescription>删除后，你和其他成员将无法查看或使用这个孩子的成长记录，不支持恢复。</AlertDialogDescription></AlertDialogHeader>
        <Feedback id="deleteChildError" message={action.error} />
        <AlertDialogFooter className="child-delete-actions"><AlertDialogCancel id="cancelDeleteChild" className="btn" disabled={!!action.busy}>取消</AlertDialogCancel><AlertDialogAction id="confirmDeleteChild" className="btn danger" disabled={!!action.busy} onClick={event => { event.preventDefault(); remove() }}>{action.busy === "delete" ? "正在删除…" : "删除孩子"}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}

export function Family({ controller, child }: { controller: Controller; child: Child }) {
  const { deps } = controller, action = useAction(controller), login = useRef<HTMLInputElement>(null)
  const owner = child.role === "owner", editable = owner && !child.archived
  const read = useRead(async () => {
    const [members, sent] = await Promise.all([
      deps.api<{ members: Member[] }>(`/api/children/${child.id}/members`),
      owner ? deps.api<{ invitations: Invitation[] }>(`/api/children/${child.id}/invitations`) : Promise.resolve({ invitations: [] as Invitation[] }),
    ])
    return { members: members.members, sent: sent.invitations.filter(inv => !["revoked", "accepted"].includes(inv.status)) }
  })
  if (!read.value) return <ReadStatus error={read.error} loading="正在读取家人信息…" retry={controller.refresh} />
  const { members, sent } = read.value
  function change(key: string, path: string, method: string, body?: unknown) {
    if (!editable) return
    action.run(key, () => deps.api(path, method, body), async () => {
      const available = await deps.sync(false); if (!action.active()) return
      if (!available) deps.home(); else controller.refresh()
    })
  }
  return <>
    {editable ? <form id="inviteParentForm" className="settings-invite-form" onSubmit={event => { event.preventDefault(); change("invite", `/api/children/${child.id}/invitations`, "POST", { loginName: login.current!.value.trim() }) }}><fieldset disabled={action.busy === "invite"}><div className="settings-field"><Label htmlFor="inviteLogin">家人的登录名</Label><div className="settings-inline-field"><Input ref={login} id="inviteLogin" required minLength={3} maxLength={32} autoComplete="off" autoCapitalize="none" placeholder="输入已开通账号的登录名" /><Button type="submit" className="btn primary">{action.busy === "invite" ? "正在处理…" : "发送邀请"}</Button></div><p className="settings-help">家人需要先由管理员开通账号。接受邀请后，仅共享当前孩子的任务、积分和礼品。</p></div><Feedback id="childManageError" message={action.error} /></fieldset></form> : <><Notice>{child.archived ? "孩子已归档，家人管理暂不可修改。" : "只有孩子负责人可以邀请家人和调整共同管理权限。"}</Notice><Feedback id="childManageError" message={action.error} /></>}
    <section className="settings-section"><div className="settings-section-title"><h3>共同管理家长</h3><span>{members.length} 人</span></div><Card className="settings-member-list">{members.map(member => <article className="settings-person-row" key={member.userId}>
      <span className="settings-mini-avatar">{initial(member.nickname)}</span><div className="settings-person-copy"><strong>{member.nickname}{member.userId === deps.context().user.id && <> <small>我</small></>}</strong><p>{member.loginName}</p></div><Badge className={`settings-status ${member.role === "owner" ? "is-owner" : ""}`}>{member.role === "owner" ? "管理员" : "成员"}</Badge>
      {editable && member.role !== "owner" && <details className="settings-member-actions"><summary aria-label={`管理 ${member.nickname}`}>管理</summary><div><Button type="button" data-transfer={member.userId} disabled={!!action.busy} onClick={() => { if (confirm("转让后，你将成为共同管理家长。确认转让负责身份？")) change(member.userId, `/api/children/${child.id}/transfer`, "POST", { userId: member.userId }) }}>转让负责身份</Button><Button type="button" className="danger" data-remove={member.userId} disabled={!!action.busy} onClick={() => { if (confirm("移除后，该家长将无法访问这个孩子的成长记录。确认移除？")) change(member.userId, `/api/children/${child.id}/members/${member.userId}`, "DELETE") }}>移除家长</Button></div></details>}
    </article>)}</Card></section>
    {owner && <section className="settings-section"><div className="settings-section-title"><h3>已发邀请</h3><span>{sent.filter(inv => inv.status === "pending").length} 份待接受</span></div>{sent.length ? <Card className="settings-member-list">{sent.map(inv => <article className="settings-person-row" key={inv.id}>
      <span className="settings-mini-avatar muted-avatar">{initial(inv.nickname)}</span><div className="settings-person-copy"><strong>{inv.nickname}</strong><p>{inv.loginName}{inv.status === "pending" && <span> · 待接受</span>}</p><small className="settings-invitation-sent-at">发出于 <time dateTime={inv.createdAt}>{date(inv.createdAt)}</time></small></div>
      {inv.status === "pending" ? <Button type="button" className="btn settings-small-btn" data-revoke={inv.id} disabled={!editable || !!action.busy} onClick={() => change(inv.id, `/api/children/${child.id}/invitations/${inv.id}`, "DELETE")}>{action.busy === inv.id ? "正在处理…" : "撤销邀请"}</Button> : <><Badge className="settings-status">{statusNames[inv.status] || "已处理"}</Badge>{inv.status === "rejected" && <Button type="button" className="btn danger settings-small-btn" data-delete-invitation={inv.id} disabled={!editable || !!action.busy} onClick={() => change(inv.id, `/api/children/${child.id}/invitations/${inv.id}`, "DELETE")}>{action.busy === inv.id ? "正在处理…" : "删除"}</Button>}</>}
    </article>)}</Card> : <Empty title="暂无已发邀请" copy="邀请家人，共同记录孩子的成长。" />}</section>}
  </>
}

export function Invitations({ controller }: { controller: Controller }) {
  const { deps } = controller, action = useAction(controller), [reload, setReload] = useState(0)
  const [notice, setNotice] = useState<{ answer: string; childId: string } | null>(null)
  const read = useRead(() => deps.api<{ invitations: Invitation[] }>("/api/invitations"), reload)
  if (!read.value) return <ReadStatus error={read.error} loading="正在读取我的邀请…" retry={controller.refresh} />
  const answer = (inv: Invitation, value: string) => action.run(inv.id, () => deps.api<{ childId: string }>(`/api/invitations/${inv.id}/${value}`, "POST", {}), async result => {
    await deps.sync(false); if (!action.active()) return
    setNotice({ answer: value, childId: result.childId }); setReload(value => value + 1)
  })
  return <>
    {notice && <div className="settings-success-banner" role="status"><span>{notice.answer === "accept" ? "已接受邀请，可以一起记录成长了。" : "已拒绝这份邀请。"}</span>{notice.answer === "accept" && <Button type="button" className="btn" data-enter-invited-child onClick={() => deps.selectChild(notice.childId)}>进入孩子</Button>}</div>}
    <Feedback id="invitationError" message={action.error || read.error} />
    <div className="settings-invitation-list">{read.value.invitations.length ? read.value.invitations.map(inv => <Card className="settings-invitation-card" key={inv.id}>
      <div className="settings-person-row"><span className="settings-large-avatar">{initial(inv.childName)}</span><div className="settings-person-copy"><strong>{inv.childName}</strong><p>邀请你成为共同管理家长</p></div><Badge className="settings-status is-owner">待处理</Badge></div><p className="settings-help">接受后，可以查看和管理这个孩子的任务、积分与礼品。</p><div className="settings-invitation-footer"><span>{date(inv.expiresAt)} 前有效</span><div><Button className="btn" type="button" data-reject-invite={inv.id} disabled={!!action.busy} onClick={() => answer(inv, "reject")}>{action.busy === inv.id ? "正在处理…" : "拒绝邀请"}</Button><Button className="btn primary" type="button" data-accept-invite={inv.id} disabled={!!action.busy} onClick={() => answer(inv, "accept")}>接受邀请</Button></div></div>
    </Card>) : <Empty title="暂无待处理邀请" copy="收到家人的邀请后，会在这里显示。" />}</div>
  </>
}

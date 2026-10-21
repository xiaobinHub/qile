import { useState, useRef, useEffect } from "react"
import { Gift as GiftIcon, Plus, Settings2, ChevronDown, History } from "lucide-react"
import { Badge } from "@shared/components/ui/badge"
import { EmptyState } from "@shared/components/empty-state"
import { PageHeading } from "@shared/components/page-heading"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@shared/components/ui/tabs"
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@shared/components/ui/table"
import {
  Button,
  Input,
  Card,
  Choice,
  DatePicker,
  DateRangePicker,
  Field,
  Modal,
  Confirm,
  ErrorText,
  useAsync,
} from "./ui"
import { runtime } from "../lib/runtime"
import { balance, today } from "../domain/calendar"
import { compressGiftImage } from "../domain/images"
import type { BusinessData, Child, Gift, Ledger } from "../domain/types"
const source = (row: Ledger) =>
  row.kind.startsWith("gift-") ? "gift" : row.kind === "manual" ? "manual" : "task"
const sourceLabel = (row: Ledger) =>
  ({
    "task-complete": "完成任务",
    "task-reversal": "撤销完成",
    "gift-redeem": "兑换礼品",
    "gift-reversal": "撤销兑换",
    manual: "手动调整",
  })[row.kind]
export function StorePage({
  data,
  child,
  notify,
}: {
  data: BusinessData
  child: Child
  notify: (s: string) => void
}) {
  const [tab, setTab] = useState("gifts"),
    [historyOpen, setHistoryOpen] = useState(false),
    [manager, setManager] = useState(false),
    [editing, setEditing] = useState<Gift | true | null>(null),
    [manual, setManual] = useState(false),
    [confirm, setConfirm] = useState<{ gift: Gift; kind: "redeem" | "reverse" | "delete" } | null>(
      null,
    )
  const current = balance(data),
    available = data.gifts.filter((g) => g.status === "available"),
    redeemed = data.gifts.filter((g) => g.status === "redeemed")
  return (
    <section className="store-page">
      <PageHeading title="积分商城" className="store-heading" />
      {child.archived && <p className="notice">孩子已归档，商城仅可查看。</p>}
      <Tabs value={tab} onValueChange={setTab} className="store-tabs">
        <TabsList variant="line" aria-label="商城内容" className="store-tabs-list">
          <TabsTrigger value="gifts" data-store-tab="gifts">
            礼品兑换
          </TabsTrigger>
          <TabsTrigger value="ledger" data-store-tab="ledger">
            积分流水
          </TabsTrigger>
        </TabsList>
        <TabsContent value="gifts" className="store-tab-content">
          <section aria-labelledby="availableGiftsTitle">
            <header className="store-section-heading">
              <div className="store-section-title">
                <h2 id="availableGiftsTitle">可兑换礼品</h2>
                <Badge variant="secondary">{available.length}</Badge>
              </div>
              <Button
                variant="outline"
                id="giftManageBtn"
                disabled={child.archived}
                onClick={() => setManager(true)}
              >
                <Settings2 data-icon="inline-start" />
                管理礼品
              </Button>
            </header>
            {available.length ? (
              <div className="gift-grid">
                {available.map((g) => (
                  <Card className="gift-card" key={g.id} data-gift={g.id}>
                    <div className="gift-image" data-has-image={Boolean(g.imageData)}>
                      {g.imageData ? (
                        <img src={g.imageData} alt={g.name} />
                      ) : (
                        <GiftIcon aria-hidden />
                      )}
                    </div>
                    <div className="gift-card-body">
                      <h3 title={g.name}>{g.name}</h3>
                      <p className="gift-cost">
                        {g.points} <small>积分</small>
                      </p>
                      <div className="gift-card-actions">
                        {current < g.points && (
                          <p className="gift-shortage">还差 {g.points - current} 积分</p>
                        )}
                        <Button
                          data-redeem={g.id}
                          variant={current < g.points ? "secondary" : "default"}
                          disabled={child.archived || current < g.points}
                          onClick={() => setConfirm({ gift: g, kind: "redeem" })}
                        >
                          {current >= g.points ? "兑换礼品" : "积分不足"}
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <EmptyState
                title="暂无可兑换礼品"
                description="添加礼品，为孩子准备下一份奖励。"
                icon={<GiftIcon aria-hidden />}
              />
            )}
          </section>
          <section className="gift-history" aria-labelledby="giftHistoryTitle">
            <h2 id="giftHistoryTitle">
              <Button
                id="giftHistoryToggle"
                variant="ghost"
                className="gift-history-toggle"
                aria-expanded={historyOpen}
                aria-controls="giftHistoryList"
                onClick={() => setHistoryOpen((open) => !open)}
              >
                <span className="gift-history-label">
                  <History aria-hidden />
                  兑换记录<Badge variant="secondary">{redeemed.length}</Badge>
                </span>
                <span className="gift-history-state">
                  {historyOpen ? "收起" : "展开"}
                  <ChevronDown aria-hidden className={historyOpen ? "rotate-180" : undefined} />
                </span>
              </Button>
            </h2>
            <div id="giftHistoryList" hidden={!historyOpen}>
              {redeemed.length ? (
                <ul className="gift-history-list">
                  {redeemed.map((g) => (
                    <li className="gift-history-row" key={g.id} data-redeemed-gift={g.id}>
                      <div className="gift-history-image">
                        {g.imageData ? <img src={g.imageData} alt="" /> : <GiftIcon aria-hidden />}
                      </div>
                      <div className="gift-history-copy">
                        <h3>{g.name}</h3>
                        <p>
                          {g.redeemedAt ? (
                            <time dateTime={g.redeemedAt}>
                              {new Date(g.redeemedAt).toLocaleString("zh-CN")}
                            </time>
                          ) : (
                            "已兑换"
                          )}
                        </p>
                      </div>
                      <p className="gift-history-cost">
                        {g.points}
                        <span>积分</span>
                      </p>
                      <Button
                        variant="outline"
                        disabled={child.archived}
                        data-undo-gift={g.id}
                        onClick={() => setConfirm({ gift: g, kind: "reverse" })}
                      >
                        撤销兑换
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title="还没有兑换记录"
                  description="兑换礼品后，记录会显示在这里。"
                  icon={<History aria-hidden />}
                />
              )}
            </div>
          </section>
        </TabsContent>
        <TabsContent value="ledger" className="store-tab-content">
          <LedgerPanel data={data} archived={child.archived} onAdjust={() => setManual(true)} />
        </TabsContent>
      </Tabs>
      {manager && !editing && (
        <Modal id="giftManagerDialog" title="管理礼品" onClose={() => setManager(false)}>
          <Button id="newGiftBtn" onClick={() => setEditing(true)}>
            <Plus />
            创建礼品
          </Button>
          <div id="giftManagerList" className="manager-list">
            {data.gifts.map((g) => (
              <div className="manager-row" key={g.id}>
                <strong>{g.name}</strong>
                <span>{g.points} 分</span>
                <Button
                  variant="outline"
                  disabled={g.status !== "available"}
                  data-edit-gift={g.id}
                  onClick={() => setEditing(g)}
                >
                  编辑
                </Button>
                <Button
                  variant="destructive"
                  disabled={g.status !== "available"}
                  data-delete-gift={g.id}
                  onClick={() => setConfirm({ gift: g, kind: "delete" })}
                >
                  删除
                </Button>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {editing && (
        <GiftEditor
          gift={editing === true ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {manual && <ManualEditor onClose={() => setManual(false)} />}
      {confirm && (
        <Confirm
          id={confirm.kind === "redeem" ? "giftRedeemDialog" : "giftConfirmDialog"}
          title={
            confirm.kind === "redeem"
              ? `确认兑换「${confirm.gift.name}」？`
              : confirm.kind === "reverse"
                ? "撤销礼品兑换？"
                : `删除「${confirm.gift.name}」？`
          }
          description={
            confirm.kind === "redeem"
              ? `当前 ${current} 积分，兑换消耗 ${confirm.gift.points} 积分，剩余 ${current - confirm.gift.points} 积分。`
              : confirm.kind === "reverse"
                ? "撤销后返还原兑换积分，礼品恢复为可兑换。"
                : "礼品会从商城移除，历史积分流水保留。"
          }
          label={
            confirm.kind === "redeem"
              ? "确认兑换"
              : confirm.kind === "reverse"
                ? "撤销兑换"
                : "删除礼品"
          }
          work={async () => {
            await runtime.command(`gift.${confirm.kind}`, { id: confirm.gift.id })
            notify(
              confirm.kind === "redeem"
                ? "兑换成功"
                : confirm.kind === "reverse"
                  ? "已撤销兑换"
                  : "礼品已删除",
            )
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </section>
  )
}
function LedgerPanel({
  data,
  archived,
  onAdjust,
}: {
  data: BusinessData
  archived: boolean
  onAdjust: () => void
}) {
  const [range, setRange] = useState<{ from?: string; to?: string }>({}),
    [kind, setKind] = useState("all"),
    [direction, setDirection] = useState("all")
  let running = 0
  const rows = [...data.ledger]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((l) => ({ ...l, balanceAfter: (running += l.amount) }))
    .filter(
      (l) =>
        (!range.from || l.date >= range.from) &&
        (!range.to || l.date <= range.to) &&
        (kind === "all" || source(l) === kind) &&
        (direction === "all" || (direction === "plus" ? l.amount > 0 : l.amount < 0)),
    )
    .reverse()
  return (
    <section className="store-ledger" aria-labelledby="ledgerOverviewTitle">
      <header className="store-section-heading">
        <h2 id="ledgerOverviewTitle">积分概览</h2>
        <Button variant="outline" id="manualBtn" disabled={archived} onClick={onAdjust}>
          手动调整
        </Button>
      </header>
      <div className="stats">
        <Card>
          <span>当前积分</span>
          <b>{balance(data)}</b>
        </Card>
        <Card>
          <span>累计获得</span>
          <b className="positive">
            +{data.ledger.filter((l) => l.amount > 0).reduce((n, l) => n + l.amount, 0)}
          </b>
        </Card>
        <Card>
          <span>累计扣减</span>
          <b className="negative">
            {data.ledger.filter((l) => l.amount < 0).reduce((n, l) => n + l.amount, 0)}
          </b>
        </Card>
      </div>
      <div className="ledger-filters">
        <Field label="日期范围" id="ledgerRange">
          <DateRangePicker id="ledgerRange" value={range} onChange={setRange} />
        </Field>
        <Field label="来源" id="filterSource">
          <Choice
            id="filterSource"
            label="流水来源"
            value={kind}
            onChange={setKind}
            options={[
              { value: "all", label: "全部来源" },
              { value: "task", label: "任务" },
              { value: "gift", label: "礼品兑换" },
              { value: "manual", label: "手动调整" },
            ]}
          />
        </Field>
        <Field label="增减" id="filterDirection">
          <Choice
            id="filterDirection"
            label="积分增减"
            value={direction}
            onChange={setDirection}
            options={[
              { value: "all", label: "全部增减" },
              { value: "plus", label: "增加" },
              { value: "minus", label: "扣减" },
            ]}
          />
        </Field>
        <Button
          id="clearFilters"
          variant="outline"
          onClick={() => {
            setRange({})
            setKind("all")
            setDirection("all")
          }}
        >
          清除筛选
        </Button>
      </div>
      <div className="ledger-desktop">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>日期</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>说明</TableHead>
              <TableHead className="ledger-number">变动</TableHead>
              <TableHead className="ledger-number">变动后</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((l) => (
              <TableRow key={l.id}>
                <TableCell>{l.date}</TableCell>
                <TableCell>{sourceLabel(l)}</TableCell>
                <TableCell>
                  <strong>{l.source || ""}</strong>
                  <p className="field-help">{l.reason}</p>
                </TableCell>
                <TableCell className={`ledger-number ${l.amount >= 0 ? "positive" : "negative"}`}>
                  {l.amount > 0 ? "+" : ""}
                  {l.amount}
                </TableCell>
                <TableCell className="ledger-number">{l.balanceAfter}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="ledger-mobile">
        {rows.map((l) => (
          <Card key={l.id} className="ledger-mobile-card">
            <div>
              <strong>{l.source || sourceLabel(l)}</strong>
              <span className={l.amount >= 0 ? "positive" : "negative"}>
                {l.amount > 0 ? "+" : ""}
                {l.amount}
              </span>
            </div>
            <p>
              {l.date} · {sourceLabel(l)}
            </p>
            <p>{l.reason}</p>
            <small>变动后积分 {l.balanceAfter}</small>
          </Card>
        ))}
      </div>
      {!rows.length && <div className="empty-state">还没有符合条件的积分流水</div>}
    </section>
  )
}
function ManualEditor({ onClose }: { onClose: () => void }) {
  const [amount, setAmount] = useState(""),
    [reason, setReason] = useState(""),
    [date, setDate] = useState(today()),
    action = useAsync()
  return (
    <Modal
      id="manualDialog"
      title="手动调整积分"
      description="正数增加，负数扣减；每次调整都会保留流水。"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={action.busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="manualForm" disabled={action.busy}>
            {action.busy ? "保存中…" : "保存调整"}
          </Button>
        </>
      }
    >
      <form
        id="manualForm"
        onSubmit={(e) => {
          e.preventDefault()
          void action.run(async () => {
            if (!Number.isInteger(Number(amount)) || Number(amount) === 0)
              throw Error("请输入非零整数积分。")
            if (!date) throw Error("请选择日期。")
            await runtime.command("ledger.manual", {
              amount: Number(amount),
              reason: reason.trim(),
              date,
            })
            onClose()
          })
        }}
      >
        <fieldset disabled={action.busy}>
          <Field label="调整积分" id="manualAmount">
            <Input
              id="manualAmount"
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              step={1}
              placeholder="例如 10 或 -5"
            />
          </Field>
          <Field label="业务日期" id="manualDate">
            <DatePicker id="manualDate" value={date} onChange={setDate} />
          </Field>
          <Field label="调整原因" id="manualReason">
            <Input
              id="manualReason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              maxLength={200}
            />
          </Field>
          <ErrorText message={action.error} id="manualError" />
        </fieldset>
      </form>
    </Modal>
  )
}
function GiftEditor({ gift, onClose }: { gift?: Gift; onClose: () => void }) {
  const [name, setName] = useState(gift?.name || ""),
    [points, setPoints] = useState(String(gift?.points || "")),
    [image, setImage] = useState(gift?.imageData || ""),
    [processing, setProcessing] = useState(false),
    action = useAsync(),
    fileRef = useRef<HTMLInputElement>(null),
    live = useRef(true)
  useEffect(
    () => () => {
      live.current = false
    },
    [],
  )
  async function choose(file: File) {
    setProcessing(true)
    action.setError("")
    try {
      const result = await compressGiftImage(file)
      if (live.current) setImage(result)
    } catch (e) {
      if (live.current) action.setError((e as Error).message)
    } finally {
      if (live.current) setProcessing(false)
    }
  }
  return (
    <Modal
      id="giftEditorDialog"
      title={gift ? "编辑礼品" : "创建礼品"}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={action.busy || processing} onClick={onClose}>
            取消
          </Button>
          <Button
            id="saveGiftBtn"
            type="submit"
            form="giftEditorForm"
            disabled={action.busy || processing}
          >
            {action.busy ? "保存中…" : "保存礼品"}
          </Button>
        </>
      }
    >
      <form
        id="giftEditorForm"
        onSubmit={(e) => {
          e.preventDefault()
          void action.run(async () => {
            await runtime.command("gift.save", {
              gift: {
                ...(gift ? { id: gift.id } : {}),
                name: name.trim(),
                points: Number(points),
                imageData: image || null,
              },
            })
            onClose()
          })
        }}
      >
        <fieldset disabled={action.busy || processing}>
          <div className="gift-image-preview" id="giftImagePreview">
            {image ? <img src={image} alt="礼品图片预览" /> : <GiftIcon aria-hidden />}
          </div>
          <input
            id="giftImageInput"
            ref={fileRef}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="选择礼品图片"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ""
              if (f) void choose(f)
            }}
          />
          <div className="form-actions">
            <Button
              id="chooseGiftImage"
              variant="outline"
              type="button"
              onClick={() => fileRef.current?.click()}
            >
              选择图片
            </Button>
            {image && (
              <Button
                id="removeGiftImage"
                type="button"
                variant="ghost"
                onClick={() => setImage("")}
              >
                移除图片
              </Button>
            )}
          </div>
          <Field label="礼品名称" id="giftName">
            <Input
              id="giftName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={40}
            />
          </Field>
          <Field label="所需积分" id="giftPoints">
            <Input
              id="giftPoints"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
              type="number"
              min={1}
              max={99999}
              step={1}
              required
            />
          </Field>
          <ErrorText id="giftEditorError" message={action.error} />
          {processing && <p role="status">正在处理图片…</p>}
        </fieldset>
      </form>
    </Modal>
  )
}

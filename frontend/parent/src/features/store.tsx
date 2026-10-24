import { useState, useRef, useEffect } from "react"
import {
  Gift as GiftIcon,
  Plus,
  Settings2,
  ChevronDown,
  History,
  Trash2,
  ImagePlus,
} from "lucide-react"
import { Badge } from "@shared/components/ui/badge"
import { EmptyState } from "@shared/components/empty-state"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@shared/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@shared/components/ui/dropdown-menu"
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
import { runtime, operationId } from "../lib/runtime"
import { balance, today } from "../domain/calendar"
import { compressGiftImage } from "../domain/images"
import {
  ledgerView,
  ledgerActionsForSource,
  retainLedgerActions,
  ledgerActionLabel,
} from "../domain/ledger"
import type { BusinessData, Child, Gift } from "../domain/types"
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
    <section className="store-page" aria-label="积分商城">
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
                variant="default"
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
                    <div className="gift-image" data-has-image={Boolean(g.imageUrl || g.imageData)}>
                      {g.imageUrl || g.imageData ? (
                        <img src={g.imageUrl || g.imageData || undefined} alt={g.name} />
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
                          {current >= g.points ? "立即兑换" : "积分不足"}
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
                        {g.imageUrl || g.imageData ? (
                          <img src={g.imageUrl || g.imageData || undefined} alt="" />
                        ) : (
                          <GiftIcon aria-hidden />
                        )}
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
        <Modal
          id="giftManagerDialog"
          title="管理礼品"
          size="complex"
          onClose={() => setManager(false)}
        >
          <div className="gift-manager-toolbar">
            <span>共 {data.gifts.length} 件礼品</span>
            <Button id="newGiftBtn" onClick={() => setEditing(true)}>
              <Plus data-icon="inline-start" />
              创建礼品
            </Button>
          </div>
          <ul id="giftManagerList" className="gift-manager-list">
            {data.gifts.map((g) => (
              <li className="gift-manager-row" key={g.id}>
                <div className="gift-manager-image">
                  {g.imageUrl || g.imageData ? (
                    <img src={g.imageUrl || g.imageData || undefined} alt="" />
                  ) : (
                    <GiftIcon aria-hidden />
                  )}
                </div>
                <div className="gift-manager-copy">
                  <h3>{g.name}</h3>
                  <div className="gift-manager-meta">
                    <span>{g.points} 积分</span>
                    <Badge variant="secondary">
                      {g.status === "available" ? "可兑换" : "已兑换"}
                    </Badge>
                  </div>
                </div>
                <div className="gift-manager-actions">
                  <Button
                    variant="outline"
                    disabled={g.status !== "available"}
                    data-edit-gift={g.id}
                    onClick={() => setEditing(g)}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={g.status !== "available"}
                    data-delete-gift={g.id}
                    aria-label={`删除礼品「${g.name}」`}
                    title="删除礼品"
                    onClick={() => setConfirm({ gift: g, kind: "delete" })}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {!data.gifts.length && (
            <EmptyState
              title="还没有礼品"
              description="创建一份礼品，作为孩子努力后的奖励。"
              icon={<GiftIcon aria-hidden />}
            />
          )}
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
function LedgerScenePicker({
  id,
  source,
  value,
  onChange,
}: {
  id: string
  source: string
  value: string[]
  onChange: (value: string[]) => void
}) {
  const options = ledgerActionsForSource(source)
  const selected = options.filter((option) => value.includes(option.value))
  const label =
    selected.length === 1
      ? selected[0].label
      : selected.length
        ? `已选 ${selected.length} 项`
        : "全部场景"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          variant="outline"
          className="w-full justify-between text-left font-normal"
          aria-label={`积分变动场景：${selected.map((option) => option.label).join("、") || "全部场景"}`}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="ledger-scene-options min-w-40"
        aria-label="积分变动场景"
        align="start"
      >
        <DropdownMenuCheckboxItem
          checked={!value.length}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => onChange([])}
        >
          全部场景
        </DropdownMenuCheckboxItem>
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={value.includes(option.value)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...value, option.value]
                  : value.filter((entry) => entry !== option.value),
              )
            }
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
    [actions, setActions] = useState<string[]>([])
  const { rows, earned, deducted } = ledgerView(data.ledger, { ...range, source: kind, actions })
  return (
    <section className="store-ledger" aria-label="积分流水">
      <div className="ledger-filters">
        <Field label="日期范围" id="ledgerRange">
          <DateRangePicker id="ledgerRange" value={range} onChange={setRange} />
        </Field>
        <Field label="来源" id="filterSource">
          <Choice
            id="filterSource"
            label="流水来源"
            value={kind}
            onChange={(source) => {
              setKind(source)
              setActions((selected) => retainLedgerActions(selected, source))
            }}
            options={[
              { value: "all", label: "全部来源" },
              { value: "task", label: "任务" },
              { value: "gift", label: "礼品兑换" },
              { value: "manual", label: "手动调整" },
            ]}
          />
        </Field>
        <Field label="变动场景" id="filterDirection">
          <LedgerScenePicker
            id="filterDirection"
            source={kind}
            value={actions}
            onChange={setActions}
          />
        </Field>
        <Button
          id="clearFilters"
          variant="outline"
          onClick={() => {
            setRange({})
            setKind("all")
            setActions([])
          }}
        >
          清除筛选
        </Button>
        <Button variant="default" id="manualBtn" disabled={archived} onClick={onAdjust}>
          手动调整
        </Button>
      </div>
      <div className="stats">
        <Card>
          <span>当前积分</span>
          <b>{balance(data)}</b>
        </Card>
        <Card>
          <span>获得积分</span>
          <b className="positive">+{earned}</b>
        </Card>
        <Card>
          <span>扣减积分</span>
          <b className="negative">{deducted}</b>
        </Card>
      </div>
      <div className="ledger-desktop">
        <Table tabIndex={0} aria-label="积分流水明细">
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
                <TableCell>{ledgerActionLabel(l)}</TableCell>
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
              <strong>{l.source || ledgerActionLabel(l)}</strong>
              <span className={l.amount >= 0 ? "positive" : "negative"}>
                {l.amount > 0 ? "+" : ""}
                {l.amount}
              </span>
            </div>
            <p>
              {l.date} · {ledgerActionLabel(l)}
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
  const [direction, setDirection] = useState("increase"),
    [amount, setAmount] = useState(""),
    [reason, setReason] = useState(""),
    [date, setDate] = useState(today()),
    action = useAsync()
  return (
    <Modal
      id="manualDialog"
      title="手动调整积分"
      description="选择增加或减少，填写积分数值；每次调整都会保留流水。"
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
            if (!Number.isSafeInteger(Number(amount)) || Number(amount) <= 0)
              throw Error("请输入大于 0 的整数积分。")
            if (!date) throw Error("请选择日期。")
            await runtime.command("ledger.manual", {
              amount: Number(amount) * (direction === "decrease" ? -1 : 1),
              reason: reason.trim(),
              date,
            })
            onClose()
          })
        }}
      >
        <fieldset disabled={action.busy}>
          <div className="manual-amount-row">
            <Field label="调整方式" id="manualDirection">
              <Choice
                id="manualDirection"
                label="调整方式"
                value={direction}
                onChange={setDirection}
                options={[
                  { value: "increase", label: "增加" },
                  { value: "decrease", label: "减少" },
                ]}
              />
            </Field>
            <Field label="调整积分" id="manualAmount">
              <Input
                id="manualAmount"
                type="number"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                placeholder="例如 10"
              />
            </Field>
          </div>
          <Field label="日期" id="manualDate">
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
    [image, setImage] = useState(gift?.imageUrl || gift?.imageData || ""),
    [assetId, setAssetId] = useState(gift?.imageAssetId || ""),
    [uploadFailed, setUploadFailed] = useState(false),
    pendingImage = useRef<{ value: string; id: string } | null>(null),
    imageEpoch = useRef(runtime.getSnapshot().epoch),
    [processing, setProcessing] = useState(false),
    action = useAsync(),
    fileRef = useRef<HTMLInputElement>(null),
    live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const active = () => live.current && imageEpoch.current === runtime.getSnapshot().epoch
  async function upload(retry = false) {
    const pending = pendingImage.current
    if (!pending || !active()) return
    setProcessing(true)
    action.setError("")
    try {
      const result = await runtime.uploadImage(pending.value, pending.id, imageEpoch.current, retry)
      if (active() && pendingImage.current === pending) {
        setAssetId(result.assetId)
        setUploadFailed(false)
        pendingImage.current = null
      }
    } catch (e) {
      if (active()) {
        setUploadFailed(true)
        action.setError((e as Error).message)
      }
    } finally {
      if (active()) setProcessing(false)
    }
  }
  async function choose(file: File) {
    setProcessing(true)
    action.setError("")
    try {
      const result = await compressGiftImage(file)
      if (active()) {
        setImage(result)
        setAssetId("")
        pendingImage.current = { value: result, id: operationId() }
        setUploadFailed(true)
        await upload()
      }
    } catch (e) {
      if (active()) action.setError((e as Error).message)
    } finally {
      if (active()) setProcessing(false)
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
            disabled={action.busy || processing || uploadFailed}
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
          if (processing || uploadFailed) return
          void action.run(async () => {
            await runtime.command("gift.save", {
              gift: {
                ...(gift ? { id: gift.id } : {}),
                name: name.trim(),
                points: Number(points),
                imageAssetId: assetId || null,
              },
            })
            onClose()
          })
        }}
      >
        <fieldset disabled={action.busy || processing} className="gift-editor-fields">
          <div className="gift-image-field">
            <p className="gift-image-label">
              礼品图片<span>选填</span>
            </p>
            <Button
              id="giftImagePreview"
              className="gift-image-picker"
              variant="outline"
              type="button"
              aria-label={image ? "更换礼品图片" : "上传礼品图片"}
              aria-describedby="giftImageHelp"
              onClick={() => fileRef.current?.click()}
            >
              {image ? (
                <img src={image} alt="礼品图片预览" />
              ) : (
                <span className="gift-image-empty">
                  <ImagePlus aria-hidden />
                  <span>点击上传图片</span>
                </span>
              )}
              {image && (
                <span className="gift-image-caption">
                  <ImagePlus aria-hidden />
                  点击更换图片
                </span>
              )}
            </Button>
            <input
              id="giftImageInput"
              ref={fileRef}
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="选择礼品图片"
              tabIndex={-1}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ""
                if (file) void choose(file)
              }}
            />
            <div className="gift-image-help-row">
              <p id="giftImageHelp" className="field-help">
                支持 JPG、PNG、WebP，最大 10MB
              </p>
              {image && (
                <Button
                  id="removeGiftImage"
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setImage("")
                    setAssetId("")
                    pendingImage.current = null
                    setUploadFailed(false)
                    action.setError("")
                  }}
                >
                  移除图片
                </Button>
              )}
            </div>
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
          {processing && <p role="status">正在处理并上传图片…</p>}
          {uploadFailed && !processing && (
            <Button type="button" variant="outline" onClick={() => void upload(true)}>
              重试图片上传
            </Button>
          )}
        </fieldset>
      </form>
    </Modal>
  )
}

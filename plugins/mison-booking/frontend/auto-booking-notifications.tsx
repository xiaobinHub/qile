import { useId, useRef, useState, type FormEvent } from "react"
import { Plus, X } from "lucide-react"
import { Checkbox } from "@shared/components/ui/checkbox"
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@shared/components/ui/field"
import { Separator } from "@shared/components/ui/separator"
import { Button, Input, Overlay } from "./ui"
import type { AutoBookingConfig } from "./types"
import "./auto-booking-notifications.css"

type Notifications = AutoBookingConfig["notifications"]
type KeyRow = { id: number; name: string; value: string }
type Draft = { enabled: boolean; rows: KeyRow[]; events: Notifications["events"] }

const MAX_KEYS = 10
const BARK_KEY = /^[A-Za-z0-9_-]{8,128}$/

function validate(draft: Draft) {
  const rowErrors = new Map<number, string>()
  const nameErrors = new Map<number, string>()
  const seen = new Set<string>()
  const barkKeys: string[] = []
  const barkKeyNames: string[] = []
  for (const row of draft.rows) {
    const key = row.value.trim()
    const name = row.name.trim()
    if (!name) nameErrors.set(row.id, "请输入设备名称。")
    else if (Array.from(name).length > 40) nameErrors.set(row.id, "设备名称最多40个字符。")
    if (!key) {
      rowErrors.set(row.id, "请输入 Bark Key，或移除这一行。")
      continue
    }
    if (!BARK_KEY.test(key)) {
      rowErrors.set(row.id, "Key 需为 8–128 位英文字母、数字、下划线或连字符。")
    } else if (seen.has(key)) {
      rowErrors.set(row.id, "此 Bark Key 已添加，请勿重复。")
    } else if (barkKeys.length >= MAX_KEYS) {
      rowErrors.set(row.id, "最多添加 10 个 Bark Key。")
    }
    seen.add(key)
    barkKeys.push(key)
    barkKeyNames.push(name)
  }
  return {
    rowErrors,
    nameErrors,
    barkKeys,
    barkKeyNames,
    sceneError: draft.enabled && !draft.events.includes("booked") ? "请选择约课成功通知场景。" : "",
  }
}

export function AutoBookingNotificationsDrawer({
  value,
  canManage,
  onApply,
  onClose,
}: {
  value: Notifications
  canManage: boolean
  onApply(value: Notifications): void
  onClose(): void
}) {
  const prefix = useId()
  const formId = `${prefix}-notifications`
  const sceneId = `${prefix}-booked`
  const nextRowId = useRef(Math.max(value.barkKeys.length, 1))
  const inputs = useRef(new Map<number, HTMLInputElement>())
  const names = useRef(new Map<number, HTMLInputElement>())
  const scene = useRef<HTMLButtonElement>(null)
  const [draft, setDraft] = useState<Draft>(() => ({
    enabled: value.enabled,
    rows: (value.barkKeys.length ? value.barkKeys : [""]).map((key, id) => ({
      id,
      name: value.barkKeyNames?.[id] ?? "",
      value: key,
    })),
    events: [...value.events],
  }))
  const [submitted, setSubmitted] = useState(false)
  const [touched, setTouched] = useState<Set<string>>(() => new Set())
  const validation = validate(draft)
  const keyCount = draft.rows.filter((row) => row.value.trim()).length
  const canSave =
    !validation.rowErrors.size &&
    !validation.nameErrors.size &&
    !validation.sceneError &&
    (!draft.enabled || keyCount > 0)

  function touch(id: string) {
    setTouched((current) => new Set(current).add(id))
  }

  function updateRow(id: number, patch: Partial<Pick<KeyRow, "name" | "value">>) {
    if (!canManage) return
    setDraft((current) => ({
      ...current,
      rows: current.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }))
  }

  function addRow() {
    if (!canManage || draft.rows.length >= MAX_KEYS) return
    const row: KeyRow = {
      id: nextRowId.current++,
      name: "",
      value: "",
    }
    setDraft((current) => ({ ...current, rows: [...current.rows, row] }))
    requestAnimationFrame(() => names.current.get(row.id)?.focus())
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (!canManage) return

    // Keep an actual field available to focus when every row was removed.
    const candidate =
      draft.enabled && !draft.rows.length
        ? {
            ...draft,
            rows: [{ id: nextRowId.current++, name: "", value: "" }],
          }
        : draft
    if (candidate !== draft) setDraft(candidate)
    const result = validate(candidate)
    setSubmitted(true)
    const invalidRow = candidate.rows.find(
      (row) => result.rowErrors.has(row.id) || result.nameErrors.has(row.id),
    )
    if (invalidRow || result.sceneError) {
      requestAnimationFrame(() => {
        if (invalidRow)
          (result.nameErrors.has(invalidRow.id) ? names : inputs).current
            .get(invalidRow.id)
            ?.focus()
        else scene.current?.focus()
      })
      return
    }
    onApply({
      enabled: candidate.enabled,
      barkKeys: result.barkKeys,
      barkKeyNames: result.barkKeyNames,
      events: [...candidate.events],
    })
  }

  return (
    <Overlay
      drawer
      className="mison-auto-notification-drawer"
      title="Bark App"
      onClose={onClose}
      footer={
        canManage ? (
          <>
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              type="submit"
              form={formId}
              disabled={!canSave}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.stopPropagation()
              }}
            >
              保存
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        )
      }
    >
      <form
        id={formId}
        className="mison-auto-notification-form"
        autoComplete="off"
        noValidate
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.stopPropagation()
        }}
      >
        <FieldSet className="mison-auto-notification-keys">
          <FieldLegend>Bark Key</FieldLegend>
          {canManage ? (
            <>
              <div className="mison-auto-notification-key-list">
                {draft.rows.map((row, index) => {
                  const inputId = `${prefix}-key-${row.id}`
                  const nameId = `${prefix}-name-${row.id}`
                  const error = submitted || touched.has(inputId) ? validation.rowErrors.get(row.id) : undefined
                  const nameError = submitted || touched.has(nameId) ? validation.nameErrors.get(row.id) : undefined
                  return (
                    <Field
                      key={row.id}
                      className="mison-auto-notification-key"
                      data-invalid={!!error || !!nameError}
                    >
                      <div className="mison-auto-notification-key-controls">
                        <FieldLabel htmlFor={nameId} className="sr-only">
                          设备名称 {index + 1}
                        </FieldLabel>
                        <Input
                          id={nameId}
                          ref={(input) => {
                            if (input) names.current.set(row.id, input)
                            else names.current.delete(row.id)
                          }}
                          className="mison-auto-notification-device-name"
                          aria-label={`设备名称 ${index + 1}`}
                          placeholder="设备名称"
                          autoComplete="off"
                          name={`bark-device-name-${row.id}`}
                          required
                          value={row.name}
                          aria-invalid={!!nameError}
                          aria-describedby={nameError ? `${nameId}-error` : undefined}
                          onChange={(event) => updateRow(row.id, { name: event.target.value })}
                          onBlur={() => touch(nameId)}
                        />
                        <Input
                          id={inputId}
                          ref={(input) => {
                            if (input) inputs.current.set(row.id, input)
                            else inputs.current.delete(row.id)
                          }}
                          type="text"
                          autoComplete="off"
                          name={`bark-device-key-${row.id}`}
                          required
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          placeholder="输入 Bark App 的 Key"
                          aria-label={`Bark Key ${index + 1}`}
                          value={row.value}
                          aria-invalid={!!error}
                          aria-describedby={error ? `${inputId}-error` : undefined}
                          onChange={(event) => updateRow(row.id, { value: event.target.value })}
                          onBlur={() => touch(inputId)}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`移除 Bark Key ${index + 1}`}
                          onClick={() => {
                            if (!canManage) return
                            setDraft((current) => ({
                              ...current,
                              rows: current.rows.filter((item) => item.id !== row.id),
                            }))
                          }}
                        >
                          <X />
                        </Button>
                      </div>
                      {nameError ? (
                        <FieldError id={`${nameId}-error`}>{nameError}</FieldError>
                      ) : null}
                      {error ? <FieldError id={`${inputId}-error`}>{error}</FieldError> : null}
                    </Field>
                  )
                })}
              </div>
              <Button
                variant="outline"
                className="mison-auto-notification-add"
                disabled={draft.rows.length >= MAX_KEYS}
                onClick={addRow}
              >
                <Plus data-icon="inline-start" />
                添加设备
              </Button>
            </>
          ) : (
            <p className="mison-auto-notification-count">已配置 {keyCount} 个 Bark Key</p>
          )}
        </FieldSet>
        <Separator />
        <FieldSet className="mison-auto-notification-scenes">
          <FieldLegend>通知场景</FieldLegend>
          <Field orientation="horizontal" data-invalid={(submitted || touched.has(sceneId)) && !!validation.sceneError}>
            <Checkbox
              id={sceneId}
              ref={scene}
              checked={draft.events.includes("booked")}
              disabled={!canManage}
              aria-invalid={(submitted || touched.has(sceneId)) && !!validation.sceneError}
              aria-describedby={(submitted || touched.has(sceneId)) && validation.sceneError ? `${sceneId}-error` : undefined}
              onBlur={() => touch(sceneId)}
              onCheckedChange={(checked) => {
                if (!canManage) return
                setDraft((current) => ({ ...current, events: checked === true ? ["booked"] : [] }))
              }}
            />
            <FieldLabel htmlFor={sceneId}>约课成功</FieldLabel>
          </Field>
          {canManage && (submitted || touched.has(sceneId)) && validation.sceneError ? (
            <FieldError id={`${sceneId}-error`}>{validation.sceneError}</FieldError>
          ) : null}
        </FieldSet>
      </form>
    </Overlay>
  )
}

import { useEffect, useId, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@shared/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@shared/components/ui/field"
import { Separator } from "@shared/components/ui/separator"
import { Switch } from "@shared/components/ui/switch"
import { Slider } from "radix-ui"
import { AutoBookingCheckWindow } from "./auto-booking-check-window"
import { AutoBookingNotificationsDrawer } from "./auto-booking-notifications"
import { Button } from "./ui"
import type { AutoBookingConfig, PluginContext } from "./types"

type Notifications = AutoBookingConfig["notifications"]

function copyNotifications(value: Notifications): Notifications {
  return {
    ...value,
    barkKeys: [...value.barkKeys],
    barkKeyNames: value.barkKeyNames ? [...value.barkKeyNames] : undefined,
    events: [...value.events],
  }
}

function isNotificationReady(value: Notifications) {
  const keys = value.barkKeys.map((key) => key.trim())
  return (
    keys.length > 0 &&
    keys.length <= 10 &&
    keys.every((key) => /^[A-Za-z0-9_-]{8,128}$/.test(key)) &&
    keys.every((_, index) => {
      const name = value.barkKeyNames?.[index]?.trim() ?? ""
      return name.length > 0 && Array.from(name).length <= 40
    }) &&
    new Set(keys).size === keys.length &&
    value.events.includes("booked")
  )
}

function BookingRuleSlider({
  id,
  label,
  value,
  min,
  max,
  unit,
  disabled,
  onChange,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  unit: string
  disabled: boolean
  onChange(value: number): void
}) {
  return (
    <Field className="mison-auto-rule-slider-field" data-disabled={disabled}>
      <div className="mison-auto-check-interval-heading">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <output htmlFor={id}>
          {value} {unit}
        </output>
      </div>
      <Slider.Root
        className="mison-auto-check-slider"
        min={min}
        max={max}
        step={1}
        value={[value]}
        disabled={disabled}
        onValueChange={([next]) => onChange(next)}
      >
        <Slider.Track className="mison-auto-check-track">
          <Slider.Range className="mison-auto-check-range" />
        </Slider.Track>
        <Slider.Thumb
          id={id}
          className="mison-auto-check-thumb"
          aria-label={label}
          aria-disabled={disabled}
          aria-valuetext={`${value} ${unit}`}
        />
      </Slider.Root>
    </Field>
  )
}

export function AutoBookingExecutionSettings({
  context,
  value,
  canManage,
  busy,
  active,
  onChange,
}: {
  context: PluginContext
  value: AutoBookingConfig
  canManage: boolean
  busy: boolean
  active: boolean
  onChange(value: AutoBookingConfig): void
}) {
  const prefix = useId()
  const [notificationDraft, setNotificationDraft] = useState<Notifications | null>(null)
  const [noticeLimit, setNoticeLimit] = useState(() => Math.max(72, value.minNoticeHours))
  const noticeMax = Math.max(noticeLimit, value.minNoticeHours)
  useEffect(() => {
    // Preserve a wider range if an existing config exceeds the usual 72 hours.
    setNoticeLimit((current) => Math.max(current, value.minNoticeHours))
  }, [value.minNoticeHours])
  const unavailable = busy || !active || context.signal.aborted
  const disabled = !canManage || unavailable
  useEffect(() => {
    if (unavailable) setNotificationDraft(null)
  }, [unavailable])
  useEffect(() => {
    setNotificationDraft(null)
    const close = () => setNotificationDraft(null)
    context.signal.addEventListener("abort", close, { once: true })
    return () => context.signal.removeEventListener("abort", close)
  }, [context, value.revision, value.bindingRevision, canManage])

  function toggleBarkApp(enabled: boolean) {
    if (disabled) return
    const next = { ...value.notifications, enabled }
    if (enabled && !isNotificationReady(next)) {
      setNotificationDraft(copyNotifications(next))
    } else {
      onChange({ ...value, notifications: next })
    }
  }

  const keyCount = value.notifications.barkKeys.filter((key) => key.trim()).length
  const notificationSummary = keyCount
    ? `${value.notifications.events.includes("booked") ? "约课成功" : "未选择通知场景"} · ${keyCount} 个 Key`
    : ""

  return (
    <section className="mison-auto-execution-groups" aria-label="自动约课执行设置">
      <Card className="mison-auto-settings-card mison-auto-rhythm-card">
        <CardHeader>
          <CardTitle>
            <h2 id={`${prefix}-rhythm`}>执行节奏</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup
            role="group"
            aria-labelledby={`${prefix}-rhythm`}
            className="mison-auto-execution-fields"
          >
            <Field className="mison-auto-check-interval" data-disabled={disabled}>
              <div className="mison-auto-check-interval-heading">
                <FieldLabel htmlFor={`${prefix}-check-min`}>检查间隔</FieldLabel>
                <output htmlFor={`${prefix}-check-min ${prefix}-check-max`}>
                  {value.checkInterval.minMinutes}～{value.checkInterval.maxMinutes} 分钟
                </output>
              </div>
              <Slider.Root
                className="mison-auto-check-slider"
                min={1}
                max={30}
                step={1}
                value={[value.checkInterval.minMinutes, value.checkInterval.maxMinutes]}
                disabled={disabled}
                onValueChange={([minMinutes, maxMinutes]) =>
                  onChange({ ...value, checkInterval: { minMinutes, maxMinutes } })
                }
              >
                <Slider.Track className="mison-auto-check-track">
                  <Slider.Range className="mison-auto-check-range" />
                </Slider.Track>
                <Slider.Thumb
                  id={`${prefix}-check-min`}
                  className="mison-auto-check-thumb"
                  aria-label="最短检查间隔"
                  aria-disabled={disabled}
                  aria-valuetext={`${value.checkInterval.minMinutes} 分钟`}
                />
                <Slider.Thumb
                  id={`${prefix}-check-max`}
                  className="mison-auto-check-thumb"
                  aria-label="最长检查间隔"
                  aria-disabled={disabled}
                  aria-valuetext={`${value.checkInterval.maxMinutes} 分钟`}
                />
              </Slider.Root>
            </Field>
            <Separator />
            <AutoBookingCheckWindow
              value={value.sleep}
              disabled={disabled}
              onChange={(sleep) => onChange({ ...value, sleep })}
            />
          </FieldGroup>
        </CardContent>
      </Card>
      <Card className="mison-auto-settings-card mison-auto-rules-card">
        <CardHeader>
          <CardTitle>
            <h2 id={`${prefix}-rules`}>预约规则</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup
            role="group"
            aria-labelledby={`${prefix}-rules`}
            className="mison-auto-execution-fields mison-auto-booking-rules"
          >
            <BookingRuleSlider
              id={`${prefix}-notice`}
              label="最少提前预约"
              value={value.minNoticeHours}
              min={0}
              max={noticeMax}
              unit="小时"
              disabled={disabled}
              onChange={(minNoticeHours) => onChange({ ...value, minNoticeHours })}
            />
            <Separator />
            <BookingRuleSlider
              id={`${prefix}-daily`}
              label="每天最多预约"
              value={value.dailyLessons}
              min={1}
              max={4}
              unit="节"
              disabled={disabled}
              onChange={(dailyLessons) => onChange({ ...value, dailyLessons })}
            />
            <Separator />
            <Field orientation="horizontal" className="mison-auto-execution-row mison-auto-rebook">
              <FieldLabel htmlFor={`${prefix}-rebook`}>取消课程后自动补约</FieldLabel>
              <Switch
                id={`${prefix}-rebook`}
                checked={value.rebookCancelled}
                disabled={disabled}
                onCheckedChange={(rebookCancelled) => onChange({ ...value, rebookCancelled })}
              />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
      <Card className="mison-auto-settings-card mison-auto-notifications-card">
        <CardHeader>
          <CardTitle>
            <h2 id={`${prefix}-notifications`}>消息提醒</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup
            role="group"
            aria-labelledby={`${prefix}-bark-label`}
            className="mison-auto-execution-fields"
          >
            <Field orientation="horizontal" className="mison-auto-execution-row">
              <FieldLabel id={`${prefix}-bark-label`} htmlFor={`${prefix}-bark`}>
                Bark App
              </FieldLabel>
              <div className="mison-auto-notification-actions">
                <Button
                  variant="link"
                  aria-label={canManage ? "配置 Bark App" : "查看 Bark App"}
                  disabled={unavailable}
                  onClick={(event) => {
                    event.currentTarget.focus({ preventScroll: true })
                    setNotificationDraft(copyNotifications(value.notifications))
                  }}
                >
                  {canManage ? "配置参数" : "查看配置"}
                </Button>
                <Switch
                  id={`${prefix}-bark`}
                  checked={value.notifications.enabled}
                  disabled={disabled}
                  onClick={(event) => {
                    event.stopPropagation()
                    event.currentTarget.focus({ preventScroll: true })
                  }}
                  onCheckedChange={toggleBarkApp}
                />
              </div>
            </Field>
            {notificationSummary ? (
              <div className="mison-auto-notification-summary">
                <p>{notificationSummary}</p>
              </div>
            ) : null}
          </FieldGroup>
        </CardContent>
      </Card>
      {notificationDraft && !unavailable ? (
        <AutoBookingNotificationsDrawer
          value={notificationDraft}
          canManage={canManage}
          onApply={(notifications) => {
            if (!disabled) onChange({ ...value, notifications })
            setNotificationDraft(null)
          }}
          onClose={() => setNotificationDraft(null)}
        />
      ) : null}
    </section>
  )
}

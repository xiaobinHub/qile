import { useId, useRef } from "react"
import { Slider } from "radix-ui"
import { Field, FieldLabel } from "@shared/components/ui/field"
import {
  axisTime,
  checkWindow,
  checkWindowLabel,
  DAY_MINUTES,
  moveCheckBoundary,
  quietHours,
} from "./check-window"
import type { AutoBookingConfig } from "./types"

type Boundary = "start" | "end"

export function AutoBookingCheckWindow({
  value,
  disabled,
  onChange,
}: {
  value: AutoBookingConfig["sleep"]
  disabled: boolean
  onChange(value: AutoBookingConfig["sleep"]): void
}) {
  const prefix = useId()
  const startThumb = useRef<HTMLSpanElement>(null)
  const endThumb = useRef<HTMLSpanElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; boundary: Boundary } | null>(null)
  const selected = checkWindow(value)
  const wrapped = selected.start > selected.end

  function update(boundary: Boundary, position: number) {
    if (!disabled) onChange(quietHours(value, moveCheckBoundary(selected, boundary, position)))
  }
  function pointerPosition(clientX: number) {
    const rect = track.current!.getBoundingClientRect()
    return Math.max(0, Math.min(DAY_MINUTES, ((clientX - rect.left) / rect.width) * DAY_MINUTES))
  }

  return (
    <Field className="mison-auto-check-window" data-disabled={disabled}>
      <div className="mison-auto-check-interval-heading">
        <FieldLabel id={`${prefix}-label`}>检查时间</FieldLabel>
        <output htmlFor={`${prefix}-start ${prefix}-end`}>{checkWindowLabel(value)}</output>
      </div>
      <div
        className="mison-auto-time-slider"
        onPointerDown={(event) => {
          if (
            disabled ||
            event.button !== 0 ||
            (event.target as Element).closest('[role="slider"]')
          )
            return
          event.preventDefault()
          const position = pointerPosition(event.clientX)
          const boundary =
            Math.abs(position - selected.start) <= Math.abs(position - selected.end)
              ? "start"
              : "end"
          drag.current = { pointerId: event.pointerId, boundary }
          event.currentTarget.setPointerCapture(event.pointerId)
          ;(boundary === "start" ? startThumb : endThumb).current?.focus({ preventScroll: true })
          update(boundary, position)
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId === event.pointerId) {
            event.preventDefault()
            update(drag.current.boundary, pointerPosition(event.clientX))
          }
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        <div
          ref={track}
          className="mison-auto-check-track mison-auto-time-track"
          aria-hidden="true"
        >
          {wrapped ? (
            <>
              <span
                className="mison-auto-check-range"
                style={{ left: 0, width: `${(selected.end / DAY_MINUTES) * 100}%` }}
              />
              <span
                className="mison-auto-check-range"
                style={{ left: `${(selected.start / DAY_MINUTES) * 100}%`, right: 0 }}
              />
            </>
          ) : (
            <span
              className="mison-auto-check-range"
              style={{
                left: `${(selected.start / DAY_MINUTES) * 100}%`,
                width: `${((selected.end - selected.start) / DAY_MINUTES) * 100}%`,
              }}
            />
          )}
        </div>
        <span className="mison-auto-midnight-tick" aria-hidden="true" />
        {(["start", "end"] as const).map((boundary) => (
          <Slider.Root
            key={boundary}
            className="mison-auto-check-slider mison-auto-time-handle"
            min={0}
            max={DAY_MINUTES}
            step={1}
            value={[selected[boundary]]}
            disabled={disabled}
            onValueChange={([position]) => update(boundary, position)}
          >
            <Slider.Thumb
              ref={boundary === "start" ? startThumb : endThumb}
              id={`${prefix}-${boundary}`}
              className="mison-auto-check-thumb"
              aria-label={boundary === "start" ? "检查开始" : "检查结束"}
              aria-describedby={`${prefix}-label`}
              aria-disabled={disabled}
              aria-valuetext={axisTime(selected[boundary])}
            />
          </Slider.Root>
        ))}
      </div>
      <div className="mison-auto-time-axis" aria-hidden="true">
        <span>12:00</span>
        <span>00:00</span>
        <span>12:00</span>
      </div>
    </Field>
  )
}

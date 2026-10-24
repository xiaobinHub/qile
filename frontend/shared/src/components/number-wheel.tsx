import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react"
import type { TimeWheelHandle } from "./time-wheel"

const rowHeight = 44
const windowSize = 101

/** A bounded native-scroll wheel. A sliding window keeps large numbers cheap. */
export function NumberWheel({
  label,
  value,
  min = 0,
  max,
  onChange,
  onComplete,
  ref,
}: {
  label: string
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
  onComplete: () => void
  ref?: Ref<TimeWheelHandle>
}) {
  const last = max ?? Number.MAX_SAFE_INTEGER
  const count = Math.min(windowSize, last - min + 1)
  const bound = (next: number) => Math.max(min, Math.min(last, Math.round(next)))
  const windowFor = (next: number) =>
    Math.max(min, Math.min(last - count + 1, next - Math.floor(count / 2)))
  const [start, setStart] = useState(() => windowFor(value))
  const startRef = useRef(start)
  const positioned = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)
  const selected = useRef(value)
  const frame = useRef(0)
  const touching = useRef(false)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    if (value < start || value >= start + count) {
      selected.current = value
      setStart(windowFor(value))
      return
    }
    if (!positioned.current || startRef.current !== start || selected.current !== value) {
      selected.current = value
      startRef.current = start
      positioned.current = true
      node.scrollTop = (value - start) * rowHeight
    }
  }, [start, value, min, max])
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
      clearTimeout(settle.current)
    },
    [],
  )

  function publish(next: number) {
    if (selected.current !== next) {
      selected.current = next
      onChange(next)
    }
  }
  function choose(next: number) {
    clearTimeout(settle.current)
    cancelAnimationFrame(frame.current)
    frame.current = 0
    next = bound(next)
    const nextStart = windowFor(next)
    publish(next)
    if (nextStart !== startRef.current) setStart(nextStart)
    else
      scroller.current?.scrollTo({
        top: (next - startRef.current) * rowHeight,
        behavior: "instant",
      })
  }
  function visibleValue() {
    return bound(startRef.current + Math.round((scroller.current?.scrollTop || 0) / rowHeight))
  }
  useImperativeHandle(ref, () => ({ commit: () => choose(visibleValue()) }))
  function scroll() {
    clearTimeout(settle.current)
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        const next = visibleValue()
        publish(next)
        if (next - startRef.current < 10 || next - startRef.current > count - 11) {
          const nextStart = windowFor(next)
          if (nextStart !== startRef.current) setStart(nextStart)
        }
      })
    if (!touching.current) settle.current = setTimeout(() => choose(visibleValue()), 160)
  }

  return (
    <div className="time-wheel" style={{ "--time-wheel-row": `${rowHeight}px` } as CSSProperties}>
      <div className="time-wheel-selection" aria-hidden="true" />
      <div
        ref={scroller}
        role="spinbutton"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        className="time-wheel-scroll"
        onScroll={scroll}
        onTouchStart={() => {
          touching.current = true
          clearTimeout(settle.current)
        }}
        onTouchEnd={() => {
          touching.current = false
          scroll()
        }}
        onTouchCancel={() => {
          touching.current = false
          scroll()
        }}
        onPointerDown={() => scroller.current?.focus({ preventScroll: true })}
        onClick={(event) => {
          const row = (event.target as HTMLElement).closest<HTMLElement>("[data-number-value]")
          if (row) choose(Number(row.dataset.numberValue))
        }}
        onKeyDown={(event) => {
          const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[event.key]
          if (step !== undefined) {
            event.preventDefault()
            choose(selected.current + step)
          } else if (event.key === "Home" || (event.key === "End" && max !== undefined)) {
            event.preventDefault()
            choose(event.key === "Home" ? min : max!)
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            onComplete()
          }
        }}
      >
        <div aria-hidden="true">
          {Array.from({ length: count }, (_, index) => (
            <div className="time-wheel-row" data-number-value={start + index} key={start + index}>
              {start + index}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

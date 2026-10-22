import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type Ref,
} from "react"

const rowHeight = 44
const copies = 7
const middleCopy = Math.floor(copies / 2)
const modulo = (value: number, count: number) => ((value % count) + count) % count
export type TimeWheelHandle = { commit: () => void }

/** Repeated rows keep native touch/mouse scrolling continuous across 00. The
 * duplicates are visual only; assistive technology sees one bounded spinbutton. */
export function TimeWheel({
  label,
  unit,
  count,
  value,
  onChange,
  onComplete,
  ref,
}: {
  label: string
  unit: string
  count: number
  value: number
  onChange: (value: number) => void
  onComplete: () => void
  ref?: Ref<TimeWheelHandle>
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const selected = useRef(value)
  const frame = useRef(0)
  const touching = useRef(false)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const rows = useMemo(
    () =>
      Array.from({ length: count * copies }, (_, index) => (
        <div className="time-wheel-row" data-wheel-index={index} key={index}>
          {String(index % count).padStart(2, "0")}
        </div>
      )),
    [count],
  )

  useLayoutEffect(() => {
    if (scroller.current && (selected.current !== value || scroller.current.scrollTop === 0)) {
      selected.current = value
      scroller.current.scrollTop = (middleCopy * count + value) * rowHeight
    }
  }, [count, value])
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
      clearTimeout(settle.current)
    },
    [],
  )

  function publish(index: number) {
    const next = modulo(index, count)
    if (selected.current !== next) {
      selected.current = next
      onChange(next)
    }
  }
  function choose(index: number) {
    clearTimeout(settle.current)
    const node = scroller.current
    if (!node) return
    const target =
      index < count || index >= (copies - 1) * count
        ? middleCopy * count + modulo(index, count)
        : index
    node.scrollTo({ top: target * rowHeight, behavior: "instant" })
    publish(target)
  }
  useImperativeHandle(ref, () => ({
    // Flush the visible center before an outside click/Done unmounts the wheel,
    // even if its last scroll event is still waiting for the next frame.
    commit: () => choose(Math.round((scroller.current?.scrollTop || 0) / rowHeight)),
  }))
  function scroll() {
    clearTimeout(settle.current)
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        const node = scroller.current
        if (!node) return
        const position = node.scrollTop / rowHeight
        publish(Math.round(position))
        // Rebase well before either end. The surrounding rows are identical,
        // so even a very long scroll cannot expose the repeated list's ends.
        if (position < count || position >= (copies - 1) * count) {
          node.scrollTop = (middleCopy * count + modulo(position, count)) * rowHeight
        }
      })
    }
    if (touching.current) return
    settle.current = setTimeout(() => {
      const node = scroller.current
      if (!node) return
      const next = modulo(Math.round(node.scrollTop / rowHeight), count)
      choose(middleCopy * count + next)
    }, 160)
  }

  return (
    <div className="time-wheel" style={{ "--time-wheel-row": `${rowHeight}px` } as CSSProperties}>
      <div className="time-wheel-selection" aria-hidden="true" />
      <div
        ref={scroller}
        role="spinbutton"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={value}
        aria-valuetext={`${String(value).padStart(2, "0")} ${unit}`}
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
          const row = (event.target as HTMLElement).closest<HTMLElement>("[data-wheel-index]")
          if (row) choose(Number(row.dataset.wheelIndex))
        }}
        onKeyDown={(event) => {
          const index = Math.round((scroller.current?.scrollTop || 0) / rowHeight)
          const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[event.key]
          if (step !== undefined) {
            event.preventDefault()
            choose(index + step)
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault()
            choose(middleCopy * count + (event.key === "Home" ? 0 : count - 1))
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            onComplete()
          }
        }}
      >
        <div aria-hidden="true">{rows}</div>
      </div>
    </div>
  )
}

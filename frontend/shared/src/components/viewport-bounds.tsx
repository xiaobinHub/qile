import { useEffect, type ReactNode } from "react"

/** Follows the usable visual viewport when the installed iPad app shows its keyboard. */
export function ViewportBounds({ children }: { children: ReactNode }) {
  useEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement
    let frame = 0
    let revealFocus = false
    const measure = (reveal = false) => {
      revealFocus ||= reveal
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (viewport && viewport.scale > 1.05) return
        const height = viewport?.height ?? innerHeight
        const top = viewport?.offsetTop ?? 0
        const layoutHeight = Math.max(root.clientHeight, innerHeight)
        const keyboardOpen = layoutHeight - height > Math.max(120, layoutHeight * 0.15)
        const changed = root.hasAttribute("data-app-keyboard-open") !== keyboardOpen
        root.style.setProperty("--app-visible-height", `${height}px`)
        root.style.setProperty("--app-visible-top", `${top}px`)
        root.toggleAttribute("data-app-keyboard-open", keyboardOpen)

        const dialogs = root.querySelectorAll<HTMLElement>('[data-keyboard-scroll="true"]')
        if (changed) {
          for (const dialog of dialogs) {
            dialog.scrollTop = 0
            const body = dialog.querySelector<HTMLElement>(".ui-modal-body")
            if (body) body.scrollTop = 0
          }
        }
        // Move only the dialog's scrollport, never the calendar behind it. Ordinary
        // viewport scroll events must not pull users back to the focused field.
        const active = document.activeElement
        if (keyboardOpen && revealFocus && active instanceof HTMLElement) {
          const dialog = active.closest<HTMLElement>('[data-keyboard-scroll="true"]')
          if (dialog && active.matches('input, textarea, [contenteditable="true"]')) {
            const bounds = active.getBoundingClientRect()
            const min = top + 24
            const max = top + height - 24
            if (bounds.top < min || bounds.height > max - min) {
              dialog.scrollTop += bounds.top - min
            } else if (bounds.bottom > max) {
              dialog.scrollTop += bounds.bottom - max
            }
          }
        }
        revealFocus = false
      })
    }
    const resize = () => measure(true)
    const scroll = () => measure()
    resize()
    viewport?.addEventListener("resize", resize, { passive: true })
    viewport?.addEventListener("scroll", scroll, { passive: true })
    window.addEventListener("resize", resize, { passive: true })
    document.addEventListener("focusin", resize)
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener("resize", resize)
      viewport?.removeEventListener("scroll", scroll)
      window.removeEventListener("resize", resize)
      document.removeEventListener("focusin", resize)
      root.removeAttribute("data-app-keyboard-open")
      root.style.removeProperty("--app-visible-height")
      root.style.removeProperty("--app-visible-top")
    }
  }, [])
  return children
}

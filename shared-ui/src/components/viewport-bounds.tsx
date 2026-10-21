import { useEffect, type ReactNode } from "react"

/** Follows the usable visual viewport when the installed iPad app shows its keyboard. */
export function ViewportBounds({ children }: { children: ReactNode }) {
  useEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (viewport && viewport.scale > 1.05) return
        root.style.setProperty("--app-visible-height", `${viewport?.height ?? innerHeight}px`)
        root.style.setProperty("--app-visible-top", `${viewport?.offsetTop ?? 0}px`)
      })
    }
    measure()
    viewport?.addEventListener("resize", measure, { passive: true })
    viewport?.addEventListener("scroll", measure, { passive: true })
    window.addEventListener("resize", measure, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener("resize", measure)
      viewport?.removeEventListener("scroll", measure)
      window.removeEventListener("resize", measure)
      root.style.removeProperty("--app-visible-height")
      root.style.removeProperty("--app-visible-top")
    }
  }, [])
  return children
}

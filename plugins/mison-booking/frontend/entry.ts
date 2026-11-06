import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import { ImageContext, PortalContext } from "./contexts"
import "./utilities.css"
import "./style.css"

export function mount(container: HTMLElement, context: Parameters<typeof App>[0]["context"]) {
  const portal = context.overlay
  portal.classList.add("mison-ui")
  const root = createRoot(container)
  root.render(
    createElement(
      PortalContext.Provider,
      { value: portal },
      createElement(
        ImageContext.Provider,
        { value: context },
        createElement("div", { className: "mison-ui" }, createElement(App, { context })),
      ),
    ),
  )
  return () => {
    root.unmount()
    portal.replaceChildren()
    portal.classList.remove("mison-ui")
  }
}

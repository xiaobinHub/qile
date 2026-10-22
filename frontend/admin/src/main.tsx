import { ViewportBounds } from "@shared/components/viewport-bounds"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "@/App"
import { ToastProvider } from "@shared/components/ui/toast"
import "@/index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <ViewportBounds>
        <App />
      </ViewportBounds>
    </ToastProvider>
  </StrictMode>,
)

import { ViewportBounds } from "@shared/components/viewport-bounds"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./styles.css"
createRoot(document.getElementById("root")!).render(
  <ViewportBounds>
    <App />
  </ViewportBounds>,
)

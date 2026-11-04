/** Shared aliases, React and scoped UI compilation for build and development. */
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import tailwind from "@tailwindcss/vite"
import { scopedCss } from "./plugin_ui_css.mjs"
export function pluginViteConfig(root, id) {
  const source = resolve(root, "plugins", id)
  const ui = existsSync(resolve(source, "frontend/utilities.css"))
  return {
    configFile: false,
    root: source,
    publicDir: false,
    plugins: [react(), ...(ui ? [tailwind()] : [])],
    css: ui
      ? {
          postcss: { plugins: [scopedCss(id === "mison-booking" ? ".mison-ui" : `.${id}-ui`, id)] },
        }
      : undefined,
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: {
        "@shared": resolve(root, "frontend/shared/src"),
        "@plugin-sdk": resolve(root, "packages/plugin-sdk/src"),
      },
    },
  }
}

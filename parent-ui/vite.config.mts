import { fileURLToPath, URL } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: {
    alias: { "@": fileURLToPath(new URL("../admin-ui/src", import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL("../web/parent-dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      name: "LeleParentUI",
      formats: ["iife"],
      fileName: () => "parent-ui.js",
    },
  },
})

import { fileURLToPath, URL } from "node:url"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/parent-assets/",
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../shared/src", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../../web/parent-dist", import.meta.url)),
    assetsDir: "",
    emptyOutDir: true,
    sourcemap: false,
  },
})

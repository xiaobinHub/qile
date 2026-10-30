/** Independently build one plugin; never rebuild either host application. */
import { build } from "vite"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  readdirSync,
  lstatSync,
  rmSync,
} from "node:fs"
import { resolve, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const id = process.argv[2]
if (!id || !/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw Error("请指定有效的插件 ID。")
const source = join(root, "plugins", id)
const manifest = JSON.parse(readFileSync(join(source, "plugin.json"), "utf8"))
if (manifest.id !== id || !/^\d+\.\d+\.\d+$/.test(manifest.version))
  throw Error("插件标识或版本无效。")
const output = join(root, "output/plugin-releases", id, manifest.version, "build")
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
if (manifest.frontend) {
  await build({
    configFile: false,
    root: source,
    publicDir: false,
    build: {
      outDir: join(output, "frontend"),
      emptyOutDir: true,
      sourcemap: false,
      lib: {
        entry: join(source, "frontend/entry.ts"),
        formats: ["es"],
        fileName: () => "entry.js",
      },
      rollupOptions: { output: { assetFileNames: "style.[ext]" } },
      minify: true,
      cssCodeSplit: false,
    },
  })
  manifest.frontend = {
    entry: "frontend/entry.js",
    styles: existsSync(join(output, "frontend/style.css")) ? ["frontend/style.css"] : [],
  }
}
function copyTree(from, to) {
  if (lstatSync(from).isSymbolicLink()) throw Error("插件源码不能包含符号链接。")
  if (lstatSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from))
      if (!name.startsWith(".") && name !== "__pycache__")
        copyTree(join(from, name), join(to, name))
  } else cpSync(from, to)
}
for (const dir of ["schemas", "assets", "backend"])
  if (existsSync(join(source, dir))) copyTree(join(source, dir), join(output, dir))
writeFileSync(join(output, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log(relative(root, output))

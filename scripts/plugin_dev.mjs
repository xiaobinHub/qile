/** Local plugin development orchestrator. No packaging or business API calls. */
import { createServer } from "vite"
import { spawn } from "node:child_process"
import { readFileSync, mkdirSync, chmodSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { pluginViteConfig } from "./plugin_vite_config.mjs"
const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
export function developmentEntry(base, id) {
  return `import RefreshRuntime from ${JSON.stringify("/@react-refresh")};
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
let implementation = await import(${JSON.stringify("/frontend/entry.ts")});
const mounts = new Set();
const ownedStyles = new Map();
const sourcePrefix = ${JSON.stringify(resolve(root, "plugins", "__PLUGIN__").replace("__PLUGIN__", ""))} + ${JSON.stringify(id)} + "/";
function collectStyles() {
  for (const style of document.querySelectorAll("style[data-vite-dev-id]")) {
    const key = style.getAttribute("data-vite-dev-id");
    if (key.startsWith(sourcePrefix)) {
      ownedStyles.set(key, style);
      if (!mounts.size) style.remove();
    }
  }
}
collectStyles();
const styleObserver = new MutationObserver(collectStyles);
styleObserver.observe(document.head, {childList: true});
// Session-level client survives core navigation. Ending a session reloads the
// document to dispose Vite's socket/module cache using supported browser APIs.
let ended = false;
async function checkSession() {
  if (ended) return;
  try {
    const response = await fetch(${JSON.stringify(base + "__dev_health")}, {credentials: "same-origin", cache: "no-store"});
    if (response.status === 409) { ended = true; location.reload(); return; }
  } catch { /* Loader reports a failed server; never silently use installed code. */ }
  if (!ended) sessionTimer = setTimeout(checkSession, 2000);
}
let sessionTimer = setTimeout(checkSession, 2000);
export function mount(container, context) {
  const item = {container, context, dispose: () => {}};
  mounts.add(item);
  for (const style of ownedStyles.values()) if (!style.isConnected) document.head.append(style);
  try { item.dispose = implementation.mount(container, context); }
  catch(error) { mounts.delete(item); collectStyles(); throw error; }
  return () => { mounts.delete(item); try { item.dispose(); } finally { collectStyles(); } };
}
if (import.meta.hot) {
  import.meta.hot.accept(${JSON.stringify("/frontend/entry.ts")}, module => {
    if (!module) return;
    implementation = module;
    for (const item of mounts) {
      item.dispose();
      if (!item.context.signal.aborted) item.dispose = module.mount(item.container, item.context);
    }
  });
  import.meta.hot.dispose(() => { ended = true; clearTimeout(sessionTimer); for (const item of mounts) item.dispose(); mounts.clear(); collectStyles(); styleObserver.disconnect(); });
}`
}
export async function createPluginDevServer(id, session, options = {}) {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id) || !/^[a-zA-Z0-9-]{8,80}$/.test(session))
    throw Error("无效的插件开发标识。")
  const base = `/__plugin-dev/${id}/${session}/`
  const common = pluginViteConfig(root, id)
  const server = await createServer({
    ...common,
    base,
    appType: "custom",
    optimizeDeps: { entries: [resolve(root, "plugins", id, "frontend/entry.ts")] },
    cacheDir: resolve(root, "node_modules/.vite-plugin-dev", id),
    plugins: [
      ...common.plugins,
      {
        name: "plugin-development-entry",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url?.split("?")[0] === base + "@plugin-entry") {
              try {
                const result = await server.transformRequest("/@plugin-entry.js")
                res.setHeader("Content-Type", "application/javascript")
                res.end(result.code)
              } catch (error) {
                next(error)
              }
              return
            }
            if (req.url?.split("?")[0] === base + "__dev_health") {
              res.setHeader("Content-Type", "application/json")
              res.end('{"ok":true}')
            } else next()
          })
        },
        resolveId(id) {
          if (id === base + "@plugin-entry" || id === "@plugin-entry" || id === "/@plugin-entry.js")
            return "\0plugin-development-entry"
        },
        load(moduleId) {
          if (moduleId === "\0plugin-development-entry") return developmentEntry(base, id)
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      ws: { path: base + "hmr", ...options.ws },
      fs: {
        strict: true,
        allow: [
          resolve(root, "plugins", id, "frontend"),
          resolve(root, "frontend/shared/src"),
          resolve(root, "packages/plugin-sdk/src"),
          resolve(root, "node_modules"),
        ],
        deny: ["**/.env*", "**/.git/**", "**/data/**", "**/*.{key,pem}"],
      },
    },
  })
  await server.listen()
  return server
}
function control(...args) {
  return new Promise((done, fail) => {
    const child = spawn(
      resolve(root, ".venv/bin/python"),
      [resolve(root, "scripts/plugin_dev.py"), ...args],
      { cwd: root, stdio: "inherit" },
    )
    child.on("error", fail)
    child.on("exit", (code) => (code === 0 ? done() : fail(Error(`开发控制命令失败 (${code})`))))
  })
}
async function main() {
  const [id, ...args] = process.argv.slice(2)
  if (!id || args.some((arg) => arg !== "--with-backend"))
    throw Error("用法：npm run plugin:dev -- 插件ID [--with-backend]")
  const config = JSON.parse(readFileSync(resolve(root, "data/development/config.json"), "utf8"))
  const origin = new URL(config.parent_origin)
  if (
    config.environment !== "development" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  )
    throw Error("仅支持本机开发环境。")
  const session = randomUUID()
  mkdirSync(resolve(root, "data/development/plugin-dev"), { recursive: true, mode: 0o700 })
  chmodSync(resolve(root, "data/development/plugin-dev"), 0o700)
  const server = await createPluginDevServer(id, session, {
    ws: {
      clientPort: Number(origin.port),
      protocol: origin.protocol === "https:" ? "wss" : "ws",
    },
  })
  let registered = false,
    stopping = false,
    timer,
    running = Promise.resolve()
  try {
    await control(
      "register",
      id,
      "--port",
      String(server.httpServer.address().port),
      "--session",
      session,
      "--pid",
      String(process.pid),
      ...args,
    )
    registered = true
  } catch (error) {
    await server.close()
    throw error
  }
  const source = resolve(root, "plugins", id)
  const reload = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      running = running
        .then(() => control("reload", id, "--session", session))
        .catch((error) => console.error(error.message))
    }, 400)
  }
  server.watcher.add([
    resolve(source, "backend"),
    resolve(source, "plugin.json"),
    resolve(source, "schemas"),
    resolve(root, "package-lock.json"),
  ])
  server.watcher.on("all", (_event, file) => {
    if (stopping) return
    if (file.startsWith(resolve(source, "backend")) && args.includes("--with-backend")) reload()
    else if (
      file.endsWith("plugin.json") ||
      file.endsWith("package-lock.json") ||
      file.startsWith(resolve(source, "schemas"))
    ) {
      console.error("权限、依赖或配置结构已变化。请停止开发模式，检查兼容性后重新启动。")
      void shutdown()
    }
  })
  async function shutdown() {
    if (stopping) return
    stopping = true
    clearTimeout(timer)
    try {
      await running
      if (registered) await control("stop", id, "--session", session)
      await server.close()
      console.log("开发模式已退出；刷新插件后使用已安装版本。")
      process.exitCode = 0
    } catch (error) {
      console.error(error.message)
      stopping = false
      console.error("尚未退出，请等待请求完成后再次按 Ctrl+C。")
    }
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  console.log(
    `插件 ${id} · 开发模式\n前端：源码热更新\n后端：${args.includes("--with-backend") ? "源码运行" : "已安装版本"}\n源码：${source}\n入口：${origin.origin}（刷新原插件页面）\nCtrl+C 排空请求并退出。`,
  )
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })

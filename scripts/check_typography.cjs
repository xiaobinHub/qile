/* Guard the shared scale against new screen-only pixel and viewport sizes. */
const fs = require("node:fs")
const path = require("node:path")
const root = path.resolve(__dirname, "..")
const violations = []
let files = 0
function walk(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (/\.(css|tsx)$/.test(file)) {
      files++
      fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/font-size:\s*(?:[\d.]+px|clamp\(|[^;]*\b\d+(?:\.\d+)?v[wh])|\btext-\[[\d.]+px\]/.test(line)) {
          violations.push(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`)
        }
      })
    }
  }
}
for (const folder of ["parent-ui/src", "admin-ui/src", "shared-ui/src"]) walk(path.join(root, folder))
if (violations.length) {
  console.error("Use shared typography roles; see docs/ui/字体与响应式规范.md\n" + violations.join("\n"))
  process.exitCode = 1
} else console.log(JSON.stringify({ passed: true, files, rule: "No arbitrary px or viewport-based screen font sizes" }))

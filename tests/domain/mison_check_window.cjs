const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const Module = require("node:module")
const source = path.resolve(__dirname, "../../plugins/mison-booking/frontend/check-window.ts")
const compiled = new Module(source, module)
compiled._compile(
  ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText,
  source,
)
const { checkWindow, quietHours, checkWindowLabel, axisTime, moveCheckBoundary } = compiled.exports

for (const [start, end] of [
  ["23:00", "08:00"],
  ["08:00", "23:00"],
  ["12:00", "13:00"],
  ["09:00", "12:00"],
  ["00:00", "12:00"],
  ["12:00", "00:00"],
  ["00:01", "23:59"],
  ["11:59", "12:01"],
]) {
  const quiet = { enabled: true, start, end }
  assert.deepEqual(
    quietHours(quiet, checkWindow(quiet)),
    quiet,
    `round trip preserves ${start}–${end}`,
  )
}
const legacy = { enabled: true, start: "23:00", end: "08:00" }
assert.deepEqual(checkWindow(legacy), { start: 1200, end: 660 })
assert.equal(checkWindowLabel(legacy), "08:00～23:00")
const overnight = quietHours(legacy, { start: 660, end: 1200 })
assert.deepEqual(overnight, { enabled: true, start: "08:00", end: "23:00" })
assert.equal(checkWindowLabel(overnight), "23:00～次日 08:00")
const full = quietHours(legacy, { start: 0, end: 1440 })
assert.deepEqual(full, { ...legacy, enabled: false })
assert.equal(checkWindowLabel(full), "全天执行")
assert.deepEqual(checkWindow(full), { start: 0, end: 1440 })
assert.equal(axisTime(0), "12:00")
assert.equal(axisTime(720), "00:00")
assert.equal(axisTime(1440), "12:00")
assert.deepEqual(moveCheckBoundary({ start: 719, end: 720 }, "start", 720), {
  start: 721,
  end: 720,
})
assert.deepEqual(moveCheckBoundary({ start: 0, end: 1440 }, "start", -1), { start: 0, end: 1440 })
assert.deepEqual(moveCheckBoundary({ start: 0, end: 1440 }, "end", 1500), { start: 0, end: 1440 })
assert.deepEqual(moveCheckBoundary({ start: 1200, end: 660 }, "start", 1440), { start: 0, end: 660 })
assert.deepEqual(moveCheckBoundary({ start: 0, end: 660 }, "end", 0), { start: 0, end: 1440 })
console.log(
  "Mison check window: round trips, noon/midnight, overnight, full day and boundary crossing passed",
)

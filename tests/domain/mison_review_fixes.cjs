const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const frontend = path.join(__dirname, "../../plugins/mison-booking/frontend")
let handler = async () => {
  throw new Error("未安装课程请求替身。")
}

const source = require(path.join(frontend, "booking-source.ts"))
const avatars = require(path.join(frontend, "avatar-cache.ts"))

function context() {
  const controller = new AbortController()
  return {
    controller,
    signal: controller.signal,
    api: async (...args) => ({ ok: true, data: await handler(...args) }),
  }
}

function lessonPage(complete = true) {
  return {
    status: "upcoming",
    page: 1,
    pageSize: 100,
    complete,
    items: [{ key: "lesson-1", startsAt: "2099-01-03T19:00:00" }],
  }
}

async function settled() {
  await new Promise((resolve) => setImmediate(resolve))
}

async function main() {
  let calls = 0
  let rejectFirst = () => {}
  handler = () =>
    new Promise((resolve, reject) => {
      calls += 1
      if (calls === 1) {
        rejectFirst = () => reject(Object.assign(new Error("页面已切换。"), { code: "stale" }))
        return
      }
      resolve(lessonPage())
    })
  const first = source.syncBookingSource(context(), "child:1", "upcoming", null)
  await settled()
  assert.equal(calls, 1)
  rejectFirst()
  await first
  assert.equal(source.readBookingSource("child:1", "upcoming", null).error, "")
  await source.syncBookingSource(context(), "child:1", "upcoming", null)
  assert.equal(calls, 2)
  assert.equal(source.readBookingSource("child:1", "upcoming", null).items.length, 1)
  source.clearBookingSource()

  const closed = context()
  closed.controller.abort()
  calls = 0
  handler = async () => {
    calls += 1
    return lessonPage()
  }
  await source.syncBookingSource(closed, "child:closed", "upcoming", null)
  await source.loadNextBookingPage(closed, "child:closed", "upcoming")
  assert.equal(calls, 0, "an abandoned instance cannot start another request")
  source.clearBookingSource()

  calls = 0
  handler = async () => {
    calls += 1
    throw new Error("课程读取失败")
  }
  await source.syncBookingSource(context(), "child:2", "upcoming", null)
  assert.equal(source.readBookingSource("child:2", "upcoming", null).error, "课程读取失败")
  await source.syncBookingSource(context(), "child:2", "upcoming", null)
  assert.equal(calls, 1, "a real read failure still stays until an explicit reload")
  source.clearBookingSource()

  calls = 0
  handler = () =>
    new Promise((resolve, reject) => {
      calls += 1
      if (calls === 1) {
        rejectFirst = () => reject(Object.assign(new Error("页面已切换。"), { code: "stale" }))
        return
      }
      resolve(lessonPage())
    })
  const old = context()
  const pending = source.syncBookingSource(old, "child:3", "upcoming", null)
  await settled()
  old.controller.abort()
  source.clearBookingSource()
  rejectFirst()
  await pending
  await source.syncBookingSource(context(), "child:3", "upcoming", null)
  assert.equal(calls, 2)
  assert.equal(source.readBookingSource("child:3", "upcoming", null).error, "")
  source.clearBookingSource()

  handler = async () => ({ status: "upcoming", page: 1, pageSize: 100, complete: false, items: [] })
  await source.syncBookingSource(context(), "child:4", "upcoming", null)
  assert.equal(
    source.readBookingSource("child:4", "upcoming", null).error,
    "课程分页未推进，请刷新列表。",
  )
  source.clearBookingSource()

  const reference = `mison-image:${"ab".repeat(32)}`
  const data = "data:image/png;base64,aaaa"
  let notices = 0
  const stop = avatars.subscribeAvatar(reference, () => {
    notices += 1
  })
  assert.equal(await avatars.loadAvatar(reference, async () => data), data)
  assert.equal(avatars.peekAvatar(reference), data)
  assert.equal(notices, 1, "a successful avatar load notifies the previously failed component")
  stop()
  avatars.forgetAvatar(reference)
  await avatars.loadAvatar(reference, async () => data)
  assert.equal(notices, 1, "unmounted avatars no longer receive cache updates")
  console.log(
    JSON.stringify({ passed: true, checks: ["stale booking cache", "avatar subscription"] }),
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

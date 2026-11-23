const assert = require("node:assert/strict")
const fs = require("node:fs")
const ts = require("typescript")
require.extensions[".ts"] = (module, file) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    file,
  )
global.BroadcastChannel = undefined
Object.assign(global, {
  history: { replaceState() {}, pushState() {} },
  location: { pathname: "/" },
  window: { scrollTo() {} },
  document: { hidden: false },
})
const { Runtime } = require("../../frontend/parent/src/lib/runtime.ts")
const { occurrences, isDone } = require("../../frontend/parent/src/domain/calendar.ts")
const child = { id: "child1", name: "甲", role: "owner", archived: false, membershipVersion: 3 }
const other = { ...child, id: "child2", name: "乙" }
const date = "2026-10-24"
function pkg(revision = 1, completed = [], changed = false) {
  const series = ["a", "b", "c"].map((id, index) => ({
    id,
    title: id,
    startDate: date,
    startTime: "17:00",
    endTime: "17:30",
    note: "",
    categoryId: "cat",
    points: changed && id === "b" ? 99 : (index + 1) * 5,
    recurrence: null,
  }))
  const data = {
    schemaVersion: 2,
    settings: { childName: "甲", weekStartsOn: 1 },
    categories: [{ id: "cat", name: "学习", color: "#123456", active: true }],
    series,
    exceptions: [],
    completions: [],
    ledger: [],
    gifts: [],
    taskPresets: [],
    operationLog: [],
  }
  for (const id of completed) {
    const task = series.find((t) => t.id === id)
    data.completions.push({
      occurrenceKey: `${id}@${date}`,
      completed: true,
      snapshot: { ...task, seriesId: id, date, originalDate: date },
      updatedAt: "2026-10-24T00:00:00Z",
    })
    data.ledger.push({
      id: "ledger-" + id,
      kind: "task-complete",
      amount: task.points,
      occurrenceKey: `${id}@${date}`,
      date,
      createdAt: "2026-10-24T00:00:00Z",
    })
  }
  return {
    format: "lele-task-manager-store",
    version: 1,
    revision,
    updatedAt: null,
    context: { childId: child.id, membershipVersion: 3 },
    data,
  }
}
function setup() {
  const runtime = new Runtime()
  runtime.patch({
    child,
    user: { id: "u", nickname: "家长", loginName: "parent" },
    children: [child, other],
    data: pkg().data,
    revision: 1,
    loading: false,
  })
  return { r: runtime, tasks: occurrences(runtime.getSnapshot().data, date, date) }
}
const conflict = () =>
  Response.json({ error: "数据已更新", kind: "revision_conflict" }, { status: 409 })
async function run() {
  {
    const {
        r,
        tasks: [a, b, c],
      } = setup(),
      requests = []
    global.fetch = (path, options) =>
      new Promise((resolve) => requests.push({ body: JSON.parse(options.body), resolve }))
    const first = r.setCompletion(a, true),
      duplicate = r.setCompletion(a, true),
      second = r.setCompletion(b, true),
      third = r.setCompletion(c, true)
    assert.equal(first, duplicate)
    await assert.rejects(() => r.setCompletion(a, false), /正在保存/)
    assert.equal(requests.length, 1)
    assert.deepEqual(r.getSnapshot().completionPending, [a.occurrenceKey, b.occurrenceKey, c.occurrenceKey])
    await assert.rejects(() => r.command("ledger.manual", { amount: 5 }), /正在保存/)
    for (const [index, pending] of [first, second, third].entries()) {
      assert.equal(requests.length, index + 1)
      assert.equal(requests[index].body.expectedRevision, index + 1)
      const id = ["a", "b", "c"][index]
      const result = pkg(index + 2, [id])
      const { completions, ledger } = result.data
      delete result.data
      result.changes = { completion: completions[0], ledger, operation: {id} }
      requests[index].resolve(Response.json(result))
      await pending
    }
    assert.equal(new Set(requests.map(({body}) => body.operationId)).size, 3)
    assert.equal(r.getSnapshot().revision, 4)
    assert.equal(r.getSnapshot().data.ledger.length, 3)
    assert.equal(r.getSnapshot().data.operationLog.length, 3)
    assert.equal(isDone(r.getSnapshot().data, b), true)
    assert.equal(r.getSnapshot().busy, false)
  }
  // Only a confirmed revision conflict gets a fresh revision; intent and ID stay stable.
  {
    const {
        r,
        tasks: [, b],
      } = setup(),
      posts = []
    global.fetch = async (path, options) => {
      if (options.method === "GET") return Response.json(pkg(2, ["a"]))
      const body = JSON.parse(options.body)
      posts.push(body)
      return body.expectedRevision === 1 ? conflict() : Response.json(pkg(3, ["a", "b"]))
    }
    await r.setCompletion(b, true)
    assert.equal(posts.length, 2)
    assert.equal(posts[0].operationId, posts[1].operationId)
    assert.equal(posts[1].expectedRevision, 2)
    assert.equal(r.getSnapshot().revision, 3)
    assert.equal(r.getSnapshot().unconfirmed, false)
  }
  // Never apply an old click to changed task content or points.
  {
    const {
      r,
      tasks: [, b],
    } = setup()
    let posts = 0
    global.fetch = async (path, options) =>
      options.method === "GET" ? Response.json(pkg(2, [], true)) : (posts++, conflict())
    await assert.rejects(
      () => r.setCompletion(b, true),
      (e) => e.code === "task_changed",
    )
    assert.equal(posts, 1)
    assert.equal(r.getSnapshot().unconfirmed, false)
    assert.deepEqual(r.getSnapshot().completionPending, [])
  }
  {
    const {
        r,
        tasks: [a, b],
      } = setup(),
      posts = []
    global.fetch = async (path, options) => {
      if (options.method === "GET") return Response.json(pkg(2, ["a"]))
      const body = JSON.parse(options.body)
      posts.push(body)
      if (body.payload.occurrenceKey === a.occurrenceKey) throw Error("committed response lost")
      assert.fail("Queued request sent before recovery")
    }
    const first = r.setCompletion(a, true),
      second = r.setCompletion(b, true)
    await assert.rejects(() => first, /未确认/)
    assert.equal(r.getSnapshot().unconfirmed, true)
    assert.equal(r.getSnapshot().busy, false)
    assert.deepEqual(r.getSnapshot().completionPending, [b.occurrenceKey])
    await r.refresh()
    assert.match(r.getSnapshot().message, /原操作编号仍保留/)
    assert.equal(posts.length, 1)
    await assert.rejects(() => r.selectChild(other.id), /刷新核对/)
    await r.enter()
    assert.equal(r.getSnapshot().child.id, child.id)
    await assert.rejects(() => r.setCompletion(a, false), /上次保存结果/)
    await assert.rejects(() => r.command("ledger.manual", { amount: 5 }), /尚未确认/)
    global.fetch = async (path, options) => {
      posts.push(JSON.parse(options.body))
      return Response.json(posts.length === 2 ? pkg(2, ["a"]) : pkg(3, ["a", "b"]))
    }
    await r.retryPending()
    await second
    assert.deepEqual(posts[0], posts[1])
    assert.equal(posts[2].expectedRevision, 2)
    assert.equal(r.getSnapshot().unconfirmed, false)
    assert.equal(r.getSnapshot().data.ledger.length, 2)
  }
  {
    const {
        r,
        tasks: [a, b],
      } = setup(),
      posts = []
    global.fetch = async (path, options) => {
      posts.push(JSON.parse(options.body))
      throw Error("lost")
    }
    const first = r.setCompletion(a, true)
    const second = r.setCompletion(b, true)
    await assert.rejects(first, /未确认/)
    assert.equal(r.getSnapshot().unconfirmed, true)
    global.fetch = async (path, options) => {
      if (options.method === "GET") return Response.json(pkg(2, [], true))
      const body = JSON.parse(options.body)
      posts.push(body)
      return body.expectedRevision === 1 ? conflict() : Response.json(pkg(3, ["a"], true))
    }
    await r.retryPending()
    await assert.rejects(second, (error) => error.code === "task_changed")
    assert.equal(posts.length, 3)
    assert.deepEqual(posts[0], posts[1])
    assert.deepEqual(posts[2], {...posts[0], expectedRevision: 2})
    assert.equal(r.getSnapshot().unconfirmed, false)
  }
  // Membership changes and HTTP errors do not silently retry.
  {
    const {
      r,
      tasks: [a],
    } = setup()
    let requests = 0
    global.fetch = async () => {
      requests++
      return Response.json({ error: "权限已变化", kind: "membership_changed" }, { status: 409 })
    }
    await assert.rejects(
      () => r.setCompletion(a, true),
      (e) => e.code === "membership_changed",
    )
    assert.equal(requests, 1)
    assert.equal(r.getSnapshot().unconfirmed, false)
  }
  // If another client already reached the desired state, do not write another ledger entry.
  {
    const {
      r,
      tasks: [a],
    } = setup()
    let posts = 0
    global.fetch = async (path, options) =>
      options.method === "GET" ? Response.json(pkg(2, ["a"])) : (posts++, conflict())
    await r.setCompletion(a, true)
    assert.equal(posts, 1)
    assert.equal(isDone(r.getSnapshot().data, a), true)
  }
  // An old-child reply must never alter the replacement context.
  {
    const {
      r,
      tasks: [a],
    } = setup()
    let resolve
    global.fetch = async () => new Promise((done) => (resolve = done))
    const pending = r.setCompletion(a, true)
    const queued = r.setCompletion(occurrences(r.getSnapshot().data, date, date)[1], true)
    r.reset()
    r.patch({ child: other, data: pkg().data, loading: false })
    resolve(Response.json(pkg(2, ["a"])))
    await Promise.all([pending, queued].map((job) => assert.rejects(job, (error) => error.kind === "stale")))
    assert.equal(r.getSnapshot().child.id, other.id)
    assert.equal(r.getSnapshot().unconfirmed, false)
    assert.deepEqual(r.getSnapshot().completionPending, [])
  }
  // Read failures after a confirmed conflict are safe failures, not unknown writes.
  {
    const {
      r,
      tasks: [a],
    } = setup()
    global.fetch = async (path, options) => {
      if (options.method === "GET") throw Error("offline read")
      return conflict()
    }
    await assert.rejects(() => r.setCompletion(a, true), /暂时无法连接/)
    assert.equal(r.getSnapshot().unconfirmed, false)
  }
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "three immediate spinners, FIFO posts",
        "same-task deduplication",
        "incremental ledger and operation log",
        "confirmed-conflict retry",
        "changed-task guard",
        "mixed failure retention",
        "original-body recovery",
        "queued task rechecked after recovery",
        "membership guard",
        "desired-state no-op",
        "stale child response",
        "confirmed-conflict read failure",
      ],
    }),
  )
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

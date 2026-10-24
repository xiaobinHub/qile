const assert = require("node:assert/strict")
const fs = require("node:fs")
const ts = require("typescript")
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    filename,
  )
const {
  ledgerView,
  ledgerAction,
  ledgerActionLabel,
  ledgerActionsForSource,
  retainLedgerActions,
} = require("../../frontend/parent/src/domain/ledger.ts")
const row = (id, kind, amount, date, occurrenceKey) => ({
  id,
  kind,
  amount,
  date: `2026-10-0${date}`,
  createdAt: `2026-10-0${date}T12:00:00Z`,
  occurrenceKey,
})
const ledger = [
  row("cancelled", "task-complete", 10, 5, "a"),
  row("old-completion", "task-complete", 20, 5, "b"),
  row("still-complete", "task-complete", 30, 5, "c"),
  row("bonus", "manual", 50, 5),
  row("undo-a", "task-reversal", -10, 6, "a"),
  row("undo-b", "task-reversal", -20, 6, "b"),
  row("deduction", "manual", -7, 6),
  row("redeem", "gift-redeem", -15, 6),
  row("new-completion", "task-complete", 20, 7, "b"),
  { ...row("refund", "gift-reversal", 15, 7), relatedLedgerId: "redeem" },
]
function check(filters, earned, deducted, count) {
  const result = ledgerView(ledger, filters)
  assert.equal(result.earned, earned)
  assert.equal(result.deducted, deducted)
  assert.equal(result.rows.length, count)
  return result
}
const all = check({}, 50, -22, 10)
assert.equal(all.rows[0].balanceAfter, 93)
check({ actions: ["task-complete"] }, 50, 0, 4)
check({ actions: ["task-reversal"] }, 0, 0, 2)
check({ actions: ["gift-redeem"] }, 0, -15, 1)
check({ actions: ["gift-reversal"] }, 0, 0, 1)
check({ actions: ["manual-minus"] }, 0, -7, 1)
check({ actions: ["manual-plus"] }, 0, 0, 1)
check({ source: "task" }, 50, 0, 6)
check({ source: "manual" }, 0, -7, 2)
check({ source: "gift" }, 0, -15, 2)
check({ from: "2026-10-05", to: "2026-10-05" }, 30, 0, 4)
check({ from: "2026-10-06", to: "2026-10-06" }, 0, -22, 4)
check({ from: "2026-10-07", to: "2026-10-07" }, 20, 0, 2)
const filtered = check({ source: "task", actions: ["task-complete"], to: "2026-10-05" }, 30, 0, 3)
assert.equal(filtered.rows[0].balanceAfter, 60, "Historical balance includes every earlier record")
check({ source: "manual", actions: ["task-complete"] }, 0, 0, 0)
assert.deepEqual(ledgerView([]), { rows: [], earned: 0, deducted: 0 })
assert.equal(ledgerView(ledger.slice(0, 1).concat(ledger[4])).earned, 0)
assert.equal(
  ledgerView([
    row("same-a", "task-complete", 5, 5, "same"),
    row("same-b", "task-reversal", -5, 5, "same"),
  ]).earned,
  0,
)
assert.equal(ledgerAction(ledger[3]), "manual-plus")
assert.equal(ledgerActionLabel(ledger[6]), "手动扣减")
assert.equal(ledgerActionLabel(ledger[9]), "撤销兑换")
assert.deepEqual(
  ledger.map((entry) => entry.id),
  [
    "cancelled",
    "old-completion",
    "still-complete",
    "bonus",
    "undo-a",
    "undo-b",
    "deduction",
    "redeem",
    "new-completion",
    "refund",
  ],
  "Aggregation never mutates input order",
)
console.log(
  "Ledger metrics passed: final task earnings, repeated completions, cross-date cancellations, six action filters, source/date intersections and historical balances.",
)

check({ actions: ["task-complete", "task-reversal"] }, 50, 0, 6)
check({ actions: ["manual-plus", "manual-minus"] }, 0, -7, 2)
check({ actions: ["gift-redeem", "gift-reversal"] }, 0, -15, 2)
check({ actions: ["task-complete", "manual-minus"] }, 50, -7, 5)
check({ source: "task", actions: ["task-complete", "manual-minus"] }, 50, 0, 4)
check({ from: "2026-10-06", actions: ["task-complete", "task-reversal"] }, 20, 0, 3)
check({ actions: [] }, 50, -22, 10)
assert.deepEqual(
  ledgerActionsForSource("all").map((option) => option.value),
  ["task-complete", "task-reversal", "gift-redeem", "gift-reversal", "manual-minus", "manual-plus"],
)
assert.deepEqual(
  ledgerActionsForSource("task").map((option) => option.value),
  ["task-complete", "task-reversal"],
)
assert.deepEqual(
  ledgerActionsForSource("gift").map((option) => option.value),
  ["gift-redeem", "gift-reversal"],
)
assert.deepEqual(
  ledgerActionsForSource("manual").map((option) => option.value),
  ["manual-minus", "manual-plus"],
)
assert.deepEqual(retainLedgerActions(["task-complete", "manual-minus"], "task"), ["task-complete"])
assert.deepEqual(retainLedgerActions(["manual-minus"], "task"), [])
assert.deepEqual(retainLedgerActions(["task-reversal"], "all"), ["task-reversal"])
console.log(
  "Linked scene multi-selection, OR/AND intersections, ordering and compatible source transitions passed.",
)

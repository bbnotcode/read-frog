import assert from "node:assert/strict"
import test from "node:test"
import {
  normalizeBudget,
  budgetWindow,
  budgetSummary,
  claimBudgetReminder,
  recoverPendingUsage,
} from "./chatgpt-budget.mjs"
test("budget resets at Shanghai 08:00 and keeps daily limit", () => {
  assert.equal(budgetWindow(Date.parse("2026-10-01T23:59:59Z")), "2026-10-01")
  assert.equal(budgetWindow(Date.parse("2026-10-02T00:00:00Z")), "2026-10-02")
  assert.deepEqual(
    normalizeBudget(
      { day: "2026-10-01", limit: 60000, used: 40000, extra: 25000 },
      Date.parse("2026-10-02T00:00:00Z"),
    ),
    {
      day: "2026-10-02",
      limit: 60000,
      used: 0,
      extra: 0,
      estimated: 0,
      notifiedDay: null,
      pending: [],
      models: {},
    },
  )
})
test("forced-exit recovery charges pending calls once and preserves confirmed model statistics", () => {
  const models = { test: { requests: 1, input: 100, output: 100, reasoning: 0 } }
  const value = {
    day: budgetWindow(),
    limit: 50000,
    used: 200,
    models,
    pending: [{ id: "call", tokens: 2000 }],
  }
  const recovered = recoverPendingUsage(value)
  assert.equal(recovered.used, 2200)
  assert.equal(recovered.estimated, 2000)
  assert.deepEqual(recovered.models, models)
  assert.deepEqual(recoverPendingUsage(recovered), recovered)
  assert.equal(recoverPendingUsage({ ...value, day: "2020-01-01" }).used, 0)
})
test("20-percent reminder uses exact settled usage and ignores reservations", () => {
  const value = { day: budgetWindow(), limit: 50000, used: 39999 }
  assert.equal(budgetSummary(value, 10000).percent, 0)
  assert.equal(budgetSummary(value, 10000).low, false)
  assert.equal(claimBudgetReminder(value), null)
  const reminder = claimBudgetReminder({ ...value, used: 40000 })
  assert.ok(reminder)
  assert.match(reminder.message, /20%/)
  assert.match(reminder.message, /不是 Plus/)
})
test("reminder survives restart and top-ups, then resets with the next budget day", () => {
  const now = Date.parse("2026-10-02T03:00:00Z")
  const reminder = claimBudgetReminder({ day: "2026-10-02", limit: 50000, used: 40000 }, now)
  const restored = JSON.parse(JSON.stringify(reminder.budget))
  assert.equal(claimBudgetReminder(restored, now), null)
  assert.equal(claimBudgetReminder({ ...restored, extra: 25000, used: 70000 }, now), null)
  const next = Date.parse("2026-10-03T00:00:00Z")
  const reset = normalizeBudget(restored, next)
  assert.equal(reset.notifiedDay, null)
  assert.ok(claimBudgetReminder({ ...reset, used: 40000 }, next))
})
test("in-flight reservations reduce available budget without changing actual usage", () => {
  const value = { day: budgetWindow(), limit: 50000, used: 10000, extra: 0 }
  const summary = budgetSummary(value, 5000)
  assert.equal(summary.used, 10000)
  assert.equal(summary.remaining, 35000)
  assert.equal(summary.percent, 70)
})
test("invalid numbers recover and exhausted budgets never show negative remaining", () => {
  assert.equal(normalizeBudget({ limit: null }).limit, 50000)
  const summary = budgetSummary({ day: budgetWindow(), limit: 50000, used: 51000, extra: 0 })
  assert.equal(summary.remaining, 0)
  assert.equal(summary.percent, 0)
})

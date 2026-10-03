export function budgetWindow(now = Date.now()) {
  // 08:00 Asia/Shanghai is 00:00 UTC, independent of the computer timezone.
  return new Date(now).toISOString().slice(0, 10)
}
export function normalizeBudget(value = {}, now = Date.now()) {
  const day = budgetWindow(now)
  return {
    day,
    limit: Number.isSafeInteger(value.limit) && value.limit > 0 ? value.limit : 50000,
    extra:
      value.day === day && Number.isSafeInteger(value.extra) && value.extra >= 0 ? value.extra : 0,
    used: value.day === day && Number.isSafeInteger(value.used) && value.used >= 0 ? value.used : 0,
    estimated:
      value.day === day && Number.isSafeInteger(value.estimated) && value.estimated >= 0
        ? value.estimated
        : 0,
    notifiedDay: value.notifiedDay === day ? day : null,
    pending:
      value.day === day && Array.isArray(value.pending)
        ? value.pending.filter(
            (item) =>
              typeof item?.id === "string" && Number.isSafeInteger(item.tokens) && item.tokens > 0,
          )
        : [],
    models:
      value.day === day && value.models && typeof value.models === "object"
        ? Object.fromEntries(
            Object.entries(value.models).filter(
              ([, item]) =>
                item &&
                ["requests", "input", "output", "reasoning"].every(
                  (key) => Number.isSafeInteger(item[key]) && item[key] >= 0,
                ),
            ),
          )
        : {},
  }
}
export function recoverPendingUsage(value, now = Date.now()) {
  const budget = normalizeBudget(value, now)
  const estimate = budget.pending.reduce((total, item) => total + item.tokens, 0)
  return {
    ...budget,
    used: budget.used + estimate,
    estimated: budget.estimated + estimate,
    pending: [],
  }
}
export function budgetSummary(value, reserved = 0) {
  const budget = normalizeBudget(value)
  const total = budget.limit + budget.extra
  const remaining = Math.max(0, total - budget.used - reserved)
  return {
    ...budget,
    total,
    remaining,
    reserved,
    percent: Math.round((100 * remaining) / total),
    low: budget.used >= total * 0.8,
    exceeded: Math.max(0, budget.used - total),
    mode: "reminder",
    resetAt: new Date(Date.parse(`${budget.day}T00:00:00Z`) + 86400000).toISOString(),
  }
}

// Use settled usage, not temporary reservations or rounded percentages.
// One reminder per Shanghai budget day, even after top-ups or a service restart.
export function claimBudgetReminder(value, now = Date.now()) {
  const budget = normalizeBudget(value, now)
  const total = budget.limit + budget.extra
  if (budget.notifiedDay === budget.day || budget.used < total * 0.8) return null
  return {
    budget: { ...budget, notifiedDay: budget.day },
    message: `今日阅读预算剩余 ${Math.max(0, Math.round((100 * (total - budget.used)) / total))}%（${Math.max(0, total - budget.used).toLocaleString("zh-CN")} tokens）。仍可继续使用或追加预算；这不是 Plus 账户余额，请注意为开发留出额度。`,
  }
}

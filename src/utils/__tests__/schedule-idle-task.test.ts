import { describe, expect, it, vi } from "vitest"
import { scheduleIdleTask } from "../schedule-idle-task"

describe("scheduleIdleTask", () => {
  it("uses and cancels requestIdleCallback when available", () => {
    const task = vi.fn<() => void>()
    const requestIdleCallback = vi.fn<(callback: () => void) => number>(() => 42)
    const cancelIdleCallback = vi.fn<(handle: number) => void>()
    const cancel = scheduleIdleTask(task, {
      requestIdleCallback,
      cancelIdleCallback,
      setTimeout,
      clearTimeout,
    })

    expect(requestIdleCallback).toHaveBeenCalledWith(task, { timeout: 1000 })
    cancel()
    expect(cancelIdleCallback).toHaveBeenCalledWith(42)
  })

  it("falls back to a cancellable timer", () => {
    vi.useFakeTimers()
    const task = vi.fn<() => void>()
    const cancel = scheduleIdleTask(task)
    cancel()
    vi.runAllTimers()
    expect(task).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

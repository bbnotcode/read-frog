interface IdleTaskTarget {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}

/** Schedule non-urgent startup work without competing with the page's initial interactions. */
export function scheduleIdleTask(
  task: () => void,
  target: IdleTaskTarget = globalThis,
  timeout = 1000,
) {
  if (target.requestIdleCallback && target.cancelIdleCallback) {
    const handle = target.requestIdleCallback(task, { timeout })
    return () => target.cancelIdleCallback?.(handle)
  }

  const handle = target.setTimeout(task, 0)
  return () => target.clearTimeout(handle)
}

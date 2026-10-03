// Small bounded FIFO; cancelled requests never acquire a slot or reserve budget.
export class RequestGate {
  active = 0
  queue = []
  constructor(limit = 2) {
    this.limit = limit
  }
  acquire(signal) {
    if (signal.aborted) return Promise.reject(signal.reason)
    if (this.queue.length >= 64) return Promise.reject(new Error("翻译排队过多，请稍后再试。"))
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, abort: undefined }
      item.abort = () => {
        const index = this.queue.indexOf(item)
        if (index >= 0) this.queue.splice(index, 1)
        reject(signal.reason)
      }
      signal.addEventListener("abort", item.abort, { once: true })
      this.queue.push(item)
      this.drain()
    })
  }
  drain() {
    while (this.active < this.limit && this.queue.length) {
      const item = this.queue.shift()
      item.signal.removeEventListener("abort", item.abort)
      this.active++
      let released = false
      item.resolve(() => {
        if (released) return
        released = true
        this.active--
        this.drain()
      })
    }
  }
}
export function estimateRequestTokens(input) {
  // Conservative text estimate plus output headroom, not an account-quota conversion.
  return Math.max(2000, Math.ceil(JSON.stringify(input).length / 2) + 1500)
}

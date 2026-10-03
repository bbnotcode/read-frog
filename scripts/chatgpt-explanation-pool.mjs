// Ephemeral subscribers belong to the local process, not the extension worker.
// The last departing reader cancels upstream; one departing reader cannot cancel others.
export class ExplanationPool {
  jobs = new Map()
  run(key, signal, onText, produce) {
    if (signal.aborted) return Promise.reject(signal.reason)
    let job = this.jobs.get(key)
    if (!job || job.controller.signal.aborted) {
      job = { controller: new AbortController(), readers: new Set(), text: "" }
      this.jobs.set(key, job)
      const current = job
      queueMicrotask(async () => {
        try {
          const result = await produce(current.controller.signal, (text) => {
            current.text = text
            for (const reader of current.readers) reader.onText(text)
          })
          for (const reader of current.readers) reader.resolve(result)
        } catch (error) {
          for (const reader of current.readers) reader.reject(error)
        } finally {
          for (const reader of current.readers) reader.cleanup()
          current.readers.clear()
          if (this.jobs.get(key) === current) this.jobs.delete(key)
        }
      })
    }
    const current = job
    return new Promise((resolve, reject) => {
      const abort = () => {
        current.readers.delete(reader)
        reader.cleanup()
        reject(signal.reason)
        if (!current.readers.size) current.controller.abort()
      }
      const reader = {
        resolve,
        reject,
        onText,
        cleanup: () => signal.removeEventListener("abort", abort),
      }
      current.readers.add(reader)
      signal.addEventListener("abort", abort, { once: true })
      if (current.text) onText(current.text)
    })
  }
  abortAll() {
    for (const job of this.jobs.values()) job.controller.abort()
  }
}

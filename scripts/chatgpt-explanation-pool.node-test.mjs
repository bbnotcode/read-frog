import assert from "node:assert/strict"
import test from "node:test"
import { ExplanationPool } from "./chatgpt-explanation-pool.mjs"

test("duplicate readers share work, late readers receive current text, one cancellation is isolated", async () => {
  const pool = new ExplanationPool()
  const a = new AbortController(),
    b = new AbortController()
  let calls = 0,
    complete,
    emit,
    upstream
  const producer = async (signal, onText) => {
    calls++
    emit = onText
    upstream = signal
    return new Promise((resolve) => {
      complete = resolve
    })
  }
  const first = pool.run("same", a.signal, () => {}, producer)
  const rejected = assert.rejects(first, { name: "AbortError" })
  await new Promise(queueMicrotask)
  emit("partial")
  const texts = []
  const second = pool.run("same", b.signal, (text) => texts.push(text), producer)
  assert.deepEqual(texts, ["partial"])
  a.abort()
  await rejected
  assert.equal(upstream.aborted, false)
  complete({ text: "final" })
  assert.deepEqual(await second, { text: "final" })
  assert.equal(calls, 1)
  assert.equal(pool.jobs.size, 0)
})

test("last reader cancels upstream; a new request never joins the aborted job", async () => {
  const pool = new ExplanationPool(),
    a = new AbortController(),
    b = new AbortController()
  let cancelled = false
  const first = pool.run(
    "same",
    a.signal,
    () => {},
    (signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true
            reject(signal.reason)
          },
          { once: true },
        )
      }),
  )
  const rejected = assert.rejects(first, { name: "AbortError" })
  await new Promise(queueMicrotask)
  a.abort()
  const second = pool.run(
    "same",
    b.signal,
    () => {},
    async () => ({ text: "new" }),
  )
  await rejected
  assert.equal(cancelled, true)
  assert.deepEqual(await second, { text: "new" })
  assert.equal(pool.jobs.size, 0)
})

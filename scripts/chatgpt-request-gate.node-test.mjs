import assert from "node:assert/strict"
import test from "node:test"
import { RequestGate, estimateRequestTokens } from "./chatgpt-request-gate.mjs"
test("FIFO concurrency is bounded and release is idempotent", async () => {
  const gate = new RequestGate(2)
  const signal = new AbortController().signal
  const a = await gate.acquire(signal),
    b = await gate.acquire(signal)
  let granted = false
  const pending = gate.acquire(signal).then((release) => {
    granted = true
    return release
  })
  await Promise.resolve()
  assert.equal(granted, false)
  assert.equal(gate.active, 2)
  a()
  a()
  const c = await pending
  assert.equal(gate.active, 2)
  b()
  c()
  assert.equal(gate.active, 0)
})
test("queued cancellation frees the queue and does not leak a slot", async () => {
  const gate = new RequestGate(1)
  const first = await gate.acquire(new AbortController().signal)
  const controller = new AbortController()
  const pending = gate.acquire(controller.signal)
  controller.abort(new Error("cancelled"))
  await assert.rejects(pending, /cancelled/)
  assert.equal(gate.queue.length, 0)
  first()
  assert.equal(gate.active, 0)
  await assert.rejects(gate.acquire(controller.signal), /cancelled/)
})
test("estimates reserve output headroom and scale with input", () => {
  assert.equal(estimateRequestTokens({ input: "hello" }), 2000)
  assert.ok(estimateRequestTokens({ input: "x".repeat(10000) }) > 6000)
})

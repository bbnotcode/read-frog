import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { getTestPort } from "./chatgpt-test-port.mjs"
test("bridge gates concurrent translation, settles reservations, and records missing usage conservatively", async () => {
  const directory = await mkdtemp(join(tmpdir(), "readfrog-gate-test-"))
  const port = await getTestPort()
  await writeFile(
    join(directory, "credentials.json"),
    JSON.stringify({
      host: "test",
      pairing: "test-pairing",
      account: {
        subject: "test-account",
        access_token: "mock-token",
        expires: Date.now() + 3600000,
      },
    }),
    { mode: 0o600 },
  )
  const startChild = () =>
    spawn(
      process.execPath,
      [
        "--import",
        resolve("scripts/chatgpt-bridge.mock-upstream.mjs"),
        "scripts/chatgpt-bridge.mjs",
      ],
      {
        env: {
          ...process.env,
          READFROG_CHATGPT_DATA_DIR: directory,
          READFROG_CHATGPT_DISABLE_NOTIFICATIONS: "1",
          READFROG_CHATGPT_PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
  let child = startChild()
  const ready = async () =>
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw new Error("Bridge could not start")
      }),
    ])
  const headers = { Authorization: "Bearer test-pairing", "Content-Type": "application/json" }
  const base = `http://127.0.0.1:${port}`
  const usage = async () => await (await fetch(`${base}/usage`, { headers })).json()
  const translate = async (text = "hello") =>
    await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-6-luna",
        input: [{ role: "user", content: text }],
        stream: false,
      }),
    })
  try {
    await ready()
    const responses = Promise.all(Array.from({ length: 5 }, () => translate()))
    const concurrencyDeadline = Date.now() + 1000
    let active = 0
    do {
      active = (await usage()).inFlight
      if (active === 4) break
      await new Promise((resume) => setTimeout(resume, 10))
    } while (Date.now() < concurrencyDeadline)
    assert.equal(active, 4)
    const results = await responses
    for (const r of results) {
      assert.equal(r.status, 200)
      assert.ok((await r.json()).output.length)
    }
    let state = await usage()
    assert.equal(state.budget.used, 1000)
    assert.equal(state.budget.reserved, 0)
    assert.equal(state.inFlight, 0)
    assert.equal(state.queued, 0)
    assert.equal((await translate("missing-usage")).status, 200)
    state = await usage()
    assert.equal(state.budget.estimated, 2000)
    assert.equal(state.budget.used, 3000)
    await fetch(`${base}/budget`, {
      method: "POST",
      headers,
      body: JSON.stringify({ limit: 5000 }),
    })
    const reservationResults = await Promise.all([translate(), translate()])
    assert.deepEqual(
      reservationResults.map((r) => r.status).sort((a, b) => a - b),
      [200, 200],
    )
    state = await usage()
    assert.equal(state.budget.used, 3400)
    assert.equal(state.budget.reserved, 0)
    // Lowering the daily target should remind, never block subsequent translation.
    await fetch(`${base}/budget`, {
      method: "POST",
      headers,
      body: JSON.stringify({ limit: 1000 }),
    })
    assert.equal((await translate()).status, 200)
    state = await usage()
    assert.equal(state.budget.used, 3600)
    assert.equal(state.budget.percent, 0)
    assert.equal(state.budget.low, true)
    assert.equal(state.budget.exceeded, 2600)
    assert.equal(state.budget.mode, "reminder")
    const persisted = JSON.parse(await readFile(join(directory, "budget.json"), "utf8"))
    assert.equal(persisted.notifiedDay, state.budget.day)
    const explain = async (word, stream = true, signal) =>
      await fetch(`${base}/explain`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({ word, sentence: "a sentence", model: "gpt-6-luna", stream }),
      })
    const before = state.models["gpt-6-luna"].requests
    const [a, b] = await Promise.all([explain("bank"), explain("bank")])
    const reader = a.body.getReader()
    const first = await reader.read()
    assert.match(new TextDecoder().decode(first.value), /"type":"text"/)
    assert.equal((await usage()).models["gpt-6-luna"].requests, before)
    let body = new TextDecoder().decode(first.value)
    while (true) {
      const next = await reader.read()
      if (next.done) break
      body += new TextDecoder().decode(next.value)
    }
    assert.match(body, /"type":"complete"/)
    assert.match(await b.text(), /"type":"complete"/)
    assert.equal((await usage()).models["gpt-6-luna"].requests, before + 1)
    assert.equal((await (await explain("bank", false)).json()).cached, true)
    const cancel = new AbortController()
    const cancelled = await explain("cancelled", true, cancel.signal)
    const cancelReader = cancelled.body.getReader()
    await cancelReader.read()
    cancel.abort()
    await cancelReader.cancel().catch(() => {})
    const deadline = Date.now() + 3000
    do {
      state = await usage()
      if (!state.inFlight) break
      await new Promise((resume) => setTimeout(resume, 20))
    } while (Date.now() < deadline)
    assert.equal(state.inFlight, 0)
    assert.equal(state.budget.reserved, 0)
    assert.equal(state.budget.pending.length, 0)
    assert.equal(state.budget.estimated, 4000)
    const savedUsed = state.budget.used
    // A real process restart preserves completed statistics and does not double-charge cancellation.
    child.kill()
    await once(child, "exit")
    child = startChild()
    await ready()
    state = await usage()
    assert.equal(state.budget.used, savedUsed)
    assert.equal(state.models["gpt-6-luna"].requests, before + 1)
    // Kill during an admitted request: its durable estimate is recovered exactly once.
    const interrupted = await explain("forced-exit")
    const interruptedReader = interrupted.body.getReader()
    await interruptedReader.read()
    child.kill("SIGKILL")
    await once(child, "exit")
    await interruptedReader.cancel().catch(() => {})
    child = startChild()
    await ready()
    state = await usage()
    assert.equal(state.budget.used, savedUsed + 2000)
    assert.equal(state.budget.estimated, 6000)
    assert.equal(state.budget.pending.length, 0)
  } finally {
    child.kill()
    await once(child, "exit")
  }
})

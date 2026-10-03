import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { getTestPort } from "./chatgpt-test-port.mjs"

test("bridge rejects unpaired requests, hostile origins and forged OAuth callbacks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "readfrog-chatgpt-test-"))
  const port = await getTestPort()
  const child = spawn(process.execPath, ["scripts/chatgpt-bridge.mjs"], {
    env: {
      ...process.env,
      READFROG_CHATGPT_DATA_DIR: directory,
      READFROG_CHATGPT_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  try {
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw new Error("Bridge could not start")
      }),
    ])
    const base = `http://127.0.0.1:${port}`
    assert.equal((await fetch(`${base}/models`)).status, 403)
    assert.equal(
      (await fetch(`${base}/local-status`, { headers: { Origin: "https://example.com" } })).status,
      403,
    )
    assert.equal((await fetch(`${base}/auth/callback?state=forged&code=forged`)).status, 400)
    assert.equal(
      (
        await fetch(`${base}/login`, {
          method: "POST",
          headers: { Origin: "https://evil.test", "X-ReadFrog-Local": "1" },
        })
      ).status,
      403,
    )
    const extensionStatus = await fetch(`${base}/local-status`, {
      headers: { Origin: `chrome-extension://${"a".repeat(32)}`, "X-ReadFrog-Local": "1" },
    })
    assert.equal(extensionStatus.status, 200)
    assert.equal((await extensionStatus.json()).connected, false)
    const local = await (await fetch(`${base}/local-status`)).json()
    assert.ok(local.pairing.length >= 40)
    assert.equal((await fetch(`${base}/usage`)).status, 403)
    const usage = await (
      await fetch(`${base}/usage`, { headers: { Authorization: `Bearer ${local.pairing}` } })
    ).json()
    assert.equal(usage.remaining, null)
    assert.deepEqual(usage.models, {})
    assert.equal(usage.budget.limit, 50000)
    assert.equal((await fetch(`${base}/budget`, { method: "POST", body: "{}" })).status, 403)
    const headers = { Authorization: `Bearer ${local.pairing}`, "Content-Type": "application/json" }
    const updated = await (
      await fetch(`${base}/budget`, {
        method: "POST",
        headers,
        body: JSON.stringify({ limit: 60000, add: 25000 }),
      })
    ).json()
    assert.equal(updated.budget.total, 85000)
    assert.equal(
      (
        await fetch(`${base}/budget`, {
          method: "POST",
          headers,
          body: JSON.stringify({ limit: -1 }),
        })
      ).status,
      400,
    )
    assert.equal((await stat(join(directory, "budget.json"))).mode & 0o777, 0o600)
    assert.equal((await stat(join(directory, "credentials.json"))).mode & 0o777, 0o600)
    const unauthenticated = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${local.pairing}` },
    })
    assert.equal(unauthenticated.status, 400)
    assert.match((await unauthenticated.json()).error, /登录/)
    const login = await (
      await fetch(`${base}/login`, { method: "POST", headers: { "X-ReadFrog-Local": "1" } })
    ).json()
    const url = new URL(login.url)
    assert.equal(url.origin, "https://auth.openai.com")
    assert.equal(url.searchParams.get("agent_name_hint"), "ReadFrog Word Hunter")
    assert.equal(url.searchParams.get("code_challenge_method"), "S256")
    assert.ok(url.searchParams.get("scope").includes("chatgpt.tokens.use.direct"))
    const cancellation = await fetch(
      `${base}/auth/callback?state=${url.searchParams.get("state")}&error=access_denied`,
    )
    assert.equal(cancellation.status, 400)
  } finally {
    child.kill()
    await once(child, "exit")
  }
})

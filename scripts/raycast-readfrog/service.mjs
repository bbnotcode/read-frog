import { execFileSync } from "node:child_process"
import { mkdir, access } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
const scripts = dirname(fileURLToPath(import.meta.url))
const repo = resolve(process.env.READFROG_PROJECT_DIR || resolve(scripts, "../.."))
const label = "com.readfrog.chatgpt.manual"
const agentFile = resolve(homedir(), "Library/LaunchAgents/com.readfrog.chatgpt.manual.plist")
const domain = `gui/${process.getuid()}`
let autoStart = false
try {
  await access(agentFile)
  autoStart = true
} catch {}
const base = "http://127.0.0.1:17373"
function command(file, args) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}
function listener() {
  let pid
  try {
    pid = command("/usr/sbin/lsof", ["-t", "-nP", "-iTCP:17373", "-sTCP:LISTEN"]).split("\n")[0]
  } catch {
    return null
  }
  const cmd = command("/bin/ps", ["-p", pid, "-o", "command="])
  const cwd = command("/usr/sbin/lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"])
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1)
  const expected = cmd === `node scripts/chatgpt-bridge.mjs` && cwd === repo
  const absolute =
    /^(?:\S+\/)?node /.test(cmd) && cmd.endsWith(`${repo}/scripts/chatgpt-bridge.mjs`)
  if (!expected && !absolute) throw new Error("端口被其他进程占用，未操作该进程。")
  return Number(pid)
}
async function status() {
  const s = await (
    await fetch(`${base}/local-status`, { signal: AbortSignal.timeout(2000) })
  ).json()
  console.log(`服务运行中 · ${s.connected ? "已登录 ChatGPT" : "尚未登录，请在扩展设置中登录"}`)
  if (s.pairing) {
    const u = await (
      await fetch(`${base}/usage`, {
        headers: { Authorization: `Bearer ${s.pairing}` },
        signal: AbortSignal.timeout(2000),
      })
    ).json()
    if (u.budget)
      console.log(
        `今日阅读预算剩余 ${u.budget.percent}%（${u.budget.remaining.toLocaleString()} tokens）\n北京时间 ${new Date(u.budget.resetAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 重置\n这是插件预算，不是 Plus 余额。`,
      )
  }
}
try {
  const action = process.argv[2]
  const pid = listener()
  if (action === "stop") {
    if (!pid) {
      console.log("本地服务已停止，登录仍保留。")
      process.exit(0)
    }
    try {
      command("/bin/launchctl", ["remove", label])
    } catch {
      /* Old terminal-managed service. */
    }
    if (listener() === pid) process.kill(pid, "SIGTERM")
    console.log("已停止 ReadFrog ChatGPT，登录和预算仍保留。")
  } else if (action === "start") {
    if (pid) {
      console.log("ReadFrog ChatGPT 已运行，无需重复启动。")
      process.exit(0)
    }
    await mkdir(resolve(repo, ".chatgpt-bridge"), { recursive: true, mode: 0o700 })
    try {
      command("/bin/launchctl", ["remove", label])
    } catch {}
    if (autoStart) command("/bin/launchctl", ["bootstrap", domain, agentFile])
    else
      command("/bin/launchctl", [
        "submit",
        "-l",
        label,
        "-o",
        resolve(repo, ".chatgpt-bridge/service.log"),
        "-e",
        resolve(repo, ".chatgpt-bridge/service-error.log"),
        "--",
        "/bin/bash",
        resolve(scripts, "run-service.sh"),
      ])
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if (listener()) {
        console.log("已启动 ReadFrog ChatGPT，请在扩展中刷新连接。")
        process.exit(0)
      }
    }
    throw new Error("服务未能启动，请查看 .chatgpt-bridge/service-error.log")
  } else if (action === "status") {
    console.log(
      autoStart ? "登录 macOS 后自动启动已启用；手动停止只影响当前会话。" : "自动启动未启用。",
    )
    if (!pid) console.log("服务未运行，请执行“启动 ReadFrog ChatGPT”。")
    else await status()
  } else throw new Error("未知命令")
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}

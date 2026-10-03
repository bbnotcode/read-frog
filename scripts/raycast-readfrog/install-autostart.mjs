import { mkdir, writeFile, access, constants } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
const scripts = dirname(fileURLToPath(import.meta.url))
const repo = resolve(process.env.READFROG_PROJECT_DIR || resolve(scripts, "../.."))
const runtime = process.env.READFROG_NODE || process.execPath
await access(runtime, constants.X_OK)
await access(resolve(repo, "scripts/chatgpt-bridge.mjs"))
const agents = resolve(homedir(), "Library/LaunchAgents")
await mkdir(agents, { recursive: true })
await mkdir(resolve(repo, ".chatgpt-bridge"), { recursive: true, mode: 0o700 })
const xml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.readfrog.chatgpt.manual</string>
<key>ProgramArguments</key><array><string>${xml(runtime)}</string><string>${xml(resolve(repo, "scripts/chatgpt-bridge.mjs"))}</string></array>
<key>WorkingDirectory</key><string>${xml(repo)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>StandardOutPath</key><string>${xml(resolve(repo, ".chatgpt-bridge/service.log"))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(repo, ".chatgpt-bridge/service-error.log"))}</string>
</dict></plist>`
await writeFile(resolve(agents, "com.readfrog.chatgpt.manual.plist"), plist, { mode: 0o644 })
console.log("已更新 ReadFrog 登录自启路径；使用 Raycast 停止后启动即可应用。")

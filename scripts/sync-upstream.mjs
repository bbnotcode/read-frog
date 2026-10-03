import { mkdtemp, rm } from "node:fs/promises"
import { dirname, join, resolve, relative, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  command,
  copySource,
  fetchOfficial,
  git,
  installExtension,
  mergePreservingChanges,
  recoverInstallation,
  takeLock,
  validateExtension,
} from "./sync-support.mjs"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const help = `ReadFrog 官方安全同步（保留本地功能）
用法：./同步ReadFrog.command [--check] [--full] [--no-install] [--clean-deps]
  --check       只检查环境和本地状态，不改源码或安装包
  --full        额外运行完整测试（跳过在线免费翻译服务用例）
  --no-install  完成合并、验证和构建，不替换现有安装包
  --clean-deps  成功后清理源码目录的可再生成依赖和构建缓存
  --keep-deps   保留源码目录依赖（默认）
环境变量：READFROG_EXTENSION_DIR 可指定已有安装目录。
未提交改动会建立快照并保持原处；冲突会停止，不强行覆盖。
本脚本不会自动提交或推送 GitHub，也不会修改浏览器词库、登录或预算。`

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(help)
    return
  }
  const allowed = new Set(["--check", "--full", "--no-install", "--clean-deps", "--keep-deps"])
  if (args.some((arg) => !allowed.has(arg))) throw new Error(`未知选项。\n${help}`)
  if (Number(process.versions.node.split(".")[0]) < 26)
    throw new Error("需要 Node.js 26 或更新版本，请先更新 Node.js。")
  const actualRepository = (await git(repository, ["rev-parse", "--show-toplevel"])).trim()
  if (resolve(actualRepository) !== repository)
    throw new Error("Git 指向了其他仓库，请检查环境配置；未开始同步。")
  const branch = (await git(repository, ["branch", "--show-current"])).trim()
  if (branch !== "codex/vocabulary-hunter")
    throw new Error("请在 codex/vocabulary-hunter 定制分支同步，未改动其他分支。")
  const conflicts = await git(repository, ["ls-files", "--unmerged"])
  if (conflicts.trim()) throw new Error("仓库仍有未解决冲突，请先交给 Codex 处理。")
  const remote = (await git(repository, ["remote", "get-url", "origin"])).trim()
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:)mengxi-ream\/read-frog(?:\.git)?$/.test(remote)
  )
    throw new Error("origin 不是已确认的 ReadFrog 官方仓库，未开始同步。")
  const target = resolve(
    process.env.READFROG_EXTENSION_DIR || join(repository, "..", "ReadFrog-WordHunter-Chrome-v2"),
  )
  const distance = relative(repository, target)
  if (!distance.startsWith(`..${sep}`)) throw new Error("安装目录必须在源码仓库外，未执行替换。")
  if (args.includes("--check") && !args.includes("--no-install")) await validateExtension(target)
  const registry = new URL(process.env.PNPM_REGISTRY || "https://registry.npmjs.org/")
  if (registry.protocol !== "https:" || registry.username || registry.password)
    throw new Error("依赖源必须是无内嵌凭据的 HTTPS 地址。")
  const pnpm = process.env.READFROG_PNPM || "pnpm"
  await command(pnpm, ["--version"], { cwd: repository, capture: true, timeout: 15000 })
  const dirty = await git(repository, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).agents/skills",
  ])
  console.log(
    `Node ${process.versions.node} · 分支 ${branch} · ${dirty.trim() ? "有本地改动，将自动安全备份" : "源码无未提交改动"}`,
  )
  if (args.includes("--check")) {
    console.log("检查通过。同步时仍可能遇到官方代码冲突，脚本会保留备份并停止。")
    return
  }
  const lockPath = resolve(
    repository,
    (await git(repository, ["rev-parse", "--git-path", "readfrog-sync.lock"])).trim(),
  )
  const unlock = await takeLock(lockPath)
  const controller = new AbortController()
  const stop = () => controller.abort(new Error("用户已中断同步"))
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  let temporary
  let step = "获取官方更新"
  let backup
  const env = {
    ...process.env,
    CI: "true",
    SKIP_FREE_API: "true",
    npm_config_registry: registry.href,
  }
  const run = async (label, file, argv, timeout = 300000, extraEnv = {}) => {
    step = label
    console.log(`\n${label}…`)
    await command(file, argv, {
      cwd: temporary || repository,
      env: { ...env, ...extraEnv },
      signal: controller.signal,
      timeout,
    })
  }
  try {
    if (!args.includes("--no-install")) {
      if (await recoverInstallation(target)) console.log("已恢复上次中断的安装包。")
      await validateExtension(target)
    }
    console.log("获取官方最新 main…")
    await fetchOfficial(repository, { signal: controller.signal })
    step = "备份并合并官方代码"
    backup = await mergePreservingChanges(repository, "origin/main", { signal: controller.signal })
    console.log(`源码恢复点：${backup.ref}`)
    temporary = await mkdtemp("/private/tmp/readfrog-sync-")
    step = "复制当前源码（包含保留的本地改动）"
    await copySource(repository, temporary)
    const store = (
      await command(pnpm, ["store", "path"], { cwd: repository, capture: true, timeout: 15000 })
    ).trim()
    const installArgs = [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      `--store-dir=${store}`,
      "--reporter=append-only",
    ]
    try {
      await run("复用依赖缓存", pnpm, [...installArgs, "--offline"])
    } catch {
      controller.signal.throwIfAborted()
      console.log("缓存未满足完整校验，改用官方依赖源；不关闭供应链检查。")
      let failure
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await run(
            `恢复依赖 ${attempt}/3`,
            pnpm,
            [...installArgs, `--registry=${registry.href}`, "--network-concurrency=4"],
            600000,
          )
          failure = null
          break
        } catch (error) {
          failure = error
          controller.signal.throwIfAborted()
        }
      }
      if (failure) throw failure
    }
    const bin = (file) => join(temporary, "node_modules", ".bin", file)
    env.PATH = `${join(temporary, "node_modules", ".bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`
    await run("生成扩展类型配置", bin("wxt"), ["prepare"], 120000, {
      WXT_SKIP_ENV_VALIDATION: "true",
    })
    await run(
      "检查生词猎手格式",
      bin("oxfmt"),
      [
        "--check",
        "src/utils/vocabulary-hunter",
        "src/entrypoints/vocabulary-hunter.content",
        "src/entrypoints/options/pages/vocabulary-hunter",
      ],
      120000,
    )
    await run(
      "检查全项目类型和代码规则",
      bin("oxlint"),
      ["--type-aware", "--type-check", "--threads=1"],
      120000,
    )
    await run("生词猎手与本地订阅回归", bin("vitest"), [
      "run",
      "src/utils/vocabulary-hunter/__tests__",
      "src/utils/providers/__tests__/chatgpt-local.test.ts",
      "src/components/custom-action/__tests__",
      "src/utils/config/__tests__/migration-scripts",
      "--maxWorkers=1",
      "--no-file-parallelism",
    ])
    await run("本地服务模拟回归（不打断正在运行的服务）", process.execPath, [
      "--test",
      "--test-concurrency=1",
      "scripts/chatgpt-bridge.node-test.mjs",
      "scripts/chatgpt-budget.node-test.mjs",
      "scripts/chatgpt-request-gate.node-test.mjs",
      "scripts/chatgpt-explanation-pool.node-test.mjs",
      "scripts/chatgpt-bridge.integration.node-test.mjs",
      "scripts/sync-support.node-test.mjs",
    ])
    if (args.includes("--full"))
      await run(
        "完整项目回归",
        bin("vitest"),
        [
          "run",
          "--exclude",
          "src/utils/host/translate/api/__tests__/free-api.test.ts",
          "--maxWorkers=1",
          "--no-file-parallelism",
        ],
        900000,
      )
    await run("构建 Chrome MV3", bin("wxt"), ["build"], 300000, {
      WXT_GOOGLE_CLIENT_ID: "test-client-id",
      WXT_POSTHOG_HOST: "https://example.invalid",
      WXT_POSTHOG_API_KEY: "test-key",
    })
    controller.signal.throwIfAborted()
    const output = join(temporary, ".output", "chrome-mv3")
    const manifest = await validateExtension(output)
    if (!args.includes("--no-install")) {
      step = "原子更新安装包"
      await installExtension(output, target, { signal: controller.signal })
    }
    if (args.includes("--clean-deps")) {
      for (const folder of ["node_modules", ".output", ".wxt", ".nx"])
        await rm(join(repository, folder), { recursive: true, force: true })
      console.log("已清理可再生成的开发依赖和缓存；源码、登录、预算和浏览器词库未清理。")
    }
    console.log(
      `\n同步完成：ReadFrog ${manifest.version}，本地功能保留。${args.includes("--no-install") ? "未替换现有安装包。" : "请在扩展管理页重新加载 ReadFrog，再刷新已打开的网页。"}`,
    )
    if (backup.snapshot)
      console.log("未提交改动保持原处且快照保留；没有自动提交到定制分支或推送 GitHub。")
  } catch (error) {
    const detail = (error.stderr || error.cause?.stderr || "").trim()
    console.error(
      `\n“${step}”未完成：${error.message}${detail ? `\n${detail}` : ""}\n现有安装包在验证成功前不会被替换；请把错误交给 Codex。`,
    )
    if (backup) console.error(`源码恢复点：${backup.ref}`)
    throw error
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true })
    } finally {
      await unlock()
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

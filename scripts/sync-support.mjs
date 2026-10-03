import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
  lstat,
} from "node:fs/promises"
import { dirname, basename, join, resolve, relative, sep } from "node:path"

export async function command(
  file,
  args,
  { cwd, env = process.env, capture = false, timeout = 180000, signal } = {},
) {
  signal?.throwIfAborted()
  return await new Promise((done, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    })
    let stdout = ""
    let stderr = ""
    let stopping = false
    let forceTimer
    const stop = () => {
      if (stopping) return
      stopping = true
      const kill = (type) => {
        try {
          if (process.platform === "win32") child.kill(type)
          else process.kill(-child.pid, type)
        } catch {}
      }
      kill("SIGTERM")
      forceTimer = setTimeout(() => kill("SIGKILL"), 1500)
    }
    child.stdout?.on("data", (data) => {
      stdout += data
    })
    child.stderr?.on("data", (data) => {
      stderr += data
    })
    const timer = setTimeout(stop, timeout)
    signal?.addEventListener("abort", stop, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      if (!stopping) clearTimeout(forceTimer)
      signal?.removeEventListener("abort", stop)
    }
    child.on("error", (error) => {
      cleanup()
      reject(error)
    })
    child.on("close", (code, terminated) => {
      cleanup()
      if (code === 0 && !stopping) done(stdout)
      else {
        const error = new Error(
          stopping
            ? `${basename(file)} 超时或已中断`
            : `${basename(file)} 执行失败（${code ?? terminated}）`,
        )
        Object.assign(error, { code, stdout, stderr })
        reject(error)
      }
    })
  })
}

export function git(repo, args, options = {}) {
  return command("git", args, { cwd: repo, capture: true, ...options })
}

export async function fetchOfficial(repo, { log = console.log, signal, run = git } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted()
    try {
      await run(repo, ["fetch", "origin", "main"], { signal })
      return
    } catch (error) {
      signal?.throwIfAborted()
      const detail = `${error.message}\n${error.stderr || ""}`
      const transient =
        /超时|Could not resolve|Failed to connect|Connection.*(?:reset|timed out)|SSL_ERROR_SYSCALL|HTTP.*(?:502|503|504)|RPC failed|early EOF|remote end hung up|Operation timed out|Empty reply from server/i.test(
          detail,
        )
      if (!transient || attempt === 3) throw error
      log(`官方代码拉取遇到临时网络故障，准备重试 ${attempt + 1}/3。`)
      await new Promise((done) => setTimeout(done, 1000))
    }
  }
}

export async function takeLock(path) {
  try {
    await mkdir(path)
  } catch (lockError) {
    if (lockError.code !== "EEXIST") throw lockError
    const files = await readdir(path)
    if (files.some((file) => !["owner.json", "pid"].includes(file)))
      throw new Error("同步锁包含未知文件，请交给 Codex 检查", { cause: lockError })
    let pid
    try {
      pid = JSON.parse(await readFile(join(path, "owner.json"), "utf8")).pid
    } catch {
      try {
        pid = Number(await readFile(join(path, "pid"), "utf8"))
      } catch {}
    }
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
        throw new Error("另一个同步任务正在运行，请勿重复启动", { cause: lockError })
      } catch (error) {
        if (error.code !== "ESRCH") throw error
      }
    } else throw new Error("无法确认旧同步锁的状态，请交给 Codex 检查", { cause: lockError })
    for (const file of files) await rm(join(path, file))
    await rmdir(path)
    await mkdir(path)
  }
  await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid }), { flag: "wx" })
  return async () => {
    const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"))
    if (owner.pid !== process.pid) throw new Error("同步锁已更换，未清理其他任务的锁")
    await rm(join(path, "owner.json"))
    await rmdir(path)
  }
}

export async function mergePreservingChanges(repo, upstream, { log = console.log, signal } = {}) {
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim()
  const id = `${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomUUID().slice(0, 8)}`
  const ref = `refs/readfrog-sync/backups/${id}`
  await git(repo, ["update-ref", `${ref}/base`, base])
  const paths = [".", ":(exclude).agents/skills"]
  const dirty = (
    await git(repo, ["status", "--porcelain", "--untracked-files=all", "--", ...paths])
  ).trim()
  let snapshot
  if (dirty) {
    const directory = await mkdtemp("/private/tmp/readfrog-sync-index-")
    const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index") }
    try {
      // A private index records current files without removing/recreating source.
      // This avoids File Provider/iCloud conflict copies produced by stash push.
      await git(repo, ["read-tree", "HEAD"], { env })
      await git(repo, ["add", "-A", "--", ...paths], { env })
      const tree = (await git(repo, ["write-tree"], { env })).trim()
      snapshot = (
        await git(repo, ["commit-tree", tree, "-p", base, "-m", `ReadFrog local snapshot ${id}`])
      ).trim()
      await git(repo, ["update-ref", `${ref}/worktree`, snapshot])
      const stagedTree = (await git(repo, ["write-tree"])).trim()
      const staged = (
        await git(repo, [
          "commit-tree",
          stagedTree,
          "-p",
          base,
          "-m",
          `ReadFrog staged snapshot ${id}`,
        ])
      ).trim()
      await git(repo, ["update-ref", `${ref}/index`, staged])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    log("已建立本地改动快照；源码保持原处，备份不自动删除。")
  }
  signal?.throwIfAborted()
  let upToDate = false
  try {
    await git(repo, ["merge-base", "--is-ancestor", upstream, "HEAD"])
    upToDate = true
  } catch {}
  if (upToDate) log("本地已包含官方最新版本。")
  else {
    if (snapshot) {
      const common = (await git(repo, ["merge-base", base, upstream])).trim()
      const changed = new Set(
        (await git(repo, ["diff", "--name-only", "-z", common, upstream]))
          .split("\0")
          .filter(Boolean),
      )
      const local = (await git(repo, ["diff", "--name-only", "-z", base, snapshot]))
        .split("\0")
        .filter(Boolean)
      const overlap = local.filter((file) => changed.has(file))
      if (overlap.length)
        throw new Error(
          `本地未提交改动与官方变更重叠，已保留原样和备份，未安装新版。请先提交或交给 Codex 处理：${ref}/worktree`,
        )
    }
    try {
      await git(repo, ["merge", "--no-edit", upstream], {
        env: { ...process.env, HUSKY: "0" },
        signal,
      })
    } catch (error) {
      let merging = false
      try {
        await git(repo, ["rev-parse", "--verify", "MERGE_HEAD"])
        merging = true
      } catch {}
      if (merging) await git(repo, ["merge", "--abort"])
      throw new Error(`官方合并未完成，已停止；当前安装包未改动。本地源码恢复点：${ref}`, {
        cause: error,
      })
    }
  }
  return { ref, base, snapshot, preserved: true }
}

export async function copySource(repo, target) {
  const files = (await git(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
  if (
    files.some(
      (file) =>
        file.startsWith(".chatgpt-bridge/") ||
        (/(^|\/)\.env(?:$|\.)/.test(file) && !/\.example$/.test(file)),
    )
  )
    throw new Error("源码包含私人运行数据，已停止构建")
  for (const file of new Set(files)) {
    if ([".agents/", ".claude/", ".codex/"].some((prefix) => file.startsWith(prefix))) continue
    if (
      file.startsWith(".chatgpt-bridge/") ||
      (/(^|\/)\.env(?:$|\.)/.test(file) && !/\.example$/.test(file))
    )
      throw new Error("源码包含私人运行数据，已停止构建")
    const source = resolve(repo, file)
    const rel = relative(repo, source)
    if (
      !rel ||
      rel.startsWith(`..${sep}`) ||
      rel === ".." ||
      resolve(target, rel) === resolve(target)
    )
      throw new Error("源码路径校验失败")
    let info
    try {
      info = await lstat(source)
    } catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
    if (!info.isFile()) throw new Error(`源码包含非普通文件，未复制：${file}`)
    const destination = join(target, rel)
    await mkdir(dirname(destination), { recursive: true })
    try {
      await cp(source, destination, { force: false, errorOnExist: true })
    } catch (error) {
      if (
        process.platform !== "darwin" ||
        !["ECANCELED", "EAGAIN", "EBUSY", "EIO"].includes(error.code)
      )
        throw error
      await command("brctl", ["download", source], { capture: true, timeout: 60000 })
      await cp(source, destination)
    }
  }
}

export async function validateExtension(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))
  if (
    manifest.manifest_version !== 3 ||
    !manifest.content_scripts?.some((item) =>
      item.js?.includes("content-scripts/vocabulary-hunter.js"),
    )
  )
    throw new Error("这不是完整的 ReadFrog Word Hunter MV3 安装包")
  for (const file of [
    "content-scripts/vocabulary-hunter.js",
    "background.js",
    "options.html",
    "chatgpt-bridge.html",
    "vocabulary/eng-dict.txt",
  ]) {
    if (!(await lstat(join(directory, file))).isFile()) throw new Error(`安装包缺少文件：${file}`)
  }
  if ((await readdir(directory)).some((file) => file.startsWith("_") && file !== "_locales"))
    throw new Error("安装包包含不允许的下划线目录")
  return manifest
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

export async function recoverInstallation(target) {
  const journal = `${target}.readfrog-sync.json`
  if (!(await exists(journal))) return false
  if ((await lstat(journal)).isSymbolicLink()) throw new Error("安装恢复记录是符号链接，未操作")
  const state = JSON.parse(await readFile(journal, "utf8"))
  if (
    state.target !== target ||
    dirname(state.stage || "") !== dirname(target) ||
    !basename(state.stage || "").startsWith(".readfrog-stage-") ||
    !new RegExp(`^[0-9a-f-]{36}$`).test((state.backup || "").slice(`${target}.backup-`.length)) ||
    !state.backup?.startsWith(`${target}.backup-`)
  )
    throw new Error("安装恢复记录路径无效，未操作")
  if (Number.isInteger(state.pid) && state.pid > 0) {
    try {
      process.kill(state.pid, 0)
      throw new Error("另一个安装任务仍在运行")
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
  } else throw new Error("安装恢复记录缺少有效进程标识")
  const oldExists = await exists(state.backup)
  const currentExists = await exists(target)
  const stageExists = await exists(state.stage)
  for (const path of [target, state.backup, state.stage]) {
    if ((await exists(path)) && (await lstat(path)).isSymbolicLink())
      throw new Error("安装恢复目录是符号链接，未操作")
  }
  if (oldExists) {
    await validateExtension(state.backup)
    if (currentExists) {
      if (stageExists) throw new Error("安装恢复现场有额外目录，请交给 Codex 检查")
      await rename(target, state.stage)
    }
    await rename(state.backup, target)
  } else if (!currentExists) throw new Error("找不到可恢复的安装包，请交给 Codex 检查")
  await validateExtension(target)
  await rm(state.stage, { recursive: true, force: true })
  await rm(journal)
  return true
}

export async function installExtension(
  source,
  target,
  { copy = cp, validate = validateExtension, signal } = {},
) {
  await recoverInstallation(target)
  const next = await validate(source)
  await validate(target)
  if ((await lstat(target)).isSymbolicLink()) throw new Error("安装目录是符号链接，未替换")
  const stage = await mkdtemp(join(dirname(target), ".readfrog-stage-"))
  const backup = `${target}.backup-${randomUUID()}`
  const journal = `${target}.readfrog-sync.json`
  let oldMoved = false
  let newMoved = false
  let journalWritten = false
  try {
    signal?.throwIfAborted()
    await copy(source, stage, { recursive: true })
    await validate(stage)
    signal?.throwIfAborted()
    await writeFile(journal, JSON.stringify({ target, stage, backup, pid: process.pid }), {
      flag: "wx",
      mode: 0o600,
    })
    journalWritten = true
    await rename(target, backup)
    oldMoved = true
    await rename(stage, target)
    newMoved = true
    await validate(target)
    signal?.throwIfAborted()
  } catch (error) {
    if (newMoved) await rename(target, stage)
    if (oldMoved) await rename(backup, target)
    if (journalWritten) await rm(journal)
    throw error
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  // Only the exact, just-created backup of generated extension files is removed.
  await rm(backup, { recursive: true })
  await rm(journal)
  return next.version
}

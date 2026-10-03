import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, cp, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  command,
  copySource,
  fetchOfficial,
  git,
  installExtension,
  mergePreservingChanges,
  takeLock,
  recoverInstallation,
  validateExtension,
} from "./sync-support.mjs"

test("official fetch retries transient failures and retains the actual failure details", async () => {
  let attempts = 0
  await fetchOfficial("unused", {
    log: () => {},
    run: async (repo, args) => {
      assert.deepEqual(args, ["fetch", "origin", "main"])
      if (++attempts < 3)
        throw Object.assign(new Error("git 执行失败（128）"), {
          stderr: "fatal: unable to access official remote: SSL_ERROR_SYSCALL",
        })
    },
  })
  assert.equal(attempts, 3)
  attempts = 0
  await assert.rejects(
    fetchOfficial("unused", {
      log: () => {},
      run: async () => {
        attempts++
        throw Object.assign(new Error("git 执行失败（128）"), {
          stderr: "fatal: Authentication failed",
        })
      },
    }),
    (error) => error.stderr === "fatal: Authentication failed",
  )
  assert.equal(attempts, 1)
})

test("cancelled official fetch never starts a new attempt", async () => {
  const controller = new AbortController()
  controller.abort(new Error("test cancellation"))
  await assert.rejects(
    fetchOfficial("unused", {
      signal: controller.signal,
      run: async () => assert.fail("cancelled fetch must not run"),
    }),
    /test cancellation/,
  )
})

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), "readfrog-sync-test-"))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await git(repo, ["init", "--initial-branch=local"])
  await git(repo, ["config", "user.name", "ReadFrog Test"])
  await git(repo, ["config", "user.email", "readfrog-test@example.invalid"])
  await writeFile(join(repo, ".gitignore"), ".chatgpt-bridge/\nnode_modules/\n")
  await writeFile(join(repo, "feature.txt"), "original\n")
  await git(repo, ["add", "."])
  await git(repo, ["commit", "-m", "test baseline"])
  return repo
}

test("merge preserves tracked, staged and untracked local features with permanent recovery refs", async (t) => {
  const repo = await fixture(t)
  await git(repo, ["checkout", "-b", "official"])
  await writeFile(join(repo, "upstream.txt"), "new official feature\n")
  await git(repo, ["add", "."])
  await git(repo, ["commit", "-m", "test official update"])
  await git(repo, ["checkout", "local"])
  await writeFile(join(repo, "feature.txt"), "local customization\n")
  await git(repo, ["add", "feature.txt"])
  await writeFile(join(repo, "local feature.mjs"), "export const value = 1\n")
  await mkdir(join(repo, ".chatgpt-bridge"))
  await writeFile(join(repo, ".chatgpt-bridge", "credentials.json"), "PRIVATE_TEST_DATA")
  const result = await mergePreservingChanges(repo, "official", { log: () => {} })
  assert.equal(result.preserved, true)
  assert.equal(await readFile(join(repo, "feature.txt"), "utf8"), "local customization\n")
  assert.equal(await readFile(join(repo, "local feature.mjs"), "utf8"), "export const value = 1\n")
  assert.equal(await readFile(join(repo, "upstream.txt"), "utf8"), "new official feature\n")
  assert.match(await git(repo, ["diff", "--cached", "--name-only"]), /feature.txt/)
  assert.equal((await git(repo, ["rev-parse", `${result.ref}/worktree`])).trim(), result.snapshot)
  assert.equal(
    await readFile(join(repo, ".chatgpt-bridge", "credentials.json"), "utf8"),
    "PRIVATE_TEST_DATA",
  )
  const build = join(repo, "build")
  await mkdir(build)
  await copySource(repo, build)
  assert.equal(await readFile(join(build, "local feature.mjs"), "utf8"), "export const value = 1\n")
  assert.equal((await readdir(build)).includes(".chatgpt-bridge"), false)
})

test("official conflict aborts the merge and restores dirty changes without resetting history", async (t) => {
  const repo = await fixture(t)
  await git(repo, ["checkout", "-b", "official"])
  await writeFile(join(repo, "feature.txt"), "official replacement\n")
  await git(repo, ["add", "."])
  await git(repo, ["commit", "-m", "test official change"])
  await git(repo, ["checkout", "local"])
  await writeFile(join(repo, "feature.txt"), "committed local feature\n")
  await git(repo, ["add", "."])
  await git(repo, ["commit", "-m", "test local change"])
  const before = (await git(repo, ["rev-parse", "HEAD"])).trim()
  await writeFile(join(repo, "draft.txt"), "unsaved local feature\n")
  await assert.rejects(
    mergePreservingChanges(repo, "official", { log: () => {} }),
    /官方合并未完成/,
  )
  assert.equal((await git(repo, ["rev-parse", "HEAD"])).trim(), before)
  assert.equal(await readFile(join(repo, "draft.txt"), "utf8"), "unsaved local feature\n")
  assert.equal((await git(repo, ["ls-files", "--unmerged"])).trim(), "")
  assert.match(
    await git(repo, ["for-each-ref", "--format=%(refname)", "refs/readfrog-sync/backups"]),
    /\/worktree/,
  )
})

test("overlapping dirty changes stop before merging and retain the exact patch in a recovery ref", async (t) => {
  const repo = await fixture(t)
  await git(repo, ["checkout", "-b", "official"])
  await writeFile(join(repo, "feature.txt"), "official replacement\n")
  await writeFile(join(repo, "another official.txt"), "second official change\n")
  await git(repo, ["add", "."])
  await git(repo, ["commit", "-m", "test official change"])
  await git(repo, ["checkout", "local"])
  await writeFile(join(repo, "feature.txt"), "uncommitted local replacement\n")
  await writeFile(join(repo, "another local.txt"), "second local change\n")
  await assert.rejects(
    mergePreservingChanges(repo, "official", { log: () => {} }),
    /本地未提交改动与官方变更重叠/,
  )
  const refs = (
    await git(repo, ["for-each-ref", "--format=%(refname)", "refs/readfrog-sync/backups"])
  )
    .trim()
    .split("\n")
  const patch = refs.find((ref) => ref.endsWith("/worktree"))
  assert.equal(await git(repo, ["show", `${patch}:feature.txt`]), "uncommitted local replacement\n")
  assert.match(
    await readFile(join(repo, "feature.txt"), "utf8"),
    /<<<<<<<|uncommitted local replacement/,
  )
})

test("copy includes dirty files and deletions, excludes secrets, and refuses tracked credentials", async (t) => {
  const repo = await fixture(t)
  await mkdir(join(repo, ".chatgpt-bridge"))
  await writeFile(join(repo, ".chatgpt-bridge", "credentials.json"), "PRIVATE_TEST_DATA")
  await writeFile(join(repo, "new.txt"), "new local feature\n")
  await rm(join(repo, "feature.txt"))
  const build = await mkdtemp(join(tmpdir(), "readfrog-sync-build-test-"))
  t.after(() => rm(build, { recursive: true, force: true }))
  await copySource(repo, build)
  assert.equal(await readFile(join(build, "new.txt"), "utf8"), "new local feature\n")
  assert.deepEqual((await readdir(build)).sort(), [".gitignore", "new.txt"])
  await git(repo, ["add", "-f", ".chatgpt-bridge/credentials.json"])
  await assert.rejects(copySource(repo, build), /私人运行数据/)
})

test("lock refuses concurrent runs and recovers only a known stale lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "readfrog-sync-lock-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lock = join(root, "lock")
  const release = await takeLock(lock)
  await assert.rejects(takeLock(lock), /另一个同步任务/)
  await release()
  await mkdir(lock)
  await writeFile(join(lock, "pid"), "2147483647")
  await (
    await takeLock(lock)
  )()
  await mkdir(lock)
  await writeFile(join(lock, "important.txt"), "do not remove")
  await assert.rejects(takeLock(lock), /未知文件/)
  assert.equal(await readFile(join(lock, "important.txt"), "utf8"), "do not remove")
})

async function extension(directory, version) {
  await mkdir(join(directory, "content-scripts"), { recursive: true })
  await mkdir(join(directory, "vocabulary"), { recursive: true })
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      version,
      content_scripts: [{ js: ["content-scripts/vocabulary-hunter.js"] }],
    }),
  )
  for (const file of [
    "content-scripts/vocabulary-hunter.js",
    "background.js",
    "options.html",
    "chatgpt-bridge.html",
    "vocabulary/eng-dict.txt",
  ])
    await writeFile(join(directory, file), version)
}

test("incomplete staging never replaces an installed extension; valid update leaves no stale bundle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "readfrog-sync-install-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const old = join(root, "installed")
  const next = join(root, "next")
  await extension(old, "1.0.0")
  await extension(next, "2.0.0")
  await writeFile(join(old, "old-hash.js"), "old generated bundle")
  await assert.rejects(
    installExtension(next, old, {
      copy: async (source, stage) => {
        await cp(source, stage, { recursive: true })
        await rm(join(stage, "background.js"))
      },
    }),
    /ENOENT/,
  )
  assert.equal(JSON.parse(await readFile(join(old, "manifest.json"), "utf8")).version, "1.0.0")
  assert.equal(await installExtension(next, old), "2.0.0")
  assert.equal((await readdir(old)).includes("old-hash.js"), false)
  assert.equal(
    (await readdir(root)).some(
      (file) => file.includes("backup-") || file.startsWith(".readfrog-stage-"),
    ),
    false,
  )
})

test("command timeout terminates its own child and returns a clear error", async () => {
  await assert.rejects(
    command(process.execPath, ["-e", "setInterval(()=>{},1000)"], { capture: true, timeout: 150 }),
    /超时或已中断/,
  )
})

test("post-replacement validation failure rolls back the previous installed version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "readfrog-sync-rollback-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const old = join(root, "installed")
  const next = join(root, "next")
  await extension(old, "1.0.0")
  await extension(next, "2.0.0")
  let checked = 0
  await assert.rejects(
    installExtension(next, old, {
      validate: async (directory) => {
        checked++
        if (checked === 4) throw new Error("simulate failed final validation")
        return await validateExtension(directory)
      },
    }),
    /failed final validation/,
  )
  assert.equal((await validateExtension(old)).version, "1.0.0")
  assert.equal(
    (await readdir(root)).some(
      (file) => file.includes("backup-") || file.endsWith("readfrog-sync.json"),
    ),
    false,
  )
})

test("interrupted installation recovers the prior package both before and after the new move", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "readfrog-sync-recovery-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const newMoved of [false, true]) {
    const target = join(root, newMoved ? "after" : "before")
    const backup = `${target}.backup-${randomUUID()}`
    const stage = await mkdtemp(join(root, ".readfrog-stage-"))
    await extension(target, "1.0.0")
    await extension(stage, "2.0.0")
    await rename(target, backup)
    if (newMoved) await rename(stage, target)
    await writeFile(
      `${target}.readfrog-sync.json`,
      JSON.stringify({ target, backup, stage, pid: 2147483647 }),
    )
    assert.equal(await recoverInstallation(target), true)
    assert.equal((await validateExtension(target)).version, "1.0.0")
    assert.equal(await recoverInstallation(target), false)
  }
})

test("invalid recovery paths cannot delete unrelated directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "readfrog-sync-recovery-safety-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, "installed")
  const privateData = join(root, "private-data")
  await extension(target, "1.0.0")
  await mkdir(privateData)
  await writeFile(join(privateData, "important.txt"), "keep")
  await writeFile(
    `${target}.readfrog-sync.json`,
    JSON.stringify({ target, backup: privateData, stage: privateData, pid: 2147483647 }),
  )
  await assert.rejects(recoverInstallation(target), /路径无效/)
  assert.equal(await readFile(join(privateData, "important.txt"), "utf8"), "keep")
})

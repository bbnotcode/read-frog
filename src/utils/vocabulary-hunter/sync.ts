import type { VocabularyStatus, VocabularyWordInfo } from "./candidates"
import type { VocabularyHunterState } from "./storage"
import { browser } from "#imports"

const BUCKET_SIZE = 400
const BUCKET_PREFIX = "rf_vocabulary_known_"
const MAX_GIST_BYTES = 4 * 1024 * 1024
const MAX_GIST_WORDS = 100_000
const MAX_WORD_LENGTH = 64
const WORD_PATTERN = /^[a-z]+(?:'[a-z]+)?$/

function normalizeSyncWord(value: string) {
  const word = value.trim().toLocaleLowerCase()
  return word.length <= MAX_WORD_LENGTH && WORD_PATTERN.test(word) ? word : undefined
}

function assertSafeResponseSize(response: Response) {
  const length = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(length) && length > MAX_GIST_BYTES) {
    throw new Error("Gist 备份文件过大")
  }
}

async function readLimitedText(response: Response) {
  assertSafeResponseSize(response)
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_GIST_BYTES) {
    throw new Error("Gist 备份文件过大")
  }
  return text
}

export function mergeVocabularyStatusesByUpdatedAt(
  localStatuses: Record<string, VocabularyStatus>,
  localUpdatedAt: Record<string, number>,
  syncedStatuses: Record<string, VocabularyStatus>,
  syncedUpdatedAt: Record<string, number>,
) {
  const statuses = { ...localStatuses }
  const updatedAt = { ...localUpdatedAt }

  Object.entries(syncedStatuses).forEach(([word, status]) => {
    const incomingUpdatedAt = syncedUpdatedAt[word] ?? 0
    const localWordUpdatedAt = updatedAt[word] ?? 0
    if (!(word in statuses) || incomingUpdatedAt >= localWordUpdatedAt) {
      statuses[word] = status
      updatedAt[word] = incomingUpdatedAt
    }
  })

  return { statuses, updatedAt }
}

function bucketKey(index: number) {
  return `${BUCKET_PREFIX}${Math.floor(index / BUCKET_SIZE)}`
}

function setBitmapValue(bitmap: string | undefined, index: number, known: boolean) {
  const normalized = (bitmap ?? "").padEnd(BUCKET_SIZE, "0").slice(0, BUCKET_SIZE)
  const offset = index % BUCKET_SIZE
  return `${normalized.slice(0, offset)}${known ? "1" : "0"}${normalized.slice(offset + 1)}`
}

export async function syncKnownWord(
  word: string,
  known: boolean,
  dictionary: Map<string, VocabularyWordInfo>,
) {
  const wordInfo = dictionary.get(word)
  if (!wordInfo) return
  const key = bucketKey(wordInfo.index)
  const current = await browser.storage.sync.get(key)
  await browser.storage.sync.set({
    [key]: setBitmapValue(current[key] as string | undefined, wordInfo.index, known),
  })
}

export async function syncKnownWords(
  words: Iterable<string>,
  dictionary: Map<string, VocabularyWordInfo>,
) {
  const indices = [...words].flatMap((word) => {
    const wordInfo = dictionary.get(word.toLocaleLowerCase())
    return wordInfo ? [wordInfo.index] : []
  })
  const keys = [...new Set(indices.map(bucketKey))]
  const current = await browser.storage.sync.get(keys)
  const updates: Record<string, string> = {}
  indices.forEach((index) => {
    const key = bucketKey(index)
    updates[key] = setBitmapValue(updates[key] ?? (current[key] as string | undefined), index, true)
  })
  if (Object.keys(updates).length) await browser.storage.sync.set(updates)
}

export async function mergeKnownWordsFromSync(
  state: VocabularyHunterState,
  dictionary: Map<string, VocabularyWordInfo>,
) {
  const indexedWords: Array<string | undefined> = []
  dictionary.forEach((info) => {
    indexedWords[info.index] ??= info.lemma
  })
  const keys = Array.from(
    { length: Math.ceil(indexedWords.length / BUCKET_SIZE) },
    (_, index) => `${BUCKET_PREFIX}${index}`,
  )
  const stored = await browser.storage.sync.get(keys)
  const statuses = { ...state.statuses }
  let changed = false
  keys.forEach((key, bucketIndex) => {
    const bitmap = stored[key]
    if (typeof bitmap !== "string") return
    for (let offset = 0; offset < bitmap.length; offset += 1) {
      if (bitmap[offset] !== "1") continue
      const word = indexedWords[bucketIndex * BUCKET_SIZE + offset]
      if (word && statuses[word] === undefined) {
        statuses[word] = "known"
        changed = true
      }
    }
  })
  return changed ? { ...state, statuses } : state
}

function parseBackupObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("不是有效的 Word Hunter 备份文件")
  }
  return parsed as Record<string, unknown>
}

export function readWordHunterBackup(text: string) {
  const parsed = parseBackupObject(text)
  if (parsed.known && typeof parsed.known === "object" && !Array.isArray(parsed.known)) {
    const words = Object.keys(parsed.known).flatMap((word) => {
      const normalized = normalizeSyncWord(word)
      return normalized ? [normalized] : []
    })
    if (words.length > MAX_GIST_WORDS) throw new Error("Gist 中的词汇数量过多")
    if (words.length) return words
  }
  if (parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files)) {
    for (const file of Object.values(parsed.files as Record<string, unknown>)) {
      if (!file || typeof file !== "object" || Array.isArray(file)) continue
      const content = (file as { content?: unknown }).content
      if (typeof content !== "string") continue
      try {
        return readWordHunterBackup(content)
      } catch {
        // Try the next file in an exported Gist response.
      }
    }
  }
  const entries = Object.entries(parsed)
  if (
    entries.length &&
    entries.every(
      ([word, value]) =>
        /^[a-z]+(?:'[a-z]+)?$/i.test(word) &&
        (typeof value === "string" || value === true || value === 1),
    )
  ) {
    return entries.map(([word]) => word)
  }
  throw new Error("文件中没有找到 Word Hunter 的 known 词汇数据")
}

function parseGistId(gistUrlOrId: string) {
  const gistId = gistUrlOrId.trim().replace(/\/$/, "").split("/").at(-1)?.split("?")[0]
  if (!gistId || !/^[\da-f]+$/i.test(gistId)) throw new Error("Gist 地址或 ID 不正确")
  return gistId
}

export async function fetchWordHunterGist(gistUrlOrId: string, token?: string) {
  const gistId = parseGistId(gistUrlOrId)
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: token?.trim()
      ? {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token.trim()}`,
        }
      : { Accept: "application/vnd.github+json" },
  })
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "找不到该 Gist；如果是私有 Gist，请填写访问令牌"
        : `读取 Gist 失败（${response.status}）`,
    )
  }
  assertSafeResponseSize(response)
  const gist = JSON.parse(await readLimitedText(response)) as {
    files?: Record<string, { content?: string; raw_url?: string; truncated?: boolean }>
  }
  const files = Object.values(gist.files ?? {})
  const preferred =
    gist.files?.["word_hunter_backup.json"] ??
    files.find((file) => file.content?.includes('"known"'))
  if (!preferred) throw new Error("该 Gist 中没有 Word Hunter 备份数据")
  if (preferred.content && !preferred.truncated) {
    if (new TextEncoder().encode(preferred.content).byteLength > MAX_GIST_BYTES) {
      throw new Error("Gist 备份文件过大")
    }
    return preferred.content
  }
  if (!preferred.raw_url) throw new Error("Gist 备份内容无法读取")
  const rawUrl = new URL(preferred.raw_url)
  if (rawUrl.protocol !== "https:" || rawUrl.hostname !== "gist.githubusercontent.com") {
    throw new Error("Gist 原始备份地址不可信")
  }
  const rawResponse = await fetch(rawUrl)
  if (!rawResponse.ok) throw new Error("Gist 原始备份文件读取失败")
  return readLimitedText(rawResponse)
}

export async function syncWordsToWordHunterGist(
  gistUrlOrId: string,
  token: string,
  localStatuses: Record<string, VocabularyStatus>,
  localUpdatedAt: Record<string, number>,
) {
  if (!token.trim()) throw new Error("写入 Gist 必须填写具有 Gist 权限的访问令牌")
  const gistId = parseGistId(gistUrlOrId)
  const remoteText = await fetchWordHunterGist(gistId, token)
  const remoteBackup = parseBackupObject(remoteText)
  const remoteKnown =
    remoteBackup.known &&
    typeof remoteBackup.known === "object" &&
    !Array.isArray(remoteBackup.known)
      ? (remoteBackup.known as Record<string, unknown>)
      : {}
  const remoteReadFrog = remoteBackup.read_frog as
    | {
        statuses?: Record<string, { status?: VocabularyStatus; updatedAt?: number }>
      }
    | undefined
  const mergedStatuses = Object.create(null) as Record<
    string,
    { status: VocabularyStatus; updatedAt: number }
  >
  Object.keys(remoteKnown).forEach((word) => {
    const normalized = normalizeSyncWord(word)
    if (normalized) mergedStatuses[normalized] = { status: "known", updatedAt: 0 }
  })
  Object.entries(remoteReadFrog?.statuses ?? {}).forEach(([word, entry]) => {
    const normalized = normalizeSyncWord(word)
    if (
      normalized &&
      entry &&
      ["known", "fuzzy", "unknown"].includes(entry.status ?? "") &&
      typeof entry.updatedAt === "number" &&
      Number.isFinite(entry.updatedAt) &&
      entry.updatedAt >= 0
    ) {
      mergedStatuses[normalized] = {
        status: entry.status as VocabularyStatus,
        updatedAt: entry.updatedAt,
      }
    }
  })
  Object.entries(localStatuses).forEach(([word, status]) => {
    const normalized = normalizeSyncWord(word)
    if (!normalized) return
    const rawUpdatedAt = localUpdatedAt[word] ?? 0
    const updatedAt = Number.isFinite(rawUpdatedAt) && rawUpdatedAt >= 0 ? rawUpdatedAt : 0
    if (!mergedStatuses[normalized] || updatedAt >= mergedStatuses[normalized].updatedAt) {
      mergedStatuses[normalized] = { status, updatedAt }
    }
  })
  if (Object.keys(mergedStatuses).length > MAX_GIST_WORDS) {
    throw new Error("Gist 中的词汇数量过多")
  }
  const mergedKnown = Object.fromEntries(
    Object.entries(mergedStatuses)
      .filter(([, entry]) => entry.status === "known")
      .map(([word]) => [word, "o"]),
  )
  const now = Date.now()
  const content = JSON.stringify({
    ...remoteBackup,
    known: mergedKnown,
    read_frog: {
      version: 1,
      statuses: mergedStatuses,
      updatedAt: now,
    },
    context: remoteBackup.context ?? {},
    settings: remoteBackup.settings ?? {},
    knwon_update_timestamp: now,
  })
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: {
        "word_hunter_backup.json": { content },
      },
    }),
  })
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(error?.message || `写入 Gist 失败（${response.status}）`)
  }
  return {
    count: Object.keys(mergedKnown).length,
    statuses: Object.fromEntries(
      Object.entries(mergedStatuses).map(([word, entry]) => [word, entry.status]),
    ) as Record<string, VocabularyStatus>,
    updatedAt: Object.fromEntries(
      Object.entries(mergedStatuses).map(([word, entry]) => [word, entry.updatedAt]),
    ),
  }
}

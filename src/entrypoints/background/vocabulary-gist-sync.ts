import { browser } from "#imports"
import { loadVocabularyDictionary } from "@/utils/vocabulary-hunter/dictionary-data"
import {
  applyVocabularyWordUpdate,
  getVocabularyHunterState,
  getVocabularyHunterGistToken,
  setVocabularyHunterState,
  type VocabularyHunterPreferencePatch,
  type VocabularyHunterState,
} from "@/utils/vocabulary-hunter/storage"
import {
  mergeVocabularyStatusesByUpdatedAt,
  syncKnownWords,
  syncWordsToWordHunterGist,
} from "@/utils/vocabulary-hunter/sync"

const ALARM_NAME = "read-frog-vocabulary-gist-sync"
let running = false
let stateUpdateQueue: Promise<void> = Promise.resolve()

function enqueueStateUpdate<T>(operation: () => Promise<T>) {
  const result = stateUpdateQueue.then(operation)
  stateUpdateQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

const LEVELS = new Set(["p", "m", "h", "4", "6", "g", "o"])
const DICTIONARIES = new Set(["haici", "google", "ai"])

function sanitizePreferencePatch(patch: VocabularyHunterPreferencePatch) {
  const safe: VocabularyHunterPreferencePatch = {}
  if (typeof patch.enabled === "boolean") safe.enabled = patch.enabled
  if (
    typeof patch.minimumLength === "number" &&
    Number.isInteger(patch.minimumLength) &&
    patch.minimumLength >= 1 &&
    patch.minimumLength <= 32
  ) {
    safe.minimumLength = patch.minimumLength
  }
  if (Array.isArray(patch.enabledLevels)) {
    safe.enabledLevels = patch.enabledLevels.filter((level) => LEVELS.has(level))
  }
  if (Array.isArray(patch.enabledDictionaries)) {
    safe.enabledDictionaries = patch.enabledDictionaries.filter((dictionary) =>
      DICTIONARIES.has(dictionary),
    )
  }
  if (Array.isArray(patch.dictionaryOrder)) {
    safe.dictionaryOrder = [...new Set(patch.dictionaryOrder)].filter((dictionary) =>
      DICTIONARIES.has(dictionary),
    )
  }
  if (/^#[\da-f]{6}$/i.test(patch.unknownHighlightColor ?? "")) {
    safe.unknownHighlightColor = patch.unknownHighlightColor
  }
  if (/^#[\da-f]{6}$/i.test(patch.fuzzyHighlightColor ?? "")) {
    safe.fuzzyHighlightColor = patch.fuzzyHighlightColor
  }
  if (typeof patch.gistId === "string" && patch.gistId.length <= 512) {
    safe.gistId = patch.gistId.trim()
  }
  if (typeof patch.gistAutoSync === "boolean") safe.gistAutoSync = patch.gistAutoSync
  return safe
}

export function patchVocabularyPreferences(patch: VocabularyHunterPreferencePatch) {
  return enqueueStateUpdate(async () => {
    const latest = await getVocabularyHunterState()
    const safePatch = sanitizePreferencePatch(patch)
    const next = { ...latest, ...safePatch }
    await setVocabularyHunterState(next)
    return next
  })
}

export function mergeVocabularyWordData(
  statuses: VocabularyHunterState["statuses"],
  updatedAt: VocabularyHunterState["statusUpdatedAt"],
  deletedAt: VocabularyHunterState["deletedAt"] = {},
) {
  return enqueueStateUpdate(async () => {
    const latest = await getVocabularyHunterState()
    const merged = mergeVocabularyStatusesByUpdatedAt(
      latest.statuses,
      latest.statusUpdatedAt,
      statuses,
      updatedAt,
      latest.deletedAt,
      deletedAt,
    )
    const next = {
      ...latest,
      statuses: merged.statuses,
      statusUpdatedAt: merged.updatedAt,
      deletedAt: merged.deletedAt,
    }
    await setVocabularyHunterState(next)
    return next
  })
}

export function updateVocabularyWord(
  word: string,
  status: "known" | "fuzzy" | "unknown" | null,
  updatedAt: number,
) {
  let applied = false
  return enqueueStateUpdate(async () => {
    const normalized = word.trim().toLocaleLowerCase()
    if (!/^[a-z]+(?:'[a-z]+)?$/.test(normalized) || normalized.length > 64) {
      return { applied }
    }
    if (!Number.isFinite(updatedAt) || updatedAt < 0 || updatedAt > Date.now() + 60_000) {
      return { applied }
    }
    const latest = await getVocabularyHunterState()
    const next = applyVocabularyWordUpdate(latest, normalized, status, updatedAt)
    if (next === latest) return { applied }
    await setVocabularyHunterState(next)
    applied = true
    return { applied }
  })
}

export async function runVocabularyGistSync() {
  if (running) return false
  const state = await getVocabularyHunterState()
  const gistToken = await getVocabularyHunterGistToken()
  if (!state.gistAutoSync || !state.gistId || !gistToken) return false
  running = true
  try {
    const dictionary = await loadVocabularyDictionary()
    const synced = await syncWordsToWordHunterGist(
      state.gistId,
      gistToken,
      state.statuses,
      state.statusUpdatedAt,
      state.deletedAt,
    )
    const statuses = { ...synced.statuses }
    const deletedAt: Record<string, number> = {}
    const mergedWords = new Set<string>()
    Object.entries(synced.statuses).forEach(([word, status]) => {
      const lemma = dictionary.get(word.toLocaleLowerCase())?.lemma ?? word.toLocaleLowerCase()
      statuses[lemma] = status
      if (status === "known") mergedWords.add(lemma)
    })
    Object.entries(synced.deletedAt).forEach(([word, timestamp]) => {
      const lemma = dictionary.get(word.toLocaleLowerCase())?.lemma ?? word.toLocaleLowerCase()
      deletedAt[lemma] = timestamp
    })
    await syncKnownWords(mergedWords, dictionary)
    await enqueueStateUpdate(async () => {
      const latestState = await getVocabularyHunterState()
      const merged = mergeVocabularyStatusesByUpdatedAt(
        latestState.statuses,
        latestState.statusUpdatedAt,
        statuses,
        synced.updatedAt,
        latestState.deletedAt,
        deletedAt,
      )
      await setVocabularyHunterState({
        ...latestState,
        statuses: merged.statuses,
        statusUpdatedAt: merged.updatedAt,
        deletedAt: merged.deletedAt,
        gistLastSyncAt: Date.now(),
        gistLastSyncCount: synced.count,
        gistSyncError: "",
      })
    })
    return true
  } catch (error) {
    await enqueueStateUpdate(async () => {
      const latestState = await getVocabularyHunterState()
      await setVocabularyHunterState({
        ...latestState,
        gistSyncError: error instanceof Error ? error.message : "自动同步失败",
      })
    })
    return false
  } finally {
    running = false
  }
}

export function setupVocabularyGistAutoSync() {
  void browser.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: 5,
  })
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void runVocabularyGistSync()
  })
}

import { browser } from "#imports"
import { loadVocabularyDictionary } from "@/utils/vocabulary-hunter/dictionary-data"
import {
  applyVocabularyWordUpdate,
  getVocabularyHunterState,
  getVocabularyHunterGistToken,
  setVocabularyHunterState,
} from "@/utils/vocabulary-hunter/storage"
import {
  mergeVocabularyStatusesByUpdatedAt,
  syncKnownWords,
  syncWordsToWordHunterGist,
} from "@/utils/vocabulary-hunter/sync"

const ALARM_NAME = "read-frog-vocabulary-gist-sync"
let running = false
let wordUpdateQueue: Promise<void> = Promise.resolve()

export function updateVocabularyWord(
  word: string,
  status: "known" | "fuzzy" | "unknown" | null,
  updatedAt: number,
) {
  let applied = false
  const operation = wordUpdateQueue.then(async () => {
    const normalized = word.trim().toLocaleLowerCase()
    if (!/^[a-z]+(?:'[a-z]+)?$/.test(normalized) || normalized.length > 64) return
    if (!Number.isFinite(updatedAt) || updatedAt < 0 || updatedAt > Date.now() + 60_000) return
    const latest = await getVocabularyHunterState()
    const next = applyVocabularyWordUpdate(latest, normalized, status, updatedAt)
    if (next === latest) return
    await setVocabularyHunterState(next)
    applied = true
  })
  wordUpdateQueue = operation.catch(() => undefined)
  return operation.then(() => ({ applied }))
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
    )
    const statuses = { ...synced.statuses }
    const mergedWords = new Set<string>()
    Object.entries(synced.statuses).forEach(([word, status]) => {
      const lemma = dictionary.get(word.toLocaleLowerCase())?.lemma ?? word.toLocaleLowerCase()
      statuses[lemma] = status
      if (status === "known") mergedWords.add(lemma)
    })
    await syncKnownWords(mergedWords, dictionary)
    const latestState = await getVocabularyHunterState()
    const merged = mergeVocabularyStatusesByUpdatedAt(
      latestState.statuses,
      latestState.statusUpdatedAt,
      statuses,
      synced.updatedAt,
    )
    await setVocabularyHunterState({
      ...latestState,
      statuses: merged.statuses,
      statusUpdatedAt: merged.updatedAt,
      gistLastSyncAt: Date.now(),
      gistLastSyncCount: synced.count,
      gistSyncError: "",
    })
    return true
  } catch (error) {
    const latestState = await getVocabularyHunterState()
    await setVocabularyHunterState({
      ...latestState,
      gistSyncError: error instanceof Error ? error.message : "自动同步失败",
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

import { browser } from "#imports"
import { loadVocabularyDictionary } from "@/utils/vocabulary-hunter/dictionary-data"
import {
  getVocabularyHunterState,
  setVocabularyHunterState,
} from "@/utils/vocabulary-hunter/storage"
import {
  mergeVocabularyStatusesByUpdatedAt,
  syncKnownWords,
  syncWordsToWordHunterGist,
} from "@/utils/vocabulary-hunter/sync"

const ALARM_NAME = "read-frog-vocabulary-gist-sync"
let running = false

async function runVocabularyGistSync() {
  if (running) return
  const state = await getVocabularyHunterState()
  if (!state.gistAutoSync || !state.gistId || !state.gistToken) return
  running = true
  try {
    const dictionary = await loadVocabularyDictionary()
    const synced = await syncWordsToWordHunterGist(
      state.gistId,
      state.gistToken,
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
  } catch (error) {
    const latestState = await getVocabularyHunterState()
    await setVocabularyHunterState({
      ...latestState,
      gistSyncError: error instanceof Error ? error.message : "自动同步失败",
    })
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

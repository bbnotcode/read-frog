import type { VocabularyLevel, VocabularyStatus } from "./candidates"
import { storage } from "#imports"

export const VOCABULARY_HUNTER_STORAGE_KEY = "local:vocabulary-hunter"
export type VocabularyDictionary = "haici" | "google" | "ai"
const SUPPORTED_DICTIONARIES: VocabularyDictionary[] = ["haici", "google", "ai"]

export interface VocabularyHunterState {
  enabled: boolean
  minimumLength: number
  enabledLevels: VocabularyLevel[]
  enabledDictionaries: VocabularyDictionary[]
  dictionaryOrder: VocabularyDictionary[]
  unknownHighlightColor: string
  fuzzyHighlightColor: string
  gistId: string
  gistToken: string
  gistAutoSync: boolean
  gistLastSyncAt: number
  gistLastSyncCount: number
  gistSyncError: string
  statuses: Record<string, VocabularyStatus>
  statusUpdatedAt: Record<string, number>
}

export const DEFAULT_VOCABULARY_HUNTER_STATE: VocabularyHunterState = {
  enabled: true,
  minimumLength: 2,
  enabledLevels: ["p", "m", "h", "4", "6", "g", "o"],
  enabledDictionaries: [...SUPPORTED_DICTIONARIES],
  dictionaryOrder: [...SUPPORTED_DICTIONARIES],
  unknownHighlightColor: "#fb7185",
  fuzzyHighlightColor: "#fbbf24",
  gistId: "",
  gistToken: "",
  gistAutoSync: false,
  gistLastSyncAt: 0,
  gistLastSyncCount: 0,
  gistSyncError: "",
  statuses: {},
  statusUpdatedAt: {},
}

function migrateState(
  state: Omit<Partial<VocabularyHunterState>, "statuses"> & {
    statuses?: Record<string, VocabularyStatus | "learning" | "ignored">
  },
): VocabularyHunterState {
  const statuses = Object.fromEntries(
    Object.entries(state.statuses ?? {}).map(([word, status]) => [
      word,
      status === "learning" ? "fuzzy" : status === "ignored" ? "known" : status,
    ]),
  ) as Record<string, VocabularyStatus>
  const enabledDictionaries = SUPPORTED_DICTIONARIES.filter((dictionary) =>
    state.enabledDictionaries?.includes(dictionary),
  )
  const savedOrder = (state.dictionaryOrder ?? []).filter((dictionary) =>
    SUPPORTED_DICTIONARIES.includes(dictionary),
  )
  const dictionaryOrder = [
    ...savedOrder,
    ...SUPPORTED_DICTIONARIES.filter((dictionary) => !savedOrder.includes(dictionary)),
  ]

  return {
    ...DEFAULT_VOCABULARY_HUNTER_STATE,
    ...state,
    enabledDictionaries:
      state.enabledDictionaries === undefined
        ? [...DEFAULT_VOCABULARY_HUNTER_STATE.enabledDictionaries]
        : enabledDictionaries,
    dictionaryOrder,
    statuses,
    statusUpdatedAt: state.statusUpdatedAt ?? {},
  }
}

export async function getVocabularyHunterState() {
  return migrateState(
    (await storage.getItem<VocabularyHunterState>(VOCABULARY_HUNTER_STORAGE_KEY)) ?? {},
  )
}

export function setVocabularyHunterState(state: VocabularyHunterState) {
  return storage.setItem(VOCABULARY_HUNTER_STORAGE_KEY, state)
}

export function watchVocabularyHunterState(callback: (state: VocabularyHunterState) => void) {
  return storage.watch<VocabularyHunterState>(VOCABULARY_HUNTER_STORAGE_KEY, (next) => {
    callback(migrateState(next ?? {}))
  })
}

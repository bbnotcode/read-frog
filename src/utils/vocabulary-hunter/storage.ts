import type { VocabularyLevel, VocabularyStatus } from "./candidates"
import { storage } from "#imports"

export const VOCABULARY_HUNTER_STORAGE_KEY = "local:vocabulary-hunter"
const VOCABULARY_HUNTER_SECRET_KEY = "local:vocabulary-hunter-secret"
export const VOCABULARY_HUNTER_SCHEMA_VERSION = 5
export const DEFAULT_VOCABULARY_WORDBOOK = "托福生词"
export type VocabularyDictionary = "haici" | "google" | "ai"
const SUPPORTED_DICTIONARIES: VocabularyDictionary[] = ["haici", "google", "ai"]

export interface VocabularyHunterState {
  schemaVersion: number
  enabled: boolean
  minimumLength: number
  enabledLevels: VocabularyLevel[]
  enabledDictionaries: VocabularyDictionary[]
  dictionaryOrder: VocabularyDictionary[]
  unknownHighlightColor: string
  fuzzyHighlightColor: string
  gistId: string
  gistAutoSync: boolean
  gistLastSyncAt: number
  gistLastSyncCount: number
  gistSyncError: string
  activeWordbook: string
  wordbooks: Record<string, string[]>
  wordbookAddedAt: Record<string, Record<string, number>>
  statuses: Record<string, VocabularyStatus>
  statusUpdatedAt: Record<string, number>
  deletedAt: Record<string, number>
}

export type VocabularyHunterPreferences = Pick<
  VocabularyHunterState,
  | "enabled"
  | "minimumLength"
  | "enabledLevels"
  | "enabledDictionaries"
  | "dictionaryOrder"
  | "unknownHighlightColor"
  | "fuzzyHighlightColor"
  | "gistId"
  | "gistAutoSync"
  | "activeWordbook"
>

export type VocabularyHunterPreferencePatch = Partial<VocabularyHunterPreferences>

export const DEFAULT_VOCABULARY_HUNTER_STATE: VocabularyHunterState = {
  schemaVersion: VOCABULARY_HUNTER_SCHEMA_VERSION,
  enabled: true,
  minimumLength: 2,
  enabledLevels: ["p", "m", "h", "4", "6", "g", "o"],
  enabledDictionaries: [...SUPPORTED_DICTIONARIES],
  dictionaryOrder: [...SUPPORTED_DICTIONARIES],
  unknownHighlightColor: "#fb7185",
  fuzzyHighlightColor: "#fbbf24",
  gistId: "",
  gistAutoSync: false,
  gistLastSyncAt: 0,
  gistLastSyncCount: 0,
  gistSyncError: "",
  activeWordbook: DEFAULT_VOCABULARY_WORDBOOK,
  wordbooks: { [DEFAULT_VOCABULARY_WORDBOOK]: [] },
  wordbookAddedAt: { [DEFAULT_VOCABULARY_WORDBOOK]: {} },
  statuses: {},
  statusUpdatedAt: {},
  deletedAt: {},
}

interface VocabularyHunterSecret {
  gistToken: string
}

export async function getVocabularyHunterGistToken() {
  const secret = await storage.getItem<VocabularyHunterSecret>(VOCABULARY_HUNTER_SECRET_KEY)
  return secret?.gistToken ?? ""
}

export async function setVocabularyHunterGistToken(gistToken: string) {
  await storage.setItem<VocabularyHunterSecret>(VOCABULARY_HUNTER_SECRET_KEY, {
    gistToken: gistToken.trim(),
  })
}

export function applyVocabularyWordUpdate(
  state: VocabularyHunterState,
  word: string,
  status: VocabularyStatus | null,
  updatedAt: number,
) {
  const normalized = word.trim().toLocaleLowerCase()
  if (!/^[a-z]+(?:'[a-z]+)?$/.test(normalized) || normalized.length > 64) return state
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return state
  if (
    Math.max(state.statusUpdatedAt[normalized] ?? 0, state.deletedAt[normalized] ?? 0) > updatedAt
  ) {
    return state
  }
  const statuses = { ...state.statuses }
  const statusUpdatedAt = { ...state.statusUpdatedAt }
  const deletedAt = { ...state.deletedAt }
  if (status === null) {
    delete statuses[normalized]
    delete statusUpdatedAt[normalized]
    deletedAt[normalized] = updatedAt
  } else {
    statuses[normalized] = status
    statusUpdatedAt[normalized] = updatedAt
    delete deletedAt[normalized]
  }
  if (status !== "unknown") return { ...state, statuses, statusUpdatedAt, deletedAt }
  const activeWordbook = normalizeVocabularyWordbookName(state.activeWordbook)
  if (!activeWordbook) return { ...state, statuses, statusUpdatedAt, deletedAt }
  const words = state.wordbooks[activeWordbook] ?? []
  const wordbooks = words.includes(normalized)
    ? state.wordbooks
    : { ...state.wordbooks, [activeWordbook]: [...words, normalized].sort() }
  const existingAddedAt = state.wordbookAddedAt[activeWordbook] ?? {}
  const wordbookAddedAt = existingAddedAt[normalized]
    ? state.wordbookAddedAt
    : {
        ...state.wordbookAddedAt,
        [activeWordbook]: { ...existingAddedAt, [normalized]: updatedAt },
      }
  return { ...state, statuses, statusUpdatedAt, deletedAt, wordbooks, wordbookAddedAt }
}

export function normalizeVocabularyWordbookName(name: string) {
  const normalized = name.trim().replace(/\s+/g, " ")
  const reservedNames = new Set(["__proto__", "constructor", "prototype"])
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  return normalized &&
    normalized.length <= 40 &&
    !hasControlCharacter &&
    !reservedNames.has(normalized.toLocaleLowerCase())
    ? normalized
    : ""
}

function sanitizeWordbooks(wordbooks: Record<string, string[]> | undefined) {
  const result: Record<string, string[]> = {}
  Object.entries(wordbooks ?? {}).forEach(([rawName, rawWords]) => {
    const name = normalizeVocabularyWordbookName(rawName)
    if (!name || !Array.isArray(rawWords)) return
    result[name] = [
      ...new Set(
        rawWords
          .map((word) => word.trim().toLocaleLowerCase())
          .filter((word) => /^[a-z]+(?:'[a-z]+)?$/.test(word) && word.length <= 64),
      ),
    ].sort()
  })
  return result
}

export function createVocabularyWordbookState(state: VocabularyHunterState, rawName: string) {
  const name = normalizeVocabularyWordbookName(rawName)
  if (!name) return state
  return {
    ...state,
    activeWordbook: name,
    wordbooks: state.wordbooks[name] ? state.wordbooks : { ...state.wordbooks, [name]: [] },
    wordbookAddedAt: state.wordbookAddedAt[name]
      ? state.wordbookAddedAt
      : { ...state.wordbookAddedAt, [name]: {} },
  }
}

export function migrateVocabularyHunterState(
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
  const wordbooks = sanitizeWordbooks(state.wordbooks)
  if (!wordbooks[DEFAULT_VOCABULARY_WORDBOOK]) wordbooks[DEFAULT_VOCABULARY_WORDBOOK] = []
  if ((state.schemaVersion ?? 0) < 4) {
    wordbooks[DEFAULT_VOCABULARY_WORDBOOK] = [
      ...new Set([
        ...wordbooks[DEFAULT_VOCABULARY_WORDBOOK],
        ...Object.entries(statuses)
          .filter(([, status]) => status === "unknown")
          .map(([word]) => word),
      ]),
    ].sort()
  }
  const wordbookAddedAt = Object.fromEntries(
    Object.entries(wordbooks).map(([name, words]) => {
      const saved = state.wordbookAddedAt?.[name] ?? {}
      return [
        name,
        Object.fromEntries(
          words.map((word) => {
            const timestamp = saved[word] ?? state.statusUpdatedAt?.[word] ?? 0
            return [word, Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0]
          }),
        ),
      ]
    }),
  )
  const requestedWordbook = normalizeVocabularyWordbookName(state.activeWordbook ?? "")
  const activeWordbook =
    requestedWordbook && wordbooks[requestedWordbook]
      ? requestedWordbook
      : DEFAULT_VOCABULARY_WORDBOOK

  return {
    ...DEFAULT_VOCABULARY_HUNTER_STATE,
    ...state,
    schemaVersion: VOCABULARY_HUNTER_SCHEMA_VERSION,
    enabledDictionaries:
      state.enabledDictionaries === undefined
        ? [...DEFAULT_VOCABULARY_HUNTER_STATE.enabledDictionaries]
        : enabledDictionaries,
    dictionaryOrder,
    activeWordbook,
    wordbooks,
    wordbookAddedAt,
    statuses,
    statusUpdatedAt: state.statusUpdatedAt ?? {},
    deletedAt: state.deletedAt ?? {},
  }
}

export async function getVocabularyHunterState() {
  const stored: Partial<VocabularyHunterState> & { gistToken?: string } =
    (await storage.getItem<VocabularyHunterState & { gistToken?: string }>(
      VOCABULARY_HUNTER_STORAGE_KEY,
    )) ?? {}
  if (stored.gistToken && !(await getVocabularyHunterGistToken())) {
    await setVocabularyHunterGistToken(stored.gistToken)
  }
  const { gistToken: _legacyToken, ...state } = stored
  if (_legacyToken) await storage.setItem(VOCABULARY_HUNTER_STORAGE_KEY, state)
  return migrateVocabularyHunterState(state)
}

export function setVocabularyHunterState(state: VocabularyHunterState) {
  return storage.setItem(VOCABULARY_HUNTER_STORAGE_KEY, state)
}

export function watchVocabularyHunterState(callback: (state: VocabularyHunterState) => void) {
  return storage.watch<VocabularyHunterState>(VOCABULARY_HUNTER_STORAGE_KEY, (next) => {
    callback(migrateVocabularyHunterState(next ?? {}))
  })
}

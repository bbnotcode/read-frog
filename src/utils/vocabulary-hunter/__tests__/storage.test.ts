import { describe, expect, it } from "vitest"
import {
  applyVocabularyWordUpdate,
  DEFAULT_VOCABULARY_HUNTER_STATE,
  migrateVocabularyHunterState,
  VOCABULARY_HUNTER_SCHEMA_VERSION,
} from "../storage"

describe("applyVocabularyWordUpdate", () => {
  it("does not let an older tab overwrite a newer judgement", () => {
    const current = {
      ...DEFAULT_VOCABULARY_HUNTER_STATE,
      statuses: { promise: "known" as const },
      statusUpdatedAt: { promise: 200 },
    }
    expect(applyVocabularyWordUpdate(current, "promise", "unknown", 100)).toBe(current)
    expect(applyVocabularyWordUpdate(current, "promise", "fuzzy", 300)).toMatchObject({
      statuses: { promise: "fuzzy" },
      statusUpdatedAt: { promise: 300 },
    })
  })

  it("normalizes words and can clear an existing judgement", () => {
    const current = {
      ...DEFAULT_VOCABULARY_HUNTER_STATE,
      statuses: { promise: "unknown" as const },
      statusUpdatedAt: { promise: 100 },
    }
    expect(applyVocabularyWordUpdate(current, " Promise ", null, 200)).toMatchObject({
      statuses: {},
      statusUpdatedAt: {},
      deletedAt: { promise: 200 },
    })
  })

  it("does not let an older synced judgement revive a deleted word", () => {
    const deleted = applyVocabularyWordUpdate(
      {
        ...DEFAULT_VOCABULARY_HUNTER_STATE,
        statuses: { promise: "known" },
        statusUpdatedAt: { promise: 100 },
      },
      "promise",
      null,
      200,
    )

    expect(applyVocabularyWordUpdate(deleted, "promise", "known", 150)).toBe(deleted)
    expect(applyVocabularyWordUpdate(deleted, "promise", "unknown", 300)).toMatchObject({
      statuses: { promise: "unknown" },
      statusUpdatedAt: { promise: 300 },
      deletedAt: {},
    })
  })
})

describe("migrateVocabularyHunterState", () => {
  it("migrates legacy statuses and records the current schema version", () => {
    const migrated = migrateVocabularyHunterState({
      statuses: { remembered: "ignored", reviewing: "learning", missing: "unknown" },
      statusUpdatedAt: { remembered: 10 },
    })

    expect(migrated.schemaVersion).toBe(VOCABULARY_HUNTER_SCHEMA_VERSION)
    expect(migrated.statuses).toEqual({
      remembered: "known",
      reviewing: "fuzzy",
      missing: "unknown",
    })
    expect(migrated.statusUpdatedAt).toEqual({ remembered: 10 })
    expect(migrated.deletedAt).toEqual({})
  })

  it("repairs unsupported dictionary configuration", () => {
    const migrated = migrateVocabularyHunterState({
      schemaVersion: 1,
      enabledDictionaries: ["haici", "unsupported" as "haici"],
      dictionaryOrder: ["google"],
    })

    expect(migrated.enabledDictionaries).toEqual(["haici"])
    expect(migrated.dictionaryOrder).toEqual(["google", "haici", "ai"])
  })
})

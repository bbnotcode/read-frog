import { describe, expect, it } from "vitest"
import { shouldRefreshVocabularyHighlights } from "../highlight-refresh"
import { DEFAULT_VOCABULARY_HUNTER_STATE } from "../storage"

function state(overrides = {}) {
  return { ...DEFAULT_VOCABULARY_HUNTER_STATE, ...overrides }
}

describe("shouldRefreshVocabularyHighlights", () => {
  it("ignores UI preferences and a storage echo of an already-applied status", () => {
    const previous = state({ statuses: { surprise: "known" as const } })
    const next = state({
      statuses: { surprise: "known" as const },
      unknownHighlightColor: "#123456",
      dictionaryOrder: ["google", "haici", "ai"],
      wordbooks: { 托福生词: ["surprise"] },
    })
    expect(shouldRefreshVocabularyHighlights(previous, next)).toBe(false)
  })

  it("refreshes when a status changes on another device or page", () => {
    expect(
      shouldRefreshVocabularyHighlights(state(), state({ statuses: { surprise: "known" } })),
    ).toBe(true)
  })

  it.each([
    ["enabled", { enabled: false }],
    ["minimum length", { minimumLength: 5 }],
    ["enabled levels", { enabledLevels: ["p"] }],
    [
      "assessment",
      {
        vocabularyAssessment: {
          version: 1,
          probabilities: { p: 1, m: 1, h: 0.8, 4: 0.5, 6: 0.2, g: 0, o: 0 },
          previousProbabilities: null,
          testedWords: [],
          levelScores: { p: 0, m: 0, h: 0, 4: 0, 6: 0, g: 0, o: 0 },
          levelCounts: { p: 0, m: 0, h: 0, 4: 0, 6: 0, g: 0, o: 0 },
          pseudoScore: 0,
          pseudoCount: 0,
          rounds: 1,
          confidence: 0.5,
          testedAt: 1,
          sampleSize: 30,
          falsePositiveRate: 0,
        },
      },
    ],
  ])("refreshes for %s changes", (_label, overrides) => {
    expect(shouldRefreshVocabularyHighlights(state(), state(overrides))).toBe(true)
  })
})

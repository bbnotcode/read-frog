import { describe, expect, it } from "vitest"
import {
  ASSESSMENT_LEVELS,
  createVocabularyAssessmentItems,
  estimateVocabularyRange,
  estimateVocabularySize,
  scoreVocabularyAssessment,
  type VocabularyAssessmentAnswer,
} from "../assessment"

describe("vocabulary assessment", () => {
  it("keeps estimated mastery non-increasing as difficulty rises", () => {
    const answers = ASSESSMENT_LEVELS.flatMap((level, levelIndex) =>
      Array.from({ length: 4 }, (_, index): VocabularyAssessmentAnswer => ({
        word: `${level}-${index}`,
        level,
        isPseudoword: false,
        response: levelIndex === 3 ? "known" : levelIndex < 3 ? "unsure" : "unknown",
      })),
    )
    const assessment = scoreVocabularyAssessment(answers, null, 123)
    const values = ASSESSMENT_LEVELS.map((level) => assessment.probabilities[level])
    expect(values.every((value, index) => index === 0 || values[index - 1]! >= value)).toBe(true)
    expect(assessment.testedAt).toBe(123)
  })

  it("penalizes claiming to know pseudowords", () => {
    const realAnswers = ASSESSMENT_LEVELS.flatMap((level) =>
      Array.from({ length: 4 }, (_, index): VocabularyAssessmentAnswer => ({
        word: `${level}-${index}`,
        level,
        isPseudoword: false,
        response: "known",
      })),
    )
    const honest = scoreVocabularyAssessment([
      ...realAnswers,
      { word: "notaword", isPseudoword: true, response: "unknown" },
    ])
    const overclaimed = scoreVocabularyAssessment([
      ...realAnswers,
      { word: "notaword", isPseudoword: true, response: "known" },
    ])
    expect(overclaimed.probabilities.p).toBeLessThan(honest.probabilities.p)
    expect(overclaimed.confidence).toBeLessThan(honest.confidence)
  })

  it("accumulates later rounds without storing individual answers", () => {
    const round = ASSESSMENT_LEVELS.flatMap((level) =>
      Array.from({ length: 4 }, (_, index): VocabularyAssessmentAnswer => ({
        word: `${level}-${index}`,
        level,
        isPseudoword: false,
        response: "known",
      })),
    )
    const first = scoreVocabularyAssessment(round)
    const second = scoreVocabularyAssessment(round, first)

    expect(second.rounds).toBe(2)
    expect(second.sampleSize).toBe(first.sampleSize + round.length)
    expect(second.levelCounts.p).toBe(8)
    expect(second.confidence).toBeGreaterThan(first.confidence)
    expect(second.previousProbabilities).toEqual(first.probabilities)
  })

  it("estimates known lemmas without counting inflections twice", () => {
    const dictionary = new Map<string, { lemma: string; level: "p"; index: number }>(
      Array.from(
        { length: 100 },
        (_, index) =>
          [`word-${index}`, { lemma: `word-${index}`, level: "p" as const, index }] as const,
      ),
    )
    dictionary.set("learned", { lemma: "word-0", level: "p", index: 0 })
    const probabilities = { p: 1, m: 0, h: 0, "4": 0, "6": 0, g: 0, o: 0 }

    expect(estimateVocabularySize(dictionary, probabilities)).toBe(100)
  })

  it("replaces model probabilities with explicit vocabulary judgements", () => {
    const dictionary = new Map(
      Array.from(
        { length: 100 },
        (_, index) =>
          [`word-${index}`, { lemma: `word-${index}`, level: "p" as const, index }] as const,
      ),
    )
    const probabilities = { p: 0.5, m: 0, h: 0, "4": 0, "6": 0, g: 0, o: 0 }
    const statuses = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`word-${index}`, "known" as const]),
    )

    expect(estimateVocabularySize(dictionary, probabilities)).toBe(50)
    expect(estimateVocabularySize(dictionary, probabilities, statuses)).toBe(55)
  })

  it("never returns NaN when legacy data contains invalid values", () => {
    const dictionary = new Map([
      ["valid", { lemma: "valid", level: "p" as const, index: 1 }],
      ["broken", { lemma: "broken", level: "o" as const, index: 2 }],
    ])
    const probabilities = { p: 0.5, m: 0, h: 0, "4": 0, "6": 0, g: 0, o: Number.NaN }
    const statuses = { valid: "known", broken: "mastered" } as never

    expect(estimateVocabularySize(dictionary, probabilities, statuses)).toBe(1)
    expect(estimateVocabularyRange(Number.NaN, Number.NaN)).toEqual({ low: 0, high: 0 })
  })

  it("does not repeat words from earlier assessment rounds", () => {
    const dictionary = new Map(
      ASSESSMENT_LEVELS.flatMap((level, levelIndex) =>
        Array.from({ length: 10 }, (_, wordIndex) => {
          const word = `${String.fromCharCode(97 + levelIndex)}${String.fromCharCode(97 + wordIndex)}sample`
          return [word, { lemma: word, level, index: levelIndex * 10 + wordIndex }] as const
        }),
      ),
    )
    const first = createVocabularyAssessmentItems(dictionary, 1)
    const second = createVocabularyAssessmentItems(
      dictionary,
      2,
      new Set(first.map((item) => item.word)),
    )

    expect(first).toHaveLength(34)
    expect(second).toHaveLength(34)
    expect(second.some((item) => first.some((earlier) => earlier.word === item.word))).toBe(false)
  })
})

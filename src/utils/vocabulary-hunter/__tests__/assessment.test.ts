import { describe, expect, it } from "vitest"
import {
  ASSESSMENT_LEVELS,
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
    const assessment = scoreVocabularyAssessment(answers, 123)
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
})

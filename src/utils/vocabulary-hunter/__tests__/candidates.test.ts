import { describe, expect, it } from "vitest"
import { findCandidateWords, normalizeSelectedWord, normalizeWord } from "../candidates"

describe("vocabulary hunter candidates", () => {
  it("normalizes case and apostrophes", () => {
    expect(normalizeWord("LEARNER’S")).toBe("learner's")
  })

  it("accepts only one selected English word", () => {
    expect(normalizeSelectedWord("  Forgotten  ")).toBe("forgotten")
    expect(normalizeSelectedWord("isn't")).toBe("isn't")
    expect(normalizeSelectedWord("“forgotten,”")).toBe("forgotten")
    expect(normalizeSelectedWord("two words")).toBeUndefined()
    expect(normalizeSelectedWord("RyukGram v1.3.3")).toBeUndefined()
  })

  it("keeps harder words and filters common or known words", () => {
    const result = findCandidateWords(
      "This comprehensive tutorial explains unfamiliar terminology.",
      7,
      { tutorial: "known" },
    )

    expect(result.map(({ word }) => word)).toEqual([
      "comprehensive",
      "explains",
      "unfamiliar",
      "terminology",
    ])
  })
})

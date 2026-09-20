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

  it("keeps explicitly marked learning words even when automatic filters exclude them", () => {
    const dictionary = new Map([
      [
        "remembered",
        {
          lemma: "remember",
          level: "g" as const,
          index: 1,
        },
      ],
    ])

    expect(
      findCandidateWords(
        "Remembered customterm.",
        12,
        { remember: "unknown", customterm: "fuzzy" },
        dictionary,
        new Set(["p"] as const),
      ).map(({ word }) => word),
    ).toEqual(["remember", "customterm"])
  })

  it("treats inflections and conservative derivatives as known word families", () => {
    const dictionary = new Map([
      ["surprise", { lemma: "surprise", level: "m" as const, index: 1 }],
      ["surprisingly", { lemma: "surprisingly", level: "4" as const, index: 2 }],
      ["surprising", { lemma: "surprise", level: "m" as const, index: 1 }],
      ["require", { lemma: "require", level: "h" as const, index: 3 }],
      ["requirement", { lemma: "requirement", level: "h" as const, index: 4 }],
      ["requirements", { lemma: "requirement", level: "h" as const, index: 4 }],
    ])

    expect(
      findCandidateWords(
        "Surprisingly, these requirements surprised us.",
        2,
        { surprise: "known", require: "known" },
        dictionary,
        new Set(["p", "m", "h", "4", "6", "g", "o"] as const),
      ),
    ).toEqual([])
  })

  it("lets an explicit learning status override a known base word", () => {
    const dictionary = new Map([
      ["require", { lemma: "require", level: "h" as const, index: 1 }],
      ["requirement", { lemma: "requirement", level: "h" as const, index: 2 }],
    ])

    expect(
      findCandidateWords(
        "Requirement",
        2,
        { require: "known", requirement: "unknown" },
        dictionary,
        new Set(["h"] as const),
      ).map(({ word }) => word),
    ).toEqual(["requirement"])
  })

  it("does not merge ambiguous -ly words into unrelated bases", () => {
    const dictionary = new Map([
      ["like", { lemma: "like", level: "p" as const, index: 1 }],
      ["likely", { lemma: "likely", level: "h" as const, index: 2 }],
    ])

    expect(
      findCandidateWords("Likely", 2, { like: "known" }, dictionary, new Set(["h"] as const)).map(
        ({ word }) => word,
      ),
    ).toEqual(["likely"])
  })

  it("uses assessment results only when there is no explicit learning status", () => {
    const dictionary = new Map([
      ["require", { lemma: "require", level: "h" as const, index: 1 }],
      ["reluctant", { lemma: "reluctant", level: "4" as const, index: 2 }],
    ])
    const assessment = {
      version: 1 as const,
      probabilities: { p: 0.99, m: 0.95, h: 0.9, "4": 0.7, "6": 0.3, g: 0.1, o: 0.05 },
      confidence: 0.9,
      testedAt: 1,
      sampleSize: 34,
      falsePositiveRate: 0,
    }

    expect(
      findCandidateWords(
        "Require reluctant",
        2,
        { require: "unknown" },
        dictionary,
        new Set(["h", "4"] as const),
        assessment,
      ).map(({ word }) => word),
    ).toEqual(["require", "reluctant"])
    expect(
      findCandidateWords(
        "Require reluctant",
        2,
        {},
        dictionary,
        new Set(["h", "4"] as const),
        assessment,
      ).map(({ word }) => word),
    ).toEqual(["reluctant"])
  })
})

import { describe, expect, it } from "vitest"
import { createPredictedKnownIndices, estimateVocabularySize } from "../assessment"
import {
  findCandidateWords,
  normalizeSelectedWord,
  normalizeWord,
  resolveVocabularyWord,
} from "../candidates"

describe("vocabulary hunter candidates", () => {
  it("normalizes case and apostrophes", () => {
    expect(normalizeWord("LEARNER’S")).toBe("learner's")
    expect(normalizeWord("TODAY‘S")).toBe("today's")
    expect(normalizeWord("TODAYʼS")).toBe("today's")
  })

  it("accepts only one selected English word", () => {
    expect(normalizeSelectedWord("  Forgotten  ")).toBe("forgotten")
    expect(normalizeSelectedWord("isn't")).toBe("isn't")
    expect(normalizeSelectedWord("today‘s")).toBe("today's")
    expect(normalizeSelectedWord("“forgotten,”")).toBe("forgotten")
    expect(normalizeSelectedWord("two words")).toBeUndefined()
    expect(normalizeSelectedWord("RyukGram v1.3.3")).toBeUndefined()
  })

  it("resolves possessives to their known base word", () => {
    const dictionary = new Map([
      ["today", { lemma: "today", level: "p" as const, index: 1 }],
      ["student", { lemma: "student", level: "m" as const, index: 2 }],
      ["students", { lemma: "student", level: "m" as const, index: 2 }],
    ])

    expect(resolveVocabularyWord("today’s", dictionary)).toEqual({
      lemma: "today",
      level: "p",
      index: 1,
    })
    expect(
      findCandidateWords(
        "Today's today’s today‘s lesson and the students' books.",
        2,
        { today: "known", student: "known" },
        dictionary,
        new Set(["p", "m"] as const),
      ),
    ).toEqual([])
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

  it("treats common verb, plural, and spelling-changing forms as known", () => {
    const words = [
      "ask",
      "asks",
      "asked",
      "asking",
      "study",
      "studies",
      "studied",
      "studying",
      "lie",
      "lying",
      "panic",
      "panicked",
      "panicking",
      "go",
      "went",
      "child",
      "children",
    ]
    const dictionary = new Map(
      words.map((word, index) => [word, { lemma: word, level: "m" as const, index }]),
    )

    expect(
      findCandidateWords(
        "Asks asked asking studies studied studying lying panicked panicking went children",
        2,
        { ask: "known", study: "known", lie: "known", panic: "known", go: "known", child: "known" },
        dictionary,
        new Set(["m"] as const),
      ),
    ).toEqual([])
  })

  it("recognizes high-confidence adjective, adverb, and noun derivations", () => {
    const words = [
      "basic",
      "basically",
      "comfortable",
      "comfortably",
      "possible",
      "possibly",
      "normal",
      "normally",
      "perform",
      "performance",
      "differ",
      "difference",
      "sharp",
      "sharpen",
    ]
    const dictionary = new Map(
      words.map((word, index) => [word, { lemma: word, level: "h" as const, index }]),
    )

    expect(
      findCandidateWords(
        "Basically comfortably possibly normally performance difference sharpen",
        2,
        {
          basic: "known",
          comfortable: "known",
          possible: "known",
          normal: "known",
          perform: "known",
          differ: "known",
          sharp: "known",
        },
        dictionary,
        new Set(["h"] as const),
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
      previousProbabilities: null,
      testedWords: [],
      levelScores: { p: 4, m: 4, h: 4, "4": 3, "6": 1, g: 0, o: 0 },
      levelCounts: { p: 4, m: 4, h: 4, "4": 4, "6": 4, g: 4, o: 4 },
      pseudoScore: 0,
      pseudoCount: 6,
      rounds: 1,
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
        createPredictedKnownIndices(dictionary, assessment, { require: "unknown" }),
      ).map(({ word }) => word),
    ).toEqual(["require"])
    expect(
      findCandidateWords(
        "Require reluctant",
        2,
        {},
        dictionary,
        new Set(["h", "4"] as const),
        assessment,
        createPredictedKnownIndices(dictionary, assessment, {}),
      ).map(({ word }) => word),
    ).toEqual([])
  })

  it("turns an estimated vocabulary size into stable per-word filtering", () => {
    const dictionary = new Map(
      Array.from({ length: 10 }, (_, index) => {
        const word = `sample${String.fromCharCode(97 + index)}`
        return [word, { lemma: word, level: "h" as const, index }] as const
      }),
    )
    const assessment = {
      version: 1 as const,
      probabilities: { p: 0, m: 0, h: 0.6, "4": 0, "6": 0, g: 0, o: 0 },
      previousProbabilities: null,
      testedWords: [],
      levelScores: { p: 0, m: 0, h: 3, "4": 0, "6": 0, g: 0, o: 0 },
      levelCounts: { p: 0, m: 0, h: 5, "4": 0, "6": 0, g: 0, o: 0 },
      pseudoScore: 0,
      pseudoCount: 1,
      rounds: 1,
      confidence: 0.9,
      testedAt: 1,
      sampleSize: 10,
      falsePositiveRate: 0,
    }
    const predictedKnownCount = estimateVocabularySize(dictionary, assessment.probabilities)
    const statuses = { sampleb: "unknown" as const, samplej: "known" as const }
    const predictedKnownIndices = createPredictedKnownIndices(dictionary, assessment, statuses)
    const text = [...dictionary.keys()].join(" ")

    expect(predictedKnownCount).toBe(6)
    expect(
      findCandidateWords(
        text,
        2,
        statuses,
        dictionary,
        new Set(["h"] as const),
        assessment,
        predictedKnownIndices,
      ).map(({ word }) => word),
    ).toEqual(["sampleb", "sampleg", "sampleh", "samplei"])
  })
})

import { describe, expect, it } from "vitest"
import { mergeVocabularyStatusesByUpdatedAt, readWordHunterBackup } from "../sync"

describe("mergeVocabularyStatusesByUpdatedAt", () => {
  it("keeps a newer local shortcut judgement when an older sync finishes later", () => {
    expect(
      mergeVocabularyStatusesByUpdatedAt(
        { transient: "known" },
        { transient: 200 },
        { transient: "unknown" },
        { transient: 100 },
      ),
    ).toEqual({
      statuses: { transient: "known" },
      updatedAt: { transient: 200 },
    })
  })

  it("accepts newer remote judgements and retains local-only words", () => {
    expect(
      mergeVocabularyStatusesByUpdatedAt(
        { local: "fuzzy", updated: "unknown" },
        { local: 300, updated: 100 },
        { updated: "known", remote: "fuzzy" },
        { updated: 200, remote: 150 },
      ),
    ).toEqual({
      statuses: { local: "fuzzy", updated: "known", remote: "fuzzy" },
      updatedAt: { local: 300, updated: 200, remote: 150 },
    })
  })
})

describe("readWordHunterBackup", () => {
  it("reads a regular Word Hunter backup", () => {
    expect(
      readWordHunterBackup(JSON.stringify({ known: { activity: "o", workflow: "o" } })),
    ).toEqual(["activity", "workflow"])
  })

  it("filters unsafe and non-word keys from known data", () => {
    expect(
      readWordHunterBackup(
        JSON.stringify({
          known: {
            Activity: "o",
            "not a word": "o",
            __proto__: "o",
            ["x".repeat(65)]: "o",
          },
        }),
      ),
    ).toEqual(["activity"])
  })

  it("reads a downloaded Gist response and legacy word map", () => {
    const gist = {
      files: {
        "word_hunter_backup.json": {
          content: JSON.stringify({ known: { license: "o" } }),
        },
      },
    }
    expect(readWordHunterBackup(JSON.stringify(gist))).toEqual(["license"])
    expect(readWordHunterBackup(JSON.stringify({ modernize: "o" }))).toEqual(["modernize"])
  })
})

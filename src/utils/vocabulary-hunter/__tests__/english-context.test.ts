import { describe, expect, it } from "vitest"
import { isEnglishVocabularyContext } from "../english-context"

describe("isEnglishVocabularyContext", () => {
  it("accepts English messages", () => {
    expect(
      isEnglishVocabularyContext(
        "This extension should only highlight unfamiliar English words in the message.",
      ),
    ).toBe(true)
  })

  it("rejects French and Spanish messages", () => {
    expect(
      isEnglishVocabularyContext(
        "Cette extension ne doit pas marquer les mots français dans ce message.",
      ),
    ).toBe(false)
    expect(
      isEnglishVocabularyContext(
        "Esta extensión no debe marcar las palabras españolas de este mensaje.",
      ),
    ).toBe(false)
  })

  it("conservatively rejects text that is too short to identify", () => {
    expect(isEnglishVocabularyContext("Très bien")).toBe(false)
    expect(isEnglishVocabularyContext("Great work")).toBe(false)
  })
})

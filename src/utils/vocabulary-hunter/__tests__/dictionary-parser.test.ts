import { describe, expect, it, vi } from "vitest"
import { parseVocabularyDictionary } from "../dictionary-parser"

describe("parseVocabularyDictionary", () => {
  it("parses words and assigns one index to each lemma", async () => {
    const dictionary = await parseVocabularyDictionary(
      "ask\task\tp\nasked\task\tp\nrequirement\trequire\th\r\n",
    )
    expect(dictionary.get("ask")).toEqual({ lemma: "ask", level: "p", index: 0 })
    expect(dictionary.get("asked")).toEqual({ lemma: "ask", level: "p", index: 0 })
    expect(dictionary.get("requirement")).toEqual({ lemma: "require", level: "h", index: 1 })
  })

  it("yields between large parsing chunks", async () => {
    const yieldControl = vi.fn<() => Promise<void>>(async () => {})
    const text = Array.from({ length: 5001 }, (_, index) => `word${index}\tlemma${index}\tp`).join(
      "\n",
    )
    await parseVocabularyDictionary(text, yieldControl)
    expect(yieldControl).toHaveBeenCalledOnce()
  })
})

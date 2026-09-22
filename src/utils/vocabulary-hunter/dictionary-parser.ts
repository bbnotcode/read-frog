import type { VocabularyLevel, VocabularyWordInfo } from "./candidates"

const PARSE_CHUNK_SIZE = 5000

async function yieldToMainThread() {
  const scheduling = (
    globalThis as typeof globalThis & {
      scheduler?: { yield?: () => Promise<void> }
    }
  ).scheduler
  if (scheduling?.yield) await scheduling.yield()
  else await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export async function parseVocabularyDictionary(
  text: string,
  yieldControl: () => Promise<void> = yieldToMainThread,
) {
  const dictionary = new Map<string, VocabularyWordInfo>()
  const lemmaIndices = new Map<string, number>()
  const sharedInfo = new Map<string, VocabularyWordInfo>()
  let lineStart = 0
  let parsedLines = 0

  while (lineStart < text.length) {
    const lineEnd = text.indexOf("\n", lineStart)
    const end = lineEnd === -1 ? text.length : lineEnd
    const firstTab = text.indexOf("\t", lineStart)
    const secondTab = firstTab === -1 || firstTab >= end ? -1 : text.indexOf("\t", firstTab + 1)
    if (firstTab > lineStart && secondTab > firstTab && secondTab < end) {
      const word = text.slice(lineStart, firstTab)
      const lemma = text.slice(firstTab + 1, secondTab)
      const rawLevel = text.slice(secondTab + 1, end)
      const level = rawLevel.endsWith("\r") ? rawLevel.slice(0, -1) : rawLevel
      if (lemma && level) {
        let index = lemmaIndices.get(lemma)
        if (index === undefined) {
          index = lemmaIndices.size
          lemmaIndices.set(lemma, index)
        }
        const infoKey = `${lemma}\0${level}`
        let info = sharedInfo.get(infoKey)
        if (!info) {
          info = { lemma, level: level as VocabularyLevel, index }
          sharedInfo.set(infoKey, info)
        }
        dictionary.set(word, info)
      }
    }

    parsedLines += 1
    lineStart = lineEnd === -1 ? text.length : lineEnd + 1
    if (parsedLines % PARSE_CHUNK_SIZE === 0 && lineStart < text.length) await yieldControl()
  }

  return dictionary
}

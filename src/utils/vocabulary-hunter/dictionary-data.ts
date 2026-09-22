import type { VocabularyLevel, VocabularyWordInfo } from "./candidates"
import { browser } from "#imports"
import { parseVocabularyDictionary } from "./dictionary-parser"

export const VOCABULARY_LEVELS: Array<{
  id: VocabularyLevel
  label: string
  description: string
  rank: number
}> = [
  { id: "p", label: "高频基础", description: "小学及 A1 左右的高频词", rank: 1 },
  { id: "m", label: "日常基础", description: "初中及 A2 左右的常用词", rank: 2 },
  { id: "h", label: "核心进阶", description: "高中及 B1 左右的核心词", rank: 3 },
  { id: "4", label: "通用进阶", description: "CET-4 及 B2 左右的通用词", rank: 4 },
  { id: "6", label: "学术进阶", description: "CET-6、IELTS 常见词", rank: 5 },
  { id: "g", label: "高阶学术", description: "TOEFL、GRE 常见高阶词", rank: 6 },
  { id: "o", label: "低频扩展", description: "专业、低频及词库扩展词", rank: 7 },
]

let dictionaryPromise: Promise<Map<string, VocabularyWordInfo>> | null = null

export function loadVocabularyDictionary() {
  // WXT narrows getURL to HTML entrypoints, while this public text asset is also emitted.
  // oxlint-disable-next-line typescript/unbound-method
  const getRuntimeUrl = browser.runtime.getURL as (path: string) => string
  dictionaryPromise ??= fetch(getRuntimeUrl("vocabulary/eng-dict.txt"))
    .then((response) => {
      if (!response.ok) throw new Error(`Vocabulary dictionary: ${response.status}`)
      return response.text()
    })
    .then(parseVocabularyDictionary)

  return dictionaryPromise
}

export function getVocabularyLevel(level: VocabularyLevel | undefined) {
  return VOCABULARY_LEVELS.find((item) => item.id === level) ?? VOCABULARY_LEVELS.at(-1)!
}

import type { VocabularyLevel, VocabularyWordInfo } from "./candidates"

export const ASSESSMENT_LEVELS: VocabularyLevel[] = ["p", "m", "h", "4", "6", "g", "o"]

export type VocabularyAssessmentResponse = "known" | "unsure" | "unknown"

export interface VocabularyAssessment {
  version: 1
  probabilities: Record<VocabularyLevel, number>
  previousProbabilities: Record<VocabularyLevel, number> | null
  testedWords: string[]
  levelScores: Record<VocabularyLevel, number>
  levelCounts: Record<VocabularyLevel, number>
  pseudoScore: number
  pseudoCount: number
  rounds: number
  confidence: number
  testedAt: number
  sampleSize: number
  falsePositiveRate: number
}

export interface VocabularyAssessmentItem {
  word: string
  level?: VocabularyLevel
  isPseudoword: boolean
}

export interface VocabularyAssessmentAnswer extends VocabularyAssessmentItem {
  response: VocabularyAssessmentResponse
}

const WORD_BANK = [
  "house",
  "water",
  "family",
  "answer",
  "morning",
  "friend",
  "surprise",
  "journey",
  "improve",
  "ordinary",
  "discover",
  "protect",
  "require",
  "consequence",
  "adequate",
  "reluctant",
  "preserve",
  "ambiguous",
  "comprehensive",
  "equivalent",
  "perspective",
  "inevitable",
  "elaborate",
  "reinforce",
  "empirical",
  "intrinsic",
  "plausible",
  "alleviate",
  "deteriorate",
  "concise",
  "ubiquitous",
  "perfunctory",
  "ameliorate",
  "ephemeral",
  "obfuscate",
  "recalcitrant",
  "equivocal",
  "parsimonious",
  "intransigence",
  "synecdoche",
  "sesquipedalian",
  "antediluvian",
]

const PSEUDOWORDS = ["flinterous", "brastify", "morbical", "trellic", "dovinate", "pransive"]

function hash(seed: number) {
  let value = seed | 0
  return () => {
    value = Math.imul(value ^ (value >>> 15), 1 | value)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function shuffled<T>(items: T[], seed: number) {
  const result = [...items]
  const random = hash(seed)
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    const current = result[index]!
    result[index] = result[target]!
    result[target] = current
  }
  return result
}

export function createVocabularyAssessmentItems(
  dictionary: Map<string, VocabularyWordInfo>,
  seed = Date.now(),
  excludedWords: ReadonlySet<string> = new Set(),
) {
  const byLevel = new Map<VocabularyLevel, VocabularyAssessmentItem[]>()
  const fallbackByLevel = new Map<VocabularyLevel, VocabularyAssessmentItem[]>()
  ASSESSMENT_LEVELS.forEach((level) => byLevel.set(level, []))
  ASSESSMENT_LEVELS.forEach((level) => fallbackByLevel.set(level, []))
  WORD_BANK.forEach((word) => {
    const info = dictionary.get(word)
    if (!info || info.lemma !== word || excludedWords.has(word)) return
    byLevel.get(info.level)?.push({ word, level: info.level, isPseudoword: false })
  })
  dictionary.forEach((info, word) => {
    if (
      word !== info.lemma ||
      excludedWords.has(word) ||
      WORD_BANK.includes(word) ||
      !/^[a-z]{4,16}$/.test(word)
    ) {
      return
    }
    fallbackByLevel.get(info.level)?.push({ word, level: info.level, isPseudoword: false })
  })

  const realItems = ASSESSMENT_LEVELS.flatMap((level, index) => {
    const preferred = shuffled(byLevel.get(level) ?? [], seed + index)
    const fallback = shuffled(fallbackByLevel.get(level) ?? [], seed + index + 101)
    return [...preferred, ...fallback].slice(0, 4)
  })
  const pseudowords: VocabularyAssessmentItem[] = []
  const usedWords = new Set([...excludedWords, ...realItems.map((item) => item.word)])
  const starts = ["br", "cl", "dr", "fl", "gl", "pr", "st", "tr", "v"]
  const middles = ["a", "e", "i", "o", "u", "ai", "ori", "eli"]
  const endings = ["ble", "ful", "ical", "ish", "ment", "ous", "ive", "ity"]
  const preferredPseudowords = shuffled(PSEUDOWORDS, seed + 211)
  let attempt = 0
  while (pseudowords.length < 6) {
    const generated = `${starts[(seed + attempt * 3) % starts.length]}${middles[(seed + attempt * 5) % middles.length]}${endings[(seed + attempt * 7) % endings.length]}`
    const word = preferredPseudowords[attempt] ?? generated
    attempt += 1
    if (dictionary.has(word) || usedWords.has(word)) continue
    usedWords.add(word)
    pseudowords.push({ word, isPseudoword: true })
  }
  return shuffled([...realItems, ...pseudowords], seed)
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value))
}

function monotonicKnownProbabilities(values: number[]) {
  const blocks = values.map((value) => ({ sum: value, count: 1 }))
  for (let index = 0; index < blocks.length - 1;) {
    const leftBlock = blocks[index]!
    const rightBlock = blocks[index + 1]!
    const left = leftBlock.sum / leftBlock.count
    const right = rightBlock.sum / rightBlock.count
    if (left >= right) {
      index += 1
      continue
    }
    blocks.splice(index, 2, {
      sum: leftBlock.sum + rightBlock.sum,
      count: leftBlock.count + rightBlock.count,
    })
    if (index > 0) index -= 1
  }
  return blocks.flatMap((block) => Array(block.count).fill(block.sum / block.count))
}

export function scoreVocabularyAssessment(
  answers: VocabularyAssessmentAnswer[],
  previous: VocabularyAssessment | null = null,
  testedAt = Date.now(),
): VocabularyAssessment {
  const pseudoAnswers = answers.filter((answer) => answer.isPseudoword)
  const responseScore = (response: VocabularyAssessmentResponse) =>
    response === "known" ? 1 : response === "unsure" ? 0.5 : 0
  const pseudoScore =
    (previous?.pseudoScore ?? 0) +
    pseudoAnswers.reduce((sum, answer) => sum + responseScore(answer.response), 0)
  const pseudoCount = (previous?.pseudoCount ?? 0) + pseudoAnswers.length
  const falsePositiveRate = pseudoCount ? pseudoScore / pseudoCount : 0
  const levelScores = Object.fromEntries(
    ASSESSMENT_LEVELS.map((level) => {
      const points = answers
        .filter((answer) => !answer.isPseudoword && answer.level === level)
        .reduce((sum, answer) => sum + responseScore(answer.response), 0)
      return [level, (previous?.levelScores[level] ?? 0) + points]
    }),
  ) as Record<VocabularyLevel, number>
  const levelCounts = Object.fromEntries(
    ASSESSMENT_LEVELS.map((level) => [
      level,
      (previous?.levelCounts[level] ?? 0) +
        answers.filter((answer) => !answer.isPseudoword && answer.level === level).length,
    ]),
  ) as Record<VocabularyLevel, number>
  const rawProbabilities = ASSESSMENT_LEVELS.map((level) => {
    const smoothed = (levelScores[level] + 0.5) / (levelCounts[level] + 1)
    return clamp((smoothed - falsePositiveRate) / Math.max(0.2, 1 - falsePositiveRate))
  })
  const monotonicProbabilities = monotonicKnownProbabilities(rawProbabilities)
  const probabilities = Object.fromEntries(
    ASSESSMENT_LEVELS.map((level, index) => [level, monotonicProbabilities[index]]),
  ) as Record<VocabularyLevel, number>
  const realAnswerCount = ASSESSMENT_LEVELS.reduce((sum, level) => sum + levelCounts[level], 0)
  return {
    version: 1,
    probabilities,
    previousProbabilities: previous?.probabilities ?? null,
    testedWords: [
      ...new Set([...(previous?.testedWords ?? []), ...answers.map((answer) => answer.word)]),
    ],
    levelScores,
    levelCounts,
    pseudoScore,
    pseudoCount,
    rounds: (previous?.rounds ?? 0) + 1,
    confidence: clamp((1 - Math.exp(-realAnswerCount / 35)) * (1 - falsePositiveRate)),
    testedAt,
    sampleSize: (previous?.sampleSize ?? 0) + answers.length,
    falsePositiveRate,
  }
}

export function estimateVocabularySize(
  dictionary: Map<string, VocabularyWordInfo>,
  probabilities: Record<VocabularyLevel, number>,
) {
  const lemmaLevels = new Map<number, VocabularyLevel>()
  dictionary.forEach((info) => lemmaLevels.set(info.index, info.level))
  const estimate = [...lemmaLevels.values()].reduce((sum, level) => sum + probabilities[level], 0)
  return Math.round(estimate / 100) * 100
}

export function estimateVocabularyRange(estimate: number, confidence: number) {
  const margin = Math.max(0.1, (1 - confidence) * 0.45)
  const round = (value: number) => Math.max(0, Math.round(value / 500) * 500)
  return { low: round(estimate * (1 - margin)), high: round(estimate * (1 + margin)) }
}

export function shouldHideAssessedWord(
  assessment: VocabularyAssessment | null,
  level: VocabularyLevel | undefined,
) {
  return Boolean(
    assessment && assessment.confidence >= 0.5 && level && assessment.probabilities[level] >= 0.85,
  )
}

export type VocabularyStatus = "known" | "fuzzy" | "unknown"
export type VocabularyLevel = "p" | "m" | "h" | "4" | "6" | "g" | "o"

export interface VocabularyWordInfo {
  lemma: string
  level: VocabularyLevel
  index: number
}

export interface WordOccurrence {
  word: string
  level?: VocabularyLevel
  start: number
  end: number
}

interface VocabularyFamilyInfo {
  lemmas: string[]
  level: VocabularyLevel
}

const LEVEL_RANK: Record<VocabularyLevel, number> = {
  p: 1,
  m: 2,
  h: 3,
  "4": 4,
  "6": 5,
  g: 6,
  o: 7,
}

const FAMILY_CACHE = new WeakMap<
  Map<string, VocabularyWordInfo>,
  Map<string, VocabularyFamilyInfo>
>()

// These words look like regular -ly derivatives but have meanings that cannot
// safely be inferred from the apparent base word.
const AMBIGUOUS_LY_DERIVATIVES = new Set([
  "barely",
  "early",
  "hardly",
  "lately",
  "likely",
  "lonely",
  "lovely",
  "merely",
  "nearly",
  "only",
  "shortly",
  "silly",
])

const BASIC_WORDS = new Set(
  [
    "about",
    "after",
    "again",
    "against",
    "almost",
    "also",
    "always",
    "among",
    "another",
    "around",
    "because",
    "before",
    "being",
    "between",
    "both",
    "could",
    "does",
    "doing",
    "during",
    "each",
    "every",
    "first",
    "from",
    "going",
    "good",
    "great",
    "have",
    "having",
    "here",
    "into",
    "itself",
    "just",
    "know",
    "like",
    "little",
    "long",
    "made",
    "make",
    "many",
    "might",
    "more",
    "most",
    "much",
    "must",
    "never",
    "only",
    "other",
    "over",
    "people",
    "really",
    "right",
    "same",
    "should",
    "since",
    "some",
    "something",
    "still",
    "such",
    "take",
    "than",
    "that",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "thing",
    "think",
    "this",
    "those",
    "through",
    "time",
    "under",
    "very",
    "want",
    "well",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "will",
    "with",
    "would",
    "year",
    "your",
  ].map((word) => word.toLowerCase()),
)

const ENGLISH_WORD_SEGMENTER = new Intl.Segmenter("en-US", { granularity: "word" })

function addCandidate(candidates: Set<string>, value: string) {
  if (value.length >= 3) candidates.add(value)
}

function possibleBaseForms(word: string) {
  const candidates = new Set<string>()

  if (word.endsWith("ies")) addCandidate(candidates, `${word.slice(0, -3)}y`)
  if (word.endsWith("ves")) {
    addCandidate(candidates, `${word.slice(0, -3)}f`)
    addCandidate(candidates, `${word.slice(0, -3)}fe`)
  }
  if (word.endsWith("es")) {
    addCandidate(candidates, word.slice(0, -2))
    addCandidate(candidates, word.slice(0, -1))
  } else if (word.endsWith("s") && !word.endsWith("ss")) {
    addCandidate(candidates, word.slice(0, -1))
  }

  for (const suffix of ["ing", "ed", "er", "est"] as const) {
    if (!word.endsWith(suffix)) continue
    const stem = word.slice(0, -suffix.length)
    addCandidate(candidates, stem)
    addCandidate(candidates, `${stem}e`)
    if (stem.length >= 2 && stem.at(-1) === stem.at(-2)) {
      addCandidate(candidates, stem.slice(0, -1))
    }
  }
  if (word.endsWith("ied")) addCandidate(candidates, `${word.slice(0, -3)}y`)
  if (word.endsWith("ier")) addCandidate(candidates, `${word.slice(0, -3)}y`)
  if (word.endsWith("iest")) addCandidate(candidates, `${word.slice(0, -4)}y`)

  if (word.endsWith("ily")) addCandidate(candidates, `${word.slice(0, -3)}y`)
  if (word.endsWith("ly") && !AMBIGUOUS_LY_DERIVATIVES.has(word)) {
    addCandidate(candidates, word.slice(0, -2))
  }
  if (word.endsWith("iness")) addCandidate(candidates, `${word.slice(0, -5)}y`)
  if (word.endsWith("ness")) addCandidate(candidates, word.slice(0, -4))

  for (const suffix of [
    "ability",
    "ibility",
    "ation",
    "ition",
    "ment",
    "fully",
    "lessly",
    "able",
    "ible",
    "ship",
    "hood",
    "less",
    "ful",
    "ism",
    "ist",
    "ity",
    "ive",
    "ous",
    "ize",
    "ise",
    "ion",
    "al",
  ] as const) {
    if (!word.endsWith(suffix)) continue
    const stem = word.slice(0, -suffix.length)
    addCandidate(candidates, stem)
    addCandidate(candidates, `${stem}e`)
  }

  return candidates
}

export function getVocabularyFamilyInfo(
  lemma: string,
  dictionary: Map<string, VocabularyWordInfo>,
) {
  let dictionaryCache = FAMILY_CACHE.get(dictionary)
  if (!dictionaryCache) {
    dictionaryCache = new Map()
    FAMILY_CACHE.set(dictionary, dictionaryCache)
  }
  const cached = dictionaryCache.get(lemma)
  if (cached) return cached

  const originalInfo = dictionary.get(lemma)
  const lemmas = new Set([lemma])
  const queue = [lemma]
  let level = originalInfo?.level ?? "o"
  let depth = 0

  while (queue.length && depth < 4) {
    const currentLevelSize = queue.length
    for (let index = 0; index < currentLevelSize; index += 1) {
      const current = queue.shift()!
      for (const candidate of possibleBaseForms(current)) {
        const candidateInfo = dictionary.get(candidate)
        const baseLemma = candidateInfo?.lemma
        if (!baseLemma || lemmas.has(baseLemma)) continue
        lemmas.add(baseLemma)
        queue.push(baseLemma)
        if (LEVEL_RANK[candidateInfo.level] < LEVEL_RANK[level]) level = candidateInfo.level
      }
    }
    depth += 1
  }

  const family = { lemmas: [...lemmas], level }
  dictionaryCache.set(lemma, family)
  return family
}

export function normalizeWord(word: string) {
  return word.toLocaleLowerCase("en-US").replace(/[’']/g, "'")
}

export function normalizeSelectedWord(selection: string) {
  const match = selection
    .trim()
    .match(/^[\s"'“”‘’()[\]{},.!?:;]*([a-z]+(?:[’'][a-z]+)?)[\s"'“”‘’()[\]{},.!?:;]*$/i)
  const selectedWord = match?.[1]
  if (!selectedWord) return undefined
  const word = normalizeWord(selectedWord)
  return /^[a-z]+(?:'[a-z]+)?$/i.test(word) ? word : undefined
}

export function findCandidateWords(
  text: string,
  minimumLength: number,
  statuses: Record<string, VocabularyStatus>,
  dictionary?: Map<string, VocabularyWordInfo>,
  enabledLevels?: ReadonlySet<VocabularyLevel>,
) {
  const occurrences: WordOccurrence[] = []

  for (const segment of ENGLISH_WORD_SEGMENTER.segment(text)) {
    if (!segment.isWordLike) continue

    const word = normalizeWord(segment.segment)
    const wordInfo = dictionary?.get(word)
    const lemma = wordInfo?.lemma ?? word
    const status = statuses[lemma]
    const isExplicitLearningWord = status === "unknown" || status === "fuzzy"
    const family = wordInfo && dictionary ? getVocabularyFamilyInfo(lemma, dictionary) : undefined
    const isKnownThroughFamily =
      status === undefined &&
      family?.lemmas.some((familyLemma) => statuses[familyLemma] === "known")
    const effectiveLevel = family?.level ?? wordInfo?.level
    if (
      !/^[a-z]+(?:'[a-z]+)?$/i.test(word) ||
      status === "known" ||
      isKnownThroughFamily ||
      (!isExplicitLearningWord &&
        (word.length < minimumLength ||
          (!dictionary && BASIC_WORDS.has(word)) ||
          (effectiveLevel && enabledLevels && !enabledLevels.has(effectiveLevel)) ||
          (dictionary && !wordInfo)))
    ) {
      continue
    }

    occurrences.push({
      word: lemma,
      level: effectiveLevel,
      start: segment.index,
      end: segment.index + segment.segment.length,
    })
  }

  return occurrences
}

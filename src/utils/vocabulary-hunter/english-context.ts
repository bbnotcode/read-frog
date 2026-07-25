import { franc } from "franc"

const MIN_LANGUAGE_SAMPLE_LENGTH = 20
const MIN_LANGUAGE_SAMPLE_WORDS = 4

function normalizeLanguageSample(text: string) {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/@[a-z\d_]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function isEnglishVocabularyContext(text: string) {
  const sample = normalizeLanguageSample(text)
  const wordCount = sample.match(/[a-zÀ-ÿ]+(?:['’][a-zÀ-ÿ]+)?/gi)?.length ?? 0
  if (sample.length < MIN_LANGUAGE_SAMPLE_LENGTH || wordCount < MIN_LANGUAGE_SAMPLE_WORDS) {
    return false
  }

  return franc(sample, { minLength: MIN_LANGUAGE_SAMPLE_LENGTH }) === "eng"
}

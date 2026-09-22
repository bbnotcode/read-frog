import type { VocabularyHunterState } from "./storage"

function recordsEqual<T extends string | number>(
  left: Record<string, T>,
  right: Record<string, T>,
) {
  const leftEntries = Object.entries(left)
  if (leftEntries.length !== Object.keys(right).length) return false
  return leftEntries.every(([key, value]) => right[key] === value)
}

function arraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Only settings used while finding candidate words require a full-page rescan.
 * UI-only settings and the storage echo from a locally applied word status do not.
 */
export function shouldRefreshVocabularyHighlights(
  previous: VocabularyHunterState,
  next: VocabularyHunterState,
) {
  if (
    previous.enabled !== next.enabled ||
    previous.minimumLength !== next.minimumLength ||
    !arraysEqual(previous.enabledLevels, next.enabledLevels) ||
    !recordsEqual(previous.statuses, next.statuses)
  ) {
    return true
  }

  return JSON.stringify(previous.vocabularyAssessment) !== JSON.stringify(next.vocabularyAssessment)
}

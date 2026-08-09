import type { Config } from "@/types/config/config"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { getBuiltInDictionaryAction } from "@/utils/custom-actions"

export function resolveVocabularyDictionaryAction(
  selectionToolbar: Config["selectionToolbar"],
): SelectionToolbarCustomAction | undefined {
  const builtInDictionary = getBuiltInDictionaryAction(selectionToolbar)
  if (builtInDictionary.enabled !== false) return builtInDictionary

  return (
    selectionToolbar.customActions.find(
      (item) => item.enabled !== false && item.id === "default-dictionary",
    ) ??
    selectionToolbar.customActions.find(
      (item) => item.enabled !== false && item.icon === "tabler:book-2",
    )
  )
}

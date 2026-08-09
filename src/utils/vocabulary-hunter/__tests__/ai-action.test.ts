import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { resolveVocabularyDictionaryAction } from "../ai-action"

function cloneSelectionToolbar() {
  return structuredClone(DEFAULT_CONFIG.selectionToolbar)
}

describe("resolveVocabularyDictionaryAction", () => {
  it("resolves the enabled built-in dictionary after the upstream config migration", () => {
    const selectionToolbar = cloneSelectionToolbar()
    selectionToolbar.builtInActions.dictionary.enabled = true

    expect(resolveVocabularyDictionaryAction(selectionToolbar)).toMatchObject({
      id: "default-dictionary",
      enabled: true,
      providerId: selectionToolbar.builtInActions.dictionary.providerId,
    })
  })

  it("falls back to a legacy book action when the built-in dictionary is disabled", () => {
    const selectionToolbar = cloneSelectionToolbar()
    selectionToolbar.builtInActions.dictionary.enabled = false
    const legacyAction = {
      ...resolveVocabularyDictionaryAction({
        ...selectionToolbar,
        builtInActions: {
          ...selectionToolbar.builtInActions,
          dictionary: {
            ...selectionToolbar.builtInActions.dictionary,
            enabled: true,
          },
        },
      })!,
      id: "legacy-dictionary",
      enabled: true,
      icon: "tabler:book-2",
    }
    selectionToolbar.customActions = [legacyAction]

    expect(resolveVocabularyDictionaryAction(selectionToolbar)?.id).toBe("legacy-dictionary")
  })

  it("returns undefined when every dictionary action is disabled", () => {
    const selectionToolbar = cloneSelectionToolbar()
    selectionToolbar.builtInActions.dictionary.enabled = false
    selectionToolbar.customActions = []

    expect(resolveVocabularyDictionaryAction(selectionToolbar)).toBeUndefined()
  })
})

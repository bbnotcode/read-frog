export function explanationContextKey(word: string, sentence: string, model = "") {
  return JSON.stringify([word, sentence, model])
}
export function shouldAutomaticallyExplain(preferred: string | undefined, enabled: boolean) {
  return preferred === "ai" && enabled
}
export function explanationProviderKey(
  config: { providersConfig?: unknown; selectionToolbar?: unknown } | null | undefined,
) {
  return JSON.stringify([config?.providersConfig, config?.selectionToolbar])
}

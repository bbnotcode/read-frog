export const VOCABULARY_INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "option",
  "label",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='link']",
  "[role='option']",
  "[role='listbox']",
  "[role='combobox']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='searchbox']",
  "[role='textbox']",
  "[role='tab']",
  "[role='treeitem']",
  "[aria-haspopup]",
  "[aria-autocomplete]",
].join(",")

export function isVocabularyInteractiveTarget(target: Node | null | undefined) {
  const element = target instanceof Element ? target : target?.parentElement
  return Boolean(element?.closest(VOCABULARY_INTERACTIVE_SELECTOR))
}

export function eventComesFromEditableControl(event: Event) {
  return event.composedPath().some((target) => {
    if (!(target instanceof Element)) return false
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return true
    }
    return (
      target.matches(
        "[contenteditable]:not([contenteditable='false']),[role='textbox'],[role='searchbox'],[role='combobox']",
      ) || target.getAttribute("aria-autocomplete") !== null
    )
  })
}

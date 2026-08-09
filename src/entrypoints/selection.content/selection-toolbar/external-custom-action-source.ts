import type { ContextSnapshot, SelectionSnapshot } from "../utils"

export const OPEN_EXTERNAL_CUSTOM_ACTION_EVENT = "read-frog:open-external-selection-custom-action"

export interface ExternalCustomActionRequest {
  actionId: string
  anchor: { x: number; y: number }
  contextSnapshot: ContextSnapshot
  selectionSnapshot: SelectionSnapshot
}

export function openExternalSelectionCustomAction(request: ExternalCustomActionRequest) {
  window.dispatchEvent(
    new CustomEvent<ExternalCustomActionRequest>(OPEN_EXTERNAL_CUSTOM_ACTION_EVENT, {
      detail: request,
    }),
  )
}

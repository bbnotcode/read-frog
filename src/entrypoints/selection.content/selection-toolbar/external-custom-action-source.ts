import type { ContextSnapshot, SelectionSnapshot } from "../utils"

export const OPEN_EXTERNAL_CUSTOM_ACTION_EVENT = "read-frog:open-external-selection-custom-action"
export const EXTERNAL_CUSTOM_ACTION_STATE_EVENT = "read-frog:external-selection-custom-action-state"

export interface ExternalCustomActionRequest {
  actionId: string
  anchor: { x: number; y: number }
  contextSnapshot: ContextSnapshot
  selectionSnapshot: SelectionSnapshot
}

export function notifyExternalSelectionCustomActionState(open: boolean) {
  window.dispatchEvent(
    new CustomEvent<boolean>(EXTERNAL_CUSTOM_ACTION_STATE_EVENT, { detail: open }),
  )
}

export function openExternalSelectionCustomAction(request: ExternalCustomActionRequest) {
  window.dispatchEvent(
    new CustomEvent<ExternalCustomActionRequest>(OPEN_EXTERNAL_CUSTOM_ACTION_EVENT, {
      detail: request,
    }),
  )
}

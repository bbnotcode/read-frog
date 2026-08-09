import type { ContextSnapshot, SelectionSnapshot } from "../utils"

export const OPEN_EXTERNAL_CUSTOM_ACTION_EVENT = "read-frog:open-external-selection-custom-action"
export const EXTERNAL_CUSTOM_ACTION_RESULT_EVENT =
  "read-frog:external-selection-custom-action-result"

export interface ExternalCustomActionRequest {
  requestId: number
  actionId: string
  anchor: { x: number; y: number }
  contextSnapshot: ContextSnapshot
  selectionSnapshot: SelectionSnapshot
}

export interface ExternalCustomActionResult {
  requestId: number
  value: Record<string, unknown> | null
  error?: string
  complete?: boolean
}

export function publishExternalSelectionCustomActionResult(result: ExternalCustomActionResult) {
  window.dispatchEvent(
    new CustomEvent<ExternalCustomActionResult>(EXTERNAL_CUSTOM_ACTION_RESULT_EVENT, {
      detail: result,
    }),
  )
}

export function openExternalSelectionCustomAction(request: ExternalCustomActionRequest) {
  window.dispatchEvent(
    new CustomEvent<ExternalCustomActionRequest>(OPEN_EXTERNAL_CUSTOM_ACTION_EVENT, {
      detail: request,
    }),
  )
}

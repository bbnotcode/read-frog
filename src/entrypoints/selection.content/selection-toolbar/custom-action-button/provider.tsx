import type { ReactNode } from "react"
import type { SelectionSession } from "../atoms"
import type { SelectionPopoverActions } from "@/components/ui/selection-popover"
import { useAtomValue, useSetAtom } from "jotai"
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toastManager } from "@/components/ui/base-ui/toast"
import { SelectionPopover } from "@/components/ui/selection-popover"
import { ANALYTICS_FEATURE, ANALYTICS_SURFACE } from "@/types/analytics"
import { createFeatureUsageContext, trackFeatureUsed } from "@/utils/analytics"
import { classifyResolvedProvider, UNKNOWN_FEATURE_PROVIDER } from "@/utils/analytics-provider"
import { configFieldsAtomMap, writeConfigAtom } from "@/utils/atoms/config"
import { findSelectionToolbarAction, patchSelectionToolbarAction } from "@/utils/custom-actions"
import { onMessage } from "@/utils/message"
import {
  getSelectableProvidersForCapability,
  resolveProviderRefForCapability,
} from "@/utils/providers/provider-registry"
import { shadowWrapper } from "../.."
import { SelectionToolbarErrorAlert } from "../../components/selection-toolbar-error-alert"
import { SelectionToolbarFooterContent } from "../../components/selection-toolbar-footer-content"
import { SelectionToolbarTitleContent } from "../../components/selection-toolbar-title-content"
import { normalizeSelectedText } from "../../utils"
import {
  contextAtom,
  isSelectionToolbarVisibleAtom,
  selectionAtom,
  selectionSessionAtom,
} from "../atoms"
import {
  type ExternalCustomActionRequest,
  OPEN_EXTERNAL_CUSTOM_ACTION_EVENT,
  publishExternalSelectionCustomActionResult,
} from "../external-custom-action-source"
import { createSelectionToolbarPrecheckError } from "../inline-error"
import { useSelectionOpenRequestResolver } from "../use-selection-open-request"
import { CustomActionContent } from "./custom-action-content"
import { CustomActionToolButton } from "./custom-action-tool-button"
import { SaveToNotebaseButton } from "./save-to-notebase-button"
import { isSaveToNotebaseDialogOpenAtom } from "./save-to-notebase-dialog-atom"
import { SaveToNotebaseDialogHost } from "./save-to-notebase-dialog-host"
import {
  buildCustomActionExecutionPlan,
  useCustomActionExecution,
  useCustomActionWebPageContext,
} from "./use-custom-action-execution"

interface SelectionCustomActionPendingOpenRequest {
  actionId: string
  anchor?: { x: number; y: number }
  session: SelectionSession | null
  surface: typeof ANALYTICS_SURFACE.SELECTION_TOOLBAR | typeof ANALYTICS_SURFACE.CONTEXT_MENU
}

interface SelectionCustomActionContextValue {
  openToolbarCustomAction: (actionId: string, triggerElement: HTMLElement | null) => void
}

const SelectionCustomActionContext = createContext<SelectionCustomActionContextValue | null>(null)

function useSelectionCustomActionContext() {
  const context = use(SelectionCustomActionContext)
  if (!context) {
    throw new Error(
      "Selection custom action triggers must be used within SelectionCustomActionProvider.",
    )
  }

  return context
}

export function useSelectionCustomActionPopover() {
  return useSelectionCustomActionContext()
}

function ExternalCustomActionExecutor({
  request,
  onFinished,
}: {
  request: ExternalCustomActionRequest
  onFinished: () => void
}) {
  const selectionToolbarConfig = useAtomValue(configFieldsAtomMap.selectionToolbar)
  const providersConfig = useAtomValue(configFieldsAtomMap.providersConfig)
  const language = useAtomValue(configFieldsAtomMap.language)
  const bodyRef = useRef<HTMLDivElement>(null)
  const completedRef = useRef(false)
  const action = useMemo(
    () => findSelectionToolbarAction(selectionToolbarConfig, request.actionId),
    [request.actionId, selectionToolbarConfig],
  )
  const customActionRequest = useMemo(
    () => ({
      language,
      action: action?.enabled === false ? null : (action ?? null),
      provider: action
        ? resolveProviderRefForCapability(
            "selectionToolbar.customAction",
            providersConfig,
            action.providerId,
          )
        : null,
    }),
    [action, language, providersConfig],
  )
  const webPageContext = useCustomActionWebPageContext(true, request.requestId)
  const executionPlan = useMemo(
    () =>
      buildCustomActionExecutionPlan(
        customActionRequest,
        normalizeSelectedText(request.selectionSnapshot.text),
        request.contextSnapshot.text,
        webPageContext,
      ),
    [customActionRequest, request, webPageContext],
  )
  const { error, isRunning, result } = useCustomActionExecution({
    analyticsSurface: ANALYTICS_SURFACE.SELECTION_TOOLBAR,
    bodyRef,
    executionContext: executionPlan.executionContext,
    open: true,
    popoverSessionKey: request.requestId,
    rerunNonce: 0,
  })

  useEffect(() => {
    if (!result || completedRef.current) return
    publishExternalSelectionCustomActionResult({
      requestId: request.requestId,
      value: result,
    })
  }, [request.requestId, result])

  useEffect(() => {
    const displayedError = error ?? executionPlan.error
    if (!displayedError || completedRef.current) return
    completedRef.current = true
    publishExternalSelectionCustomActionResult({
      requestId: request.requestId,
      value: null,
      error: displayedError.description,
      complete: true,
    })
    onFinished()
  }, [error, executionPlan.error, onFinished, request.requestId])

  useEffect(() => {
    if (!executionPlan.executionContext || isRunning || !result || completedRef.current) return
    completedRef.current = true
    publishExternalSelectionCustomActionResult({
      requestId: request.requestId,
      value: result,
      complete: true,
    })
    onFinished()
  }, [executionPlan.executionContext, isRunning, onFinished, request.requestId, result])

  return null
}

export function SelectionCustomActionProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const [popoverSessionKey, setPopoverSessionKey] = useState(0)
  const [rerunNonce, setRerunNonce] = useState(0)
  const [activeSession, setActiveSession] = useState<SelectionSession | null>(null)
  const [activeActionId, setActiveActionId] = useState<string | null>(null)
  const [externalRequest, setExternalRequest] = useState<ExternalCustomActionRequest | null>(null)
  const [sourceSurface, setSourceSurface] = useState<
    typeof ANALYTICS_SURFACE.SELECTION_TOOLBAR | typeof ANALYTICS_SURFACE.CONTEXT_MENU
  >(ANALYTICS_SURFACE.SELECTION_TOOLBAR)
  const selectionSession = useAtomValue(selectionSessionAtom)
  const selection = useAtomValue(selectionAtom)
  const context = useAtomValue(contextAtom)
  const selectionToolbarConfig = useAtomValue(configFieldsAtomMap.selectionToolbar)
  const providersConfig = useAtomValue(configFieldsAtomMap.providersConfig)
  const language = useAtomValue(configFieldsAtomMap.language)
  const setIsSelectionToolbarVisible = useSetAtom(isSelectionToolbarVisibleAtom)
  const setConfig = useSetAtom(writeConfigAtom)
  const isSaveToNotebaseDialogOpen = useAtomValue(isSaveToNotebaseDialogOpenAtom)
  const bodyRef = useRef<HTMLDivElement>(null)
  const pendingOpenRequestRef = useRef<SelectionCustomActionPendingOpenRequest | null>(null)
  const popoverActionsRef = useRef<SelectionPopoverActions | null>(null)
  const nextEphemeralSessionIdRef = useRef(0)
  const trackedPrecheckErrorKeyRef = useRef<string | null>(null)
  const { resolveContextMenuOpenRequest } = useSelectionOpenRequestResolver(selectionSession)
  const selectionText = activeSession?.selectionSnapshot.text ?? null
  const cleanSelection = useMemo(() => normalizeSelectedText(selectionText), [selectionText])
  const paragraphsText = useMemo(() => {
    if (!cleanSelection) {
      return ""
    }

    return activeSession?.contextSnapshot.text || cleanSelection
  }, [activeSession?.contextSnapshot.text, cleanSelection])
  const webPageContext = useCustomActionWebPageContext(isOpen, popoverSessionKey)
  const titleText = (webPageContext?.webTitle ?? document.title) || null
  const activeAction = useMemo(() => {
    if (!activeActionId) {
      return null
    }
    const action = findSelectionToolbarAction(selectionToolbarConfig, activeActionId)
    return action && action.enabled !== false ? action : null
  }, [activeActionId, selectionToolbarConfig])
  const customActionRequest = useMemo(
    () => ({
      language,
      action: activeAction,
      provider: activeAction
        ? resolveProviderRefForCapability(
            "selectionToolbar.customAction",
            providersConfig,
            activeAction.providerId,
          )
        : null,
    }),
    [activeAction, language, providersConfig],
  )
  const customActionProviders = useMemo(
    () => getSelectableProvidersForCapability("selectionToolbar.customAction", providersConfig),
    [providersConfig],
  )
  const executionPlan = useMemo(
    () =>
      buildCustomActionExecutionPlan(
        customActionRequest,
        cleanSelection,
        paragraphsText,
        webPageContext,
      ),
    [cleanSelection, customActionRequest, paragraphsText, webPageContext],
  )
  const { error, isRunning, resetSessionState, result, thinking } = useCustomActionExecution({
    bodyRef,
    analyticsSurface: sourceSurface,
    executionContext: executionPlan.executionContext,
    open: isOpen,
    popoverSessionKey,
    rerunNonce,
  })
  const displayedResult = executionPlan.executionContext ? result : null
  const displayedError = error ?? executionPlan.error
  const displayedIsRunning =
    (isOpen && webPageContext === undefined) || (executionPlan.executionContext ? isRunning : false)
  const displayedThinking = executionPlan.executionContext ? thinking : null

  const resetPopoverSession = useCallback((options?: { clearAnchor?: boolean }) => {
    setActiveSession(null)
    setActiveActionId(null)
    if (options?.clearAnchor) {
      setAnchor(null)
    }
  }, [])

  // Anchor application is owned by SelectionPopover.Root (via requestOpen) so
  // a pinned popover reused in place never moves.
  const commitOpenRequest = useCallback((request: SelectionCustomActionPendingOpenRequest) => {
    pendingOpenRequestRef.current = request
  }, [])

  const applyPendingSession = useCallback(() => {
    const pendingRequest = pendingOpenRequestRef.current

    setActiveSession(pendingRequest?.session ?? selectionSession)
    setActiveActionId(pendingRequest?.actionId ?? null)
    setSourceSurface(pendingRequest?.surface ?? ANALYTICS_SURFACE.SELECTION_TOOLBAR)
    setIsSelectionToolbarVisible(false)
    pendingOpenRequestRef.current = null
  }, [selectionSession, setIsSelectionToolbarVisible])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      resetSessionState()

      if (nextOpen) {
        setPopoverSessionKey((prev) => prev + 1)
        applyPendingSession()
      } else {
        resetPopoverSession({
          clearAnchor: pendingOpenRequestRef.current === null,
        })
      }

      setIsOpen(nextOpen)
    },
    [applyPendingSession, resetPopoverSession, resetSessionState],
  )

  // Pinned popovers are reused in place for a new selection or action: the
  // window keeps its position, size, and pin state while the action reruns.
  const handleReuseRequest = useCallback(() => {
    resetSessionState()
    applyPendingSession()
    // Forces a rerun even when the retriggered request resolves to an
    // identical execution key.
    setRerunNonce((prev) => prev + 1)
  }, [applyPendingSession, resetSessionState])

  const openActionRequest = useCallback(
    (request: SelectionCustomActionPendingOpenRequest) => {
      commitOpenRequest(request)
      popoverActionsRef.current?.requestOpen(request.anchor ?? null)
    },
    [commitOpenRequest],
  )

  const openToolbarCustomAction = useCallback(
    (actionId: string, triggerElement: HTMLElement | null) => {
      if (!triggerElement) {
        return
      }

      const rect = triggerElement.getBoundingClientRect()
      openActionRequest({
        actionId,
        anchor: { x: rect.left, y: rect.top },
        surface: ANALYTICS_SURFACE.SELECTION_TOOLBAR,
        session:
          selectionSession ??
          (selection
            ? {
                id: --nextEphemeralSessionIdRef.current,
                createdAt: Date.now(),
                selectionSnapshot: selection,
                contextSnapshot: context ?? {
                  text: "",
                  paragraphs: [],
                },
              }
            : null),
      })
    },
    [context, openActionRequest, selection, selectionSession],
  )

  const openContextMenuCustomAction = useCallback(
    (actionId: string) => {
      const action = findSelectionToolbarAction(selectionToolbarConfig, actionId)
      if (!action || action.enabled === false) {
        const nextError = createSelectionToolbarPrecheckError("customAction", "actionUnavailable")
        void trackFeatureUsed({
          ...createFeatureUsageContext(
            ANALYTICS_FEATURE.CUSTOM_AI_ACTION,
            ANALYTICS_SURFACE.CONTEXT_MENU,
            Date.now(),
            {
              action_id: actionId,
            },
          ),
          ...UNKNOWN_FEATURE_PROVIDER,
          outcome: "failure",
        })
        toastManager.add({ type: "error", title: nextError.description })
        return
      }

      const request = resolveContextMenuOpenRequest()
      if (!request) {
        const nextError = createSelectionToolbarPrecheckError("customAction", "missingSelection")
        void trackFeatureUsed({
          ...createFeatureUsageContext(
            ANALYTICS_FEATURE.CUSTOM_AI_ACTION,
            ANALYTICS_SURFACE.CONTEXT_MENU,
            Date.now(),
            {
              action_id: action.id,
              action_name: action.name,
            },
          ),
          ...classifyResolvedProvider(
            resolveProviderRefForCapability(
              "selectionToolbar.customAction",
              providersConfig,
              action.providerId,
            ),
          ),
          outcome: "failure",
        })
        toastManager.add({ type: "error", title: nextError.description })
        return
      }

      openActionRequest({
        actionId: action.id,
        anchor: request.anchor,
        session: request.session,
        surface: ANALYTICS_SURFACE.CONTEXT_MENU,
      })
    },
    [openActionRequest, providersConfig, resolveContextMenuOpenRequest, selectionToolbarConfig],
  )

  const handleProviderChange = useCallback(
    (providerId: string) => {
      if (!activeActionId) {
        return
      }

      void setConfig({
        selectionToolbar: patchSelectionToolbarAction(selectionToolbarConfig, activeActionId, {
          providerId,
        }),
      })
    },
    [activeActionId, selectionToolbarConfig, setConfig],
  )

  const handleRegenerate = useCallback(() => {
    setRerunNonce((prev) => prev + 1)
  }, [])

  useEffect(() => {
    return onMessage("openSelectionCustomActionFromContextMenu", (message) => {
      openContextMenuCustomAction(message.data.actionId)
    })
  }, [openContextMenuCustomAction])

  useEffect(() => {
    const handleExternalCustomAction = (event: Event) => {
      const request = (event as CustomEvent<ExternalCustomActionRequest>).detail
      if (!request?.actionId || !request.selectionSnapshot.text) return
      setExternalRequest(request)
    }

    window.addEventListener(OPEN_EXTERNAL_CUSTOM_ACTION_EVENT, handleExternalCustomAction)
    return () => {
      window.removeEventListener(OPEN_EXTERNAL_CUSTOM_ACTION_EVENT, handleExternalCustomAction)
    }
  }, [])

  useEffect(() => {
    if (!isOpen || !executionPlan.error || executionPlan.executionContext) {
      return
    }

    const analyticsContext = createFeatureUsageContext(
      ANALYTICS_FEATURE.CUSTOM_AI_ACTION,
      sourceSurface,
      Date.now(),
      {
        action_id: activeActionId ?? undefined,
        action_name: activeAction?.name,
      },
    )
    const nextErrorKey = JSON.stringify({
      actionId: analyticsContext.action_id ?? null,
      description: executionPlan.error.description,
      popoverSessionKey,
      surface: sourceSurface,
    })

    if (trackedPrecheckErrorKeyRef.current === nextErrorKey) {
      return
    }
    trackedPrecheckErrorKeyRef.current = nextErrorKey

    void trackFeatureUsed({
      ...analyticsContext,
      ...classifyResolvedProvider(customActionRequest.provider),
      outcome: "failure",
    })
  }, [
    activeAction?.name,
    activeActionId,
    executionPlan.error,
    executionPlan.executionContext,
    isOpen,
    popoverSessionKey,
    customActionRequest.provider,
    sourceSurface,
  ])

  const contextValue = useMemo<SelectionCustomActionContextValue>(
    () => ({
      openToolbarCustomAction,
    }),
    [openToolbarCustomAction],
  )

  return (
    <SelectionCustomActionContext value={contextValue}>
      {children}
      <SelectionPopover.Root
        open={isOpen}
        onOpenChange={handleOpenChange}
        anchor={anchor}
        onAnchorChange={setAnchor}
        actionsRef={popoverActionsRef}
        onReuseRequest={handleReuseRequest}
        disablePointerDismissal={isSaveToNotebaseDialogOpen}
      >
        <SelectionPopover.Content
          key={popoverSessionKey}
          container={shadowWrapper ?? document.body}
        >
          <SelectionPopover.Header className="border-b">
            <SelectionToolbarTitleContent
              title={activeAction?.name ?? "Custom Action"}
              icon={activeAction?.icon ?? "tabler:sparkles"}
            />
            <div className="flex items-center gap-1">
              <SelectionPopover.Pin />
              <SelectionPopover.Close />
            </div>
          </SelectionPopover.Header>

          <SelectionPopover.Body
            key={`${popoverSessionKey}:${activeSession?.id ?? 0}`}
            ref={bodyRef}
          >
            <CustomActionContent
              isRunning={displayedIsRunning}
              outputSchema={activeAction?.outputSchema ?? []}
              selectionContent={selectionText}
              value={displayedResult}
              thinking={displayedThinking}
            />
            <SelectionToolbarErrorAlert error={displayedError} />
          </SelectionPopover.Body>
          <SelectionToolbarFooterContent
            paragraphsText={paragraphsText}
            providers={customActionProviders}
            titleText={titleText}
            value={customActionRequest.provider?.id ?? ""}
            onProviderChange={handleProviderChange}
            onRegenerate={handleRegenerate}
          >
            {activeAction && (
              <>
                <SaveToNotebaseButton
                  action={activeAction}
                  isRunning={displayedIsRunning}
                  result={displayedResult}
                />
                <CustomActionToolButton action={activeAction} />
              </>
            )}
          </SelectionToolbarFooterContent>
        </SelectionPopover.Content>
      </SelectionPopover.Root>
      {externalRequest && (
        <ExternalCustomActionExecutor
          key={externalRequest.requestId}
          request={externalRequest}
          onFinished={() => setExternalRequest(null)}
        />
      )}
      <SaveToNotebaseDialogHost />
    </SelectionCustomActionContext>
  )
}

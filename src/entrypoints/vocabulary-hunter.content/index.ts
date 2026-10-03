import type { ContentScriptContext } from "#imports"
import type { Config } from "@/types/config/config"
import { browser, storage, defineContentScript } from "#imports"
import { getLocalConfig } from "@/utils/config/storage"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import { sendMessage } from "@/utils/message"
import { isChatGPTLocalProvider } from "@/utils/providers/chatgpt-local"
import { resolveModelId } from "@/utils/providers/model-id"
import { scheduleIdleTask } from "@/utils/schedule-idle-task"
import { resolveVocabularyDictionaryAction } from "@/utils/vocabulary-hunter/ai-action"
import { createPredictedKnownIndices } from "@/utils/vocabulary-hunter/assessment"
import {
  findCandidateWords,
  normalizeSelectedWord,
  resolveVocabularyWord,
  type VocabularyLevel,
  type VocabularyStatus,
} from "@/utils/vocabulary-hunter/candidates"
import { streamVocabularyExplanation } from "@/utils/vocabulary-hunter/chatgpt-stream"
import {
  getVocabularyLevel,
  loadVocabularyDictionary,
} from "@/utils/vocabulary-hunter/dictionary-data"
import { lookupEmbeddedDictionary } from "@/utils/vocabulary-hunter/dictionary-lookup"
import { isEnglishVocabularyContext } from "@/utils/vocabulary-hunter/english-context"
import {
  explanationContextKey,
  explanationProviderKey,
  shouldAutomaticallyExplain,
} from "@/utils/vocabulary-hunter/explanation-context"
import { shouldRefreshVocabularyHighlights } from "@/utils/vocabulary-hunter/highlight-refresh"
import { pointIntersectsAnyRect } from "@/utils/vocabulary-hunter/hover-stability"
import {
  eventComesFromEditableControl,
  isVocabularyInteractiveTarget,
  VOCABULARY_INTERACTIVE_SELECTOR,
} from "@/utils/vocabulary-hunter/interactive-target"
import { renderExplanationMarkdown } from "@/utils/vocabulary-hunter/markdown"
import {
  getVocabularyHunterState,
  type VocabularyHunterState,
  type VocabularyDictionary,
  watchVocabularyHunterState,
} from "@/utils/vocabulary-hunter/storage"
import { mergeKnownWordsFromSync, syncKnownWord } from "@/utils/vocabulary-hunter/sync"
import {
  type ExternalCustomActionResult,
  EXTERNAL_CUSTOM_ACTION_RESULT_EVENT,
  openExternalSelectionCustomAction,
} from "../selection.content/selection-toolbar/external-custom-action-source"
import vocabularyCardStyles from "./card.css?raw"

const UNKNOWN_HIGHLIGHT = "read-frog-vocabulary-unknown"
const FUZZY_HIGHLIGHT = "read-frog-vocabulary-fuzzy"
const MAX_RANGES = 1200
const MAX_SYNCHRONOUS_MUTATION_NODES = 40
const INVALID_ANCESTOR_SELECTOR = `canvas,code,kbd,noscript,pre,script,style,svg,${VOCABULARY_INTERACTIVE_SELECTOR}`
const INVALID_TAGS = new Set([
  "BUTTON",
  "CANVAS",
  "CODE",
  "INPUT",
  "KBD",
  "NOSCRIPT",
  "OPTION",
  "PRE",
  "SCRIPT",
  "SELECT",
  "STYLE",
  "SVG",
  "TEXTAREA",
])

interface TrackedRange {
  range: Range
  word: string
  level?: VocabularyLevel
  anchor?: RangeAnchor
}

interface RangeAnchor {
  rect: DOMRect
  windowScrollX: number
  windowScrollY: number
  scrollContainers: Array<{
    element: Element
    rect: DOMRect
    scrollLeft: number
    scrollTop: number
  }>
}

function isTextNodeEligible(node: Text, uiHost: HTMLElement) {
  const parent = node.parentElement
  if (!parent || !node.data.trim()) return false
  if (uiHost.contains(parent) || parent.closest("[data-read-frog-vocabulary-ui]")) return false
  if (parent.isContentEditable || parent.closest("[contenteditable='true']")) return false
  if (INVALID_TAGS.has(parent.tagName) || parent.closest(INVALID_ANCESTOR_SELECTOR)) return false
  return parent.getAttribute("aria-hidden") !== "true"
}

function isUsernameMention(node: Text, wordStart: number) {
  if (node.data.slice(0, wordStart).trimEnd().endsWith("@")) return true

  // X and similar sites may render "@" and the handle in separate nested spans.
  // In that case, use the complete link label instead of only this text node.
  const link = node.parentElement?.closest("a[href]")
  return /^@[a-z\d_]{1,30}$/i.test(link?.textContent?.trim() ?? "")
}

function findLanguageContext(node: Text) {
  const parent = node.parentElement
  if (!parent) return null

  const message = parent.closest(
    "[data-list-item-id^='chat-messages'],[data-testid='tweetText'],article,[role='article']",
  )
  if (message?.textContent?.trim()) return message

  let context: Element | null = parent
  let fallback: Element | null = null
  for (let depth = 0; context && depth < 6; depth += 1) {
    const textLength = context.textContent?.trim().length ?? 0
    if (textLength >= 20 && textLength <= 1200) fallback = context
    if (textLength >= 80 || textLength > 1200) break
    context = context.parentElement
  }
  return fallback
}

function safeColor(value: string, fallback: string) {
  return /^#[\da-f]{6}$/i.test(value) ? value : fallback
}

function highlightCss(state: VocabularyHunterState) {
  const unknownColor = safeColor(state.unknownHighlightColor, "#fb7185")
  const fuzzyColor = safeColor(state.fuzzyHighlightColor, "#fbbf24")
  return `
    ::highlight(${UNKNOWN_HIGHLIGHT}) {
      background-color: color-mix(in srgb, ${unknownColor} 38%, transparent);
      text-decoration-line: underline;
      text-decoration-style: dotted;
      text-decoration-color: ${unknownColor};
      text-decoration-thickness: 2px;
    }
    ::highlight(${FUZZY_HIGHLIGHT}) {
      background-color: color-mix(in srgb, ${fuzzyColor} 34%, transparent);
      text-decoration-line: underline;
      text-decoration-style: solid;
      text-decoration-color: ${fuzzyColor};
      text-decoration-thickness: 2px;
    }
  `
}

function createHighlightStyles(state: VocabularyHunterState) {
  if (typeof CSSStyleSheet !== "undefined" && "adoptedStyleSheets" in document) {
    try {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(highlightCss(state))
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
      return {
        update: (nextState: VocabularyHunterState) => sheet.replaceSync(highlightCss(nextState)),
        remove: () => {
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
            (candidate) => candidate !== sheet,
          )
        },
      }
    } catch {
      // Fall back to a style element in browsers without constructable stylesheet support.
    }
  }

  const style = document.createElement("style")
  style.dataset.readFrogVocabularyUi = ""
  style.textContent = highlightCss(state)
  document.documentElement.append(style)
  return {
    update: (nextState: VocabularyHunterState) => {
      style.textContent = highlightCss(nextState)
    },
    remove: () => style.remove(),
  }
}

function createHoverCard() {
  const host = document.createElement("read-frog-vocabulary-hunter")
  host.dataset.readFrogVocabularyUi = ""
  host.style.cssText =
    "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;font-family:Inter,system-ui,sans-serif"
  const shadow = host.attachShadow({ mode: "open" })
  shadow.innerHTML = `
    <style>${vocabularyCardStyles}</style>
    <section id="card" role="dialog" aria-label="ReadFrog 生词卡">
      <div class="head">
        <div><div class="wordline"><div class="word" id="word"></div><span class="level" id="level"></span></div><div class="status" id="status"></div></div>
        <button class="close" data-action="close" title="关闭" aria-label="关闭生词卡">×</button>
      </div>
      <div class="sentence" id="sentence"></div>
      <div class="row judgement">
        <button data-action="known" title="快捷键 A">✓ 已掌握 <kbd class="shortcut">A</kbd></button>
        <button data-action="fuzzy" title="快捷键 S">◐ 待巩固 <kbd class="shortcut">S</kbd></button>
        <button data-action="unknown" title="快捷键 D">○ 未掌握 <kbd class="shortcut">D</kbd></button>
      </div>
      <div class="row tabs" id="tabs">
        <button draggable="true" data-dict="haici">海词</button>
        <button draggable="true" data-dict="google">Google</button>
        <button draggable="true" data-dict="ai">AI 解释</button>
      </div>
      <div class="result" id="result"></div>
      <div class="row"><a id="source-link" target="_blank" rel="noreferrer" hidden>打开单词所在的页面链接</a></div>
    </section>
    <div id="toast" role="status" aria-live="polite"></div>
  `
  document.documentElement.append(host)
  return { host, shadow }
}

function sentenceForRange(range: Range) {
  const text = range.startContainer.textContent ?? range.toString()
  const sentenceStart = Math.max(0, text.lastIndexOf(".", range.startOffset - 1) + 1)
  const nextPeriod = text.indexOf(".", range.endOffset)
  const end = nextPeriod === -1 ? Math.min(text.length, sentenceStart + 300) : nextPeriod + 1
  return text.slice(sentenceStart, end).replace(/\s+/g, " ").trim()
}

function findLinkForRange(range: Range) {
  const parent =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement
  return parent?.closest<HTMLAnchorElement>("a[href]") ?? null
}

function captureRangeAnchor(hit: TrackedRange, rect: DOMRect) {
  const scrollContainers: RangeAnchor["scrollContainers"] = []
  let ancestor = hit.range.startContainer.parentElement
  while (ancestor) {
    if (
      ancestor.scrollHeight > ancestor.clientHeight ||
      ancestor.scrollWidth > ancestor.clientWidth
    ) {
      scrollContainers.push({
        element: ancestor,
        rect: DOMRect.fromRect(ancestor.getBoundingClientRect()),
        scrollLeft: ancestor.scrollLeft,
        scrollTop: ancestor.scrollTop,
      })
    }
    ancestor = ancestor.parentElement
  }
  hit.anchor = {
    rect: DOMRect.fromRect(rect),
    windowScrollX: window.scrollX,
    windowScrollY: window.scrollY,
    scrollContainers,
  }
}

function getTrackedRangeRect(hit: TrackedRange) {
  const liveRect = hit.range.getBoundingClientRect()
  if (hit.range.startContainer.isConnected && (liveRect.width > 0 || liveRect.height > 0)) {
    captureRangeAnchor(hit, liveRect)
    return liveRect
  }

  if (!hit.anchor) return null
  const scrollDelta = hit.anchor.scrollContainers.reduce(
    (total, item) => {
      const element = item.element.isConnected
        ? item.element
        : document
            .elementsFromPoint(
              item.rect.left + item.rect.width / 2,
              item.rect.top + item.rect.height / 2,
            )
            .find(
              (candidate) =>
                (candidate.scrollHeight > candidate.clientHeight ||
                  candidate.scrollWidth > candidate.clientWidth) &&
                Math.abs(candidate.getBoundingClientRect().left - item.rect.left) < 2 &&
                Math.abs(candidate.getBoundingClientRect().top - item.rect.top) < 2,
            )
      if (!element) return total
      return {
        x: total.x + element.scrollLeft - item.scrollLeft,
        y: total.y + element.scrollTop - item.scrollTop,
      }
    },
    {
      x: window.scrollX - hit.anchor.windowScrollX,
      y: window.scrollY - hit.anchor.windowScrollY,
    },
  )
  return DOMRect.fromRect({
    x: hit.anchor.rect.x - scrollDelta.x,
    y: hit.anchor.rect.y - scrollDelta.y,
    width: hit.anchor.rect.width,
    height: hit.anchor.rect.height,
  })
}

function positionCard(card: HTMLElement, hit: TrackedRange) {
  const rect = getTrackedRangeRect(hit)
  if (!rect) return
  const viewportPadding = 12
  const triggerGap = 12
  const availableWidth = Math.max(0, window.innerWidth - viewportPadding * 2)
  const cardWidth = Math.min(430, availableWidth)
  const preferredLeft =
    rect.left + cardWidth <= window.innerWidth - viewportPadding
      ? rect.left
      : rect.right - cardWidth
  const left = Math.max(
    viewportPadding,
    Math.min(preferredLeft, window.innerWidth - cardWidth - viewportPadding),
  )
  const spaceBelow = Math.max(0, window.innerHeight - viewportPadding - rect.bottom - triggerGap)
  const spaceAbove = Math.max(0, rect.top - viewportPadding - triggerGap)
  const naturalHeight = card.scrollHeight || 320
  const placeBelow = naturalHeight <= spaceBelow || spaceBelow >= spaceAbove
  const availableHeight = placeBelow ? spaceBelow : spaceAbove
  const cardHeight = Math.min(naturalHeight, availableHeight)
  const top = placeBelow
    ? rect.bottom + triggerGap
    : Math.max(viewportPadding, rect.top - triggerGap - cardHeight)

  card.style.width = `${cardWidth}px`
  card.style.maxHeight = `${availableHeight}px`
  card.style.left = `${left}px`
  card.style.top = `${top}px`
}

function isPointOverTrackedRange(hit: TrackedRange, clientX: number, clientY: number) {
  if (
    hit.range.startContainer.isConnected &&
    pointIntersectsAnyRect(clientX, clientY, hit.range.getClientRects())
  ) {
    return true
  }
  const anchoredRect = getTrackedRangeRect(hit)
  return anchoredRect ? pointIntersectsAnyRect(clientX, clientY, [anchoredRect]) : false
}

function statusText(word: string, state: VocabularyHunterState) {
  const status = state.statuses[word]
  if (status === "known") return "已确认掌握，不再标注"
  if (status === "fuzzy") return "记忆不稳定，建议结合语境巩固"
  return "尚未掌握"
}

async function openReadFrogDictionaryAction(hit: TrackedRange, requestId: number) {
  const config = await getLocalConfig()
  if (!config) {
    throw new Error("ReadFrog 配置尚未准备好，请稍后重试。")
  }

  const action = resolveVocabularyDictionaryAction(config.selectionToolbar)

  if (!action) {
    throw new Error("请先在 ReadFrog 的“自定义 AI 操作”中启用词典操作。")
  }

  const sentence = sentenceForRange(hit.range)
  const rect = getTrackedRangeRect(hit)
  if (!rect) throw new Error("单词位置已经失效，请重新选择单词。")
  openExternalSelectionCustomAction({
    requestId,
    actionId: action.id,
    anchor: { x: rect.right, y: rect.bottom },
    selectionSnapshot: {
      text: hit.word,
      ranges: [
        {
          startContainer: hit.range.startContainer,
          startOffset: hit.range.startOffset,
          endContainer: hit.range.endContainer,
          endOffset: hit.range.endOffset,
        },
      ],
    },
    contextSnapshot: {
      text: sentence,
      paragraphs: [sentence],
    },
  })
}

async function start(ctx: ContentScriptContext) {
  if (!("highlights" in CSS) || typeof Highlight === "undefined") return

  let state = await getVocabularyHunterState()
  let automaticAI = (await browser.storage.local.get("wordHunterAutoAI")).wordHunterAutoAI === true
  let selectedContext = ""
  let vocabularyDictionary: Awaited<ReturnType<typeof loadVocabularyDictionary>> | undefined
  let predictedKnownIndices: ReadonlySet<number> = new Set()
  const ensureVocabularyDictionary = async () => {
    if (vocabularyDictionary) return vocabularyDictionary
    vocabularyDictionary = await loadVocabularyDictionary().catch(() => undefined)
    if (!vocabularyDictionary) return undefined

    const mergedState = await mergeKnownWordsFromSync(state, vocabularyDictionary).catch(
      () => state,
    )
    if (mergedState !== state) {
      state = await sendMessage("mergeVocabularyWordData", {
        statuses: mergedState.statuses,
        updatedAt: mergedState.statusUpdatedAt,
        deletedAt: mergedState.deletedAt,
      })
    }
    predictedKnownIndices = createPredictedKnownIndices(
      vocabularyDictionary,
      state.vocabularyAssessment,
      state.statuses,
    )
    return vocabularyDictionary
  }

  let trackedRanges: TrackedRange[] = []
  const rangesByTextNode = new Map<Text, TrackedRange[]>()
  let selected: TrackedRange | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let refreshGeneration = 0
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let hoverTimer: ReturnType<typeof setTimeout> | undefined
  let gistSyncTimer: ReturnType<typeof setTimeout> | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  let pendingHover: TrackedRange | null = null
  let latestPointerPosition: { clientX: number; clientY: number } | undefined
  let selectedFromTextSelection = false
  let cardPinned = false
  let preferredDictionary: VocabularyDictionary | undefined
  let activeExternalRequestId: number | undefined
  let requestSequence = 0
  let aiController: AbortController | undefined
  let aiContext = ""
  const invalidateExplanation = () => {
    aiController?.abort()
    aiController = undefined
    aiContext = ""
    return ++requestSequence
  }
  const unknownHighlight = new Highlight()
  const fuzzyHighlight = new Highlight()
  CSS.highlights.set(UNKNOWN_HIGHLIGHT, unknownHighlight)
  CSS.highlights.set(FUZZY_HIGHLIGHT, fuzzyHighlight)

  const highlightStyles = createHighlightStyles(state)
  const { host, shadow } = createHoverCard()
  const card = shadow.querySelector<HTMLElement>("#card")!
  const wordLabel = shadow.querySelector<HTMLElement>("#word")!
  const levelLabel = shadow.querySelector<HTMLElement>("#level")!
  const statusLabel = shadow.querySelector<HTMLElement>("#status")!
  const sentenceLabel = shadow.querySelector<HTMLElement>("#sentence")!
  const result = shadow.querySelector<HTMLElement>("#result")!
  const sourceLink = shadow.querySelector<HTMLAnchorElement>("#source-link")!
  const tabs = shadow.querySelector<HTMLElement>("#tabs")!
  const toast = shadow.querySelector<HTMLElement>("#toast")!

  const showWordbookToast = (wordbookName: string) => {
    clearTimeout(toastTimer)
    toast.textContent = `已添加进「${wordbookName}」生词本`
    toast.classList.add("open")
    toastTimer = setTimeout(() => toast.classList.remove("open"), 2400)
  }

  const saveDictionaryOrder = () =>
    sendMessage("patchVocabularyPreferences", { dictionaryOrder: state.dictionaryOrder })

  const scheduleGistAutoSync = () => {
    clearTimeout(gistSyncTimer)
    if (!state.gistAutoSync || !state.gistId) return
    gistSyncTimer = setTimeout(async () => {
      try {
        await sendMessage("syncVocabularyGist", undefined)
      } catch {
        // The background coordinator records sync errors in extension storage.
      }
    }, 4000)
  }

  const renderResult = (
    value: Record<string, unknown> | null,
    error?: string,
    complete = false,
  ) => {
    result.classList.add("open")
    if (error) {
      result.innerHTML = ""
      const errorNode = document.createElement("div")
      errorNode.className = "error"
      errorNode.textContent = error
      result.append(errorNode)
      return
    }
    if (!value) return
    const list = document.createElement("dl")
    Object.entries(value).forEach(([key, fieldValue]) => {
      if (fieldValue === undefined || fieldValue === null || fieldValue === "") return
      const term = document.createElement("dt")
      term.textContent = key
      const description = document.createElement("dd")
      if (preferredDictionary === "ai" && typeof fieldValue === "string") {
        description.style.whiteSpace = "normal"
        description.append(renderExplanationMarkdown(fieldValue))
        list.append(term, description)
        return
      }
      description.textContent =
        typeof fieldValue === "string" ||
        typeof fieldValue === "number" ||
        typeof fieldValue === "boolean"
          ? String(fieldValue)
          : JSON.stringify(fieldValue, null, 2)
      list.append(term, description)
    })
    if (!list.childElementCount) {
      if (complete) renderResult(null, "AI 没有返回可显示的解释，请检查模型配置。")
      return
    }
    result.innerHTML = ""
    result.append(list)
  }

  const setActiveStatus = (word: string) => {
    const status = state.statuses[word] ?? "unknown"
    shadow.querySelectorAll("[data-action]").forEach((button) => {
      button.classList.toggle("active", (button as HTMLElement).dataset.action === status)
    })
  }

  const setActiveDictionary = (dictionary: VocabularyDictionary) => {
    preferredDictionary = dictionary
    shadow.querySelectorAll("[data-dict]").forEach((button) => {
      button.classList.toggle("active", (button as HTMLElement).dataset.dict === dictionary)
    })
  }

  const applyDictionaryOrder = () => {
    state.dictionaryOrder.forEach((dictionary) => {
      const button = tabs.querySelector<HTMLElement>(`[data-dict="${dictionary}"]`)
      if (button) tabs.append(button)
    })
  }
  applyDictionaryOrder()

  const showEmbeddedDictionary = async (
    dictionary: Exclude<VocabularyDictionary, "ai">,
    hit: TrackedRange,
  ) => {
    activeExternalRequestId = undefined
    const currentSequence = invalidateExplanation()
    result.setAttribute("aria-busy", "false")
    setActiveDictionary(dictionary)
    result.classList.add("open")
    result.innerHTML = `<div class="loading">${dictionary === "haici" ? "海词" : dictionary} 正在查询…</div>`
    positionCard(card, hit)
    try {
      const definition = await lookupEmbeddedDictionary(dictionary, hit.word)
      if (currentSequence !== requestSequence || selected?.word !== hit.word) return
      result.innerHTML = ""
      const title = document.createElement("div")
      title.className = "dict-title"
      title.textContent = definition.title
      const text = document.createElement("div")
      text.className = "dict-text"
      text.textContent = definition.text
      result.append(title)
      if (definition.entry) {
        const entryWord = document.createElement("div")
        entryWord.className = "entry-word"
        const keyword = document.createElement("strong")
        keyword.textContent = definition.entry.word
        entryWord.append(keyword)
        if (definition.entry.level) {
          const level = document.createElement("span")
          level.className = "entry-level"
          level.textContent = definition.entry.level
          entryWord.append(level)
        }
        const phonetics = document.createElement("div")
        phonetics.className = "phonetics"
        definition.entry.phonetics.forEach((item) => {
          const phonetic = document.createElement("div")
          phonetic.className = "phonetic"
          const region = document.createElement("b")
          region.textContent = item.region
          const value = document.createElement("span")
          value.textContent = item.value
          phonetic.append(region, value)
          phonetics.append(phonetic)
        })
        const meanings = document.createElement("div")
        meanings.className = "meanings"
        definition.entry.meanings.forEach((item) => {
          const meaning = document.createElement("div")
          meaning.className = "meaning"
          const partOfSpeech = document.createElement("span")
          partOfSpeech.className = "pos"
          partOfSpeech.textContent = item.partOfSpeech
          const meaningText = document.createElement("span")
          meaningText.className = "definition"
          meaningText.textContent = item.definition
          meaning.append(partOfSpeech, meaningText)
          meanings.append(meaning)
        })
        result.append(entryWord, phonetics, meanings)
        if (definition.entry.forms) {
          const forms = document.createElement("div")
          forms.className = "forms"
          forms.textContent = definition.entry.forms
          result.append(forms)
        }
        if (definition.entry.details) {
          const details = document.createElement("details")
          const summary = document.createElement("summary")
          summary.textContent = "查看更多释义与用法"
          const detailsText = document.createElement("div")
          detailsText.className = "details-text"
          detailsText.textContent = definition.entry.details
          details.append(summary, detailsText)
          result.append(details)
        }
      } else {
        result.append(text)
      }
      if (definition.suggestions?.length) {
        const suggestions = document.createElement("div")
        suggestions.className = "suggestions"
        definition.suggestions.forEach((suggestion) => {
          const button = document.createElement("button")
          button.className = "suggestion"
          button.dataset.lookupWord = suggestion.word
          const label = document.createElement("strong")
          label.textContent = suggestion.word
          const description = document.createElement("span")
          description.textContent = suggestion.description
          button.append(label, description)
          suggestions.append(button)
        })
        result.append(suggestions)
      }
      positionCard(card, hit)
    } catch (error) {
      if (currentSequence !== requestSequence) return
      renderResult(null, error instanceof Error ? error.message : "词典查询失败")
    }
  }

  const showAIExplanation = async (hit: TrackedRange) => {
    const context = explanationContextKey(hit.word, sentenceForRange(hit.range))
    if (aiController && !aiController.signal.aborted && aiContext === context) return
    clearTimeout(hideTimer)
    cardPinned = true
    const sequence = invalidateExplanation()
    const controller = new AbortController()
    aiController = controller
    aiContext = context
    let streamTimer: ReturnType<typeof setTimeout> | undefined
    let streamText = ""
    const renderStream = () => {
      streamTimer = undefined
      if (sequence !== requestSequence || controller.signal.aborted) return
      const scrollTop = result.scrollTop
      const meta = document.createElement("div")
      meta.className = "explanation-meta"
      meta.textContent = "正在生成…"
      result.replaceChildren(renderExplanationMarkdown(streamText), meta)
      result.scrollTop = scrollTop
    }
    activeExternalRequestId = undefined
    setActiveDictionary("ai")
    card.classList.add("open")
    result.classList.add("open")
    result.setAttribute("aria-busy", "true")
    result.textContent = "正在结合当前语境解释…"
    try {
      const config = await getLocalConfig()
      if (sequence !== requestSequence) return
      const action = config && resolveVocabularyDictionaryAction(config.selectionToolbar)
      const provider = config?.providersConfig.find((item) => item.id === action?.providerId)
      if (isChatGPTLocalProvider(provider) && provider?.provider === "open-responses") {
        const model = resolveModelId(provider.model)
        if (!model) throw new Error("请先在订阅设置中选择模型。")
        const explanation = await streamVocabularyExplanation(
          {
            word: hit.word,
            sentence: sentenceForRange(hit.range),
            model,
          },
          controller.signal,
          (text) => {
            streamText = text
            // Bound Markdown layout work while tokens arrive; never reposition per token.
            if (streamTimer === undefined) streamTimer = setTimeout(renderStream, 100)
          },
        )
        clearTimeout(streamTimer)
        if (sequence !== requestSequence) return
        const meta = document.createElement("div")
        meta.className = "explanation-meta"
        const usage = explanation.usage
        meta.textContent = `${explanation.model || "ChatGPT"} · ${explanation.cached ? "本地缓存 · 本次未请求 OpenAI" : usage ? `输入 ${usage.input_tokens ?? "未知"} / 输出 ${usage.output_tokens ?? "未知"} tokens` : "接口未返回用量"}`
        result.replaceChildren(renderExplanationMarkdown(explanation.text), meta)
      } else {
        activeExternalRequestId = sequence
        await openReadFrogDictionaryAction(hit, sequence)
      }
      if (sequence === requestSequence && selected) positionCard(card, selected)
    } catch (error) {
      if (sequence === requestSequence) {
        if (streamText) {
          const message = document.createElement("div")
          message.className = "explanation-meta"
          message.textContent = `生成未完成：${error instanceof Error ? error.message : "请重试"}`
          result.replaceChildren(renderExplanationMarkdown(streamText), message)
        } else renderResult(null, String(error))
        activeExternalRequestId = undefined
      }
    } finally {
      clearTimeout(streamTimer)
      if (sequence === requestSequence) {
        result.setAttribute("aria-busy", "false")
        aiController = undefined
        aiContext = ""
      }
    }
  }

  const showCard = (hit: TrackedRange, source: "hover" | "selection" = "hover") => {
    clearTimeout(hoverTimer)
    pendingHover = null
    clearTimeout(hideTimer)
    selectedFromTextSelection = source === "selection"
    const contextKey = explanationContextKey(hit.word, sentenceForRange(hit.range))
    const changedWord = !selected || selectedContext !== contextKey
    selectedContext = contextKey
    if (changedWord) cardPinned = source === "selection"
    else if (source === "selection") cardPinned = true
    selected = hit
    wordLabel.textContent = hit.word
    levelLabel.textContent = getVocabularyLevel(hit.level).label
    statusLabel.textContent = statusText(hit.word, state)
    setActiveStatus(hit.word)
    shadow.querySelectorAll<HTMLElement>("[data-dict]").forEach((button) => {
      button.hidden = !state.enabledDictionaries.includes(
        button.dataset.dict as VocabularyDictionary,
      )
    })
    sentenceLabel.textContent = sentenceForRange(hit.range)
    if (changedWord) {
      invalidateExplanation()
      result.classList.remove("open")
      result.innerHTML = ""
    }

    const link = findLinkForRange(hit.range)
    sourceLink.hidden = !link
    if (link) sourceLink.href = link.href
    card.classList.add("open")
    positionCard(card, hit)
    if (changedWord) {
      if (
        shouldAutomaticallyExplain(preferredDictionary, automaticAI) &&
        state.enabledDictionaries.includes("ai")
      ) {
        void showAIExplanation(hit)
        return
      }
      const defaultDictionary =
        preferredDictionary &&
        preferredDictionary !== "ai" &&
        state.enabledDictionaries.includes(preferredDictionary)
          ? preferredDictionary
          : (state.dictionaryOrder.find(
              (item): item is Exclude<VocabularyDictionary, "ai"> =>
                item !== "ai" && state.enabledDictionaries.includes(item),
            ) ?? "haici")
      void showEmbeddedDictionary(defaultDictionary, hit)
    }
  }

  const hideCardSoon = () => {
    clearTimeout(hoverTimer)
    pendingHover = null
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (
        cardPinned ||
        selectedFromTextSelection ||
        card.matches(":hover") ||
        (selected &&
          latestPointerPosition &&
          isPointOverTrackedRange(
            selected,
            latestPointerPosition.clientX,
            latestPointerPosition.clientY,
          ))
      ) {
        return
      }
      card.classList.remove("open")
      invalidateExplanation()
    }, 260)
  }

  const clearHighlights = () => {
    unknownHighlight.clear()
    fuzzyHighlight.clear()
    trackedRanges.forEach(({ range }) => range.detach())
    trackedRanges = []
    rangesByTextNode.clear()
  }

  const removeRangesForTextNode = (node: Text) => {
    const ranges = rangesByTextNode.get(node)
    if (!ranges) return
    ranges.forEach(({ range }) => {
      unknownHighlight.delete(range)
      fuzzyHighlight.delete(range)
      range.detach()
    })
    const removedRanges = new Set(ranges)
    trackedRanges = trackedRanges.filter((item) => !removedRanges.has(item))
    rangesByTextNode.delete(node)
  }

  const removeDisconnectedRanges = () => {
    for (const node of rangesByTextNode.keys()) {
      if (!node.isConnected) removeRangesForTextNode(node)
    }
  }

  const addTrackedRange = (item: TrackedRange) => {
    trackedRanges.push(item)
    const node = item.range.startContainer as Text
    const ranges = rangesByTextNode.get(node)
    if (ranges) ranges.push(item)
    else rangesByTextNode.set(node, [item])
    if (state.statuses[item.word] === "fuzzy") fuzzyHighlight.add(item.range)
    else unknownHighlight.add(item.range)
  }

  const yieldToMainThread = async () => {
    const scheduling = (
      globalThis as typeof globalThis & {
        scheduler?: { yield?: () => Promise<void> }
      }
    ).scheduler
    if (scheduling?.yield) await scheduling.yield()
    else await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  const scanTextNode = (
    node: Text,
    englishContextCache: WeakMap<Element, boolean>,
    enabledLevels: ReadonlySet<VocabularyLevel>,
  ) => {
    removeRangesForTextNode(node)
    if (!isTextNodeEligible(node, host) || trackedRanges.length >= MAX_RANGES) return

    const languageContext = findLanguageContext(node)
    let isEnglish = false
    if (languageContext) {
      const cachedIsEnglish = englishContextCache.get(languageContext)
      if (cachedIsEnglish === undefined) {
        isEnglish = isEnglishVocabularyContext(languageContext.textContent ?? "")
        englishContextCache.set(languageContext, isEnglish)
      } else {
        isEnglish = cachedIsEnglish
      }
    }

    for (const occurrence of findCandidateWords(
      node.data,
      state.minimumLength,
      state.statuses,
      vocabularyDictionary,
      enabledLevels,
      state.vocabularyAssessment,
      predictedKnownIndices,
    )) {
      if (trackedRanges.length >= MAX_RANGES) break
      const explicitStatus = state.statuses[occurrence.word]
      if (!isEnglish && explicitStatus !== "unknown" && explicitStatus !== "fuzzy") continue
      if (isUsernameMention(node, occurrence.start)) continue
      const range = document.createRange()
      range.setStart(node, occurrence.start)
      range.setEnd(node, occurrence.end)
      addTrackedRange({ range, word: occurrence.word, level: occurrence.level })
    }
  }

  const refresh = async () => {
    const generation = ++refreshGeneration
    clearHighlights()
    if (!state.enabled || !document.body) return
    await ensureVocabularyDictionary()
    if (generation !== refreshGeneration || !state.enabled) return
    predictedKnownIndices = createPredictedKnownIndices(
      vocabularyDictionary ?? new Map(),
      state.vocabularyAssessment,
      state.statuses,
    )

    const englishContextCache = new WeakMap<Element, boolean>()
    const enabledLevels = new Set(state.enabledLevels)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let visitedNodes = 0
    while (walker.nextNode() && trackedRanges.length < MAX_RANGES) {
      const node = walker.currentNode as Text
      scanTextNode(node, englishContextCache, enabledLevels)
      visitedNodes += 1
      if (visitedNodes % 60 === 0) {
        await yieldToMainThread()
        if (generation !== refreshGeneration || !state.enabled) return
      }
    }
  }

  const pendingTextNodes = new Set<Text>()
  let isProcessingPendingTextNodes = false
  const queueTextNodes = (root: Node) => {
    if (root instanceof Text) {
      pendingTextNodes.add(root)
      return
    }
    if (!(root instanceof Element)) return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) pendingTextNodes.add(walker.currentNode as Text)
  }

  const processPendingTextNodes = async () => {
    refreshTimer = undefined
    if (isProcessingPendingTextNodes) return
    if (!state.enabled) {
      pendingTextNodes.clear()
      return
    }
    isProcessingPendingTextNodes = true
    try {
      await ensureVocabularyDictionary()
      if (!state.enabled) return
      do {
        removeDisconnectedRanges()
        const nodes = [...pendingTextNodes]
        pendingTextNodes.clear()
        const englishContextCache = new WeakMap<Element, boolean>()
        const enabledLevels = new Set(state.enabledLevels)
        for (let index = 0; index < nodes.length; index += 1) {
          const node = nodes[index]!
          if (node.isConnected) scanTextNode(node, englishContextCache, enabledLevels)
          if ((index + 1) % 40 === 0) await yieldToMainThread()
        }
      } while (state.enabled && pendingTextNodes.size)
    } finally {
      isProcessingPendingTextNodes = false
      if (state.enabled && pendingTextNodes.size) schedulePendingTextNodes()
    }
  }

  const schedulePendingTextNodes = () => {
    if (refreshTimer !== undefined) return
    refreshTimer = setTimeout(() => void processPendingTextNodes(), 50)
  }

  const hitTest = (clientX: number, clientY: number, target: EventTarget | null) => {
    if (!(target instanceof Node) || isVocabularyInteractiveTarget(target)) return undefined
    const documentWithCaret = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    const position = documentWithCaret.caretPositionFromPoint?.(clientX, clientY)
    const fallbackRange = position
      ? null
      : documentWithCaret.caretRangeFromPoint?.(clientX, clientY)
    const node = position?.offsetNode ?? fallbackRange?.startContainer
    const offset = position?.offset ?? fallbackRange?.startOffset
    if (node instanceof Text && offset !== undefined) {
      const caretHit = rangesByTextNode
        .get(node)
        ?.find(({ range }) => offset >= range.startOffset && offset < range.endOffset)
      if (caretHit) return caretHit
    }

    for (const candidate of [selected, pendingHover]) {
      if (candidate && isPointOverTrackedRange(candidate, clientX, clientY)) return candidate
    }
    return undefined
  }

  let mouseMoveFrame: number | undefined
  let latestMouseMove: MouseEvent | undefined
  const processMouseMove = () => {
    mouseMoveFrame = undefined
    const event = latestMouseMove
    latestMouseMove = undefined
    if (!event || !state.enabled || event.composedPath().includes(host)) return
    // A pinned explanation must not be replaced by incidental pointer movement.
    if (cardPinned && card.classList.contains("open")) return
    const hit = hitTest(event.clientX, event.clientY, event.target)
    if (!hit) {
      hideCardSoon()
      return
    }
    clearTimeout(hideTimer)
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) {
      if (selectedFromTextSelection && card.classList.contains("open")) {
        clearTimeout(hideTimer)
        return
      }
      hideCardSoon()
      return
    }
    if (card.classList.contains("open") && selected?.range === hit.range) return
    if (pendingHover?.range === hit.range) return
    clearTimeout(hoverTimer)
    pendingHover = hit
    hoverTimer = setTimeout(() => {
      if (pendingHover?.range === hit.range) showCard(hit)
    }, 650)
  }
  const handleMouseMove = (event: MouseEvent) => {
    latestPointerPosition = { clientX: event.clientX, clientY: event.clientY }
    latestMouseMove = event
    if (mouseMoveFrame === undefined) mouseMoveFrame = requestAnimationFrame(processMouseMove)
  }
  document.addEventListener("mousemove", handleMouseMove, true)

  const handlePageClick = (event: MouseEvent) => {
    if (!state.enabled || event.composedPath().includes(host)) return
    const target = event.target
    if (target instanceof Node && isVocabularyInteractiveTarget(target)) return
    const hit = hitTest(event.clientX, event.clientY, target)
    if (!hit) {
      card.classList.remove("open")
      cardPinned = false
      selectedFromTextSelection = false
      activeExternalRequestId = undefined
      invalidateExplanation()
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    showCard(hit)
  }
  document.addEventListener("click", handlePageClick, true)

  const showSelectedWord = () => {
    if (!state.enabled) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
    const normalizedWord = normalizeSelectedWord(selection.toString())
    if (!normalizedWord) return
    const range = selection.getRangeAt(0)
    const container =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
    if (
      !container ||
      host.contains(container) ||
      container.closest(
        "input,textarea,select,button,[role='button'],[contenteditable='true'],[data-read-frog-vocabulary-ui]",
      )
    ) {
      return
    }
    const wordInfo = resolveVocabularyWord(normalizedWord, vocabularyDictionary)
    showCard(
      {
        range: range.cloneRange(),
        word: wordInfo.lemma,
        level: wordInfo.level,
      },
      "selection",
    )
  }
  document.addEventListener("mouseup", showSelectedWord, true)

  card.addEventListener("mouseenter", () => clearTimeout(hideTimer))
  card.addEventListener("mouseleave", hideCardSoon)
  const handleExternalCustomActionResult = (event: Event) => {
    const response = (event as CustomEvent<ExternalCustomActionResult>).detail
    if (!response || response.requestId !== activeExternalRequestId) return
    renderResult(response.value, response.error, response.complete)
    if (response.complete) activeExternalRequestId = undefined
    if (selected) positionCard(card, selected)
  }
  window.addEventListener(EXTERNAL_CUSTOM_ACTION_RESULT_EVENT, handleExternalCustomActionResult)
  const keepCardInViewport = () => {
    if (selected && card.classList.contains("open")) positionCard(card, selected)
  }
  const cardResizeObserver = new ResizeObserver(keepCardInViewport)
  cardResizeObserver.observe(card)
  window.addEventListener("resize", keepCardInViewport)
  window.addEventListener("scroll", keepCardInViewport, true)

  let draggedDictionary: VocabularyDictionary | null = null
  let suppressDictionaryClick = false
  tabs.addEventListener("dragstart", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-dict]")
    if (!button) return
    draggedDictionary = button.dataset.dict as VocabularyDictionary
    button.classList.add("dragging")
    event.dataTransfer?.setData("text/plain", draggedDictionary)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
  })
  tabs.addEventListener("dragover", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-dict]")
    if (!button || button.dataset.dict === draggedDictionary) return
    event.preventDefault()
    tabs.querySelectorAll(".drag-over").forEach((item) => item.classList.remove("drag-over"))
    button.classList.add("drag-over")
  })
  tabs.addEventListener("drop", (event) => {
    event.preventDefault()
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-dict]")
    const targetDictionary = target?.dataset.dict as VocabularyDictionary | undefined
    if (!draggedDictionary || !targetDictionary || draggedDictionary === targetDictionary) return
    const order = state.dictionaryOrder.filter((item) => item !== draggedDictionary)
    order.splice(order.indexOf(targetDictionary), 0, draggedDictionary)
    state = { ...state, dictionaryOrder: order }
    applyDictionaryOrder()
    void saveDictionaryOrder()
    suppressDictionaryClick = true
    setTimeout(() => {
      suppressDictionaryClick = false
    }, 0)
  })
  tabs.addEventListener("dragend", () => {
    draggedDictionary = null
    tabs.querySelectorAll(".dragging,.drag-over").forEach((item) => {
      item.classList.remove("dragging", "drag-over")
    })
  })

  const markWord = async (
    word: string,
    status: VocabularyStatus,
    preferredRange?: Range,
    level?: VocabularyLevel,
  ) => {
    const updatedAt = Date.now()
    state = {
      ...state,
      statuses: {
        ...state.statuses,
        [word]: status,
      },
      statusUpdatedAt: {
        ...state.statusUpdatedAt,
        [word]: updatedAt,
      },
    }

    const matchingRanges = trackedRanges.filter((item) => item.word === word)
    matchingRanges.forEach((item) => {
      const { range } = item
      const node = range.startContainer as Text
      unknownHighlight.delete(range)
      fuzzyHighlight.delete(range)
      range.detach()
      const nodeRanges = rangesByTextNode.get(node)?.filter((candidate) => candidate !== item)
      if (nodeRanges?.length) rangesByTextNode.set(node, nodeRanges)
      else rangesByTextNode.delete(node)
    })
    trackedRanges = trackedRanges.filter((item) => item.word !== word)

    if (
      preferredRange?.startContainer.isConnected &&
      (status === "unknown" || status === "fuzzy") &&
      !trackedRanges.some(
        (item) =>
          item.word === word &&
          item.range.startContainer === preferredRange.startContainer &&
          item.range.startOffset === preferredRange.startOffset &&
          item.range.endContainer === preferredRange.endContainer &&
          item.range.endOffset === preferredRange.endOffset,
      )
    ) {
      addTrackedRange({ range: preferredRange, word, level })
    }
    const update = await sendMessage("updateVocabularyWord", { word, status, updatedAt })
    if (!update.applied) state = await getVocabularyHunterState()
    if (status === "unknown" && update.applied) {
      showWordbookToast(state.activeWordbook)
    }
    if (vocabularyDictionary) {
      void syncKnownWord(word, status === "known", vocabularyDictionary)
    }
    scheduleGistAutoSync()
  }

  const markSelected = async (status: VocabularyStatus) => {
    if (!selected) return
    const selectedWord = selected.word
    const selectedRange = selected.range.cloneRange()
    const selectedLevel = selected.level
    card.classList.remove("open")
    selected = null
    cardPinned = false
    activeExternalRequestId = undefined
    invalidateExplanation()
    selectedFromTextSelection = false
    window.getSelection()?.removeAllRanges()

    await markWord(selectedWord, status, selectedRange, selectedLevel)
  }

  const handleShortcut = (event: KeyboardEvent) => {
    if (eventComesFromEditableControl(event)) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const key = event.key.toLowerCase()
    if (key === "escape") {
      card.classList.remove("open")
      cardPinned = false
      selectedFromTextSelection = false
      activeExternalRequestId = undefined
      invalidateExplanation()
      return
    }
    const pageSelection = window.getSelection()
    if (key === "d" && pageSelection && !pageSelection.isCollapsed) {
      const normalizedWord = normalizeSelectedWord(pageSelection.toString())
      if (!normalizedWord) return
      const wordInfo = resolveVocabularyWord(normalizedWord, vocabularyDictionary)
      const word = wordInfo.lemma
      const selectedRange = pageSelection.rangeCount
        ? pageSelection.getRangeAt(0).cloneRange()
        : null
      const selectedLevel = wordInfo.level
      event.preventDefault()
      event.stopImmediatePropagation()
      card.classList.remove("open")
      selected = null
      cardPinned = false
      activeExternalRequestId = undefined
      invalidateExplanation()
      selectedFromTextSelection = false
      pageSelection.removeAllRanges()
      void markWord(word, "unknown", selectedRange ?? undefined, selectedLevel)
      return
    }
    if (!selected || !card.classList.contains("open")) return
    const statusByKey: Record<string, VocabularyStatus | undefined> = {
      a: "known",
      s: "fuzzy",
      d: "unknown",
    }
    const status = statusByKey[key]
    if (!status) return
    event.preventDefault()
    event.stopImmediatePropagation()
    void markSelected(status)
  }
  document.addEventListener("keydown", handleShortcut, true)

  shadow.addEventListener("click", (event) => {
    clearTimeout(hideTimer)
    cardPinned = true
    const summary = (event.target as HTMLElement).closest("summary")
    if (summary) {
      event.preventDefault()
      event.stopPropagation()
      const details = summary.closest("details")
      if (details) details.open = !details.open
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const lookupWord = (event.target as HTMLElement).closest<HTMLElement>("[data-lookup-word]")
      ?.dataset.lookupWord
    if (lookupWord && selected) {
      selected = { ...selected, word: lookupWord }
      wordLabel.textContent = lookupWord
      const wordInfo = vocabularyDictionary?.get(lookupWord)
      levelLabel.textContent = getVocabularyLevel(wordInfo?.level).label
      statusLabel.textContent = statusText(lookupWord, state)
      setActiveStatus(lookupWord)
      void showEmbeddedDictionary("haici", selected)
      return
    }

    const dictionary = (event.target as HTMLElement).closest<HTMLElement>("[data-dict]")?.dataset
      .dict as VocabularyDictionary | undefined
    if (suppressDictionaryClick) return
    if (dictionary && selected) {
      if (dictionary === "ai") {
        void showAIExplanation(selected)
      } else {
        void showEmbeddedDictionary(dictionary, selected)
      }
      return
    }

    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset
      .action
    if (!action) return
    if (action === "close") {
      cardPinned = false
      card.classList.remove("open")
      activeExternalRequestId = undefined
      invalidateExplanation()
      selectedFromTextSelection = false
      return
    }
    if (!selected) return

    void markSelected(action as VocabularyStatus)
  })

  const observer = new MutationObserver((mutations) => {
    let shouldCleanDisconnectedRanges = false
    for (const mutation of mutations) {
      if (host.contains(mutation.target)) continue
      if (mutation.type === "characterData") {
        queueTextNodes(mutation.target)
        continue
      }
      mutation.addedNodes.forEach(queueTextNodes)
      if (mutation.removedNodes.length) shouldCleanDisconnectedRanges = true
    }
    if (pendingTextNodes.size > 0 && pendingTextNodes.size <= MAX_SYNCHRONOUS_MUTATION_NODES) {
      void processPendingTextNodes()
    } else {
      if (shouldCleanDisconnectedRanges) removeDisconnectedRanges()
      if (pendingTextNodes.size) schedulePendingTextNodes()
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  let cancelInitialRefresh: (() => void) | undefined = scheduleIdleTask(() => {
    cancelInitialRefresh = undefined
    void refresh()
  })
  const unwatchState = watchVocabularyHunterState((nextState) => {
    const requiresRefresh = shouldRefreshVocabularyHighlights(state, nextState)
    state = nextState
    highlightStyles.update(state)
    applyDictionaryOrder()
    if (requiresRefresh) {
      cancelInitialRefresh?.()
      cancelInitialRefresh = undefined
      void refresh()
    }
  })
  const unwatchAI = storage.watch<boolean>("local:wordHunterAutoAI", (value) => {
    automaticAI = value === true
  })
  const unwatchConfig = storage.watch<Config>(`local:${CONFIG_STORAGE_KEY}`, (value, oldValue) => {
    if (explanationProviderKey(value) === explanationProviderKey(oldValue)) return
    // Only relevant provider/action changes cancel an explanation; unrelated settings do not.
    selectedContext = ""
    invalidateExplanation()
    activeExternalRequestId = undefined
    result.replaceChildren()
    result.classList.remove("open")
  })

  ctx.onInvalidated(() => {
    invalidateExplanation()
    clearTimeout(refreshTimer)
    clearTimeout(hideTimer)
    clearTimeout(hoverTimer)
    clearTimeout(gistSyncTimer)
    clearTimeout(toastTimer)
    cancelInitialRefresh?.()
    if (mouseMoveFrame !== undefined) cancelAnimationFrame(mouseMoveFrame)
    observer.disconnect()
    cardResizeObserver.disconnect()
    window.removeEventListener("resize", keepCardInViewport)
    window.removeEventListener("scroll", keepCardInViewport, true)
    window.removeEventListener(
      EXTERNAL_CUSTOM_ACTION_RESULT_EVENT,
      handleExternalCustomActionResult,
    )
    document.removeEventListener("keydown", handleShortcut, true)
    document.removeEventListener("mouseup", showSelectedWord, true)
    document.removeEventListener("mousemove", handleMouseMove, true)
    document.removeEventListener("click", handlePageClick, true)
    unwatchState()
    unwatchAI()
    unwatchConfig()
    clearHighlights()
    CSS.highlights.delete(UNKNOWN_HIGHLIGHT)
    CSS.highlights.delete(FUZZY_HIGHLIGHT)
    highlightStyles.remove()
    host.remove()
  })
}

export default defineContentScript({
  matches: ["*://*/*", "file:///*"],
  runAt: "document_idle",
  main: start,
})

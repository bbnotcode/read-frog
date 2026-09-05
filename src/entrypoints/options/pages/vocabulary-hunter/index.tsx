import type { VocabularyStatus, VocabularyWordInfo } from "@/utils/vocabulary-hunter/candidates"
import type {
  VocabularyDictionary,
  VocabularyHunterPreferencePatch,
} from "@/utils/vocabulary-hunter/storage"
import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/base-ui/button"
import { Input } from "@/components/ui/base-ui/input"
import { Switch } from "@/components/ui/base-ui/switch"
import { sendMessage } from "@/utils/message"
import {
  getVocabularyLevel,
  loadVocabularyDictionary,
  VOCABULARY_LEVELS,
} from "@/utils/vocabulary-hunter/dictionary-data"
import {
  lookupEmbeddedDictionary,
  type EmbeddedDictionaryResult,
} from "@/utils/vocabulary-hunter/dictionary-lookup"
import {
  DEFAULT_VOCABULARY_HUNTER_STATE,
  getVocabularyHunterGistToken,
  getVocabularyHunterState,
  setVocabularyHunterGistToken,
  type VocabularyHunterState,
} from "@/utils/vocabulary-hunter/storage"
import {
  fetchWordHunterGist,
  mergeKnownWordsFromSync,
  readWordHunterBackup,
  syncKnownWord,
  syncKnownWords,
} from "@/utils/vocabulary-hunter/sync"
import { PageLayout } from "../../components/page-layout"
import { ConfigCard } from "./config-card"

type StatusFilter = "all" | "known" | "fuzzy" | "unknown"
type ChartMode = "pie" | "bar" | "line"
type VocabularyView = "study" | "compact"
type VocabularySort = "difficulty" | "alphabetical" | "recent"
type LookupDictionary = "haici" | "google"

const PAGE_SIZE = 50
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
const todayForDateInput = () => {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

const STATUS_LABELS = {
  known: "已掌握",
  fuzzy: "待巩固",
  unknown: "未掌握",
} as const
const STATUS_COLORS = {
  known: "#10b981",
  fuzzy: "#f59e0b",
  unknown: "#f43f5e",
} as const

const DICTIONARY_LABELS: Record<VocabularyDictionary, string> = {
  haici: "海词词典",
  google: "Google 词典",
  ai: "ReadFrog AI",
}

type ChartDatum = {
  status: VocabularyStatus
  name: string
  value: number
  color: string
}

type TimelineDatum = {
  date: string
  known: number
  fuzzy: number
  unknown: number
}

function VocabularyChart({
  mode,
  chartData,
  timelineData,
}: {
  mode: ChartMode
  chartData: ChartDatum[]
  timelineData: TimelineDatum[]
}) {
  if (mode === "pie") {
    const total = chartData.reduce((sum, item) => sum + item.value, 0)
    let angle = 0
    const segments = chartData.map((item) => {
      const start = angle
      angle += total > 0 ? (item.value / total) * 360 : 0
      return `${item.color} ${start}deg ${angle}deg`
    })

    return (
      <div className="flex h-full items-center justify-center">
        <div
          role="img"
          aria-label={chartData.map((item) => `${item.name} ${item.value}`).join("，")}
          className="relative size-56 rounded-full"
          style={{
            background:
              total > 0 ? `conic-gradient(${segments.join(", ")})` : "var(--color-muted, #e5e7eb)",
          }}
        >
          <div className="absolute inset-14 flex flex-col items-center justify-center rounded-full bg-background shadow-inner">
            <span className="text-3xl font-bold">{total}</span>
            <span className="text-xs text-muted-foreground">总词汇</span>
          </div>
        </div>
      </div>
    )
  }

  if (mode === "bar") {
    const maximum = Math.max(1, ...chartData.map((item) => item.value))
    return (
      <div className="flex h-full items-end justify-center gap-8 border-b px-6 pt-5">
        {chartData.map((item) => (
          <div
            key={item.status}
            className="flex h-full w-24 flex-col items-center justify-end gap-2"
          >
            <span className="text-sm font-semibold">{item.value}</span>
            <div
              className="min-h-1 w-full rounded-t-xl transition-[height]"
              style={{
                height: `${Math.max(2, (item.value / maximum) * 82)}%`,
                backgroundColor: item.color,
              }}
            />
            <span className="pb-2 text-xs text-muted-foreground">{item.name}</span>
          </div>
        ))}
      </div>
    )
  }

  const statuses = ["known", "fuzzy", "unknown"] as const
  const maximum = Math.max(
    1,
    ...timelineData.flatMap((item) => statuses.map((status) => item[status])),
  )
  const pointsFor = (status: (typeof statuses)[number]) =>
    timelineData
      .map((item, index) => {
        const x = timelineData.length === 1 ? 50 : (index / (timelineData.length - 1)) * 100
        const y = 90 - (item[status] / maximum) * 80
        return `${x},${y}`
      })
      .join(" ")

  return (
    <div className="flex h-full flex-col pt-2">
      <svg
        role="img"
        aria-label="最近七天词汇状态折线图"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="min-h-0 flex-1 overflow-visible"
      >
        {[10, 30, 50, 70, 90].map((y) => (
          <line
            key={y}
            x1="0"
            x2="100"
            y1={y}
            y2={y}
            vectorEffect="non-scaling-stroke"
            className="stroke-border"
            strokeDasharray="4 4"
          />
        ))}
        {statuses.map((status) => (
          <polyline
            key={status}
            points={pointsFor(status)}
            fill="none"
            stroke={STATUS_COLORS[status]}
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
      <div className="mt-3 flex justify-between text-xs text-muted-foreground">
        {timelineData.map((item) => (
          <span key={item.date}>{item.date}</span>
        ))}
      </div>
    </div>
  )
}

export function VocabularyHunterPage() {
  const [state, setState] = useState<VocabularyHunterState>(DEFAULT_VOCABULARY_HUNTER_STATE)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<StatusFilter>("all")
  const [dictionary, setDictionary] = useState<Map<string, VocabularyWordInfo>>(new Map())
  const [syncMessage, setSyncMessage] = useState("")
  const [gistUrl, setGistUrl] = useState("")
  const [gistToken, setGistToken] = useState("")
  const [gistLoading, setGistLoading] = useState(false)
  const [chartMode, setChartMode] = useState<ChartMode>("pie")
  const [vocabularyView, setVocabularyView] = useState<VocabularyView>("study")
  const [vocabularySort, setVocabularySort] = useState<VocabularySort>("difficulty")
  const [letterFilter, setLetterFilter] = useState("")
  const [page, setPage] = useState(1)
  const [selectedWord, setSelectedWord] = useState("")
  const [lookupDictionary, setLookupDictionary] = useState<LookupDictionary>("haici")
  const [definition, setDefinition] = useState<EmbeddedDictionaryResult | null>(null)
  const [definitionLoading, setDefinitionLoading] = useState(false)
  const [definitionError, setDefinitionError] = useState("")
  const [newWordbookName, setNewWordbookName] = useState("")
  const [wordbookMessage, setWordbookMessage] = useState("")
  const [wordbookExportDate, setWordbookExportDate] = useState(todayForDateInput)
  const importInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void Promise.all([
      getVocabularyHunterState(),
      getVocabularyHunterGistToken(),
      loadVocabularyDictionary(),
    ]).then(async ([currentState, savedGistToken, loadedDictionary]) => {
      setDictionary(loadedDictionary)
      const mergedState = await mergeKnownWordsFromSync(currentState, loadedDictionary).catch(
        () => currentState,
      )
      setState(mergedState)
      setGistUrl(mergedState.gistId)
      setGistToken(savedGistToken)
      if (mergedState !== currentState) {
        const persisted = await sendMessage("mergeVocabularyWordData", {
          statuses: mergedState.statuses,
          updatedAt: mergedState.statusUpdatedAt,
          deletedAt: mergedState.deletedAt,
        })
        setState(persisted)
      }
    })
  }, [])

  const updateState = (next: VocabularyHunterState) => {
    const patch: VocabularyHunterPreferencePatch = {}
    if (next.enabled !== state.enabled) patch.enabled = next.enabled
    if (next.minimumLength !== state.minimumLength) patch.minimumLength = next.minimumLength
    if (next.enabledLevels !== state.enabledLevels) patch.enabledLevels = next.enabledLevels
    if (next.enabledDictionaries !== state.enabledDictionaries) {
      patch.enabledDictionaries = next.enabledDictionaries
    }
    if (next.dictionaryOrder !== state.dictionaryOrder) patch.dictionaryOrder = next.dictionaryOrder
    if (next.unknownHighlightColor !== state.unknownHighlightColor) {
      patch.unknownHighlightColor = next.unknownHighlightColor
    }
    if (next.fuzzyHighlightColor !== state.fuzzyHighlightColor) {
      patch.fuzzyHighlightColor = next.fuzzyHighlightColor
    }
    if (next.gistId !== state.gistId) patch.gistId = next.gistId
    if (next.gistAutoSync !== state.gistAutoSync) patch.gistAutoSync = next.gistAutoSync
    if (next.activeWordbook !== state.activeWordbook) patch.activeWordbook = next.activeWordbook
    setState(next)
    if (Object.keys(patch).length > 0) void sendMessage("patchVocabularyPreferences", patch)
  }

  const words = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return Object.entries(state.statuses)
      .filter(
        ([word, status]) =>
          (filter === "all" || status === filter) &&
          (!letterFilter || word.toLocaleUpperCase().startsWith(letterFilter)) &&
          word.toLocaleLowerCase().includes(normalizedQuery),
      )
      .sort(([left], [right]) => {
        if (vocabularySort === "alphabetical") return left.localeCompare(right)
        if (vocabularySort === "recent") {
          return (
            (state.statusUpdatedAt[right] ?? 0) - (state.statusUpdatedAt[left] ?? 0) ||
            left.localeCompare(right)
          )
        }
        const leftRank = getVocabularyLevel(dictionary.get(left)?.level).rank
        const rightRank = getVocabularyLevel(dictionary.get(right)?.level).rank
        return rightRank - leftRank || left.localeCompare(right)
      })
  }, [
    dictionary,
    filter,
    letterFilter,
    query,
    state.statuses,
    state.statusUpdatedAt,
    vocabularySort,
  ])
  const pageCount = Math.max(1, Math.ceil(words.length / PAGE_SIZE))
  const pagedWords = useMemo(
    () => words.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [page, words],
  )

  useEffect(() => {
    setPage(1)
  }, [filter, letterFilter, query, vocabularySort, vocabularyView])

  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  useEffect(() => {
    if (!selectedWord) {
      setDefinition(null)
      setDefinitionError("")
      return undefined
    }
    let cancelled = false
    setDefinition(null)
    setDefinitionError("")
    setDefinitionLoading(true)
    void lookupEmbeddedDictionary(lookupDictionary, selectedWord)
      .then((result) => {
        if (!cancelled) setDefinition(result)
      })
      .catch((error) => {
        if (!cancelled) {
          setDefinitionError(error instanceof Error ? error.message : "暂时无法查询释义")
        }
      })
      .finally(() => {
        if (!cancelled) setDefinitionLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [lookupDictionary, selectedWord])

  const counts = useMemo(
    () => ({
      known: Object.values(state.statuses).filter((status) => status === "known").length,
      fuzzy: Object.values(state.statuses).filter((status) => status === "fuzzy").length,
      unknown: Object.values(state.statuses).filter((status) => status === "unknown").length,
    }),
    [state.statuses],
  )
  const chartData = useMemo(
    () =>
      (["known", "fuzzy", "unknown"] as const).map((status) => ({
        status,
        name: STATUS_LABELS[status],
        value: counts[status],
        color: STATUS_COLORS[status],
      })),
    [counts],
  )
  const timelineData = useMemo(() => {
    const today = new Date()
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(today)
      day.setHours(23, 59, 59, 999)
      day.setDate(today.getDate() - (6 - index))
      const point = {
        date: `${day.getMonth() + 1}/${day.getDate()}`,
        known: 0,
        fuzzy: 0,
        unknown: 0,
      }
      Object.entries(state.statuses).forEach(([word, status]) => {
        const updatedAt = state.statusUpdatedAt[word] ?? 0
        if (updatedAt === 0 || updatedAt <= day.getTime()) point[status] += 1
      })
      return point
    })
  }, [state.statusUpdatedAt, state.statuses])

  const removeWord = async (word: string) => {
    const statuses = { ...state.statuses }
    const statusUpdatedAt = { ...state.statusUpdatedAt }
    delete statuses[word]
    delete statusUpdatedAt[word]
    setState({ ...state, statuses, statusUpdatedAt })
    await sendMessage("updateVocabularyWord", { word, status: null, updatedAt: Date.now() })
    void syncKnownWord(word, false, dictionary)
  }

  const updateWordStatus = async (word: string, status: VocabularyStatus) => {
    const updatedAt = Date.now()
    setState({
      ...state,
      statuses: { ...state.statuses, [word]: status },
      statusUpdatedAt: { ...state.statusUpdatedAt, [word]: updatedAt },
    })
    await sendMessage("updateVocabularyWord", { word, status, updatedAt })
    void syncKnownWord(word, status === "known", dictionary)
  }

  const importBackupText = async (text: string, source: string) => {
    try {
      const importedWords = readWordHunterBackup(text)
      const lemmas = new Set(
        importedWords.map(
          (word) => dictionary.get(word.toLocaleLowerCase())?.lemma ?? word.toLocaleLowerCase(),
        ),
      )
      const statuses: VocabularyHunterState["statuses"] = {}
      const statusUpdatedAt: VocabularyHunterState["statusUpdatedAt"] = {}
      const importedAt = Date.now()
      lemmas.forEach((word) => {
        statuses[word] = "known"
        statusUpdatedAt[word] = importedAt
      })
      const nextState = await sendMessage("mergeVocabularyWordData", {
        statuses,
        updatedAt: statusUpdatedAt,
      })
      setState(nextState)
      await syncKnownWords(lemmas, dictionary)
      setSyncMessage(`已从${source}导入并同步 ${lemmas.size} 个已掌握单词`)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "导入失败")
    }
  }

  const importWordHunterBackup = async (file: File) => {
    await importBackupText(await file.text(), "备份文件")
  }

  const importFromGist = async () => {
    setGistLoading(true)
    setSyncMessage("")
    try {
      const backup = await fetchWordHunterGist(gistUrl, gistToken)
      await importBackupText(backup, "GitHub Gist")
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Gist 导入失败")
    } finally {
      setGistLoading(false)
    }
  }

  const syncToGist = async () => {
    setGistLoading(true)
    setSyncMessage("")
    try {
      await setVocabularyHunterGistToken(gistToken)
      await sendMessage("patchVocabularyPreferences", {
        gistId: gistUrl.trim(),
        gistAutoSync: true,
      })
      const result = await sendMessage("syncVocabularyGist", undefined)
      const nextState = await getVocabularyHunterState()
      setState(nextState)
      if (!result.ok) throw new Error(nextState.gistSyncError || "同步到 Gist 失败")
      setSyncMessage(
        `同步成功：Gist 中共有 ${nextState.gistLastSyncCount} 个已掌握单词，自动同步已开启`,
      )
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "同步到 Gist 失败")
    } finally {
      setGistLoading(false)
    }
  }

  const createWordbook = async () => {
    const next = await sendMessage("createVocabularyWordbook", { name: newWordbookName })
    if (next === state || next.activeWordbook !== newWordbookName.trim().replace(/\s+/g, " ")) {
      setWordbookMessage("请输入 1–40 个字符的有效名称")
      return
    }
    setState(next)
    setNewWordbookName("")
    setWordbookMessage(`已创建并切换到“${next.activeWordbook}”`)
  }

  const exportActiveWordbook = (date?: string) => {
    const bookWords = state.wordbooks[state.activeWordbook] ?? []
    const addedAt = state.wordbookAddedAt[state.activeWordbook] ?? {}
    const dayStart = date ? new Date(`${date}T00:00:00`).getTime() : 0
    const dayEnd = date ? new Date(`${date}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY
    const exportedWords = bookWords
      .filter(
        (word) => !date || ((addedAt[word] ?? 0) >= dayStart && (addedAt[word] ?? 0) <= dayEnd),
      )
      .sort()
    if (exportedWords.length === 0) {
      setWordbookMessage(date ? `${date} 没有新增单词` : "当前生词本还没有单词")
      return
    }
    const blob = new Blob([`${exportedWords.join("\n")}\n`], {
      type: "text/plain;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    const safeName = state.activeWordbook.replace(/[\\/:*?"<>|]/g, "-")
    anchor.download = `${safeName}${date ? `-${date}` : ""}.txt`
    anchor.click()
    URL.revokeObjectURL(url)
    setWordbookMessage(`已导出 ${exportedWords.length} 个单词，每行一个`)
  }

  return (
    <PageLayout
      title="生词猎手"
      description="在网页中识别、标注和复习你的英语词汇，并同步个人学习状态。"
      innerClassName="flex flex-col px-8"
    >
      <ConfigCard
        layout="stacked"
        title="网页生词标注"
        description="生词卡会在鼠标悬浮时出现，不再显示独立的页面按钮。"
      >
        <div className="flex flex-col gap-5 rounded-xl border p-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block font-medium">启用生词标注</span>
              <span className="text-sm text-muted-foreground">
                红色为未掌握，琥珀色为待巩固；已掌握的词不再标注。
              </span>
            </span>
            <Switch
              checked={state.enabled}
              onCheckedChange={(enabled) => updateState({ ...state, enabled })}
            />
          </label>
          <div>
            <div className="mb-3 font-medium">标注颜色</div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex items-center justify-between rounded-xl border p-3">
                <span>
                  <span className="block text-sm font-medium">未掌握</span>
                  <span className="text-xs text-muted-foreground">尚未掌握词汇的底色</span>
                </span>
                <input
                  type="color"
                  className="h-9 w-12 cursor-pointer rounded border bg-transparent p-1"
                  value={state.unknownHighlightColor}
                  onChange={(event) =>
                    updateState({ ...state, unknownHighlightColor: event.target.value })
                  }
                />
              </label>
              <label className="flex items-center justify-between rounded-xl border p-3">
                <span>
                  <span className="block text-sm font-medium">待巩固</span>
                  <span className="text-xs text-muted-foreground">记忆不稳定词汇的底色</span>
                </span>
                <input
                  type="color"
                  className="h-9 w-12 cursor-pointer rounded border bg-transparent p-1"
                  value={state.fuzzyHighlightColor}
                  onChange={(event) =>
                    updateState({ ...state, fuzzyHighlightColor: event.target.value })
                  }
                />
              </label>
            </div>
          </div>
          <div>
            <div className="mb-3 font-medium">标注词汇等级</div>
            <div className="grid gap-2 md:grid-cols-2">
              {VOCABULARY_LEVELS.map((level) => (
                <label
                  key={level.id}
                  className="flex items-center justify-between rounded-xl border p-3"
                >
                  <span>
                    <span className="block text-sm font-medium">{level.label}</span>
                    <span className="text-xs text-muted-foreground">{level.description}</span>
                  </span>
                  <Switch
                    checked={state.enabledLevels.includes(level.id)}
                    onCheckedChange={(checked) =>
                      updateState({
                        ...state,
                        enabledLevels: checked
                          ? [...state.enabledLevels, level.id]
                          : state.enabledLevels.filter((item) => item !== level.id),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </div>
          <div className="rounded-xl bg-muted/60 p-4">
            <div className="font-medium">悬浮卡快捷键</div>
            <p className="mt-1 text-sm text-muted-foreground">
              悬浮卡打开时：A 标记为已掌握，S 标记为待巩固，D
              标记为未掌握。也可以先在网页中选中一个英文单词，再按 D
              将它重新加入未掌握。快捷键会直接显示在悬浮卡按钮中；输入框和编辑区域内不会触发。
            </p>
          </div>
        </div>
      </ConfigCard>

      <ConfigCard
        layout="stacked"
        title="生词本"
        description="标记为未掌握的单词会自动加入当前生词本；默认使用“托福生词”。"
      >
        <div className="flex flex-col gap-4 rounded-xl border p-5">
          <label className="grid gap-2">
            <span className="text-sm font-medium">新单词加入到</span>
            <select
              className="h-10 rounded-lg border bg-background px-3 text-sm"
              value={state.activeWordbook}
              onChange={(event) => updateState({ ...state, activeWordbook: event.target.value })}
            >
              {Object.entries(state.wordbooks).map(([name, bookWords]) => (
                <option key={name} value={name}>
                  {name}（{bookWords.length}）
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={newWordbookName}
              maxLength={40}
              placeholder="新建生词本名称"
              onChange={(event) => setNewWordbookName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createWordbook()
              }}
            />
            <Button variant="outline" disabled={!newWordbookName.trim()} onClick={createWordbook}>
              新建并选中
            </Button>
          </div>
          <div className="grid gap-2 rounded-xl bg-muted/50 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <input
              type="date"
              className="h-10 rounded-lg border bg-background px-3 text-sm"
              value={wordbookExportDate}
              onChange={(event) => setWordbookExportDate(event.target.value)}
            />
            <Button onClick={() => exportActiveWordbook(wordbookExportDate)}>导出所选日期</Button>
            <Button variant="outline" onClick={() => exportActiveWordbook()}>
              导出全部
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            当前“{state.activeWordbook}”共有 {state.wordbooks[state.activeWordbook]?.length ?? 0}
            个单词。单词之后改为已掌握或待巩固时，仍会保留在生词本中。
          </p>
          {wordbookMessage && <p className="text-sm text-emerald-700">{wordbookMessage}</p>}
        </div>
      </ConfigCard>

      <ConfigCard
        layout="stacked"
        title="内嵌词典"
        description="释义直接显示在网页悬浮卡中，不会打开新的词典网页。海词默认排在第一位。"
      >
        <div className="grid gap-2 md:grid-cols-2">
          {(Object.keys(DICTIONARY_LABELS) as VocabularyDictionary[]).map((item) => (
            <label key={item} className="flex items-center justify-between rounded-xl border p-4">
              <span
                className={
                  item === "ai" ? "text-violet-700" : item === "haici" ? "text-emerald-700" : ""
                }
              >
                {DICTIONARY_LABELS[item]}
              </span>
              <Switch
                checked={state.enabledDictionaries.includes(item)}
                onCheckedChange={(checked) =>
                  updateState({
                    ...state,
                    enabledDictionaries: checked
                      ? [...state.enabledDictionaries, item]
                      : state.enabledDictionaries.filter((value) => value !== item),
                  })
                }
              />
            </label>
          ))}
        </div>
      </ConfigCard>

      <ConfigCard
        layout="stacked"
        title="已掌握词汇同步"
        description="已掌握单词使用与 Word Hunter 类似的压缩位图写入 Chrome Sync，可在登录同一 Chrome 账号的设备间同步。"
      >
        <div className="flex flex-col gap-5 rounded-xl border p-5">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl bg-emerald-50 p-4 dark:bg-emerald-950/30">
              <span className="block text-2xl font-semibold text-emerald-700">{counts.known}</span>
              <span className="text-sm text-emerald-800/70">本地已掌握</span>
            </div>
            <div className="rounded-xl bg-blue-50 p-4 dark:bg-blue-950/30">
              <span className="block text-2xl font-semibold text-blue-700">
                {state.gistLastSyncCount || "—"}
              </span>
              <span className="text-sm text-blue-800/70">上次同步后的 Gist 词数</span>
            </div>
            <div className="rounded-xl bg-violet-50 p-4 dark:bg-violet-950/30">
              <span className="block text-sm font-semibold text-violet-700">
                {state.gistLastSyncAt
                  ? new Date(state.gistLastSyncAt).toLocaleString()
                  : "尚未同步"}
              </span>
              <span className="mt-1 block text-sm text-violet-800/70">最近 Gist 同步</span>
            </div>
          </div>

          <div className="rounded-xl bg-muted/50 p-5">
            <div className="mb-4 font-medium">同步流程</div>
            <div className="grid items-center gap-2 text-center md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
              <div className="rounded-xl border bg-background p-3">
                <span className="mx-auto mb-2 grid size-8 place-items-center rounded-full bg-emerald-100 font-semibold text-emerald-700">
                  1
                </span>
                <span className="block text-sm font-medium">本地词汇</span>
                <span className="text-xs text-muted-foreground">收集已掌握状态</span>
              </div>
              <span className="hidden text-xl text-muted-foreground md:block">→</span>
              <div className="rounded-xl border bg-background p-3">
                <span className="mx-auto mb-2 grid size-8 place-items-center rounded-full bg-amber-100 font-semibold text-amber-700">
                  2
                </span>
                <span className="block text-sm font-medium">安全合并</span>
                <span className="text-xs text-muted-foreground">保留本地与远程单词</span>
              </div>
              <span className="hidden text-xl text-muted-foreground md:block">→</span>
              <div className="rounded-xl border bg-background p-3">
                <span className="mx-auto mb-2 grid size-8 place-items-center rounded-full bg-blue-100 font-semibold text-blue-700">
                  3
                </span>
                <span className="block text-sm font-medium">GitHub Gist</span>
                <span className="text-xs text-muted-foreground">更新 Word Hunter 备份</span>
              </div>
              <span className="hidden text-xl text-muted-foreground md:block">→</span>
              <div className="rounded-xl border bg-background p-3">
                <span className="mx-auto mb-2 grid size-8 place-items-center rounded-full bg-violet-100 font-semibold text-violet-700">
                  4
                </span>
                <span className="block text-sm font-medium">其他设备</span>
                <span className="text-xs text-muted-foreground">再次导入或同步</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => importInputRef.current?.click()}>
              导入 Word Hunter 备份
            </Button>
            <input
              ref={importInputRef}
              hidden
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void importWordHunterBackup(file)
                event.target.value = ""
              }}
            />
            <span className="text-sm text-muted-foreground">
              支持 Word Hunter 导出的 word_hunter_backup_*.json
            </span>
          </div>
          <div className="grid gap-3 border-t pt-4">
            <div>
              <div className="font-medium">GitHub Gist 双向同步</div>
              <p className="mt-1 text-sm text-muted-foreground">
                “导入”只读取远程数据；“合并并同步”会先保留 Gist 中的单词，再加入本地已掌握词汇。
              </p>
            </div>
            <Input
              value={gistUrl}
              onChange={(event) => setGistUrl(event.target.value)}
              placeholder="Gist 地址或 ID"
            />
            <Input
              type="password"
              value={gistToken}
              onChange={(event) => setGistToken(event.target.value)}
              placeholder="私有 Gist 访问令牌（公开 Gist 留空）"
            />
            <label className="flex items-center justify-between rounded-xl border p-3">
              <span>
                <span className="block text-sm font-medium">自动同步到 Gist</span>
                <span className="text-xs text-muted-foreground">
                  已掌握词汇变化后延迟合并上传，避免频繁请求。
                </span>
              </span>
              <Switch
                checked={state.gistAutoSync}
                disabled={!gistToken.trim() || !state.gistId}
                onCheckedChange={(gistAutoSync) => updateState({ ...state, gistAutoSync })}
              />
            </label>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                disabled={!gistUrl.trim() || gistLoading}
                onClick={() => void importFromGist()}
              >
                {gistLoading ? "正在导入…" : "导入 Gist"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!gistUrl.trim() || !gistToken.trim() || gistLoading}
                onClick={() => void syncToGist()}
              >
                {gistLoading ? "正在同步…" : "保存令牌并开启自动同步"}
              </Button>
              <span className="text-xs text-muted-foreground">
                令牌保存在本机扩展存储中，不会写入 Chrome Sync 或 Gist。
              </span>
            </div>
          </div>
          {state.gistSyncError ? (
            <p className="text-sm text-red-600">自动同步失败：{state.gistSyncError}</p>
          ) : null}
          {syncMessage ? <p className="text-sm text-emerald-700">{syncMessage}</p> : null}
        </div>
      </ConfigCard>

      <ConfigCard
        layout="stacked"
        title="我的词汇"
        description="按难度从学术扩展、托福/GRE、雅思到基础词排序，集中查询你的学习判断。"
      >
        <div className="flex flex-col gap-6">
          <div className="grid gap-3 md:grid-cols-3">
            {(["known", "fuzzy", "unknown"] as const).map((status) => (
              <button
                key={status}
                type="button"
                className="group relative overflow-hidden rounded-2xl border bg-background p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                onClick={() => setFilter(status)}
              >
                <span
                  className="absolute inset-y-0 left-0 w-1.5"
                  style={{ backgroundColor: STATUS_COLORS[status] }}
                />
                <span className="block text-3xl font-bold tracking-tight">{counts[status]}</span>
                <span className="mt-1 block text-sm font-medium">{STATUS_LABELS[status]}</span>
                <span className="mt-2 block text-xs text-muted-foreground">点击查看对应词汇</span>
              </button>
            ))}
          </div>

          <div className="rounded-2xl border bg-gradient-to-br from-background to-muted/35 p-5 shadow-sm">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold">学习状态概览</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  饼图看占比，柱状图比较数量，折线图查看近 7 天状态记录。
                </p>
              </div>
              <div className="flex rounded-xl border bg-background p-1">
                {(
                  [
                    ["pie", "饼状图"],
                    ["bar", "直方图"],
                    ["line", "折线图"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      chartMode === mode
                        ? "bg-foreground text-background shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() => setChartMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-[300px] w-full">
              <VocabularyChart mode={chartMode} chartData={chartData} timelineData={timelineData} />
            </div>
            <div className="mt-2 flex flex-wrap justify-center gap-5">
              {chartData.map((item) => (
                <span key={item.status} className="flex items-center gap-2 text-xs">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                  {item.name} · {item.value}
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border bg-muted/20 p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-wrap gap-2">
                {(["all", "known", "fuzzy", "unknown"] as const).map((item) => (
                  <Button
                    key={item}
                    variant={filter === item ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFilter(item)}
                  >
                    {item === "all"
                      ? `全部 ${counts.known + counts.fuzzy + counts.unknown}`
                      : `${STATUS_LABELS[item]} ${counts[item]}`}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="h-9 rounded-lg border bg-background px-3 text-sm"
                  value={vocabularySort}
                  onChange={(event) => setVocabularySort(event.target.value as VocabularySort)}
                  aria-label="词汇排序"
                >
                  <option value="difficulty">按难度排序</option>
                  <option value="alphabetical">按字母排序</option>
                  <option value="recent">按最近判断排序</option>
                </select>
                <div className="flex rounded-lg border bg-background p-1">
                  <button
                    type="button"
                    className={`rounded-md px-3 py-1 text-xs ${
                      vocabularyView === "study"
                        ? "bg-foreground text-background"
                        : "text-muted-foreground"
                    }`}
                    onClick={() => setVocabularyView("study")}
                  >
                    学习卡片
                  </button>
                  <button
                    type="button"
                    className={`rounded-md px-3 py-1 text-xs ${
                      vocabularyView === "compact"
                        ? "bg-foreground text-background"
                        : "text-muted-foreground"
                    }`}
                    onClick={() => setVocabularyView("compact")}
                  >
                    紧凑列表
                  </button>
                </div>
                <Input
                  className="w-56 bg-background"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索单词"
                />
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-1">
              <button
                type="button"
                className={`min-w-8 rounded-md px-2 py-1 text-xs ${
                  letterFilter
                    ? "text-muted-foreground hover:bg-background"
                    : "bg-foreground text-background"
                }`}
                onClick={() => setLetterFilter("")}
              >
                全部
              </button>
              {ALPHABET.map((letter) => (
                <button
                  key={letter}
                  type="button"
                  className={`size-7 rounded-md text-xs ${
                    letterFilter === letter
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-background"
                  }`}
                  onClick={() => setLetterFilter(letterFilter === letter ? "" : letter)}
                >
                  {letter}
                </button>
              ))}
            </div>
          </div>

          {selectedWord && (
            <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50/80 to-background p-5 shadow-sm dark:border-emerald-900 dark:from-emerald-950/25">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-2xl font-bold tracking-tight">{selectedWord}</h3>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {getVocabularyLevel(dictionary.get(selectedWord)?.level).label}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    点击列表中的其他单词可直接切换，无需打开新网页。
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setSelectedWord("")}>
                  收起
                </Button>
              </div>

              <div className="mt-4 flex gap-2">
                {(["haici", "google"] as const).map((item) => (
                  <Button
                    key={item}
                    size="sm"
                    variant={lookupDictionary === item ? "default" : "outline"}
                    onClick={() => setLookupDictionary(item)}
                  >
                    {item === "haici" ? "海词" : "Google"}
                  </Button>
                ))}
              </div>

              <div className="mt-4 rounded-xl border bg-background/90 p-4">
                {definitionLoading ? (
                  <p className="text-sm text-muted-foreground">正在查询中文释义…</p>
                ) : definitionError ? (
                  <p className="text-sm text-destructive">{definitionError}</p>
                ) : definition?.entry ? (
                  <div className="space-y-4">
                    {definition.entry.phonetics.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {definition.entry.phonetics.map((item) => (
                          <span
                            key={`${item.region}-${item.value}`}
                            className="rounded-lg bg-sky-50 px-3 py-1.5 font-mono text-sm text-sky-900 dark:bg-sky-950/40 dark:text-sky-200"
                          >
                            <b className="mr-2 font-sans text-xs text-sky-600">{item.region}</b>
                            {item.value}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="space-y-2">
                      {definition.entry.meanings.map((item) => (
                        <div
                          key={`${item.partOfSpeech}-${item.definition}`}
                          className="grid gap-2 sm:grid-cols-[64px_1fr]"
                        >
                          <span className="h-fit rounded-lg bg-emerald-50 px-2 py-1 text-center text-xs font-bold text-emerald-700 dark:bg-emerald-950/40">
                            {item.partOfSpeech}
                          </span>
                          <span className="text-sm leading-6">{item.definition}</span>
                        </div>
                      ))}
                    </div>
                    {definition.entry.forms && (
                      <p className="border-t pt-3 text-sm text-muted-foreground">
                        {definition.entry.forms}
                      </p>
                    )}
                    {definition.entry.details && (
                      <details className="border-t pt-3">
                        <summary className="cursor-pointer text-sm font-medium text-emerald-700">
                          查看更多释义与用法
                        </summary>
                        <p className="mt-3 max-h-64 overflow-auto text-sm leading-6 whitespace-pre-wrap text-muted-foreground">
                          {definition.entry.details}
                        </p>
                      </details>
                    )}
                  </div>
                ) : definition ? (
                  <p className="text-sm leading-7 whitespace-pre-wrap">{definition.text}</p>
                ) : null}
              </div>
            </div>
          )}

          <div className="rounded-2xl border bg-background shadow-sm">
            {words.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">暂无匹配单词</p>
            ) : vocabularyView === "compact" ? (
              <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {pagedWords.map(([word, status]) => (
                  <button
                    key={word}
                    type="button"
                    className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left transition hover:border-foreground/25 hover:bg-muted/40 ${
                      selectedWord === word ? "border-emerald-500 bg-emerald-50/60" : ""
                    }`}
                    onClick={() => setSelectedWord(selectedWord === word ? "" : word)}
                  >
                    <span className="truncate text-sm font-semibold">{word}</span>
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: STATUS_COLORS[status] }}
                      title={STATUS_LABELS[status]}
                    />
                  </button>
                ))}
              </div>
            ) : (
              <ul className="divide-y">
                {pagedWords.map(([word, status]) => (
                  <li
                    key={word}
                    className={`flex flex-col gap-3 px-5 py-4 transition hover:bg-muted/35 sm:flex-row sm:items-center sm:justify-between ${
                      selectedWord === word ? "bg-emerald-50/60 dark:bg-emerald-950/20" : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 text-left"
                      onClick={() => setSelectedWord(selectedWord === word ? "" : word)}
                    >
                      <span className="text-base font-semibold">{word}</span>
                      <span className="ml-3 text-xs text-muted-foreground">
                        {selectedWord === word ? "收起释义" : "查看中文释义与音标"}
                      </span>
                      <span className="mt-2 flex flex-wrap items-center gap-2">
                        <span
                          className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium text-white"
                          style={{ backgroundColor: STATUS_COLORS[status] }}
                        >
                          {STATUS_LABELS[status]}
                        </span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                          {getVocabularyLevel(dictionary.get(word)?.level).label}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {state.statusUpdatedAt[word]
                            ? `最近判断 ${new Date(state.statusUpdatedAt[word]).toLocaleDateString()}`
                            : "历史导入"}
                        </span>
                      </span>
                    </button>
                    <div className="flex flex-wrap gap-1">
                      {status !== "known" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => updateWordStatus(word, "known")}
                        >
                          已掌握
                        </Button>
                      )}
                      {status !== "fuzzy" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => updateWordStatus(word, "fuzzy")}
                        >
                          待巩固
                        </Button>
                      )}
                      {status !== "unknown" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => updateWordStatus(word, "unknown")}
                        >
                          未掌握
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => removeWord(word)}>
                        清除判断
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {words.length > PAGE_SIZE && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/20 px-4 py-3">
              <span className="text-sm text-muted-foreground">
                共 {words.length} 个词，第 {page} / {pageCount} 页，每页 {PAGE_SIZE} 个
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pageCount}
                  onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                >
                  下一页
                </Button>
              </div>
            </div>
          )}
        </div>
      </ConfigCard>
    </PageLayout>
  )
}

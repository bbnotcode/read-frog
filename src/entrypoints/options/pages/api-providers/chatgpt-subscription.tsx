import type { APIProviderConfig } from "@/types/config/provider"
import { Icon } from "@iconify/react"
import { useAtom, useSetAtom } from "jotai"
import { useCallback, useEffect, useRef, useState } from "react"
import { browser } from "#imports"
import { Button } from "@/components/ui/base-ui/button"
import { configFieldsAtomMap, writeConfigAtom } from "@/utils/atoms/config"
import { buildFeatureProviderPatch } from "@/utils/constants/feature-providers"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { selectedProviderIdAtom } from "./providers-config/atoms"

const base = "http://127.0.0.1:17373"
const url = `${base}/v1/responses`
const inputClass =
  "h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"

export function ChatGPTSubscription() {
  const [providers, setProviders] = useAtom(configFieldsAtomMap.providersConfig)
  const selectProvider = useSetAtom(selectedProviderIdAtom)
  const writeConfig = useSetAtom(writeConfigAtom)
  const [pairing, setPairing] = useState("")
  const [model, setModel] = useState("")
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [account, setAccount] = useState("")
  const [connected, setConnected] = useState(false)
  const [reachable, setReachable] = useState(false)
  const [status, setStatus] = useState("")
  const [busy, setBusy] = useState(false)
  const [custom, setCustom] = useState(false)
  const [dailyLimit, setDailyLimit] = useState("50000")
  const [automaticAI, setAutomaticAI] = useState(false)
  const refreshVersion = useRef(0)
  const [usage, setUsage] = useState<{
    budget?: {
      limit: number
      extra: number
      used: number
      reserved?: number
      estimated?: number
      total: number
      remaining: number
      percent: number
      resetAt: string
      low?: boolean
      exceeded?: number
    }
    startedAt?: string
    models: Record<string, { requests: number; input: number; output: number; reasoning: number }>
  }>({ models: {} })

  const localCall = useCallback(async (path: string, method = "GET") => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "X-ReadFrog-Local": "1" },
      signal: AbortSignal.timeout(35000),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || "本地服务请求失败")
    return data
  }, [])
  const refresh = useCallback(
    async (includeModels = true) => {
      const version = ++refreshVersion.current
      let localRead = false
      setBusy(true)
      try {
        const data = await localCall("/local-status")
        if (version !== refreshVersion.current) return
        localRead = true
        setReachable(true)
        setConnected(data.connected)
        setAccount(data.email || "")
        setPairing(data.pairing)
        // Budget stays available even while offline from OpenAI or logged out.
        const usageResponse = await fetch(`${base}/usage`, {
          headers: { Authorization: `Bearer ${data.pairing}` },
          signal: AbortSignal.timeout(10000),
        })
        if (usageResponse.ok) {
          const currentUsage = await usageResponse.json()
          if (version !== refreshVersion.current) return
          setUsage(currentUsage)
          if (currentUsage.budget) setDailyLimit(String(currentUsage.budget.limit))
        }
        if (!data.connected) {
          setModels([])
          setStatus("本地服务已连接，请登录 ChatGPT。预算可以正常查看。")
          return
        }
        if (!includeModels) {
          setStatus("用量已更新。未重新请求模型列表。")
          return
        }
        const response = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${data.pairing}` },
          signal: AbortSignal.timeout(15000),
        })
        const catalog = await response.json()
        if (version !== refreshVersion.current) return
        if (!response.ok)
          throw new Error(
            `模型列表暂不可读取：${catalog.error || response.status}。本地连接与预算已更新。`,
          )
        setModels(catalog.models || [])
        setStatus("已读取当前账户的模型列表。选择后可测试调用权限。")
      } catch (error) {
        if (version !== refreshVersion.current) return
        if (!localRead) {
          setReachable(false)
          setConnected(false)
          setAccount("")
          setPairing("")
          setModels([])
          setUsage({ models: {} })
        }
        setStatus(
          error instanceof TypeError
            ? "连接请求失败。可先用 Raycast 查看或启动 ReadFrog ChatGPT；如果预算已更新，可能仅是 OpenAI 模型列表暂不可用。"
            : String(error),
        )
      } finally {
        if (version === refreshVersion.current) setBusy(false)
      }
    },
    [localCall],
  )
  useEffect(() => {
    let active = true
    void (async () => {
      const data = await browser.storage.local.get(["wordHunterChatGPT", "wordHunterAutoAI"])
      if (!active) return
      const saved = data.wordHunterChatGPT as { pairing?: string; model?: string } | undefined
      setPairing(saved?.pairing || "")
      setModel(saved?.model || "gpt-6.1-sol")
      setAutomaticAI(data.wordHunterAutoAI === true)
    })()
    return () => {
      active = false
    }
  }, [])
  // Refresh after the OAuth window returns; no background polling when settings are closed.
  useEffect(() => {
    const onFocus = () => {
      void refresh(false)
    }
    window.addEventListener("focus", onFocus)
    queueMicrotask(() => {
      void refresh()
    })
    return () => {
      window.removeEventListener("focus", onFocus)
      refreshVersion.current += 1
    }
  }, [refresh])
  async function login() {
    setBusy(true)
    try {
      const data = await localCall("/login", "POST")
      const auth = new URL(data.url)
      if (auth.origin !== "https://auth.openai.com") throw new Error("无效的授权地址")
      await browser.windows.create({ url: auth.href, type: "popup", width: 600, height: 760 })
      setStatus("请在 OpenAI 安全窗口完成授权，返回此页后点击刷新连接。无需复制配对码。")
    } catch (error) {
      setStatus(String(error))
    } finally {
      setBusy(false)
    }
  }
  async function testModel() {
    setBusy(true)
    try {
      const response = await fetch(`${base}/explain`, {
        method: "POST",
        headers: { Authorization: `Bearer ${pairing}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model.trim(),
          word: "hello",
          sentence: "Hello, welcome to ReadFrog.",
        }),
        signal: AbortSignal.timeout(95000),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setModels((current) =>
        current.some((item) => item.id === model.trim())
          ? current
          : [...current, { id: model.trim(), name: `${model.trim()} · 已验证` }],
      )
      setStatus(
        `模型 ${data.model || model} 调用成功。${data.cached ? "命中本地缓存，本次未请求 OpenAI。" : `本次输入 ${data.usage?.input_tokens ?? "未知"}、输出 ${data.usage?.output_tokens ?? "未知"} tokens（输出包含推理）；测试也会消耗套餐额度。`}`,
      )
    } catch (error) {
      setStatus(String(error))
    } finally {
      setBusy(false)
    }
  }
  async function save(applyTranslations = false) {
    if (!pairing || !model.trim()) {
      setStatus("请先刷新连接，并填写模型 ID。")
      return
    }
    setBusy(true)
    try {
      await browser.storage.local.set({ wordHunterChatGPT: { pairing, model: model.trim() } })
      const existing = providers.find((p) => p.provider === "open-responses" && p.url === url)
      const provider: APIProviderConfig = {
        ...DEFAULT_PROVIDER_CONFIG["open-responses"],
        ...(existing?.provider === "open-responses" ? existing : {}),
        id: existing?.id || crypto.randomUUID(),
        name: "ChatGPT 订阅（本地）",
        enabled: true,
        provider: "open-responses",
        url,
        apiKey: "",
        model: { model: "use-custom-model", isCustomModel: true, customModel: model.trim() },
      }
      await setProviders(
        existing
          ? providers.map((p) => (p.id === existing.id ? provider : p))
          : [...providers, provider],
      )
      await selectProvider(provider.id)
      await writeConfig((current) => ({
        selectionToolbar: {
          ...current.selectionToolbar,
          builtInActions: {
            ...current.selectionToolbar.builtInActions,
            dictionary: {
              ...current.selectionToolbar.builtInActions.dictionary,
              enabled: true,
              providerId: provider.id,
            },
          },
        },
      }))
      if (applyTranslations)
        await writeConfig(
          buildFeatureProviderPatch({
            pageTranslation: provider.id,
            videoSubtitles: provider.id,
            selectionTranslation: provider.id,
            inputTranslation: provider.id,
          }),
        )
      setStatus(
        applyTranslations
          ? "已保存并应用到网页、视频字幕、划词和输入翻译。"
          : "已保存。单词解释立即使用此模型；翻译和 AI 指令请在下方功能配置中选择此提供商。",
      )
    } catch (error) {
      setStatus(String(error))
    } finally {
      setBusy(false)
    }
  }
  const listed = models.some((m) => m.id === model)
  const modelUsage = usage.models[model]
  async function updateBudget(add?: number) {
    setBusy(true)
    try {
      const response = await fetch(`${base}/budget`, {
        method: "POST",
        headers: { Authorization: `Bearer ${pairing}`, "Content-Type": "application/json" },
        body: JSON.stringify(add ? { add } : { limit: Number(dailyLimit) }),
        signal: AbortSignal.timeout(10000),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "预算保存失败")
      setUsage((current) => ({ ...current, budget: data.budget }))
      setStatus(
        add
          ? "已追加今日预算，明天恢复每日目标。"
          : "每日阅读预算已保存，剩余 20% 时提醒，不会强制停用。",
      )
    } catch (error) {
      setStatus(String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="overflow-hidden rounded-2xl border bg-background shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-emerald-500/5 px-6 py-5">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-emerald-600 text-white">
            <Icon icon="simple-icons:openai" className="size-6" />
          </span>
          <div>
            <h2 className="text-base font-semibold">ChatGPT 订阅</h2>
            <p className="mt-1 text-xs text-muted-foreground">你自己的账户 · 本地安全接入</p>
          </div>
        </div>
        <span className="rounded-full border px-3 py-1 text-xs">
          {connected ? "✓ 已登录" : reachable ? "待登录" : "尚未检查连接"}
        </span>
      </div>
      <div className="space-y-5 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{account || "连接你的 ChatGPT 账户"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              凭据留在本机，配对自动完成。仅授权登录需要打开 OpenAI 安全窗口。
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
              刷新连接
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void login()}>
              {connected ? "重新授权" : "登录 ChatGPT"}
            </Button>
          </div>
        </div>
        <form
          action="#"
          method="POST"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
          className="space-y-4"
        >
          <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="chatgpt-model">
            接入模型（翻译与单词解释）
            <select
              id="chatgpt-model"
              className={inputClass}
              value={custom ? "__custom__" : model}
              onChange={(event) => {
                if (event.target.value === "__custom__") setCustom(true)
                else {
                  setCustom(false)
                  setModel(event.target.value)
                }
              }}
            >
              {!listed && (
                <option value={model}>{model || "选择模型"}（尚未在账户列表中确认）</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
              {[
                { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
                { id: "gpt-6-sol", name: "GPT-6 Sol" },
                { id: "gpt-6-luna", name: "GPT-6 Luna" },
              ]
                .filter((item) => item.id !== model && !models.some((m) => m.id === item.id))
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}（待测试）
                  </option>
                ))}
              <option value="__custom__">手动输入模型 ID…</option>
            </select>
          </label>
          {custom && (
            <label className="flex flex-col gap-2 text-sm" htmlFor="chatgpt-custom-model">
              自定义模型 ID
              <input
                id="chatgpt-custom-model"
                name="model"
                className={inputClass}
                value={model}
                required
                maxLength={100}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-6.1-sol"
              />
            </label>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            模型列表来自此接入接口，不等同于 Codex
            菜单。新模型可以手动输入，但只有测试成功才表示当前账户能调用。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              保存配置
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void save(true)}>
              保存并用于四项翻译
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !connected || !model.trim()}
              onClick={() => void testModel()}
            >
              测试模型（消耗少量额度）
            </Button>
          </div>
        </form>
        <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={automaticAI}
            onChange={async (event) => {
              const enabled = event.target.checked
              try {
                await browser.storage.local.set({ wordHunterAutoAI: enabled })
                setAutomaticAI(enabled)
              } catch (error) {
                setStatus(`自动解释设置保存失败：${String(error)}`)
              }
            }}
          />
          <span>
            悬停自动 AI 解释（消耗额度）
            <span className="mt-1 block text-xs text-muted-foreground">
              默认关闭：悬停使用本地词典，点击 AI 解释才请求。开启后，选择过 AI
              的页面会对后续悬停词自动生成。
            </span>
          </span>
        </label>
        <div className="rounded-xl border p-4" aria-label="ChatGPT 订阅用量">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{model || "当前模型"} 用量</h3>
            <a
              className="text-xs text-emerald-700 underline dark:text-emerald-400"
              href="https://chatgpt.com/#settings"
              target="_blank"
              rel="noopener noreferrer"
            >
              官方设置 → Usage 查看额度
            </a>
          </div>
          <div className="mt-5 border-t pt-4">
            <div className="flex justify-between gap-3 text-sm">
              <h4 className="font-medium">每日阅读预算 · 所有本地 ChatGPT 模型共享</h4>
              <span>{usage.budget ? `剩余 ${usage.budget.percent}%` : "预算数据暂不可读取"}</span>
            </div>
            <progress
              aria-label="每日阅读预算剩余"
              max={100}
              value={usage.budget?.percent ?? 0}
              className="mt-3 h-2 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-foreground"
            />
            <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {usage.budget
                  ? `已用 ${usage.budget.used.toLocaleString()} / ${usage.budget.total.toLocaleString()} tokens`
                  : "请刷新连接或更新本地服务"}
              </span>
              <span>
                {usage.budget
                  ? `${new Date(usage.budget.resetAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 重置（北京时间）`
                  : "每天 08:00 重置"}
              </span>
            </div>
            {usage.budget?.low && (
              <p
                role="status"
                className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
              >
                {usage.budget.exceeded
                  ? `今日阅读预算已超出 ${usage.budget.exceeded.toLocaleString()} tokens。`
                  : "今日阅读预算已剩余 20% 或更少。"}
                仍可继续使用或追加预算，记得为开发留出额度。这不是 Plus 账户余额。
              </p>
            )}
            {!!usage.budget?.reserved && (
              <p className="mt-2 text-xs text-muted-foreground">
                在途预占 {usage.budget.reserved.toLocaleString()} tokens，完成后按实际用量结算。
              </p>
            )}
            {!!usage.budget?.estimated && (
              <p className="mt-2 text-xs text-muted-foreground">
                已用量含 {usage.budget.estimated.toLocaleString()} tokens 保守估算（请求中断或未返回
                usage）。
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <label className="text-xs" htmlFor="chatgpt-daily-budget">
                每日预算（tokens）
              </label>
              <input
                id="chatgpt-daily-budget"
                type="number"
                min={1000}
                max={10000000}
                step={1000}
                value={dailyLimit}
                onChange={(event) => setDailyLimit(event.target.value)}
                className="h-9 w-32 rounded-md border bg-background px-2 text-sm"
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy || !usage.budget}
                onClick={() => void updateBudget()}
              >
                保存预算
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !usage.budget}
                onClick={() => void updateBudget(25000)}
              >
                今日追加 25,000
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => void refresh(false)}
              >
                刷新用量
              </Button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              默认 50,000 tokens/天，输入＋输出合计（输出包含推理）。剩余 20% 时发送一次 macOS
              提醒，每天最多一次，重启不重复。仅提醒，不强制停用或降速；追加预算后仍每天最多提醒一次。若未看到系统通知，请检查
              macOS
              通知设置和专注模式。翻译最多四条同时生成，单词解释最多一条。在途用量按估算显示、完成后结算。中断且无
              usage
              时保守计入估算，缓存解释不扣预算。预算持久保存，重启不清零；不统计其他应用，不代表
              Plus 余额或开发额度预留保证。
            </p>
          </div>
          <p className="mt-4 text-sm">Plus 账户剩余额度：暂不可读取</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            这是 Plus 共享额度，不能由本插件 token
            统计推算。下面统计今日此服务的成功调用，重启后保留，每天北京时间 08:00
            重置；点击“刷新用量”更新。旧版本未保存的模型历史统计无法补回。
          </p>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">成功调用</dt>
              <dd className="mt-1 font-semibold">{modelUsage?.requests ?? 0} 次</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">输入 tokens</dt>
              <dd className="mt-1 font-semibold">{(modelUsage?.input ?? 0).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">输出 tokens（含推理）</dt>
              <dd className="mt-1 font-semibold">{(modelUsage?.output ?? 0).toLocaleString()}</dd>
            </div>
          </dl>
        </div>
        <div className="rounded-xl bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          单词解释仅主动点击时请求，采用短回答与低推理档；相同模型、单词及句子在服务运行期间命中缓存时不重复消耗。实际
          tokens 会显示在解释下方，无法直接换算为 Plus 剩余额度百分比。
        </div>
        {status && (
          <p
            role="status"
            aria-live="polite"
            className="rounded-lg border px-4 py-3 text-sm leading-relaxed"
          >
            {status}
          </p>
        )}
      </div>
    </section>
  )
}

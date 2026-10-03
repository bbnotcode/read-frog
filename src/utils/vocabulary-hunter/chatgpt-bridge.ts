import { browser } from "#imports"
import { readExplanationStream } from "./chatgpt-stream"

export interface ChatGPTExplanation {
  text: string
  model?: string
  cached?: boolean
  usage?: {
    input_tokens?: number
    output_tokens?: number
    output_tokens_details?: { reasoning_tokens?: number }
  }
}

async function requestExplanation(
  data: { word: string; sentence: string; model?: string },
  stream = false,
  signal?: AbortSignal,
) {
  const settings = await browser.storage.local.get("wordHunterChatGPT")
  const connection = settings.wordHunterChatGPT as { pairing?: string; model?: string } | undefined
  if (!connection?.pairing || !connection.model)
    throw new Error("请在扩展设置 → API 提供商 → ChatGPT 订阅中登录并选择模型。")
  const response = await fetch("http://127.0.0.1:17373/explain", {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.pairing}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, model: data.model || connection.model, stream }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(95000)])
      : AbortSignal.timeout(95000),
  })
  return response
}
export async function explainWithChatGPT(data: { word: string; sentence: string; model?: string }) {
  const response = await requestExplanation(data)
  const result = (await response.json()) as ChatGPTExplanation & { error?: string }
  if (!response.ok || !result.text) throw new Error(result.error || "ChatGPT 没有返回解释")
  return result
}

export async function streamWithChatGPT(
  data: { word: string; sentence: string; model: string },
  signal: AbortSignal,
  onText: (text: string) => void,
) {
  const response = await requestExplanation(data, true, signal)
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || "本地解释请求失败")
  }
  return readExplanationStream(response, onText)
}

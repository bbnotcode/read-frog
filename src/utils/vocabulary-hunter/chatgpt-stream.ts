import type { ChatGPTExplanation } from "./chatgpt-bridge"
import { browser } from "#imports"

export const CHATGPT_EXPLANATION_PORT = "word-hunter-chatgpt-explanation"
export interface ExplanationInput {
  word: string
  sentence: string
  model: string
}

/** Cancellation travels by disconnecting this request's port, never a global switch. */
export function streamVocabularyExplanation(
  data: ExplanationInput,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<ChatGPTExplanation> {
  signal.throwIfAborted()
  const port = browser.runtime.connect({ name: CHATGPT_EXPLANATION_PORT })
  return new Promise((resolve, reject) => {
    let settled = false
    // Messages keep the worker alive only during this active request (including queue wait).
    const heartbeat = setInterval(() => {
      try {
        port.postMessage({ type: "ping" })
      } catch (error) {
        finish(undefined, error)
      }
    }, 15000)
    const finish = (output?: ChatGPTExplanation, error?: unknown) => {
      if (settled) return
      settled = true
      clearInterval(heartbeat)
      signal.removeEventListener("abort", abort)
      port.onMessage.removeListener(onMessage)
      port.onDisconnect.removeListener(onDisconnect)
      try {
        port.disconnect()
      } catch {
        /* Already disconnected by the worker. */
      }
      if (output) resolve(output)
      else reject(error)
    }
    const abort = () => finish(undefined, signal.reason)
    const onDisconnect = () => finish(undefined, new Error("本地解释连接中断，请重试。"))
    const onMessage = (event: {
      type: string
      text?: string
      output?: ChatGPTExplanation
      error?: string
    }) => {
      if (event.type === "text" && typeof event.text === "string") onText(event.text)
      else if (event.type === "complete" && event.output) finish(event.output)
      else if (event.type === "error") finish(undefined, new Error(event.error || "解释失败"))
    }
    port.onMessage.addListener(onMessage)
    port.onDisconnect.addListener(onDisconnect)
    signal.addEventListener("abort", abort, { once: true })
    port.postMessage({ type: "start", data })
  })
}

/** NDJSON accepts split UTF-8 characters and incomplete network chunks. */
export async function readExplanationStream(response: Response, onText: (text: string) => void) {
  if (!response.body) throw new Error("解释没有返回内容")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (buffer.length > 1024 * 1024) throw new Error("解释内容过长")
      if (done && buffer.length && !buffer.endsWith("\n")) buffer += "\n"
      let end
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        const event = JSON.parse(line) as ChatGPTExplanation & { type: string; error?: string }
        if (event.type === "text" && typeof event.text === "string") onText(event.text)
        if (event.type === "complete" && event.text?.trim()) return event
        if (event.type === "error") throw new Error(event.error || "解释生成失败")
      }
      if (done) throw new Error("解释生成中断，请重试。")
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

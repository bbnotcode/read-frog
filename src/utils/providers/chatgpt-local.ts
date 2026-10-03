import type { ProviderConfig } from "@/types/config/provider"
import { browser } from "#imports"

export const CHATGPT_LOCAL_RESPONSES_URL = "http://127.0.0.1:17373/v1/responses"

export function isChatGPTLocalProvider(config: ProviderConfig | null | undefined): boolean {
  return config?.provider === "open-responses" && config.url === CHATGPT_LOCAL_RESPONSES_URL
}

export async function getChatGPTLocalHeaders() {
  const data = await browser.storage.local.get("wordHunterChatGPT")
  const pairing = (data.wordHunterChatGPT as { pairing?: string } | undefined)?.pairing
  if (!pairing)
    throw new Error("请在 API 提供商 → ChatGPT 订阅中刷新连接并保存配置，无需 API key。")
  return { Authorization: `Bearer ${pairing}` }
}

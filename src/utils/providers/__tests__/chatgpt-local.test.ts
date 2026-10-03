import { describe, expect, it } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { CHATGPT_LOCAL_RESPONSES_URL, isChatGPTLocalProvider } from "../chatgpt-local"

describe("ChatGPT subscription authentication exemption", () => {
  const provider = {
    ...DEFAULT_PROVIDER_CONFIG["open-responses"],
    url: CHATGPT_LOCAL_RESPONSES_URL,
  }
  it("recognizes only the dedicated local Responses endpoint", () => {
    expect(isChatGPTLocalProvider(provider)).toBe(true)
    expect(
      isChatGPTLocalProvider({ ...provider, url: "https://api.example.com/v1/responses" }),
    ).toBe(false)
    expect(
      isChatGPTLocalProvider({ ...provider, url: `${CHATGPT_LOCAL_RESPONSES_URL}.evil` }),
    ).toBe(false)
    expect(isChatGPTLocalProvider(null)).toBe(false)
    expect(isChatGPTLocalProvider(DEFAULT_PROVIDER_CONFIG.openai)).toBe(false)
  })
})

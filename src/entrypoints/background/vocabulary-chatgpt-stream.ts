import { browser } from "#imports"
import { streamWithChatGPT } from "@/utils/vocabulary-hunter/chatgpt-bridge"
import { CHATGPT_EXPLANATION_PORT } from "@/utils/vocabulary-hunter/chatgpt-stream"

export function registerVocabularyChatGPTStream() {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== CHATGPT_EXPLANATION_PORT) return
    const controller = new AbortController()
    let started = false
    const send = (event: unknown) => {
      if (controller.signal.aborted) return
      try {
        port.postMessage(event)
      } catch {
        controller.abort()
      }
    }
    port.onDisconnect.addListener(() => controller.abort())
    port.onMessage.addListener((message) => {
      if (message?.type !== "start" || started) return
      started = true
      void (async () => {
        try {
          const data = message.data
          if (
            typeof data?.word !== "string" ||
            !data.word.trim() ||
            data.word.length > 100 ||
            typeof data?.sentence !== "string" ||
            data.sentence.length > 2000 ||
            typeof data?.model !== "string" ||
            !data.model.trim() ||
            data.model.length > 100
          )
            throw new Error("无效的单词解释请求")
          const output = await streamWithChatGPT(data, controller.signal, (text) =>
            send({ type: "text", text }),
          )
          send({ type: "complete", output })
        } catch (error) {
          if (!controller.signal.aborted)
            send({ type: "error", error: error instanceof Error ? error.message : "解释失败" })
        }
      })()
    })
  })
}

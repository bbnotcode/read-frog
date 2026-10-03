// Test preload only. It intercepts upstream calls, never reaches OpenAI.
const nativeFetch = globalThis.fetch
let active = 0
globalThis.fetch = async (url, options) => {
  if (typeof url !== "string" || !url.startsWith("https://api.openai.com/v1/responses"))
    return nativeFetch(url, options)
  if (++active > 4) {
    active--
    throw new Error("Mock detected excess concurrency")
  }
  const body = JSON.parse(options.body)
  const missingUsage = JSON.stringify(body.input).includes("missing-usage")
  let finished = false
  let timer
  let deltaTimer
  const finish = () => {
    if (!finished) {
      finished = true
      active--
    }
  }
  const stream = new ReadableStream({
    start(controller) {
      const abort = () => {
        clearTimeout(timer)
        clearTimeout(deltaTimer)
        finish()
        controller.error(new Error("Mock aborted"))
      }
      options.signal?.addEventListener("abort", abort, { once: true })
      const frame = (event) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
      deltaTimer = setTimeout(() => {
        if (!finished)
          controller.enqueue(
            frame({ type: "response.output_text.delta", delta: "### 语境含义\n**mock**" }),
          )
      }, 30)
      timer = setTimeout(
        () => {
          if (finished) return
          controller.enqueue(
            frame({ type: "response.output_text.delta", delta: "mock translation" }),
          )
          controller.enqueue(
            frame({
              type: "response.completed",
              response: {
                id: "mock",
                status: "completed",
                output: [],
                ...(missingUsage ? {} : { usage: { input_tokens: 100, output_tokens: 100 } }),
              },
            }),
          )
          options.signal?.removeEventListener("abort", abort)
          finish()
          controller.close()
        },
        body.instructions?.startsWith("你是英语阅读老师") ? 600 : 200,
      )
    },
    cancel() {
      clearTimeout(timer)
      clearTimeout(deltaTimer)
      finish()
    },
  })
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
}

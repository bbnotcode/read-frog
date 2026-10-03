import { TextEncoder } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { browser } from "#imports"
import { readExplanationStream, streamVocabularyExplanation } from "../chatgpt-stream"

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

function port() {
  const messages = new Set<(event: unknown) => void>()
  const disconnects = new Set<() => void>()
  const value = {
    postMessage: vi.fn<(event: unknown) => void>(),
    disconnect: vi.fn<() => void>(),
    onMessage: {
      addListener: (listener: (event: unknown) => void) => messages.add(listener),
      removeListener: (listener: (event: unknown) => void) => messages.delete(listener),
    },
    onDisconnect: {
      addListener: (listener: () => void) => disconnects.add(listener),
      removeListener: (listener: () => void) => disconnects.delete(listener),
    },
  }
  vi.spyOn(browser.runtime, "connect").mockReturnValue(
    value as unknown as ReturnType<typeof browser.runtime.connect>,
  )
  return {
    value,
    messages,
    disconnects,
    emit: (event: unknown) => {
      for (const listener of messages) listener(event)
    },
  }
}

function response(events: unknown[], terminalNewline = true) {
  const bytes = new TextEncoder().encode(
    events.map((e) => JSON.stringify(e)).join("\n") + (terminalNewline ? "\n" : ""),
  )
  let offset = 0
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close()
        controller.enqueue(bytes.slice(offset, offset + 1))
        offset++
      },
    }),
  )
}
describe("word explanation stream", () => {
  it("disconnects only the cancelled request and removes its keepalive timer", async () => {
    vi.useFakeTimers()
    const p = port(),
      controller = new AbortController(),
      onText = vi.fn<(text: string) => void>()
    const pending = streamVocabularyExplanation(
      { word: "bank", sentence: "river bank", model: "test" },
      controller.signal,
      onText,
    )
    const rejected = pending.catch((error: unknown) => error)
    p.emit({ type: "text", text: "partial" })
    expect(onText).toHaveBeenCalledWith("partial")
    vi.advanceTimersByTime(15000)
    expect(p.value.postMessage).toHaveBeenLastCalledWith({ type: "ping" })
    controller.abort()
    expect(await rejected).toMatchObject({ name: "AbortError" })
    expect(p.value.disconnect).toHaveBeenCalledOnce()
    expect(p.messages.size).toBe(0)
    expect(p.disconnects.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it("resolves completed output and cleans up the streaming channel", async () => {
    vi.useFakeTimers()
    const p = port(),
      controller = new AbortController()
    const pending = streamVocabularyExplanation(
      { word: "bank", sentence: "river bank", model: "test" },
      controller.signal,
      () => {},
    )
    p.emit({ type: "complete", output: { text: "answer", cached: true } })
    expect(await pending).toEqual({ text: "answer", cached: true })
    expect(p.value.disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("renders partial text before completion, including split Chinese UTF-8", async () => {
    const partial: string[] = []
    const result = await readExplanationStream(
      response(
        [
          { type: "text", text: "### 语境含义\n**银行**" },
          { type: "complete", text: "### 语境含义\n**银行**", model: "test" },
        ],
        false,
      ),
      (text) => partial.push(text),
    )
    expect(partial).toEqual(["### 语境含义\n**银行**"])
    expect(result.model).toBe("test")
  })
  it("does not mistake partial text or a quota error for completion", async () => {
    await expect(
      readExplanationStream(response([{ type: "text", text: "partial" }]), () => {}),
    ).rejects.toThrow("中断")
    await expect(
      readExplanationStream(response([{ type: "error", error: "quota" }]), () => {}),
    ).rejects.toThrow("quota")
  })
})

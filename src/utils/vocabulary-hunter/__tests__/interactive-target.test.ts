// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { eventComesFromEditableControl, isVocabularyInteractiveTarget } from "../interactive-target"

describe("isVocabularyInteractiveTarget", () => {
  it("excludes custom autocomplete options and their descendants", () => {
    const option = document.createElement("div")
    option.setAttribute("role", "option")
    const label = document.createElement("span")
    label.textContent = "Beijing"
    option.append(label)

    expect(isVocabularyInteractiveTarget(option)).toBe(true)
    expect(isVocabularyInteractiveTarget(label.firstChild)).toBe(true)
  })

  it("does not exclude ordinary article text", () => {
    const paragraph = document.createElement("p")
    paragraph.textContent = "Beijing is the capital city of China."

    expect(isVocabularyInteractiveTarget(paragraph.firstChild)).toBe(false)
  })
})

describe("eventComesFromEditableControl", () => {
  it("recognizes inputs inside a shadow root from the composed event path", () => {
    const host = document.createElement("div")
    const shadow = host.attachShadow({ mode: "open" })
    const input = document.createElement("input")
    shadow.append(input)
    document.body.append(host)

    const event = new KeyboardEvent("keydown", { bubbles: true, composed: true, key: "a" })
    input.addEventListener("keydown", (receivedEvent) => {
      expect(eventComesFromEditableControl(receivedEvent)).toBe(true)
    })
    input.dispatchEvent(event)
  })
})

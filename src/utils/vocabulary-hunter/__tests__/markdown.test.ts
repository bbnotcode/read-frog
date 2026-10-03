// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { renderExplanationMarkdown } from "../markdown"

describe("short explanation Markdown", () => {
  it("formats headings, emphasis, paragraphs and numbered lists", () => {
    const root = renderExplanationMarkdown(
      "### 语境含义\n**and** 表示和。\n\n1. 第一项\n2. `第二项`\n\n> 例句",
    )
    expect(root.querySelector("h3")?.textContent).toBe("语境含义")
    expect(root.querySelector("strong")?.textContent).toBe("and")
    expect(root.querySelectorAll("ol li")).toHaveLength(2)
    expect(root.querySelector("code")?.textContent).toBe("第二项")
    expect(root.querySelector("blockquote")?.textContent).toBe("例句")
  })
  it("does not execute HTML, load images or create unsafe links", () => {
    const root = renderExplanationMarkdown(
      '<img src="https://evil.test" onerror="alert(1)">\n<script>alert(1)</script>\n[x](javascript:alert(1))',
    )
    expect(root.querySelector("img,script,a,iframe")).toBeNull()
    expect(root.textContent).toContain("<script>")
  })
  it("preserves code fences as text", () => {
    const root = renderExplanationMarkdown("```\n<b>hello</b>\n```\n\nDone")
    expect(root.querySelector("pre code")?.textContent).toBe("<b>hello</b>\n")
    expect(root.querySelector("b")).toBeNull()
  })
})

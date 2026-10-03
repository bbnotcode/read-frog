/** Small, DOM-only Markdown renderer for short word explanations.
 * Never interprets HTML, URLs or images from model output.
 */
function inline(target: HTMLElement, text: string) {
  const pattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|\*([^*\n]+)\*)/g
  let start = 0
  for (const match of text.matchAll(pattern)) {
    target.append(document.createTextNode(text.slice(start, match.index)))
    const node = document.createElement(match[2] ? "strong" : match[3] ? "code" : "em")
    node.textContent = match[2] || match[3] || match[4] || ""
    target.append(node)
    start = match.index + match[0].length
  }
  target.append(document.createTextNode(text.slice(start)))
}

export function renderExplanationMarkdown(text: string): HTMLElement {
  const root = document.createElement("div")
  root.className = "explanation-markdown"
  let paragraph: HTMLParagraphElement | undefined
  let list: HTMLOListElement | HTMLUListElement | undefined
  let code: HTMLElement | undefined
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("```")) {
      paragraph = undefined
      list = undefined
      if (code) code = undefined
      else {
        const pre = document.createElement("pre")
        code = document.createElement("code")
        pre.append(code)
        root.append(pre)
      }
      continue
    }
    if (code) {
      code.append(document.createTextNode(`${line}\n`))
      continue
    }
    if (!line.trim()) {
      paragraph = undefined
      list = undefined
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(line)
    if (heading) {
      const node = document.createElement(`h${heading[1]!.length}`)
      inline(node, heading[2]!)
      root.append(node)
      paragraph = undefined
      list = undefined
    } else if (item) {
      const tag = item[1] ? "ul" : "ol"
      if (!list || list.localName !== tag) {
        list = document.createElement(tag)
        root.append(list)
      }
      const node = document.createElement("li")
      inline(node, item[2]!)
      list.append(node)
      paragraph = undefined
    } else if (line.startsWith("> ")) {
      const node = document.createElement("blockquote")
      inline(node, line.slice(2))
      root.append(node)
      paragraph = undefined
      list = undefined
    } else {
      list = undefined
      if (!paragraph) {
        paragraph = document.createElement("p")
        root.append(paragraph)
      } else paragraph.append(document.createElement("br"))
      inline(paragraph, line)
    }
  }
  return root
}

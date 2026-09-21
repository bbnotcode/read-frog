import { describe, expect, it } from "vitest"
import { pointIntersectsAnyRect, pointIntersectsRect } from "../hover-stability"

describe("vocabulary hunter hover stability", () => {
  const rect = { left: 100, right: 150, top: 40, bottom: 60 }

  it("keeps a pointer on a highlighted word inside its hit area", () => {
    expect(pointIntersectsRect(125, 50, rect)).toBe(true)
  })

  it("tolerates small caret hit-test errors near a word edge", () => {
    expect(pointIntersectsRect(98, 50, rect)).toBe(true)
    expect(pointIntersectsRect(152, 62, rect)).toBe(true)
    expect(pointIntersectsRect(95, 50, rect)).toBe(false)
  })

  it("supports words split across multiple client rects", () => {
    expect(
      pointIntersectsAnyRect(25, 32, [
        { left: 10, right: 80, top: 10, bottom: 25 },
        { left: 10, right: 42, top: 30, bottom: 45 },
      ]),
    ).toBe(true)
  })
})

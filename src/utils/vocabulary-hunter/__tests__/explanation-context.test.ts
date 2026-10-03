import { describe, expect, it } from "vitest"
import {
  explanationContextKey,
  explanationProviderKey,
  shouldAutomaticallyExplain,
} from "../explanation-context"
describe("AI explanation context", () => {
  it("invalidates the same word when sentence or model changes", () => {
    const key = explanationContextKey("bank", "The bank is open.", "luna")
    expect(key).not.toBe(explanationContextKey("bank", "On the river bank.", "luna"))
    expect(key).not.toBe(explanationContextKey("bank", "The bank is open.", "sol"))
    expect(key).toBe(explanationContextKey("bank", "The bank is open.", "luna"))
  })
  it("never spends AI tokens on hover without explicit opt-in", () => {
    expect(shouldAutomaticallyExplain("ai", false)).toBe(false)
    expect(shouldAutomaticallyExplain("ai", true)).toBe(true)
    expect(shouldAutomaticallyExplain("haici", true)).toBe(false)
  })
  it("does not invalidate an explanation when unrelated preferences change", () => {
    const config = {
      providersConfig: [{ id: "local", model: "luna" }],
      selectionToolbar: { enabled: true },
      unrelated: 1,
    }
    const otherPreferences = { ...config, unrelated: 2 }
    expect(explanationProviderKey(config)).toBe(explanationProviderKey(otherPreferences))
    expect(explanationProviderKey(config)).not.toBe(
      explanationProviderKey({ ...config, providersConfig: [{ id: "local", model: "sol" }] }),
    )
  })
})

import { describe, expect, it } from "vitest"
import {
  analyzeAvoidAiPatterns,
  formatAvoidAiPatternsPromptFragment,
  formatAvoidAiPatternsSummary,
} from "./avoid-ai-patterns"

describe("avoid-ai-patterns full port", () => {
  it("scores English AI boilerplate above clean prose", () => {
    const dirty =
      "We must delve into this intricate tapestry of ideas. Furthermore, it is important to note that " +
      "in today's rapidly evolving landscape, we should leverage synergies. Let's dive deeper."
    const clean = "She opened the door. Rain hit the steps. Nobody spoke."
    const d = analyzeAvoidAiPatterns(dirty)
    const c = analyzeAvoidAiPatterns(clean)
    expect(d.productHardGate).toBe(false)
    expect(d.languageBias).toBe("english-heavy")
    expect(d.score).toBeGreaterThan(c.score)
    expect(d.issues.length).toBeGreaterThan(0)
    expect(formatAvoidAiPatternsSummary(d)).toContain("not product hard gate")
  })

  it("builds prompt fragment when issues present", () => {
    const r = analyzeAvoidAiPatterns(
      "Furthermore, it is important to note that we must delve into the tapestry.",
    )
    const frag = formatAvoidAiPatternsPromptFragment(r)
    if (r.score >= 15 || r.issues.length > 0) {
      expect(frag).toContain("Track B")
    }
  })
})

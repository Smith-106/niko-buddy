import { describe, expect, it, vi } from "vitest"
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

  it("nullish text and technical context mode are tolerated (defensive branches)", () => {
    const viaUndefined = analyzeAvoidAiPatterns(undefined as unknown as string)
    expect(viaUndefined.score).toBeGreaterThanOrEqual(0)
    const technical = analyzeAvoidAiPatterns("query the database schema", { contextMode: "technical" })
    expect(technical.score).toBeGreaterThanOrEqual(0)
  })

  it("clean-ish text returns empty prompt fragment (score<15 && no issues)", () => {
    const r = analyzeAvoidAiPatterns("她推开门。雨落在台阶上。没有人说话。")
    expect(formatAvoidAiPatternsPromptFragment(r)).toBe("")
  })

  it("synthetic result without documentClassification exercises summary/fragment n/a fallbacks", () => {
    const synthetic = {
      schemaVersion: "avoid-ai-patterns/1.0" as const,
      score: 20,
      label: "possible-ai",
      issues: [{ type: "tapestry", text: "delve into the tapestry of the paradigm" }],
      languageBias: "english-heavy" as const,
      productHardGate: false,
    }
    const summary = formatAvoidAiPatternsSummary(synthetic)
    expect(summary).not.toContain("class=")
    const frag = formatAvoidAiPatternsPromptFragment(synthetic, 2)
    expect(frag).toContain("class=n/a")
    expect(frag).toContain("tapestry")
  })

  it("rejects a vendor module without analyzeText", async () => {
    vi.resetModules()
    vi.doMock("./vendor/avoid-ai-writing/patterns.cjs?raw", () => ({
      default: "module.exports = {}",
    }))

    const isolated = await import("./avoid-ai-patterns")
    expect(() => isolated.analyzeAvoidAiPatterns("text")).toThrow("missing analyzeText")

    vi.doUnmock("./vendor/avoid-ai-writing/patterns.cjs?raw")
    vi.resetModules()
  })

  it("normalizes a sparse vendor result to public defaults", async () => {
    vi.resetModules()
    vi.doMock("./vendor/avoid-ai-writing/patterns.cjs?raw", () => ({
      default: "module.exports = { analyzeText: () => ({}) }",
    }))

    const isolated = await import("./avoid-ai-patterns")
    expect(isolated.analyzeAvoidAiPatterns("text")).toMatchObject({
      score: 0,
      label: "Unknown",
      issues: [],
    })

    vi.doUnmock("./vendor/avoid-ai-writing/patterns.cjs?raw")
    vi.resetModules()
  })
})


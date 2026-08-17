import { describe, expect, it } from "vitest"
import { CHARACTER_AURA_RESEARCH_FILES } from "./character-aura-types"

describe("character-aura-types", () => {
  it("exposes the 6 research file descriptors", () => {
    expect(CHARACTER_AURA_RESEARCH_FILES).toHaveLength(6)
    expect(CHARACTER_AURA_RESEARCH_FILES.map((f) => f.fileName)).toEqual([
      "01-writings.md",
      "02-conversations.md",
      "03-expression-dna.md",
      "04-external-views.md",
      "05-decisions.md",
      "06-timeline.md",
    ])
    for (const file of CHARACTER_AURA_RESEARCH_FILES) {
      expect(file.label.length).toBeGreaterThan(0)
    }
  })
})

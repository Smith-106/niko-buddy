import { describe, expect, it } from "vitest"
import type { UserMemoryRule } from "./types"
import { compileUserMemorySkill } from "./compiler"

function rule(id: string, text: string, source: "manual" | "automatic", confidence: number): UserMemoryRule {
  return {
    id,
    rule: text,
    category: "interaction_preference",
    source,
    surfaces: ["all"],
    confidence,
    evidenceSummary: "",
    sourceHash: null,
    fingerprint: id,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("user memory compiler", () => {
  it("手动规则优先并限制最终提示长度", () => {
    const prompt = compileUserMemorySkill([
      rule("auto", "自动规则".repeat(300), "automatic", 0.9),
      rule("manual", "手动规则优先。", "manual", 1),
    ], 180)

    expect(prompt).toContain("手动规则优先")
    expect(prompt.length).toBeLessThanOrEqual(180)
  })
})

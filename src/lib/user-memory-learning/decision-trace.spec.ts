import { describe, expect, it } from "vitest"
import { buildUserMemoryDecision } from "./decision-trace"
import type { UserMemoryRule } from "./types"

const baseRule: UserMemoryRule = {
  id: "r1", rule: "回答时先给结论。", category: "interaction_preference", source: "manual",
  surfaces: ["all"], confidence: 1, evidenceSummary: "", sourceHash: null,
  fingerprint: "r1", enabled: true, createdAt: 1, updatedAt: 1, scope: "global", status: "active",
}

describe("user memory decision trace", () => {
  it("记录候选、命中、过滤原因和注入成本", () => {
    const decision = buildUserMemoryDecision({
      rules: [baseRule, { ...baseRule, id: "r2", status: "candidate" }],
      selected: [baseRule],
      filtered: [{ ruleId: "r2", reason: "candidate" }],
      prompt: "全局用户规则".repeat(10),
      surface: "ai-chat",
      projectKey: "p1",
      sessionKey: "s1",
    })

    expect(decision).toMatchObject({ candidateCount: 2, selectedRuleIds: ["r1"], injectedChars: 60 })
    expect(decision.estimatedTokens).toBeGreaterThan(0)
    expect(decision.filtered[0]).toEqual({ ruleId: "r2", reason: "candidate" })
  })
})

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

  it("无规则或预算为 0 时返回空串（不注入空提示头）", () => {
    expect(compileUserMemorySkill([], 3000)).toBe("")
    // 预算向下取整后为 0：即便有规则也无处安放
    expect(compileUserMemorySkill([rule("m", "手动规则。", "manual", 1)], 0.4)).toBe("")
    // 负预算按 0 处理（Math.max 下界）
    expect(compileUserMemorySkill([rule("m", "手动规则。", "manual", 1)], -5)).toBe("")
  })

  it("预算小于提示头长度时只截断提示头，不带任何规则行", () => {
    const prompt = compileUserMemorySkill([rule("m", "手动规则。", "manual", 1)], 12)

    expect(prompt).toHaveLength(12)
    expect(prompt).toContain("## 全局用户规则")
    expect(prompt).not.toContain("手动规则。")
    // 规则行以 "\n- " 开头，任何规则行都不可能出现：说明 break 在头部截断时返回
    expect(prompt).not.toContain("- ")
  })
})

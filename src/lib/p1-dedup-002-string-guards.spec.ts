import { describe, expect, it } from "vitest"
import { isBlankString, isNonEmptyString } from "@/lib/string-guards"
import { hasAnthropicApiKey } from "@/lib/llm-config/preset-resolver"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { assessLlmHealth } from "@/lib/llm-health"

/**
 * ISS-20260708-002：三处重复守卫收敛到公共守卫（行为等价）。
 */
describe("ISS-20260708-002 string-guards convergence", () => {
  it("isNonEmptyString 与原内联语义一致", () => {
    expect(isNonEmptyString("k")).toBe(true)
    expect(isNonEmptyString("  k  ")).toBe(true)
    expect(isNonEmptyString("   ")).toBe(false)
    expect(isNonEmptyString("")).toBe(false)
    expect(isNonEmptyString(undefined)).toBe(false)
    expect(isNonEmptyString(null)).toBe(false)
    expect(isNonEmptyString(123)).toBe(false)
  })

  it("isBlankString 为严格取反", () => {
    expect(isBlankString("k")).toBe(false)
    expect(isBlankString("   ")).toBe(true)
    expect(isBlankString("")).toBe(true)
    expect(isBlankString(undefined)).toBe(true)
    expect(isBlankString(null)).toBe(true)
  })

  it("hasAnthropicApiKey 经公共守卫仍等价（含 env 回退）", () => {
    expect(hasAnthropicApiKey({ apiKey: "  sk-x  " })).toBe(true)
    expect(hasAnthropicApiKey({ apiKey: "   " })).toBe(
      typeof process.env?.ANTHROPIC_API_KEY === "string" &&
        process.env.ANTHROPIC_API_KEY.trim().length > 0,
    )
  })

  it("hasUsableLlm hosted 仍需 apiKey+model（守卫收敛无行为变更）", () => {
    expect(
      hasUsableLlm({ provider: "openai", apiKey: "k", model: "m" }),
    ).toBe(true)
    expect(
      hasUsableLlm({ provider: "openai", apiKey: "   ", model: "m" }),
    ).toBe(false)
    expect(
      hasUsableLlm({ provider: "openai", apiKey: "k", model: "  " }),
    ).toBe(false)
  })

  it("assessLlmHealth 空白判定与收敛前一致", () => {
    expect(assessLlmHealth({ provider: "openai", apiKey: "", model: "" }).status).toBe(
      "unconfigured",
    )
    expect(
      assessLlmHealth({ provider: "openai", apiKey: "k", model: "" }).status,
    ).toBe("incomplete")
  })
});

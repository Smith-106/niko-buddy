/**
 * 上下文窗口兜底默认值的行为契约。
 *
 * 此前兜底是 204800，对 32K 模型是 6 倍超窗；而 token 估算器改准之后，
 * 这个错误上限反而更容易真的撞上去（以前低估、发得比预算多但被上游截断；
 * 现在估得准、天花板本身却是错的）。
 */
import { describe, expect, it } from "vitest"
import { DEFAULT_MAX_CONTEXT_TOKENS } from "./llm-context-limits"
import { getEffectiveMaxContextSize } from "./llm-providers"
import { computeContextBudget } from "./context-budget"
import { LLM_PRESETS } from "./llm-config/llm-presets"
import { resolveConfig } from "./llm-config/preset-resolver"
import type { LlmConfig } from "@/stores/wiki-store"

const fallbackConfig = (): LlmConfig => ({
  provider: "custom",
  apiKey: "sk-test",
  model: "unknown-model",
  ollamaUrl: "",
  customEndpoint: "https://example.test/v1",
  apiMode: "chat_completions",
  reasoning: { mode: "auto" },
  // 全新 store 的初值就是常量（wiki-store.ts 的初始 state）
  maxContextSize: DEFAULT_MAX_CONTEXT_TOKENS,
}) as LlmConfig

describe("DEFAULT_MAX_CONTEXT_TOKENS", () => {
  it("兜底是保守值：32K 模型不会因默认值超窗", () => {
    // runner.ts 用 maxContextSize × 0.75 作 token 预算
    const budget = Math.floor(DEFAULT_MAX_CONTEXT_TOKENS * 0.75)
    expect(budget).toBeLessThanOrEqual(32_768)
    // 保守到足以覆盖 32K 这一档，同时不至于小到没有实用价值
    expect(DEFAULT_MAX_CONTEXT_TOKENS).toBeGreaterThanOrEqual(32_768)
  })

  it("getEffectiveMaxContextSize 对缺失/非法值走同一兜底", () => {
    expect(getEffectiveMaxContextSize({})).toBe(DEFAULT_MAX_CONTEXT_TOKENS)
    expect(getEffectiveMaxContextSize({ maxContextSize: 0 })).toBe(DEFAULT_MAX_CONTEXT_TOKENS)
    expect(getEffectiveMaxContextSize({ maxContextSize: -1 })).toBe(DEFAULT_MAX_CONTEXT_TOKENS)
    // 显式值原样透传，不被兜底覆盖
    expect(getEffectiveMaxContextSize({ maxContextSize: 200_000 })).toBe(200_000)
  })

  it("computeContextBudget 的 falsy 分支与常量同源", () => {
    expect(computeContextBudget(undefined).maxCtx).toBe(DEFAULT_MAX_CONTEXT_TOKENS)
    expect(computeContextBudget(0).maxCtx).toBe(DEFAULT_MAX_CONTEXT_TOKENS)
  })
})

describe("预设路径不受兜底影响", () => {
  it("除 custom 外的预设全部自带 suggestedContextSize（所以不会走兜底）", () => {
    expect(LLM_PRESETS.length).toBeGreaterThan(0)
    const withoutSize = LLM_PRESETS.filter((p) => !p.suggestedContextSize)
    // 只有 custom 预设没有：它代表「未知模型」，兜底本来就该作用在这里
    expect(withoutSize.map((p) => p.id)).toEqual(["custom"])
    for (const preset of LLM_PRESETS) {
      if (preset.id === "custom") continue
      expect(preset.suggestedContextSize, `${preset.id} 缺 suggestedContextSize`).toBeGreaterThan(0)
    }
  })

  it("custom 预设（未知模型）继承 store 初值，即保守兜底", () => {
    const preset = LLM_PRESETS.find((p) => p.id === "custom")!
    const resolved = resolveConfig(preset, { apiKey: "sk-test" }, fallbackConfig())
    // custom 预设没有 suggestedContextSize，落到 fallback.maxContextSize，
    // 而全新 store 的初值就是 DEFAULT_MAX_CONTEXT_TOKENS。
    expect(resolved.maxContextSize).toBe(DEFAULT_MAX_CONTEXT_TOKENS)
  })

  it("即便 store 值缺失，下游仍兜到保守默认", () => {
    // resolveConfig 可能返回 undefined（自定义模型 + 无预设 + store 无值），
    // 真正的兜底发生在 getEffectiveMaxContextSize / computeContextBudget。
    expect(getEffectiveMaxContextSize({ maxContextSize: undefined })).toBe(DEFAULT_MAX_CONTEXT_TOKENS)
    expect(computeContextBudget(undefined).maxCtx).toBe(DEFAULT_MAX_CONTEXT_TOKENS)
  })

  it("预设解析出的窗口是预设值，不是兜底值", () => {
    const preset = LLM_PRESETS.find((p) => p.id === "minimax-global")!
    const resolved = resolveConfig(preset, { apiKey: "sk-test" }, fallbackConfig())
    expect(resolved.maxContextSize).toBe(preset.suggestedContextSize)
    expect(resolved.maxContextSize).not.toBe(DEFAULT_MAX_CONTEXT_TOKENS)
  })

  it("用户显式设置优先于预设", () => {
    const preset = LLM_PRESETS.find((p) => p.id === "minimax-global")!
    const resolved = resolveConfig(preset, { apiKey: "sk-test", maxContextSize: 8_000 }, fallbackConfig())
    expect(resolved.maxContextSize).toBe(8_000)
  })
})

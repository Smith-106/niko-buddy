/** C4 冒烟覆盖：src/lib/agent/required-tools-gate.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { missingRequiredToolsOnce, shouldBlockFinalWithoutRequiredTools, buildRequiredToolNudgeMessage, RequiredToolsNotCalledError, RequiredToolFallbackError, resolveRequiredToolsOnce } from "./required-tools-gate"
describe("required-tools-gate.ts smoke", () => {
  it("exports missingRequiredToolsOnce", () => {
    expect(missingRequiredToolsOnce).toBeDefined()
  })
  it("exports shouldBlockFinalWithoutRequiredTools", () => {
    expect(shouldBlockFinalWithoutRequiredTools).toBeDefined()
  })
  it("exports buildRequiredToolNudgeMessage", () => {
    expect(buildRequiredToolNudgeMessage).toBeDefined()
  })
  it("exports RequiredToolsNotCalledError", () => {
    expect(RequiredToolsNotCalledError).toBeDefined()
  })
  it("exports RequiredToolFallbackError", () => {
    expect(RequiredToolFallbackError).toBeDefined()
  })
  it("exports resolveRequiredToolsOnce", () => {
    expect(resolveRequiredToolsOnce).toBeDefined()
  })
})

/**
 * NF-01 的折算契约：装配层（main-control.ts）现在把 config.requiredToolsOnce 的来源
 * 完全交给 resolveRequiredToolsOnce，因此这里的每条分支都是「门控会不会武装」的真实开关。
 * 冒烟块只证明导出存在，测不到折算——本块补上，避免以后有人把折算改成硬编码还全绿。
 */
describe("resolveRequiredToolsOnce 折算", () => {
  const armed = (overrides: Partial<Parameters<typeof resolveRequiredToolsOnce>[0]> = {}) =>
    resolveRequiredToolsOnce({
      novelMode: true,
      intent: "write_chapter",
      mode: "standard",
      planExecuteActive: false,
      enabledToolNames: ["read_chapter", "run_chapter_workflow"],
      ...overrides,
    })

  it("章节写作意图 + 非 fast + 工具可用 → 要求 run_chapter_workflow", () => {
    expect(armed()).toEqual(["run_chapter_workflow"])
    expect(armed({ mode: "strict" })).toEqual(["run_chapter_workflow"])
  })

  it("四类章节写作意图都武装（write/continue/rewrite/polish）", () => {
    for (const intent of ["write_chapter", "continue_chapter", "rewrite_chapter", "polish_chapter"]) {
      expect(armed({ intent })).toEqual(["run_chapter_workflow"])
    }
  })

  it("非章节写作意图不武装（审稿/检索/闲聊/大纲生成）", () => {
    for (const intent of ["review_chapter", "lint_chapter", "search_plot", "general_chat", "generate_outline", null, undefined]) {
      expect(armed({ intent })).toBeUndefined()
    }
  })

  it("fast 模式不武装（快速模式允许主 Agent 直接出稿）", () => {
    expect(armed({ mode: "fast" })).toBeUndefined()
  })

  it("计划阶段不武装（计划阶段禁止调用该工具）", () => {
    expect(armed({ planExecuteActive: true })).toBeUndefined()
  })

  it("非小说模式不武装", () => {
    expect(armed({ novelMode: false })).toBeUndefined()
  })

  it("工具未注册（白名单不含它）不武装；白名单缺省/为空数组时武装", () => {
    expect(armed({ enabledToolNames: ["read_chapter", "write_chapter"] })).toBeUndefined()
    expect(armed({ enabledToolNames: null })).toEqual(["run_chapter_workflow"])
    expect(armed({ enabledToolNames: undefined })).toEqual(["run_chapter_workflow"])
    // 空数组是「显式什么都没启用」，按 includes 判定 → 不武装
    expect(armed({ enabledToolNames: [] })).toBeUndefined()
  })
})

describe("missingRequiredToolsOnce 拦截判定", () => {
  const base = {
    requiredToolsOnce: ["run_chapter_workflow"],
    availableToolNames: ["read_chapter", "run_chapter_workflow"],
    calledToolNames: [] as string[],
    toolsEnabled: true,
  }

  it("工具可用且未调用 → 返回缺失（触发 nudge / 拒绝终稿）", () => {
    expect(missingRequiredToolsOnce(base)).toEqual(["run_chapter_workflow"])
    expect(shouldBlockFinalWithoutRequiredTools(base)).toBe(true)
  })

  it("调用过 → 不拦截", () => {
    expect(missingRequiredToolsOnce({ ...base, calledToolNames: ["run_chapter_workflow"] })).toEqual([])
    expect(shouldBlockFinalWithoutRequiredTools({ ...base, calledToolNames: ["run_chapter_workflow"] })).toBe(false)
  })

  it("工具不可用（未注册）→ 不拦截：避免把没注册的工具当成模型违约", () => {
    expect(missingRequiredToolsOnce({ ...base, availableToolNames: ["read_chapter"] })).toEqual([])
  })

  it("工具通道关闭（toolsEnabled=false）→ 不拦截", () => {
    expect(missingRequiredToolsOnce({ ...base, toolsEnabled: false })).toEqual([])
  })

  it("requiredToolsOnce 为空/缺省 → 不拦截", () => {
    expect(missingRequiredToolsOnce({ ...base, requiredToolsOnce: [] })).toEqual([])
    expect(missingRequiredToolsOnce({ ...base, requiredToolsOnce: null })).toEqual([])
    expect(missingRequiredToolsOnce({ ...base, requiredToolsOnce: undefined })).toEqual([])
    expect(missingRequiredToolsOnce({ ...base, requiredToolsOnce: ["  "] })).toEqual([])
  })

  it("nudge 文案点名缺失工具，且明确禁止直接出终稿", () => {
    const message = buildRequiredToolNudgeMessage(["run_chapter_workflow"])
    expect(message).toContain("run_chapter_workflow")
    expect(message).toContain("禁止直接输出章节终稿正文")
  })
})

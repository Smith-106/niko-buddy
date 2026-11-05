import { describe, expect, it } from "vitest"
import type { AiWorkflowMode } from "./workflow-mode"
import {
  buildPlanExecutePolicyPrompt,
  shouldRequirePlan,
  WRITING_INTENTS,
} from "./plan-execute-policy"

describe("WRITING_INTENTS", () => {
  it("包含全部 5 种写作意图且不含闲聊意图", () => {
    for (const intent of [
      "write_chapter",
      "continue_chapter",
      "rewrite_chapter",
      "polish_chapter",
      "generate_outline",
    ]) {
      expect(WRITING_INTENTS.has(intent as never)).toBe(true)
    }
    expect(WRITING_INTENTS.has("general_chat" as never)).toBe(false)
    expect(WRITING_INTENTS.size).toBe(5)
  })
})

describe("shouldRequirePlan", () => {
  it("开关关闭时一律不要求计划", () => {
    expect(shouldRequirePlan(false, "strict", "write_chapter")).toBe(false)
  })

  it("无意图/空意图时不要求计划", () => {
    expect(shouldRequirePlan(true, "strict", null)).toBe(false)
    expect(shouldRequirePlan(true, "strict", undefined)).toBe(false)
    expect(shouldRequirePlan(true, "strict", "")).toBe(false)
  })

  it("非写作意图不要求计划", () => {
    expect(shouldRequirePlan(true, "strict", "general_chat")).toBe(false)
  })

  it("5 种写作意图都要求计划（模式无关）", () => {
    for (const intent of [
      "write_chapter",
      "continue_chapter",
      "rewrite_chapter",
      "polish_chapter",
      "generate_outline",
    ]) {
      expect(shouldRequirePlan(true, "fast", intent)).toBe(true)
      expect(shouldRequirePlan(true, "strict", intent)).toBe(true)
    }
  })
})

describe("buildPlanExecutePolicyPrompt", () => {
  it("三种模式都包裹 chapter_plan 标记并约束终稿调用", () => {
    for (const mode of ["fast", "strict", "standard"] as const) {
      const prompt = buildPlanExecutePolicyPrompt(mode)
      expect(prompt).toContain("<!-- chapter_plan -->")
      expect(prompt).toContain("<!-- /chapter_plan -->")
      expect(prompt).toContain("run_chapter_workflow")
    }
  })

  it("快速模式声明最短计划后直接执行", () => {
    const prompt = buildPlanExecutePolicyPrompt("fast")
    expect(prompt).toContain("快速模式")
    expect(prompt).toContain("最多 3 条")
  })

  it("严格模式声明计划阶段禁正文禁调用", () => {
    const prompt = buildPlanExecutePolicyPrompt("strict")
    expect(prompt).toContain("严格模式")
    expect(prompt).toContain("禁止输出章节正文")
    expect(prompt).toContain("禁止调用 run_chapter_workflow")
  })

  it("标准模式声明轻量计划且禁正文", () => {
    const prompt = buildPlanExecutePolicyPrompt("standard")
    expect(prompt).toContain("标准模式")
    expect(prompt).toContain("禁止输出章节正文")
  })

  it("未知模式回退到标准模式文案", () => {
    const fallback = buildPlanExecutePolicyPrompt("standard")
    expect(buildPlanExecutePolicyPrompt("weird" as AiWorkflowMode)).toBe(fallback)
  })
})
